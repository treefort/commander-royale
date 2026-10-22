// Match settings for AI assistants: a plain-text reference (served as /llms.txt) generated from the real rules
// and data, so it can't drift from the code, and a checker that says what a settings object would turn into.
// Players point their assistant at the reference, describe the match they want, and get back a link
// (/?settings=<json>) or JSON to paste into the New Match form.
import {
  BIOMES, UFO_CHOICES, PLACEMENTS, MAX_SQUAD_SIZE, MAX_COOP_PLAYERS, DEFAULT_BOT_TUNING, defaultSettings, sanitizeSettings,
  recommendedMapBlocks, recommendedScenarioBlocks, type MatchSettings,
} from "./protocol.ts";
import { UNITS, armorRule, itemRule, tr } from "./rules/index.ts";
import { CATALOG, priceUnit, budgetGuide } from "./rules/catalog.ts";
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
  { path: "mode", type: list(["ffa", "coop"]), text: "\"ffa\": free-for-all, squads fight each other and the last squad standing wins. \"coop\": a scenario — everyone who joins plays on ONE team against an enemy force the creator (the game master) defines in `scenario`." },
  { path: "name", type: "string, up to 40 characters", text: "Shown in the match list and lobby." },
  { path: "notes", type: "string, up to 1000 characters", text: "A message from the creator to everyone who joins (house rules, schedule, the story of the mission...)." },
  { path: "maxPlayers", type: "integer", range: [1, MAX_COOP_PLAYERS], text: `Free-for-all: number of squads, 2–8 (values below 2 become 2). Co-op: number of people on the team, 1–${MAX_COOP_PLAYERS} (a game master who only watches doesn't count). Default 2 squads / 4 people.` },
  { path: "biome", type: list(["RANDOM", ...BIOMES.map((b) => b.id)]), text: `Environment: ${BIOMES.map((b) => `${b.id} = ${b.name}`).join(", ")}. RANDOM is rolled when the battle starts.` },
  { path: "timeOfDay", type: list(["day", "dusk", "night", "random"]), text: "At night humans see 9 tiles except in lit areas (flares, fire); aliens see in the dark. Dusk is in between." },
  { path: "ufo", type: list(UFO_CHOICES.map((u) => u.id)), text: `A landed UFO in the middle of the map (cover, a building to fight over; co-op enemies can start inside it): ${UFO_CHOICES.filter((u) => u.id.startsWith("STR")).map((u) => `${u.id} = ${u.name}`).join(", ")}.` },
  { path: "mapBlocks", type: "integer", range: [4, 10], text: "Map edge in 10-tile blocks (5 = 50x50 tiles). Leave it out and the form picks a size for the player count / number of units (free-for-all: 5 for 2 squads, 6 for 3–4, 7 for 5–6, 8 for 7–8, +1 at $1,000,000+; co-op: from the total units on the field)." },
  { path: "budget", type: "integer (dollars)", range: [50_000, 5_000_000], text: "What each player (free-for-all: each squad's leader; co-op: each person) spends on hiring units, weapons and armor. See \"Budget rules of thumb\" below." },
  { path: "squadLimit", type: "integer (seats)", range: [1, 30], mode: "ffa", text: "Free-for-all squad size in Skyranger seats: soldiers and small aliens take 1, tanks and large aliens (Cyberdisc, Reaper, Sectopod) take 4. The original Skyranger holds 14." },
  { path: "poolSize", type: "integer", range: [10, 80], text: "How many recruits are in the hiring pool (everyone hires from an identical copy)." },
  { path: "techLevel", type: list(["conventional", "laser", "alien"]), text: "What can be bought (conventional: rifles, cannons, rockets; laser: plus lasers; alien: everything incl. plasma, blaster launchers, psi-amps) — and what co-op enemies with the \"standard\" weapon carry." },
  { path: "allowAliens", type: "boolean", text: "Alien recruits in the hiring pool (players can hire Sectoids, Mutons, Chryssalids...)." },
  { path: "allowHWP", type: "boolean", text: "Tanks (HWPs) in the hiring pool." },
  { path: "allowArmor", type: "boolean", text: "Players may buy armor (personal armor, power suit, flying suit)." },
  { path: "psionics", type: "boolean", text: "Psionics and mind control (psi-amps, Sectoid/Ethereal psi attacks)." },
  { path: "supplyDrops.enabled", type: "boolean", text: "Crates of loot that land on the map now and then; their position and countdown are announced to everyone." },
  { path: "supplyDrops.everyRounds", type: "integer", range: [1, 20], text: "Rounds between drops." },
  { path: "supplyDrops.warningRounds", type: "integer", range: [0, 10], text: "How many rounds ahead each drop is announced." },
  { path: "supplyDrops.tier", type: list(["basic", "advanced", "alien", "mixed"]), text: "basic: rifles, grenades, medikits; advanced: cannons, lasers, scanners; alien: plasma, blasters, psi; mixed: weighted random." },
  { path: "turnTimer", type: "integer (seconds)", range: [0, 3600], text: "Time limit per turn; 0 = none (play asynchronously: come back whenever). Needed by coop.turnEnd = \"timer\"." },
  { path: "coop.squadSize", type: "integer", range: [1, MAX_SQUAD_SIZE], mode: "ffa", text: "Free-for-all only: people per squad. 1 = everyone fields their own. Above 1, people can join someone else's squad; the squad's units are shared out and everyone in it moves at the same time on its turn." },
  { path: "coop.turnEnd", type: list(["lockin", "timer", "daily"]), text: "When a squad played by several people (or the co-op team) ends its turn: \"lockin\" once everyone has pressed End Turn (the default — players set the pace); \"timer\" only when turnTimer runs out (needs turnTimer > 0); \"daily\" (co-op mode only) at coop.dailyAt every day, or earlier once everyone has locked in." },
  { path: "coop.dailyAt", type: "\"HH:MM\" (24-hour)", text: "With turnEnd \"daily\": the time of day the team's turn ends. A turn that starts less than an hour before it runs to the next day's." },
  { path: "coop.timeZone", type: "IANA time zone, e.g. \"America/New_York\"", text: "Time zone for coop.dailyAt (the form fills in the creator's own)." },
  { path: "coop.afkAI", type: "boolean", text: "The computer plays the units of anyone offline for 30+ seconds until they're back. Off: offline players' units just stay put (anyone can also hand their units to the AI from the in-game options)." },
  { path: "scenario.teamName", type: "string, up to 30 characters", mode: "coop", text: "The players' side." },
  { path: "scenario.enemyName", type: "string, up to 30 characters", mode: "coop", text: "The enemy's side." },
  { path: "scenario.seatsPerPlayer", type: "integer (seats)", range: [1, 30], mode: "coop", text: "Skyranger seats each person fills with units they hire and command: soldiers and small aliens take 1, tanks and large aliens 4 (4 seats = 4 soldiers or 1 tank)." },
  { path: "scenario.teamStart", type: list(["together", "apart"]), mode: "coop", text: "\"together\": the whole team lands in one zone. \"apart\": each person lands in their own zone around the map edge, like squads in a free-for-all." },
  { path: "scenario.gmPlays", type: "boolean", mode: "coop", text: "true: the creator hires units and plays on the team. false: the creator is only the game master — hires nothing, can't give orders, and watches the whole battle (every unit, both sides)." },
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

/** Natural-language requests and the settings that answer them (checked by tests: no warnings). */
export const EXAMPLES: { ask: string; settings: Record<string, unknown> }[] = [
  {
    ask: "A quick 1v1 in a city at night, small squads, no aliens for hire, a 2-minute turn timer.",
    settings: { mode: "ffa", name: "Night in the City", maxPlayers: 2, biome: "URBAN", timeOfDay: "night", budget: 200000, squadLimit: 8, allowAliens: false, turnTimer: 120 },
  },
  {
    ask: "Three of us against the crew of a downed Sectoid scout in farmland, with Floater reinforcements later. We each want 4 soldiers, landing apart. Turns end at 8pm Eastern every day.",
    settings: {
      mode: "coop", name: "Crash Site", maxPlayers: 3, biome: "CULTA", timeOfDay: "day", ufo: "STR_SMALL_SCOUT", budget: 250000, techLevel: "laser",
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
      mode: "coop", name: "Terror Site", maxPlayers: 6, biome: "URBAN", timeOfDay: "dusk", budget: 150000, supplyDrops: { tier: "basic" },
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
      mode: "coop", name: "Cydonia", maxPlayers: 2, biome: "MARS", timeOfDay: "night", budget: 1500000, techLevel: "alien",
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
  return `# X-COM Battlescape — match settings reference for AI assistants

This server hosts multiplayer battles on the original X-COM: UFO Defense battlescape (turn-based squad tactics:
time units, line of fire, destructible terrain, night vision, psionics). This page tells you everything needed to
turn a player's description of a match into settings for the **New Match** form.

## How to hand settings back

Give the player **both**:

1. A link that opens the New Match form already filled in (they review it and press Create):
   \`${origin}/?settings=<URL-encoded JSON>\` — e.g. \`${origin}/?settings=${encodeURIComponent(JSON.stringify({ mode: "ffa", biome: "MARS", timeOfDay: "night" }))}\`
2. The same JSON in a code block, which they can paste into the "Set up a match with AI" box on the New Match form.

Rules:
- **Only include what you want to change.** Anything left out keeps its default; nested objects (\`supplyDrops\`,
  \`coop\`, \`scenario\`, \`scenario.ai\`, each enemy group) can be partial too. Leave out \`mapBlocks\` and the form
  picks a good map size.
- Numbers outside their range are clamped and unknown keys are ignored; the form lists every adjustment it made,
  so if the player pastes back a warning, fix that field.
- Only the player can create the match (they're signed in; you aren't). The JSON is not secret.
- Players can copy their current form ("Copy settings JSON" / "Copy settings link") and ask you to change it.

## The two game modes

- **Free-for-all (\`"mode": "ffa"\`)**: 2–8 squads fight; last squad standing wins. Each squad's leader hires and
  equips it from \`budget\` within \`squadLimit\` seats. With \`coop.squadSize\` above 1 several people can share one
  squad (each commands some of its units; they all move at once on its turn). Computer-played squads can be added in
  the lobby (not through these settings).
- **Co-op scenario (\`"mode": "coop"\`)**: the creator is the game master. Up to ${MAX_COOP_PLAYERS} people form one
  team — each hires and commands their own units with \`budget\` and \`scenario.seatsPerPlayer\` seats — against an
  enemy force described in \`scenario.enemies\` and played by the computer (\`scenario.ai\`). The team moves first and
  everyone acts at once; the enemy can get reinforcements in later rounds. The creator can play too or just watch
  everything (\`scenario.gmPlays\`).

Both modes share the battlefield settings (environment, time, UFO, map size, tech level, supply drops, timers).

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
- Free-for-all map size recommendation: ${[2, 4, 6, 8].map((n) => `${n} squads → ${recommendedMapBlocks(n, d.budget)}`).join(", ")} blocks (+1 at $1,000,000+). Co-op: from the total units, e.g. the default scenario → ${recommendedScenarioBlocks({ ...d, mode: "coop" })}.

## Examples

${EXAMPLES.map((e) => `**"${e.ask}"**\n\n\`\`\`json\n${JSON.stringify(e.settings, null, 2)}\n\`\`\`\n\nLink: ${origin}/?settings=${encodeURIComponent(JSON.stringify(e.settings))}`).join("\n\n")}

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
  if (settings.mode === "coop" && settings.ufo === "none" && settings.scenario.enemies.some((g) => g.placement === "ufo")) {
    warnings.push("scenario.enemies: \"ufo\" placement without a landed UFO — those enemies start in the middle of the map");
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
