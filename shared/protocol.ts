// Types shared by server and client: match settings, lobby state, and battle messages.

export type Biome = "URBAN" | "CULTA" | "FOREST" | "JUNGLE" | "DESERT" | "MOUNT" | "POLAR" | "MARS" | "UBASE";
export type TimeOfDay = "day" | "dusk" | "night";
export type TechLevel = "conventional" | "laser" | "alien";
export type LootTier = "basic" | "advanced" | "alien" | "mixed";

export interface MatchSettings {
  name: string;
  /** optional message from the creator, shown to everyone in the lobby (house rules, schedule...) */
  notes: string;
  maxPlayers: number;
  biome: Biome | "RANDOM"; // RANDOM is decided when the battle starts
  /** set when a "Random" environment was rolled at the start, so reusing these settings rolls again */
  randomBiome?: boolean;
  timeOfDay: TimeOfDay | "random"; // random is decided when the battle starts
  /** set when a "random" time of day was rolled at the start, so reusing these settings rolls again */
  randomTime?: boolean;
  ufo: string; // "none" | "random" | ufo type
  mapBlocks: number; // map edge length in 10-tile blocks
  budget: number;
  squadLimit: number; // seats; large units take 4
  poolSize: number;
  techLevel: TechLevel;
  allowAliens: boolean;
  allowHWP: boolean;
  allowArmor: boolean;
  psionics: boolean;
  supplyDrops: { enabled: boolean; everyRounds: number; warningRounds: number; tier: LootTier };
  turnTimer: number; // seconds per turn, 0 = unlimited
  coop: CoopSettings;
}

/** Several people sharing one squad: each controls some of its units, and they all act at once on its turn. */
export interface CoopSettings {
  /** people per squad (1 = everyone fields their own squad) */
  squadSize: number;
  /** a shared squad's turn ends once every member has locked in, or only when the turn timer runs out */
  turnEnd: "lockin" | "timer";
  /** the AI plays the units of people who have been offline for a while (anyone can also go AFK by hand) */
  afkAI: boolean;
}

export const MAX_SQUAD_SIZE = 10;

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

export function defaultSettings(): MatchSettings {
  return {
    name: "New Match",
    notes: "",
    maxPlayers: 2,
    biome: "URBAN",
    timeOfDay: "day",
    ufo: "none",
    mapBlocks: 5,
    budget: 400_000,
    squadLimit: 14,
    poolSize: 40,
    techLevel: "alien",
    allowAliens: true,
    allowHWP: true,
    allowArmor: true,
    psionics: true,
    supplyDrops: { enabled: true, everyRounds: 4, warningRounds: 2, tier: "mixed" },
    turnTimer: 0,
    coop: { squadSize: 1, turnEnd: "lockin", afkAI: false },
  };
}

export function sanitizeSettings(s: Partial<MatchSettings>): MatchSettings {
  const d = defaultSettings();
  const clamp = (v: unknown, lo: number, hi: number, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
  };
  const sd = s.supplyDrops ?? d.supplyDrops;
  const co: Partial<CoopSettings> = s.coop ?? d.coop;
  const turnTimer = clamp(s.turnTimer, 0, 3600, 0);
  return {
    name: String(s.name ?? d.name).slice(0, 40) || d.name,
    notes: String(s.notes ?? "").split(String.fromCharCode(13)).join("").slice(0, 1000),
    maxPlayers: clamp(s.maxPlayers, 2, 8, d.maxPlayers),
    // reusing a finished match's settings: a rolled "Random" environment goes back to Random
    biome: s.randomBiome ? "RANDOM" : s.biome === "RANDOM" || BIOMES.some((b) => b.id === s.biome) ? (s.biome as Biome | "RANDOM") : d.biome,
    timeOfDay: s.randomTime || s.timeOfDay === "random" ? "random" : s.timeOfDay === "night" || s.timeOfDay === "dusk" ? s.timeOfDay : "day",
    ufo: UFO_CHOICES.some((u) => u.id === s.ufo) ? (s.ufo as string) : d.ufo,
    mapBlocks: clamp(s.mapBlocks, 4, 10, d.mapBlocks),
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
    },
    turnTimer,
    coop: {
      squadSize: clamp(co.squadSize, 1, MAX_SQUAD_SIZE, 1),
      // "end on the timer" needs a timer
      turnEnd: co.turnEnd === "timer" && turnTimer > 0 ? "timer" : "lockin",
      afkAI: !!co.afkAI,
    },
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
  armor: string; // soldiers only; aliens/HWPs use their own
  items: { type: string; slot: string; x: number; y: number; ammo?: string }[];
}

export interface Loadout {
  squad: SquadMember[];
  stash: string[]; // bought but not carried: dropped at the deployment zone
}
