// Types shared by server and client: match settings, lobby state, and battle messages.

export type Biome = "URBAN" | "CULTA" | "FOREST" | "JUNGLE" | "DESERT" | "MOUNT" | "POLAR" | "MARS" | "UBASE";
export type TimeOfDay = "day" | "dusk" | "night";
export type TechLevel = "conventional" | "laser" | "alien";
export type LootTier = "basic" | "advanced" | "alien" | "mixed";

/** "ffa": squads fight each other; "coop": everyone on one team against a force the creator sets up. */
export type GameMode = "ffa" | "coop";

export interface MatchSettings {
  mode: GameMode;
  name: string;
  /** optional message from the creator, shown to everyone in the lobby (house rules, schedule...) */
  notes: string;
  biome: Biome | "RANDOM"; // RANDOM is decided when the battle starts
  /** set when a "Random" environment was rolled at the start, so reusing these settings rolls again */
  randomBiome?: boolean;
  timeOfDay: TimeOfDay | "random"; // random is decided when the battle starts
  /** set when a "random" time of day was rolled at the start, so reusing these settings rolls again */
  randomTime?: boolean;
  ufo: string; // "none" | "random" | ufo type
  /** map edge length in 10-tile blocks; 0 = auto, sized when the battle starts for whoever is there */
  mapBlocks: number;
  /** set when an auto map size was decided at the start, so reusing these settings sizes it again */
  autoMap?: boolean;
  budget: number;
  squadLimit: number; // seats; large units take 4
  poolSize: number;
  techLevel: TechLevel;
  allowAliens: boolean;
  allowHWP: boolean;
  allowArmor: boolean;
  psionics: boolean;
  /** `kits`: how much each drop holds (a kit is e.g. a rifle and two clips, a pair of grenades, a medikit) */
  supplyDrops: { enabled: boolean; everyRounds: number; warningRounds: number; tier: LootTier; kits: number };
  turnTimer: number; // seconds per turn, 0 = unlimited
  /**
   * the Mysterious Stranger (as in Fallout): % chance that, when a unit attacks an enemy it can see and the
   * enemy survives, a stranger with a magnum appears beside the attacker, shoots the enemy and vanishes; 0 = off
   */
  stranger: number;
  coop: CoopSettings;
  /** co-op scenario mode: the creator's setup of the team and the enemy */
  scenario: Scenario;
}

/** Several people sharing one squad: each controls some of its units, and they all act at once on its turn. */
export interface CoopSettings {
  /** people per squad (1 = everyone fields their own squad) */
  squadSize: number;
  /**
   * when a shared squad's turn ends: once every member has locked in; only when the turn timer runs out; or
   * (co-op scenarios) at `dailyAt` every day, or earlier if everyone has locked in
   */
  turnEnd: "lockin" | "timer" | "daily";
  /** "HH:MM" in `timeZone` (the creator's) */
  dailyAt: string;
  timeZone: string;
  /** the AI plays the units of people who have been offline for a while (anyone can also go AFK by hand) */
  afkAI: boolean;
}

export const MAX_SQUAD_SIZE = 10;
/**
 * No setting caps how many squads play (people can join a battle in progress), but battle events carry a 32-bit
 * mask of the sides that may see them: this many sides at most.
 */
export const MAX_SIDES = 30;

export type Placement = "edge" | "ufo" | "center" | "spread";

/** A group of identical enemies in a co-op scenario; groups arriving after round 1 are reinforcements. */
export interface EnemyGroup {
  /** a unit rule type (alien race/rank, terror unit, tank) or "SOLDIER:<0-5>" for human soldiers of a rank */
  type: string;
  count: number;
  /** "standard" (by rank and tech level), "none", or a weapon item type */
  weapon: string;
  grenades: number;
  /** soldiers only */
  armor: string;
  placement: Placement;
  /** the round it arrives (1 = there from the start) */
  round: number;
}

export interface Scenario {
  /** the players' side */
  teamName: string;
  enemyName: string;
  /** Skyranger seats each person may fill and command (soldiers and small aliens take 1, tanks and large aliens 4) */
  seatsPerPlayer: number;
  /** "together": the whole team lands in one zone; "apart": each person's units land in their own, like squads in a free-for-all */
  teamStart: "together" | "apart";
  /** the creator hires units and plays too; otherwise they run the game and watch everything */
  gmPlays: boolean;
  enemies: EnemyGroup[];
  /** how the enemy plays (strength is unused: the groups say what it fields) */
  ai: BotTuning;
}

export const PLACEMENTS: { id: Placement; name: string }[] = [
  { id: "edge", name: "Far side" },
  { id: "ufo", name: "At the UFO" },
  { id: "center", name: "Middle" },
  { id: "spread", name: "Scattered" },
];

export function defaultScenario(): Scenario {
  return {
    teamName: "X-COM",
    enemyName: "Aliens",
    seatsPerPlayer: 4,
    teamStart: "together",
    gmPlays: true,
    enemies: [
      { type: "STR_SECTOID_SOLDIER", count: 6, weapon: "standard", grenades: 0, armor: "STR_NONE_UC", placement: "edge", round: 1 },
      { type: "STR_SECTOID_LEADER", count: 1, weapon: "standard", grenades: 1, armor: "STR_NONE_UC", placement: "edge", round: 1 },
      { type: "STR_CYBERDISC_TERRORIST", count: 1, weapon: "standard", grenades: 0, armor: "STR_NONE_UC", placement: "spread", round: 4 },
    ],
    ai: { ...DEFAULT_BOT_TUNING },
  };
}

function sanitizeScenario(raw: unknown): Scenario {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<Scenario>;
  const d = defaultScenario();
  const clamp = (v: unknown, lo: number, hi: number, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
  };
  const str = (v: unknown, def: string, max = 30) => String(v ?? def).slice(0, max).trim() || def;
  const groups = Array.isArray(s.enemies) ? s.enemies : d.enemies;
  const enemies: EnemyGroup[] = groups.filter((g) => g && typeof g === "object").slice(0, 20).map((g) => ({
    type: /^(STR_[A-Z_]+|SOLDIER:[0-5])$/.test(String(g.type)) ? String(g.type) : "STR_SECTOID_SOLDIER",
    count: clamp(g.count, 1, 40, 1),
    weapon: /^(standard|none|STR_[A-Z_]+)$/.test(String(g.weapon)) ? String(g.weapon) : "standard",
    grenades: clamp(g.grenades, 0, 6, 0),
    armor: /^STR_[A-Z_]+$/.test(String(g.armor)) ? String(g.armor) : "STR_NONE_UC",
    placement: PLACEMENTS.some((p) => p.id === g.placement) ? g.placement : "edge",
    round: clamp(g.round, 1, 99, 1),
  }));
  return {
    teamName: str(s.teamName, d.teamName),
    enemyName: str(s.enemyName, d.enemyName),
    // "unitsPerPlayer" was the first version of this setting
    seatsPerPlayer: clamp(s.seatsPerPlayer ?? (s as { unitsPerPlayer?: number }).unitsPerPlayer, 1, 30, d.seatsPerPlayer),
    teamStart: s.teamStart === "apart" ? "apart" : "together",
    gmPlays: s.gmPlays === undefined ? d.gmPlays : !!s.gmPlays,
    // the enemy needs someone there from the start
    enemies: enemies.some((g) => g.round === 1) ? enemies : d.enemies,
    ai: sanitizeBotTuning(s.ai),
  };
}

function validTimeZone(tz: unknown): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: String(tz) });
    return String(tz);
  } catch {
    return "UTC";
  }
}

/** The ms offset of `timeZone`'s wall clock from UTC at instant `t`. */
function zoneOffset(t: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(t));
  const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(t / 1000) * 1000;
}

/** A turn that starts less than this before the daily time runs until the next day's instead. */
export const DAILY_MIN_TURN_MS = 60 * 60 * 1000;

/** The next time it's `at` ("HH:MM") in `timeZone`, at least DAILY_MIN_TURN_MS after `now`. */
export function nextDailyDeadline(now: number, at: string, timeZone: string): number {
  const [h, m] = at.split(":").map(Number);
  const wallNow = new Date(now + zoneOffset(now, timeZone));
  for (let day = 0; day < 3; day++) {
    const wall = Date.UTC(wallNow.getUTCFullYear(), wallNow.getUTCMonth(), wallNow.getUTCDate() + day, h, m);
    // the offset at the deadline itself (daylight saving may differ from now's)
    let t = wall - zoneOffset(wall, timeZone);
    t = wall - zoneOffset(t, timeZone);
    if (t >= now + DAILY_MIN_TURN_MS) return t;
  }
  return now + 24 * 3600 * 1000;
}

/** How a computer squad plays (the lobby's "AI settings"), mapped onto the AI's options on the server. */
export interface BotTuning {
  /** 0 cautious (aimed shots, retreats) .. 3 reckless (snap shots, charges) */
  aggression: number;
  /** rounds it remembers where it last saw an enemy */
  intelligence: number;
  /** 0..4: how keen it is on grenades and other explosives */
  difficulty: number;
  /** after this round it knows where every enemy is */
  cheatTurn: number;
  /** each race plays with its own temperament (Sectoids cautious, Chryssalids reckless...) */
  personalities: boolean;
  /** budget and seats, as a percentage of the match's (handicap the enemy for co-op games) */
  strength: number;
}

export const DEFAULT_BOT_TUNING: BotTuning = { aggression: 1, intelligence: 4, difficulty: 4, cheatTurn: 20, personalities: false, strength: 100 };

export function sanitizeBotTuning(raw: unknown): BotTuning {
  const t = (raw && typeof raw === "object" ? raw : {}) as Partial<BotTuning>;
  const d = DEFAULT_BOT_TUNING;
  const clamp = (v: unknown, lo: number, hi: number, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
  };
  return {
    aggression: clamp(t.aggression, 0, 3, d.aggression),
    intelligence: clamp(t.intelligence, 1, 10, d.intelligence),
    difficulty: clamp(t.difficulty, 0, 4, d.difficulty),
    cheatTurn: clamp(t.cheatTurn, 1, 99, d.cheatTurn),
    personalities: t.personalities === undefined ? d.personalities : !!t.personalities,
    strength: clamp(t.strength, 25, 400, d.strength),
  };
}

export const BIOMES: { id: Biome; name: string; levels: number }[] = [
  { id: "URBAN", name: "Urban (Terror Site)", levels: 4 },
  { id: "CULTA", name: "Farmland", levels: 4 },
  { id: "FOREST", name: "Forest", levels: 4 },
  { id: "JUNGLE", name: "Jungle", levels: 4 },
  { id: "DESERT", name: "Desert", levels: 4 },
  { id: "MOUNT", name: "Mountains", levels: 4 },
  { id: "POLAR", name: "Polar", levels: 4 },
  { id: "MARS", name: "Mars (Cydonia)", levels: 4 },
  { id: "UBASE", name: "Alien Base", levels: 4 },
];

export const UFO_CHOICES = [
  { id: "none", name: "None" },
  { id: "random", name: "Random" },
  { id: "STR_SMALL_SCOUT", name: "Small Scout" },
  { id: "STR_MEDIUM_SCOUT", name: "Medium Scout" },
  { id: "STR_LARGE_SCOUT", name: "Large Scout" },
  { id: "STR_HARVESTER", name: "Harvester" },
  { id: "STR_ABDUCTOR", name: "Abductor" },
  { id: "STR_TERROR_SHIP", name: "Terror Ship" },
  { id: "STR_SUPPLY_SHIP", name: "Supply Ship" },
  { id: "STR_BATTLESHIP", name: "Battleship" },
];

export function biomeName(id: string): string {
  return id === "RANDOM" ? "Random" : BIOMES.find((b) => b.id === id)?.name ?? id;
}

/** A battle's actual environment: a "Random" choice is rolled (from the match seed) when it starts. */
export function resolveBiome(biome: Biome | "RANDOM", seed: number): Biome {
  if (biome !== "RANDOM") return biome;
  return BIOMES[((seed >>> 0) * 2654435761 >>> 0) % BIOMES.length].id;
}

/** A battle's actual time of day: "random" is rolled (from the match seed) when it starts. */
export function resolveTimeOfDay(t: TimeOfDay | "random", seed: number): TimeOfDay {
  if (t !== "random") return t;
  return (["day", "dusk", "night"] as const)[(((seed >>> 0) ^ 0x7a3d) * 2246822519 >>> 0) % 3];
}

/** Time of day for pricing: a random one is priced at dusk (about the average of day, dusk and night). */
export function pricingTime(t: TimeOfDay | "random"): TimeOfDay {
  return t === "random" ? "dusk" : t;
}

export function recommendedMapBlocks(players: number, budget: number): number {
  // bigger squads (budget) and more players need more room; the original maxes out at 6x6
  const base = players <= 2 ? 5 : players <= 4 ? 6 : players <= 6 ? 7 : 8;
  const extra = budget >= 1_000_000 ? 1 : 0;
  return Math.min(10, base + extra);
}

/** Map size for a co-op scenario, from how many units take the field (both sides, reinforcements included). */
export function recommendedScenarioBlocks(s: MatchSettings, people: number): number {
  const units = people * s.scenario.seatsPerPlayer + s.scenario.enemies.reduce((a, g) => a + g.count, 0);
  const blocks = units <= 12 ? 5 : units <= 24 ? 6 : units <= 40 ? 7 : units <= 60 ? 8 : 9;
  // several landing zones around the edge want a bit more room
  return Math.min(10, blocks + (s.scenario.teamStart === "apart" && people > 2 ? 1 : 0));
}

/** The map size a battle gets: the chosen one, or (auto) one for the squads / co-op team there at the start. */
export function resolveMapBlocks(s: MatchSettings, squads: number, people: number): number {
  if (s.mapBlocks) return s.mapBlocks;
  return s.mode === "coop" ? recommendedScenarioBlocks(s, Math.max(1, people)) : recommendedMapBlocks(Math.max(2, squads), s.budget);
}

export function defaultSettings(): MatchSettings {
  return {
    name: "New Match",
    notes: "",
    biome: "URBAN",
    timeOfDay: "day",
    ufo: "none",
    mapBlocks: 0,
    budget: 400_000,
    squadLimit: 14,
    poolSize: 40,
    techLevel: "alien",
    allowAliens: true,
    allowHWP: true,
    allowArmor: true,
    psionics: true,
    supplyDrops: { enabled: true, everyRounds: 4, warningRounds: 2, tier: "mixed", kits: 3 },
    turnTimer: 0,
    stranger: 0,
    coop: { squadSize: 1, turnEnd: "lockin", dailyAt: "20:00", timeZone: "UTC", afkAI: false },
    mode: "ffa",
    scenario: defaultScenario(),
  };
}

export function sanitizeSettings(s: Partial<MatchSettings>): MatchSettings {
  const d = defaultSettings();
  const clamp = (v: unknown, lo: number, hi: number, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
  };
  // nested settings may be partial (an AI assistant or a link only gives what it changes): fill in the rest
  const sd = { ...d.supplyDrops, ...s.supplyDrops };
  const co: Partial<CoopSettings> = { ...d.coop, ...s.coop };
  const turnTimer = clamp(s.turnTimer, 0, 3600, 0);
  const mode: GameMode = s.mode === "coop" ? "coop" : "ffa";
  const dailyAt = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(co.dailyAt)) ? String(co.dailyAt) : d.coop.dailyAt;
  return {
    name: String(s.name ?? d.name).slice(0, 40) || d.name,
    notes: String(s.notes ?? "").split(String.fromCharCode(13)).join("").slice(0, 1000),
    mode,
    // reusing a finished match's settings: a rolled "Random" environment goes back to Random
    biome: s.randomBiome ? "RANDOM" : s.biome === "RANDOM" || BIOMES.some((b) => b.id === s.biome) ? (s.biome as Biome | "RANDOM") : d.biome,
    timeOfDay: s.randomTime || s.timeOfDay === "random" ? "random" : s.timeOfDay === "night" || s.timeOfDay === "dusk" ? s.timeOfDay : "day",
    ufo: UFO_CHOICES.some((u) => u.id === s.ufo) ? (s.ufo as string) : d.ufo,
    // 0 (or nothing) is auto; reusing a finished match's settings, an auto size that was decided goes back to auto
    mapBlocks: s.autoMap || !(Number(s.mapBlocks) > 0) ? 0 : clamp(s.mapBlocks, 4, 10, d.mapBlocks),
    budget: clamp(s.budget, 50_000, 5_000_000, d.budget),
    squadLimit: clamp(s.squadLimit, 1, 30, d.squadLimit),
    poolSize: clamp(s.poolSize, 10, 80, d.poolSize),
    techLevel: s.techLevel === "conventional" || s.techLevel === "laser" ? s.techLevel : "alien",
    allowAliens: s.allowAliens ?? d.allowAliens,
    allowHWP: s.allowHWP ?? d.allowHWP,
    allowArmor: s.allowArmor ?? d.allowArmor,
    psionics: s.psionics ?? d.psionics,
    supplyDrops: {
      enabled: !!sd.enabled,
      everyRounds: clamp(sd.everyRounds, 1, 20, 4),
      warningRounds: clamp(sd.warningRounds, 0, 10, 2),
      tier: (["basic", "advanced", "alien", "mixed"] as const).includes(sd.tier as LootTier) ? sd.tier : "mixed",
      kits: clamp(sd.kits, 1, 12, 3),
    },
    turnTimer,
    stranger: clamp(s.stranger, 0, 50, 0),
    coop: {
      squadSize: clamp(co.squadSize, 1, MAX_SQUAD_SIZE, 1),
      // "end on the timer" needs a timer; a daily turn end is for co-op scenarios
      turnEnd: co.turnEnd === "timer" && turnTimer > 0 ? "timer" : co.turnEnd === "daily" && mode === "coop" ? "daily" : "lockin",
      dailyAt,
      timeZone: validTimeZone(co.timeZone ?? "UTC"),
      afkAI: !!co.afkAI,
    },
    scenario: sanitizeScenario(s.scenario),
  };
}

/** A recruit available in a match's shared hiring pool. */
export interface Recruit {
  id: string;
  kind: "soldier" | "alien" | "hwp";
  type: string; // unit rule type ("SOLDIER" for humans)
  name: string;
  rank: string;
  gender: number;
  look: number;
  stats: import("./rules/index.ts").Stats;
  price: number;
  notes: string[];
}

/** One unit of a player's squad as configured in the loadout screen. */
export interface SquadMember {
  recruitId: string;
  /** co-op: user id of the squad member who controls this unit in battle (unset: dealt out in turn) */
  controller?: string;
  /** co-op scenario enemies: where on the map they start */
  deploy?: Placement;
  /** co-op scenario team landing apart: which of the side's landing zones (one per person) */
  zone?: number;
  armor: string; // soldiers only; aliens/HWPs use their own
  items: { type: string; slot: string; x: number; y: number; ammo?: string }[];
  /** human soldiers: training courses bought for them, and how many times each */
  training?: Partial<Record<CourseId, number>>;
}

/** Training courses a soldier can be put through while hiring (see `COURSES` in rules/catalog.ts). */
export type CourseId = "marksmanship" | "reflexes" | "fitness" | "toughness" | "grenadier" | "closecombat" | "psi";

export interface Loadout {
  squad: SquadMember[];
  stash: string[]; // bought but not carried: dropped at the deployment zone
}
