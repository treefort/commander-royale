// The game for AI assistants: a plain-text reference (served as /llms.txt) to every match setting and to what
// players can do outside the settings (computer squads, training, co-op controls, retries...), generated from the
// real rules and data wherever possible so it can't drift from the code (tests check it covers every setting, AI
// squad option, strategy and training course), and a checker that says what a settings object would turn into.
// Players point their assistant at the reference, describe the match they want, and get back a link
// (/?settings=<json>) or JSON to paste into the New Match form, or play links (/play?setup=<json>) that also build
// a map from a recipe, add computer opponents, and auto-configure the player's squad or leave it for them to equip. Adding a feature or an option? Describe it here too.
import {
  BIOMES, UFO_CHOICES, PLACEMENTS, MAX_SQUAD_SIZE, MAX_SIDES, DEFAULT_BOT_TUNING, defaultSettings, sanitizeSettings, sanitizeBotTuning,
  recommendedMapBlocks, recommendedScenarioBlocks, type MatchSettings, type BotTuning,
} from "./protocol.ts";
import { UNITS, armorRule, itemRule, tr } from "./rules/index.ts";
import { CATALOG, COURSES, MAX_SESSIONS, MIN_SESSION_PRICE, TRAINING_PREMIUM, priceUnit, budgetGuide } from "./rules/catalog.ts";
import { STRATEGIES, STRATEGY_NAMES, type Strategy } from "./rules/squads.ts";
import { enemyTypeChoices, weaponChoices } from "./rules/scenario.ts";

export interface FieldDoc {
  path: string;
  type: string;
  /** inclusive numeric range enforced by sanitizeSettings (checked by tests) */
  range?: [number, number];
  /** which mode reads it (omitted: both) */
  mode?: "ffa" | "coop";
  text: string;
}

const list = (xs: readonly string[]) => xs.map((x) => `"${x}"`).join(" | ");

/** Every setting, in the order the form shows them. */
export const FIELDS: FieldDoc[] = [
  { path: "mode", type: list(["ffa", "coop"]), text: "\"ffa\": free-for-all, squads fight each other and the last squad standing wins. \"coop\": a scenario: everyone who joins plays on ONE team against an enemy force the creator (the game master) defines in `scenario`." },
  { path: "name", type: "string, up to 40 characters", text: "Shown in the match list and lobby." },
  { path: "notes", type: "string, up to 1000 characters", text: "A message from the creator to everyone who joins (house rules, schedule, the story of the mission...)." },
  { path: "biome", type: list(["RANDOM", ...BIOMES.map((b) => b.id)]), text: `Environment: ${BIOMES.map((b) => `${b.id} = ${b.name}`).join(", ")}. RANDOM is rolled when the battle starts.` },
  { path: "timeOfDay", type: list(["day", "dusk", "night", "random"]), text: "At night humans see 9 tiles except in lit areas (flares, fire); aliens see in the dark. Dusk is in between." },
  { path: "ufo", type: list(UFO_CHOICES.map((u) => u.id)), text: `A landed UFO in the middle of the map (cover, a building to fight over; co-op enemies can start inside it): ${UFO_CHOICES.filter((u) => u.id.startsWith("STR")).map((u) => `${u.id} = ${u.name}`).join(", ")}.` },
  { path: "mapBlocks", type: "integer", range: [0, 10], text: "Map edge in 10-tile blocks (5 = 50x50 tiles), 4–10. 0 (the default) = auto: sized when the battle starts for whoever is there (free-for-all: 5 for 2 squads, 6 for 3–4, 7 for 5–6, 8 for more, +1 at $1,000,000+; co-op: from the team's size and the enemy force). Only set it when the player asks for a particular size." },
  { path: "map", type: "custom map id (string), or \"\"", text: "A custom map made in the map editor (/maps), by its id: the last part of its address, /maps/<id>. \"\" (the default) = a map generated from `biome`, `ufo` and `mapBlocks`. A custom map has its own terrain, size, landing zones and any UFO, so those three are ignored (`timeOfDay` still applies). Only use an id the player gave you; to make a new map, see /maps.txt." },
  { path: "budget", type: "integer (dollars)", range: [50_000, 5_000_000], text: "What each player (free-for-all: each squad's leader; co-op: each person) spends on hiring units, weapons and armor. See \"Budget rules of thumb\" below." },
  { path: "squadLimit", type: "integer (seats)", range: [1, 30], mode: "ffa", text: "Free-for-all squad size in Skyranger seats: soldiers and small aliens take 1, tanks and large aliens (Cyberdisc, Reaper, Sectopod) take 4. The original Skyranger holds 14." },
  { path: "poolSize", type: "integer", range: [10, 80], text: "How many recruits are in the hiring pool (everyone hires from an identical copy)." },
  { path: "techLevel", type: list(["conventional", "laser", "alien"]), text: "What can be bought (conventional: rifles, cannons, rockets; laser: plus lasers; alien: everything incl. plasma, blaster launchers, psi-amps), and what co-op enemies with the \"standard\" weapon carry." },
  { path: "allowAliens", type: "boolean", text: "Alien recruits in the hiring pool (players can hire Sectoids, Mutons, Chryssalids...)." },
  { path: "allowHWP", type: "boolean", text: "Tanks (HWPs) in the hiring pool." },
  { path: "allowArmor", type: "boolean", text: "Players may buy armor (personal armor, power suit, flying suit)." },
  { path: "psionics", type: "boolean", text: "Psionics and mind control (psi-amps, Sectoid/Ethereal psi attacks)." },
  { path: "supplyDrops.enabled", type: "boolean", text: "Crates of loot that land on the map now and then; their position and countdown are announced to everyone." },
  { path: "supplyDrops.everyRounds", type: "integer", range: [1, 20], text: "Rounds between drops." },
  { path: "supplyDrops.warningRounds", type: "integer", range: [0, 10], text: "How many rounds ahead each drop is announced." },
  { path: "supplyDrops.tier", type: list(["basic", "advanced", "alien", "mixed"]), text: "basic: rifles, grenades, medikits; advanced: cannons, lasers, scanners; alien: plasma, blasters, psi; mixed: weighted random." },
  { path: "supplyDrops.kits", type: "integer", range: [1, 12], text: "How much each drop holds, in kits: a kit is a weapon with its ammo, a pair of grenades, a medikit, a scanner... Default 3; 1 is a small top-up, 8+ re-arms a squad." },
  { path: "turnTimer", type: "integer (seconds)", range: [0, 3600], text: "Time limit per turn; 0 = none (play asynchronously: come back whenever). Needed by coop.turnEnd = \"timer\"." },
  { path: "stranger", type: "integer (percent)", range: [0, 50], text: "The Mysterious Stranger (as in Fallout): the % chance that when a unit shoots or strikes an enemy it can see and the enemy survives, a stranger with a magnum appears beside the attacker, fires one deadly shot at that enemy and vanishes. Works for every side alike. 0 (the default) = off; 10 is Fallout's chance." },
  { path: "autoStart", type: "boolean", text: "The battle starts by itself as soon as it can once the creator is ready (free-for-all: once two squads are ready, e.g. the creator's and a computer squad; co-op with a game master who only watches: once someone on the team is ready), so nobody has to press Start. Play links (below) turn it on." },
  { path: "coop.squadSize", type: "integer", range: [1, MAX_SQUAD_SIZE], mode: "ffa", text: "Free-for-all only: people per squad. 1 = everyone fields their own. Above 1, people can join someone else's squad; the squad's units are shared out and everyone in it moves at the same time on its turn." },
  { path: "coop.turnEnd", type: list(["lockin", "timer", "daily"]), text: "When a squad played by several people (or the co-op team) ends its turn: \"lockin\" once everyone has pressed End Turn (the default, so players set the pace); \"timer\" only when turnTimer runs out (needs turnTimer > 0); \"daily\" (co-op mode only) at coop.dailyAt every day, or earlier once everyone has locked in." },
  { path: "coop.dailyAt", type: "\"HH:MM\" (24-hour)", text: "With turnEnd \"daily\": the time of day the team's turn ends. A turn that starts less than an hour before it runs to the next day's." },
  { path: "coop.timeZone", type: "IANA time zone, e.g. \"America/New_York\"", text: "Time zone for coop.dailyAt (the form fills in the creator's own)." },
  { path: "coop.afkAI", type: "boolean", text: "The computer plays the units of anyone offline for 30+ seconds until they're back. Off: offline players' units just stay put (anyone can also hand their units to the AI from the in-game options)." },
  { path: "scenario.teamName", type: "string, up to 30 characters", mode: "coop", text: "The players' side." },
  { path: "scenario.enemyName", type: "string, up to 30 characters", mode: "coop", text: "The enemy's side." },
  { path: "scenario.seatsPerPlayer", type: "integer (seats)", range: [1, 30], mode: "coop", text: "Skyranger seats each person fills with units they hire and command: soldiers and small aliens take 1, tanks and large aliens 4 (4 seats = 4 soldiers or 1 tank)." },
  { path: "scenario.teamStart", type: list(["together", "apart"]), mode: "coop", text: "\"together\": the whole team lands in one zone. \"apart\": each person lands in their own zone around the map edge, like squads in a free-for-all." },
  { path: "scenario.gmPlays", type: "boolean", mode: "coop", text: "true: the creator hires units and plays on the team. false: the creator is only the game master: they hire nothing, can't give orders, and watches the whole battle (every unit, both sides)." },
  { path: "scenario.enemies", type: "array of enemy groups (1–20)", mode: "coop", text: "The enemy force, played by the computer. At least one group must have round 1. The team wins when every enemy is down and no more groups are coming. See \"Enemy groups\" below." },
  { path: "scenario.enemies[].type", type: "enemy unit id (table below)", mode: "coop", text: "An alien race and rank, a terror unit, a tank, or \"SOLDIER:<0-5>\" for human soldiers of a rank (0 rookie .. 5 commander)." },
  { path: "scenario.enemies[].count", type: "integer", range: [1, 40], mode: "coop", text: "How many of this type." },
  { path: "scenario.enemies[].weapon", type: "\"standard\" | \"none\" | weapon id (table below)", mode: "coop", text: "\"standard\": by rank and tech level (crew get pistols, soldiers rifles, leaders/commanders heavy weapons: plasma at alien tech, lasers at laser tech, conventional arms otherwise). Terror units (Chryssalid, Reaper, Cyberdisc...) have built-in attacks either way; tanks can't carry anything." },
  { path: "scenario.enemies[].grenades", type: "integer", range: [0, 6], mode: "coop", text: "Grenades each (alien grenades at alien tech)." },
  { path: "scenario.enemies[].armor", type: list(["STR_NONE_UC", "STR_PERSONAL_ARMOR_UC", "STR_POWER_SUIT_UC", "STR_FLYING_SUIT_UC"]), mode: "coop", text: "Human soldiers only; aliens have their natural armor." },
  { path: "scenario.enemies[].placement", type: list(PLACEMENTS.map((p) => p.id)), mode: "coop", text: `Where they start: ${PLACEMENTS.map((p) => `"${p.id}" = ${p.name.toLowerCase()}`).join(", ")}. "edge" is their own landing zone across the map from the team; "ufo" needs a landed UFO (otherwise they start in the middle); "spread" keeps clear of everyone's landing zones.` },
  { path: "scenario.enemies[].round", type: "integer", range: [1, 99], mode: "coop", text: "The round they arrive. 1 = on the map from the start; later = reinforcements landing at the start of that round." },
  { path: "scenario.ai.aggression", type: "integer", range: [0, 3], mode: "coop", text: "0 cautious (aimed shots, falls back) .. 3 reckless (snap shots, charges)." },
  { path: "scenario.ai.difficulty", type: "integer", range: [0, 4], mode: "coop", text: "How keen it is on grenades and explosives: 0 rarely .. 4 whenever it can." },
  { path: "scenario.ai.intelligence", type: "integer", range: [1, 10], mode: "coop", text: "Rounds it remembers where it last saw one of you." },
  { path: "scenario.ai.cheatTurn", type: "integer", range: [1, 99], mode: "coop", text: "After this round it knows where everyone is (so battles don't stall)." },
  { path: "scenario.ai.personalities", type: "boolean", mode: "coop", text: "Each race plays to type (Sectoids cautious, Chryssalids reckless...) instead of the aggression above." },
];

/** A computer squad's AI settings (free-for-all lobby, "AI settings" under each one; co-op uses scenario.ai). */
export const BOT_TUNING_DOCS: Record<keyof BotTuning, { range?: [number, number]; text: string }> = {
  aggression: { range: [0, 3], text: "0 cautious (aimed shots, falls back) .. 3 reckless (snap shots, charges)." },
  difficulty: { range: [0, 4], text: "How keen it is on grenades and other explosives." },
  intelligence: { range: [1, 10], text: "Rounds it remembers where it last saw an enemy." },
  cheatTurn: { range: [1, 99], text: "After this round it knows where every enemy is." },
  personalities: { text: "Each race plays to type (Sectoids cautious, Chryssalids reckless...)." },
  strength: { range: [25, 400], text: "Its budget and seats as a % of the match's: handicap it, or make it a boss for several people to gang up on. Changing it rehires the squad." },
};

/** Natural-language requests and the settings that answer them (checked by tests: no warnings). */
export const EXAMPLES: { ask: string; settings: Record<string, unknown> }[] = [
  {
    ask: "A quick 1v1 in a city at night, small squads, no aliens for hire, a 2-minute turn timer.",
    settings: { mode: "ffa", name: "Night in the City", biome: "URBAN", timeOfDay: "night", budget: 200000, squadLimit: 8, allowAliens: false, turnTimer: 120 },
  },
  {
    ask: "Three of us against the crew of a downed Sectoid scout in farmland, with Floater reinforcements later. We each want 4 soldiers, landing apart. Turns end at 8pm Eastern every day.",
    settings: {
      mode: "coop", name: "Crash Site", biome: "CULTA", timeOfDay: "day", ufo: "STR_SMALL_SCOUT", budget: 250000, techLevel: "laser",
      coop: { turnEnd: "daily", dailyAt: "20:00", timeZone: "America/New_York" },
      scenario: {
        teamName: "X-COM", enemyName: "Sectoid Crew", seatsPerPlayer: 4, teamStart: "apart", gmPlays: true,
        enemies: [
          { type: "STR_SECTOID_SOLDIER", count: 5, weapon: "standard", placement: "ufo", round: 1 },
          { type: "STR_SECTOID_LEADER", count: 1, weapon: "standard", grenades: 2, placement: "ufo", round: 1 },
          { type: "STR_FLOATER_SOLDIER", count: 4, weapon: "standard", placement: "edge", round: 3 },
        ],
      },
    },
  },
  {
    ask: "I'll run a terror mission for 6 friends (2 seats each) — Chryssalids and zombies in a city at dusk, and I just want to watch.",
    settings: {
      mode: "coop", name: "Terror Site", biome: "URBAN", timeOfDay: "dusk", budget: 150000, supplyDrops: { tier: "basic" },
      scenario: {
        teamName: "Rapid Response", enemyName: "The Hive", seatsPerPlayer: 2, teamStart: "together", gmPlays: false,
        enemies: [
          { type: "STR_CHRYSSALID_TERRORIST", count: 4, placement: "spread", round: 1 },
          { type: "STR_ZOMBIE", count: 6, placement: "spread", round: 1 },
          { type: "STR_CHRYSSALID_TERRORIST", count: 3, placement: "center", round: 4 },
        ],
        ai: { aggression: 3, personalities: true },
      },
    },
  },
  {
    ask: "Hard mode: two of us with big budgets assault the alien base on Mars — Ethereals, Mutons and a Sectopod.",
    settings: {
      mode: "coop", name: "Cydonia", biome: "MARS", timeOfDay: "night", budget: 1500000, techLevel: "alien",
      scenario: {
        seatsPerPlayer: 8, enemyName: "Ethereal Guard",
        enemies: [
          { type: "STR_ETHEREAL_COMMANDER", count: 1, placement: "center", round: 1 },
          { type: "STR_ETHEREAL_SOLDIER", count: 4, placement: "center", round: 1 },
          { type: "STR_MUTON_SOLDIER", count: 6, grenades: 1, placement: "spread", round: 1 },
          { type: "STR_SECTOPOD_TERRORIST", count: 1, placement: "edge", round: 2 },
        ],
        ai: { aggression: 2, difficulty: 4 },
      },
    },
  },
];

/** Requests answered with play links (checked by tests: no warnings, and the recipe builds). */
export const PLAY_EXAMPLES: { ask: string; setup: Record<string, unknown> }[] = [
  {
    ask: "Get me straight into a game against two computer squads, one of them heavy weapons, in the desert at dusk.",
    setup: {
      settings: { mode: "ffa", name: "Dust Up", biome: "DESERT", timeOfDay: "dusk", budget: 300000 },
      opponents: [{ strategy: "heavy" }, { strategy: "swarm", ai: { aggression: 3 } }],
      squad: "auto",
    },
  },
  {
    ask: "Me alone against a Muton raiding party on a small farm map you design; I want to pick my own soldiers.",
    setup: {
      settings: { mode: "coop", name: "Muton Raid", timeOfDay: "night", budget: 350000, scenario: { seatsPerPlayer: 8, enemies: [{ type: "STR_MUTON_SOLDIER", count: 6, placement: "spread" }] } },
      recipe: { name: "Hedgerow Farm", terrain: "CULTA", size: 40, base: "generated", zones: 4 },
      squad: "equip",
    },
  },
];

function md(rows: string[][]): string {
  const esc = (c: string) => c.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [rows[0], rows[0].map(() => "---"), ...rows.slice(1)].map((r) => `| ${r.map(esc).join(" | ")} |`).join("\n");
}

function defaultAt(path: string): string {
  if (path.includes("[]")) return "";
  let v: unknown = defaultSettings();
  for (const k of path.split(".")) v = (v as Record<string, unknown>)?.[k];
  if (path === "scenario.enemies") return "(a Sectoid patrol)";
  return v === undefined ? "" : JSON.stringify(v);
}

/** The whole reference, as Markdown. `origin` is where this server lives (for links). */
export function settingsReference(origin: string): string {
  const d = defaultSettings();
  const guide = budgetGuide(d);
  const enemyRows = enemyTypeChoices().map((t) => {
    const soldier = /^SOLDIER:(\d)$/.exec(t.id);
    if (soldier) return [`\`${t.id}\``, t.name, t.group, "1", "30–60", "50–80", "0 (buy armor via `armor`)", "", "human soldier; better with rank"];
    const u = UNITS.get(t.id)!;
    const a = armorRule(u.armor);
    const kind = t.group === "Tanks" ? "hwp" : "alien";
    const p = priceUnit(kind, u.type, { ...u.stats }, true);
    const traits = p.notes.filter((n) => !/^Large unit|^Armor /.test(n)).join("; ");
    return [`\`${t.id}\``, t.name, t.group, String(a.size > 1 ? 4 : 1), String(u.stats.health), String(u.stats.tu), String(a.front), `$${p.price.toLocaleString("en-US")}`, traits];
  });
  const weaponRows = weaponChoices().filter((w) => w.id.startsWith("STR_")).map((w) => {
    const r = itemRule(w.id);
    const tech = CATALOG.find((c) => c.type === w.id)?.tech ?? "";
    // a gun's damage is its ammunition's
    const power = r.power || (r.compatibleAmmo[0] ? itemRule(r.compatibleAmmo[0]).power : 0);
    return [`\`${w.id}\``, w.name, tech, String(power)];
  });
  const fieldRows = FIELDS.map((f) => [`\`${f.path}\``, f.type + (f.range ? ` (${f.range[0].toLocaleString("en-US")}–${f.range[1].toLocaleString("en-US")})` : ""), f.mode === "ffa" ? "free-for-all" : f.mode === "coop" ? "co-op" : "both", defaultAt(f.path), f.text]);
  const tuning = (Object.keys(BOT_TUNING_DOCS) as (keyof BotTuning)[]).map((k) => {
    const t = BOT_TUNING_DOCS[k];
    return `\`${k}\`${t.range ? ` (${t.range[0]}–${t.range[1]})` : ""}: ${t.text}`;
  });
  const courses = COURSES.map((c) => `${c.name} (${Object.entries(c.gains).map(([k, v]) => `+${v} ${k}`).join(", ")}${c.psionic ? "; needs psionics on" : ""})`);
  return `# Commander Royale: game and match settings reference for AI assistants

Commander Royale hosts multiplayer battles on the original X-COM: UFO Defense battlescape (turn-based squad tactics:
time units, line of fire, destructible terrain, night vision, psionics): free-for-all squad battles, and co-op
scenarios against an enemy force a game master designs. This page tells you everything needed to turn a player's
description of a match into settings for the **New Match** form, and what else the game lets them do.

## How to hand settings back

Give the player **both**:

1. A link that opens the New Match form already filled in (they review it and press Create):
   \`${origin}/?settings=<URL-encoded JSON>\`, for example \`${origin}/?settings=${encodeURIComponent(JSON.stringify({ mode: "ffa", biome: "MARS", timeOfDay: "night" }))}\`
2. The same JSON in a code block, which they can paste into the "Set up a match with AI" box on the New Match form.

Rules:
- **Only include what you want to change.** Anything left out keeps its default; nested objects (\`supplyDrops\`,
  \`coop\`, \`scenario\`, \`scenario.ai\`, each enemy group) can be partial too. Leave out \`mapBlocks\` and the map
  is sized when the battle starts, for however many players are there.
- There is no player limit to set: anyone with the invite link can join, before the battle or while it's on.
- **Custom maps**: players make their own battle maps in the map editor (${origin}/maps), and you can design one
  for them: ${origin}/maps.txt explains the map recipe format. A saved map is played on with \`"map": "<its id>"\`.
- Numbers outside their range are clamped and unknown keys are ignored; the form lists every adjustment it made,
  so if the player pastes back a warning, fix that field.
- Only the player can create the match (they're signed in; you aren't). The JSON is not secret.
- Players can copy their current form ("Copy settings JSON" / "Copy settings link") and ask you to change it.

## Play links

When the player wants to play rather than review a form ("set me up a game against the computer on a map
with..."), give them play links. A play link builds a map from a recipe (if you give one), creates the match, adds
computer opponents, and then either auto-configures the player's squad and starts the battle, or takes them to hire
and equip their squad and starts the battle when they press Ready.

\`${origin}/play?setup=<URL-encoded JSON>\`, where the JSON is

\`\`\`json
{
  "settings": { ... },
  "recipe": { ... },
  "opponents": [ { "strategy": "heavy", "ai": { "aggression": 2 } } ],
  "squad": "auto"
}
\`\`\`

- \`settings\`: match settings exactly as above (partial is fine). Play links always turn on \`autoStart\`.
- \`recipe\` (optional): a map recipe (${origin}/maps.txt). It is built and saved to the player's maps, and the match
  is played on it (it replaces \`settings.map\`). Or leave it out and use \`settings.map\` / a generated map.
- \`opponents\` (free-for-all): the computer squads to fight, each \`{ "strategy", "ai" }\` (both optional: a strategy
  is picked at random, \`ai\` takes the computer squad AI settings below). Left out: one computer squad. \`[]\`: none;
  the player waits in the lobby for friends to join with the invite link (the battle starts once one is ready). In
  co-op the enemy is \`settings.scenario.enemies\`, and the player is on the team (\`scenario.gmPlays\` is turned on).
- \`squad\`: \`"auto"\` hires and equips the strongest squad the budget and seats allow and starts the battle at once;
  \`"equip"\` opens the player's squad to hire and equip, and the battle starts when they press Ready.

Give the player **two links**, the same setup with \`"squad": "auto"\` and with \`"squad": "equip"\`, and say which is
which. Each opens a page describing the setup; nothing is created until the player presses a button there, so the
links are safe to open. In this repo, \`bun tools/match-link.ts --server <address> '<setup JSON>'\` checks a
setup and prints both links.

## The two game modes

- **Free-for-all (\`"mode": "ffa"\`)**: any number of squads (up to ${MAX_SIDES}) fight; last squad standing wins.
  People can join while the battle is on: their squad lands at the map edge, as far from the others as possible,
  and takes its turn after the others each round. Each squad's leader hires and
  equips it from \`budget\` within \`squadLimit\` seats. With \`coop.squadSize\` above 1 several people can share one
  squad (each commands some of its units; they all move at once on its turn). Computer-played squads are added in
  the lobby, or by a play link's \`opponents\` (not through these settings).
- **Co-op scenario (\`"mode": "coop"\`)**: the creator is the game master. Everyone who joins (also once the battle
  is on) is on one team, each hiring and commanding their own units with \`budget\` and \`scenario.seatsPerPlayer\` seats, against an
  enemy force described in \`scenario.enemies\` and played by the computer (\`scenario.ai\`). The team moves first and
  everyone acts at once; the enemy can get reinforcements in later rounds. The creator can play too or just watch
  everything (\`scenario.gmPlays\`).

Both modes share the battlefield settings (environment, time, UFO, map size, tech level, supply drops, timers).

## Everything else players can do (not settings, but worth knowing when advising them)

**The rules** are the original UFO Defense battlescape's, ported faithfully (via OpenXcom): time units, snap / aimed /
auto fire with the original accuracy, voxel line of fire, armor facing, fatal wounds, stun, reaction fire (from any
other side's units that see the mover), explosions that wreck terrain, fire and smoke, doors and UFO doors,
multi-level maps, flying, grenade fuses, proximity grenades, flares, medikits, motion scanner, mind probe, blaster
bomb waypoints. Aliens see in the dark; humans see 9 tiles at night beyond lit areas. Mind control hands a unit to
the attacker until their next turn begins; Chryssalid victims rise as zombies for the Chryssalid's side. Picked-up
gear is usable at once (no research). There are no civilians and no morale or panic.

**Hiring and equipping.** Everyone hires from an identical copy of a random pool (\`poolSize\`): human soldiers from
rookie to commander, every alien race and rank (if \`allowAliens\`), and tanks (if \`allowHWP\`), priced by what they
can do (time units, health × armor, accuracy, reactions, strength, psionics, built-in weapons, flight, night
vision...). Any unit except a tank can carry gear (yes, a Chryssalid with a grenade). Weapons, ammo, explosives,
equipment and armor are bought from the \`budget\` and put on units on the original inventory screen; anything left
unequipped lands at the squad's deployment zone. **Auto-configure squad** hires and kits out a whole squad for the
match, to adjust afterwards; money it can't spend on units and gear goes on training them.

**Training** (human soldiers, while hiring): ${courses.join(", ")}. Up to ${MAX_SESSIONS} sessions per course, never
past the original stat caps, priced at what the better stats are worth ×${TRAINING_PREMIUM} ($${MIN_SESSION_PRICE.toLocaleString("en-US")} a session at
least): a luxury for leftover money, since hiring a better soldier is far cheaper.

**Computer squads** (free-for-all; the creator adds them in the lobby, or a play link's \`opponents\` does): each hires with a
strategy (${STRATEGIES.map((k) => `\`${k}\` ${STRATEGY_NAMES[k]}`).join(", ")}), is always ready, and plays its
turns on the server one action at a time. Each has AI settings (defaults \`${JSON.stringify(DEFAULT_BOT_TUNING)}\`):

${tuning.map((t) => `- ${t}`).join("\n")}

For "a few of us against one strong computer squad", suggest free-for-all with \`coop.squadSize\` set to their number
(so they share one squad) and a computer squad with a higher strength (a play link's \`opponents\`, or added in the
lobby), or co-op mode, where the settings describe the whole enemy force.

**During a battle.** Turns are asynchronous unless \`turnTimer\` is set: close the tab and come back later. In a squad
played by several people (and the co-op team) everyone moves at once, each on their own units; End Turn locks you in,
G hands the selected unit to a teammate, Options → AFK lets the AI play your units, and the host gets an "AI: play
this turn for ..." button whenever a turn is waiting on someone. People can join while the battle is on (the invite
link still works): they hire, equip and press Deploy, landing in a new zone at the map edge (or with the co-op team).
The move preview shows how exposed the destination is (share of sightlines, kneeling, enemies with a line of fire).
Music and sound effects can be switched off in Options.

**Afterwards.** Every battle keeps its starting point. **Retry** plays the same start again with fresh dice (you play
your squad, the AI plays everyone else); **Share as challenge** makes a link (\`/c/<id>\`) where anyone can play your
squad from that start against the AI, with every go ranked. A battle can't be retried or shared while other people
are still fighting it. Every finished match keeps a statistics record (hires, gear, kills, accuracy...).

## Settings

${md([["setting", "type (range)", "mode", "default", "what it does"], ...fieldRows])}

## Enemy groups (co-op)

Each entry of \`scenario.enemies\` is \`{ "type", "count", "weapon", "grenades", "armor", "placement", "round" }\`
(only \`type\` is really needed: count 1, standard weapon, no grenades, placement "edge", round 1).
Think of the team's strength when sizing the force: a soldier hired for ~$15–25k plus a ~$7k rifle kit roughly
matches one mid-rank alien; the "rough value" column below is what that unit would cost a player to hire.

### Enemy unit ids

Seats: 4 = large unit (2x2 tiles). HP/TU/front armor are base stats (individuals vary ±10%).

${md([["id", "name", "group", "seats", "HP", "TU", "front armor", "rough value", "traits"], ...enemyRows])}

### Weapon ids (for \`weapon\`)

"standard" picks by rank and tech level; "none" leaves them unarmed (psionics and built-in attacks still work).

${md([["id", "name", "tech level", "damage"], ...weaponRows])}

## Budget rules of thumb

${guide.examples.map((x) => `- ${x}`).join("\n")}
- ${guide.prices.join(" ")}
- Auto map size: free-for-all ${[2, 4, 6, 8].map((n) => `${n} squads → ${recommendedMapBlocks(n, d.budget)}`).join(", ")} blocks (+1 at $1,000,000+). Co-op: from the total units, e.g. the default scenario with 4 people → ${recommendedScenarioBlocks({ ...d, mode: "coop" }, 4)}.

## Examples

${EXAMPLES.map((e) => `**"${e.ask}"**\n\n\`\`\`json\n${JSON.stringify(e.settings, null, 2)}\n\`\`\`\n\nLink: ${origin}/?settings=${encodeURIComponent(JSON.stringify(e.settings))}`).join("\n\n")}

### Play link examples

${PLAY_EXAMPLES.map((e) => {
  const links = playLinks(origin, e.setup);
  return `**"${e.ask}"**\n\n\`\`\`json\n${JSON.stringify(e.setup, null, 2)}\n\`\`\`\n\nAuto-configured squad, battle starts at once: ${links.auto}\n\nPlayer equips the squad first: ${links.equip}`;
}).join("\n\n")}

## Defaults (everything you leave out)

\`\`\`json
${JSON.stringify(d, null, 2)}
\`\`\`
`;
}

/**
 * What a (possibly partial, possibly wrong) settings object becomes, and what had to change on the way: clamped
 * numbers, unknown values, ignored keys, settings that don't apply to the chosen mode.
 */
export function checkSettings(raw: unknown): { settings: MatchSettings; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { settings: defaultSettings(), warnings: ["Settings must be a JSON object: using the defaults"] };
  }
  const settings = sanitizeSettings(raw as Partial<MatchSettings>);
  const r = raw as Record<string, unknown>;
  const groups = (r.scenario as { enemies?: unknown } | undefined)?.enemies;
  // an enemy force with nobody there from round 1 is swapped for the default one (said once, below)
  const replaced = Array.isArray(groups) && !groups.some((g) => (Number((g as { round?: unknown })?.round) || 1) <= 1);
  const same = (a: unknown, b: unknown) => a === b || (typeof b === "number" && a !== "" && a !== null && Number(a) === b) || (typeof b === "string" && typeof a === "string" && a.trim() === b);
  const walk = (given: unknown, got: unknown, path: string) => {
    if (Array.isArray(given)) {
      if (!Array.isArray(got)) return warnings.push(`${path}: ignored`);
      if (given.length > got.length) warnings.push(`${path}: only the first ${got.length} entries are used`);
      given.slice(0, got.length).forEach((v, i) => walk(v, got[i], `${path}[${i}]`));
      return;
    }
    if (given && typeof given === "object") {
      if (!got || typeof got !== "object") return warnings.push(`${path}: ignored`);
      for (const [k, v] of Object.entries(given)) {
        const p = path ? `${path}.${k}` : k;
        if (k === "unitsPerPlayer" && path === "scenario") continue; // the old name of seatsPerPlayer
        if (p === "scenario.enemies" && replaced) continue;
        if (!(k in (got as object))) warnings.push(`${p}: not a setting (ignored)`);
        else walk(v, (got as Record<string, unknown>)[k], p);
      }
      return;
    }
    if (!same(given, got)) warnings.push(`${path}: ${JSON.stringify(given)} isn't allowed here, using ${JSON.stringify(got)}`);
  };
  walk(r, settings, "");
  if (replaced) warnings.push("scenario.enemies: no group arrives in round 1, so the default enemy force is used instead");
  const types = new Set(enemyTypeChoices().map((t) => t.id));
  const weapons = new Set(weaponChoices().map((w) => w.id));
  // the settings handed back are what will really happen: unknown units left out, unknown weapons made standard
  settings.scenario.enemies.forEach((g, i) => {
    if (!types.has(g.type)) warnings.push(`scenario.enemies[${i}].type: no such unit "${g.type}" (see the enemy unit ids): that group was left out`);
    if (!weapons.has(g.weapon)) {
      warnings.push(`scenario.enemies[${i}].weapon: no such weapon "${g.weapon}" (see the weapon ids): using "standard"`);
      g.weapon = "standard";
    }
  });
  const known = settings.scenario.enemies.filter((g) => types.has(g.type));
  if (known.length !== settings.scenario.enemies.length) {
    if (known.some((g) => g.round <= 1)) settings.scenario.enemies = known;
    else {
      settings.scenario.enemies = defaultSettings().scenario.enemies;
      warnings.push("scenario.enemies: nothing valid left on the map from round 1, so the default enemy force is used instead");
    }
  }
  if (settings.mode === "ffa" && r.scenario !== undefined) warnings.push("scenario: only used in co-op mode (\"mode\": \"coop\")");
  if (settings.mode === "coop" && r.squadLimit !== undefined) warnings.push("squadLimit: co-op uses scenario.seatsPerPlayer instead");
  // a custom map has its own UFO (or not): `ufo` doesn't apply
  if (settings.mode === "coop" && !settings.map && settings.ufo === "none" && settings.scenario.enemies.some((g) => g.placement === "ufo")) {
    warnings.push("scenario.enemies: \"ufo\" placement without a landed UFO: those enemies start in the middle of the map");
  }
  return { settings, warnings: [...new Set(warnings)] };
}

/** Reads settings from a `?settings=` link value or pasted text (JSON, possibly inside a code block or a link). */
export function parseSettingsText(text: string): unknown {
  let t = text.trim();
  const link = /[?&]settings=([^&\s]+)/.exec(t);
  if (link) t = decodeURIComponent(link[1]);
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1];
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("No settings found: paste the JSON (or the link) your assistant gave you");
  return JSON.parse(t.slice(start, end + 1));
}

export { tr };

/** A play link's setup (/play?setup=<json>): the match settings, an optional map recipe, opponents, and the squad. */
export interface PlaySetup {
  settings: MatchSettings;
  /** a map recipe (shared/maps/recipe.ts) to build and play on, or null */
  recipe: Record<string, unknown> | null;
  /** free-for-all computer squads; strategy null = picked at random */
  opponents: { strategy: Strategy | null; ai: BotTuning }[];
  /** "auto": auto-configure the player's squad and start; "equip": they hire and equip it, then Ready starts */
  squad: "auto" | "equip";
}

const SETUP_KEYS = ["settings", "recipe", "opponents", "squad"];

/** What a (possibly partial, possibly wrong) play setup becomes, and what had to change on the way. */
export function checkSetup(raw: unknown): { setup: PlaySetup; warnings: string[] } {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const warnings: string[] = [];
  if (r !== raw) warnings.push("A setup must be a JSON object: using the defaults");
  for (const k of Object.keys(r)) if (!SETUP_KEYS.includes(k)) warnings.push(`${k}: not part of a setup (ignored; match settings go in "settings")`);
  const checked = checkSettings(r.settings ?? {});
  warnings.push(...checked.warnings.map((w) => `settings.${w}`));
  const settings = checked.settings;
  settings.autoStart = true;
  let recipe: Record<string, unknown> | null = null;
  if (r.recipe !== undefined && r.recipe !== null) {
    if (typeof r.recipe !== "object" || Array.isArray(r.recipe)) warnings.push("recipe: must be a map recipe object (ignored)");
    else {
      recipe = r.recipe as Record<string, unknown>;
      if (settings.map) warnings.push("settings.map: the recipe's map is played instead");
      settings.map = "";
      // the recipe's map decides whether there's a UFO to start at, not `ufo`
      const crashed = (recipe.base === "generated" && recipe.ufo && recipe.ufo !== "none") || (Array.isArray(recipe.ops) && recipe.ops.some((o) => (o as { op?: unknown })?.op === "ufo"));
      const noUfo = (w: string) => w.includes("\"ufo\" placement without a landed UFO");
      for (let i = warnings.length - 1; i >= 0; i--) if (noUfo(warnings[i])) warnings.splice(i, 1);
      if (!crashed && settings.mode === "coop" && settings.scenario.enemies.some((g) => g.placement === "ufo")) warnings.push("settings.scenario.enemies: \"ufo\" placement, but the recipe's map has no UFO: those enemies start in the middle of the map");
    }
  }
  if (settings.mode === "coop" && !settings.scenario.gmPlays) {
    // said only when the setup asked for a game master who just watches (the default is to play too)
    if ((r.settings as { scenario?: { gmPlays?: unknown } } | undefined)?.scenario?.gmPlays === false) warnings.push("settings.scenario.gmPlays: a play link puts the player on the team, so it's turned on");
    settings.scenario.gmPlays = true;
  }
  let opponents: PlaySetup["opponents"] = [];
  if (settings.mode === "coop") {
    if (r.opponents !== undefined) warnings.push("opponents: only used in free-for-all (co-op enemies are settings.scenario.enemies)");
  } else if (r.opponents === undefined) {
    opponents = [{ strategy: null, ai: { ...DEFAULT_BOT_TUNING } }];
  } else if (!Array.isArray(r.opponents)) {
    warnings.push("opponents: must be a list of computer squads (using one)");
    opponents = [{ strategy: null, ai: { ...DEFAULT_BOT_TUNING } }];
  } else {
    const list = r.opponents.slice(0, MAX_SIDES - 1);
    if (r.opponents.length > list.length) warnings.push(`opponents: at most ${MAX_SIDES - 1} (the rest are left out)`);
    opponents = list.map((o, i) => {
      const x = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
      for (const k of Object.keys(x)) if (k !== "strategy" && k !== "ai") warnings.push(`opponents[${i}].${k}: not an opponent option (ignored)`);
      let strategy: Strategy | null = null;
      if (x.strategy !== undefined && x.strategy !== null) {
        if (STRATEGIES.includes(x.strategy as Strategy)) strategy = x.strategy as Strategy;
        else warnings.push(`opponents[${i}].strategy: no such strategy "${String(x.strategy)}" (one of ${STRATEGIES.join(", ")}): picked at random`);
      }
      const ai = sanitizeBotTuning(x.ai);
      if (x.ai !== undefined) {
        const given = (x.ai && typeof x.ai === "object" ? x.ai : {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries(given)) {
          if (!(k in ai)) warnings.push(`opponents[${i}].ai.${k}: not an AI setting (ignored)`);
          else if (JSON.stringify(v) !== JSON.stringify(ai[k as keyof BotTuning])) warnings.push(`opponents[${i}].ai.${k}: ${JSON.stringify(v)} isn't allowed here, using ${JSON.stringify(ai[k as keyof BotTuning])}`);
        }
      }
      return { strategy, ai };
    });
  }
  let squad: PlaySetup["squad"] = "auto";
  if (r.squad === "equip") squad = "equip";
  else if (r.squad !== undefined && r.squad !== "auto") warnings.push(`squad: "auto" or "equip", not ${JSON.stringify(r.squad)} (using "auto")`);
  return { setup: { settings, recipe, opponents, squad }, warnings: [...new Set(warnings)] };
}

/** Whether pasted JSON is a play setup rather than bare match settings. */
export function isSetup(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).some((k) => SETUP_KEYS.includes(k)) && !("mode" in raw);
}

/** Reads a setup from a `?setup=` link value or pasted text (JSON, possibly inside a code block or a link). */
export function parseSetupText(text: string): unknown {
  const link = /[?&]setup=([^&\s]+)/.exec(text.trim());
  return parseSettingsText(link ? decodeURIComponent(link[1]) : text);
}

/** The two play links for a setup (as given: the page checks it again), one per way of getting a squad. */
export function playLinks(origin: string, setup: Record<string, unknown>): { auto: string; equip: string } {
  const link = (squad: string) => `${origin}/play?setup=${encodeURIComponent(JSON.stringify({ ...setup, squad }))}`;
  return { auto: link("auto"), equip: link("equip") };
}

/** A setup made short for a link: settings and opponents only where they differ from the defaults. */
export function setupDelta(s: PlaySetup): Record<string, unknown> {
  const settings = settingsDelta(s.settings);
  // play links always auto-start; saying so again only adds noise
  delete settings.autoStart;
  if (s.recipe) delete settings.map;
  const out: Record<string, unknown> = { settings };
  if (s.recipe) out.recipe = s.recipe;
  if (s.settings.mode === "ffa") {
    out.opponents = s.opponents.map((o) => {
      const ai = Object.fromEntries(Object.entries(o.ai).filter(([k, v]) => DEFAULT_BOT_TUNING[k as keyof BotTuning] !== v));
      return { ...(o.strategy ? { strategy: o.strategy } : {}), ...(Object.keys(ai).length ? { ai } : {}) };
    });
  }
  out.squad = s.squad;
  return out;
}

/** Only what differs from the defaults (for "copy settings" and links: short, and shows what was chosen). */
export function settingsDelta(s: MatchSettings): Record<string, unknown> {
  const diff = (a: unknown, d: unknown): unknown => {
    if (a && typeof a === "object" && !Array.isArray(a) && d && typeof d === "object" && !Array.isArray(d)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a)) {
        const x = diff(v, (d as Record<string, unknown>)[k]);
        if (x !== undefined) out[k] = x;
      }
      return Object.keys(out).length ? out : undefined;
    }
    return JSON.stringify(a) === JSON.stringify(d) ? undefined : a;
  };
  // compared with what the same mode defaults to (co-op teams default to 4 people, free-for-all to 2 squads)
  const out = (diff(s, sanitizeSettings({ mode: s.mode })) ?? {}) as Record<string, unknown>;
  // the mode always goes along, so the result reads clearly on its own
  return { mode: s.mode, ...out };
}
