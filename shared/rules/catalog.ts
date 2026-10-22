// Multiplayer economy: what can be bought, what recruits cost, and what falls from the sky.
import { ITEMS, UNITS, SOLDIER, armorRule, itemRule, unitRule, livingWeaponFor, hwpAmmoFor, tr, fitsSlot, type PlacedItem, type Stats, type UnitRule } from "./index.ts";
import { combatValue, type UnitTraits } from "./value.ts";
import calibration from "./calibration.json" with { type: "json" };

/** Corrections measured with bot duels (tools/duels.ts --calibrate): unit price multipliers, item and armor prices. */
const CAL = calibration as { units: Record<string, number>; items: Record<string, number>; armor: Record<string, number> };
import names from "./names.json" with { type: "json" };
import { pricingTime, type MatchSettings, type Recruit, type LootTier, type Loadout, type TechLevel } from "../protocol.ts";
import { RNG } from "../engine/rng.ts";

export interface CatalogEntry {
  type: string;
  price: number;
  tech: TechLevel;
  category: "weapon" | "ammo" | "explosive" | "equipment" | "armor";
  needsPsionics?: boolean;
}

/** Original buy prices where X-COM could buy the item; balanced prices for alien technology. */
export const CATALOG: CatalogEntry[] = [
  { type: "STR_PISTOL", price: 800, tech: "conventional", category: "weapon" },
  { type: "STR_PISTOL_CLIP", price: 70, tech: "conventional", category: "ammo" },
  { type: "STR_RIFLE", price: 3000, tech: "conventional", category: "weapon" },
  { type: "STR_RIFLE_CLIP", price: 200, tech: "conventional", category: "ammo" },
  { type: "STR_HEAVY_CANNON", price: 6400, tech: "conventional", category: "weapon" },
  { type: "STR_HC_AP_AMMO", price: 300, tech: "conventional", category: "ammo" },
  { type: "STR_HC_HE_AMMO", price: 500, tech: "conventional", category: "ammo" },
  { type: "STR_HC_I_AMMO", price: 400, tech: "conventional", category: "ammo" },
  { type: "STR_AUTO_CANNON", price: 13500, tech: "conventional", category: "weapon" },
  { type: "STR_AC_AP_AMMO", price: 500, tech: "conventional", category: "ammo" },
  { type: "STR_AC_HE_AMMO", price: 700, tech: "conventional", category: "ammo" },
  { type: "STR_AC_I_AMMO", price: 650, tech: "conventional", category: "ammo" },
  { type: "STR_ROCKET_LAUNCHER", price: 4000, tech: "conventional", category: "weapon" },
  { type: "STR_SMALL_ROCKET", price: 600, tech: "conventional", category: "ammo" },
  { type: "STR_LARGE_ROCKET", price: 900, tech: "conventional", category: "ammo" },
  { type: "STR_INCENDIARY_ROCKET", price: 1200, tech: "conventional", category: "ammo" },
  { type: "STR_GRENADE", price: 300, tech: "conventional", category: "explosive" },
  { type: "STR_SMOKE_GRENADE", price: 150, tech: "conventional", category: "explosive" },
  { type: "STR_PROXIMITY_GRENADE", price: 500, tech: "conventional", category: "explosive" },
  { type: "STR_HIGH_EXPLOSIVE", price: 1500, tech: "conventional", category: "explosive" },
  { type: "STR_STUN_ROD", price: 1260, tech: "conventional", category: "weapon" },
  { type: "STR_ELECTRO_FLARE", price: 60, tech: "conventional", category: "equipment" },
  { type: "STR_MEDI_KIT", price: 3000, tech: "conventional", category: "equipment" },
  { type: "STR_MOTION_SCANNER", price: 3500, tech: "conventional", category: "equipment" },
  { type: "STR_LASER_PISTOL", price: 8000, tech: "laser", category: "weapon" },
  { type: "STR_LASER_RIFLE", price: 14000, tech: "laser", category: "weapon" },
  { type: "STR_HEAVY_LASER", price: 20000, tech: "laser", category: "weapon" },
  { type: "STR_PLASMA_PISTOL", price: 12000, tech: "alien", category: "weapon" },
  { type: "STR_PLASMA_PISTOL_CLIP", price: 600, tech: "alien", category: "ammo" },
  { type: "STR_PLASMA_RIFLE", price: 20000, tech: "alien", category: "weapon" },
  { type: "STR_PLASMA_RIFLE_CLIP", price: 900, tech: "alien", category: "ammo" },
  { type: "STR_HEAVY_PLASMA", price: 28000, tech: "alien", category: "weapon" },
  { type: "STR_HEAVY_PLASMA_CLIP", price: 1200, tech: "alien", category: "ammo" },
  { type: "STR_SMALL_LAUNCHER", price: 18000, tech: "alien", category: "weapon" },
  { type: "STR_STUN_BOMB", price: 1500, tech: "alien", category: "ammo" },
  { type: "STR_BLASTER_LAUNCHER", price: 45000, tech: "alien", category: "weapon" },
  { type: "STR_BLASTER_BOMB", price: 4000, tech: "alien", category: "ammo" },
  { type: "STR_ALIEN_GRENADE", price: 1500, tech: "alien", category: "explosive" },
  { type: "STR_MIND_PROBE", price: 12000, tech: "alien", category: "equipment", needsPsionics: false },
  { type: "STR_PSI_AMP", price: 15000, tech: "alien", category: "equipment", needsPsionics: true },
];

export const ARMOR_PRICES: Record<string, { price: number; tech: TechLevel }> = {
  STR_NONE_UC: { price: 0, tech: "conventional" },
  STR_PERSONAL_ARMOR_UC: { price: 12000, tech: "conventional" },
  STR_POWER_SUIT_UC: { price: 30000, tech: "alien" },
  STR_FLYING_SUIT_UC: { price: 45000, tech: "alien" },
};

const TECH_ORDER: TechLevel[] = ["conventional", "laser", "alien"];
export function techAllowed(entry: TechLevel, level: TechLevel): boolean {
  return TECH_ORDER.indexOf(entry) <= TECH_ORDER.indexOf(level);
}

export function catalogFor(s: MatchSettings): CatalogEntry[] {
  return CATALOG.filter((c) => techAllowed(c.tech, s.techLevel) && (!c.needsPsionics || s.psionics)).map((c) => ({ ...c, price: itemPrice(c.type) }));
}

export function armorsFor(s: MatchSettings): string[] {
  if (!s.allowArmor) return ["STR_NONE_UC"];
  return Object.keys(ARMOR_PRICES).filter((a) => techAllowed(ARMOR_PRICES[a].tech, s.techLevel));
}

export function itemPrice(type: string): number {
  return CAL.items[type] ?? CATALOG.find((c) => c.type === type)?.price ?? 0;
}

export function armorPrice(type: string): number {
  return CAL.armor[type] ?? ARMOR_PRICES[type]?.price ?? 0;
}

// ------------------------------------------------------------------------------------------
// recruits
// ------------------------------------------------------------------------------------------

export interface PriceInfo {
  price: number;
  notes: string[];
}

/** What a median rookie with a rifle costs; every other price is relative to this. */
export const ROOKIE_PRICE = 14000;
/** Lanchester square law: price grows with the square root of combat value (see value.ts). */
export const QUALITY_EXPONENT = 0.5;

const REFERENCE_ROOKIE: Stats = { tu: 55, stamina: 55, health: 32, bravery: 35, reactions: 45, firing: 55, throwing: 65, strength: 30, psiStrength: 50, psiSkill: 0, melee: 30 };

function referenceValue(timeOfDay: UnitTraits["timeOfDay"]): number {
  const v = combatValue({ stats: REFERENCE_ROOKIE, armor: "STR_NONE_UC", weapon: "STR_RIFLE", ammo: "STR_RIFLE_CLIP", psionic: false, psionics: false, nightVision: false, timeOfDay, zombifies: false, spawnsOnDeath: false, explodesOnDeath: false });
  return v.offense * v.durability;
}

/** Price of a unit from its combat value relative to the reference rookie (both with a rifle unless it has a built-in weapon). */
export function priceUnit(kind: Recruit["kind"], type: string, stats: Stats, psionics: boolean, armorType?: string, timeOfDay: UnitTraits["timeOfDay"] = "day"): PriceInfo {
  const rule: UnitRule | null = kind === "soldier" ? null : unitRule(type);
  const armor = armorRule(kind === "soldier" ? armorType ?? "STR_NONE_UC" : rule!.armor);
  const notes: string[] = [];
  const innate = rule ? livingWeaponFor(rule) : null;
  const traits: UnitTraits = {
    stats, armor: armor.type,
    weapon: innate ?? "STR_RIFLE",
    ammo: innate ? (rule && kind === "hwp" ? hwpAmmoFor(rule) : null) : "STR_RIFLE_CLIP",
    psionic: stats.psiSkill > 0, psionics, nightVision: kind === "alien", timeOfDay,
    zombifies: !!(innate && itemRule(innate).zombieUnit), spawnsOnDeath: !!rule?.spawnUnit, explodesOnDeath: rule?.specab === 1 || rule?.specab === 3,
  };
  const v = combatValue(traits);
  const ratio = (v.offense * v.durability) / referenceValue(timeOfDay);
  const price = Math.max(3000, Math.round((ROOKIE_PRICE * Math.pow(Math.max(0.01, ratio), QUALITY_EXPONENT) * (CAL.units[type] ?? 1)) / 500) * 500);
  if (innate) notes.push(`Built-in weapon: ${tr(itemRule(innate).name)}`);
  if (kind === "alien") notes.push("Night vision");
  if (psionics && kind === "alien" && stats.psiSkill > 0) notes.push("Innate psionics (no Psi-Amp needed)");
  if (traits.zombifies) notes.push("Victims rise as zombies");
  if (rule?.spawnUnit) notes.push(`Bursts into a ${tr(rule.spawnUnit)} when killed`);
  if (rule?.specab === 1) notes.push("Explodes when destroyed");
  if (rule?.specab === 2) notes.push("Burns the ground it crosses");
  if (rule?.capturable === false) notes.push("Cannot be stunned");
  if (armor.movementType === 1) notes.push("Flying");
  if (armor.size > 1) notes.push("Large unit: takes 4 seats");
  if (kind === "hwp") notes.push("No inventory");
  const avgArmor = (armor.front + 2 * armor.side + armor.rear + armor.under) / 5;
  if (avgArmor >= 30) notes.push(`Armor ${armor.front}/${armor.side}/${armor.rear}/${armor.under}`);
  return { price, notes };
}

export function seatsFor(r: Recruit): number {
  if (r.kind === "soldier") return 1;
  return armorRule(unitRule(r.type).armor).size > 1 ? 4 : 1;
}

const RANKS = ["STR_ROOKIE", "STR_SQUADDIE", "STR_SERGEANT", "STR_CAPTAIN", "STR_COLONEL", "STR_COMMANDER"];
const NATIONS = Object.keys(names);

function soldierName(rng: RNG, female: boolean): string {
  const n = (names as Record<string, { mf: string[]; ff: string[]; ml: string[]; fl: string[] }>)[rng.pick(NATIONS)];
  const first = rng.pick(female ? n.ff : n.mf);
  const last = rng.pick(female ? n.fl : n.ml);
  return `${first} ${last}`;
}

function makeSoldier(rng: RNG, id: string, tier: number, psionics: boolean, timeOfDay: UnitTraits["timeOfDay"]): Recruit {
  const s: Stats = { ...SOLDIER.minStats };
  const keys = Object.keys(s) as (keyof Stats)[];
  for (const k of keys) s[k] = rng.int(SOLDIER.minStats[k], SOLDIER.maxStats[k]);
  // veterans: battle experience pushes stats towards the caps
  for (let t = 0; t < tier; t++) {
    s.tu += rng.int(0, Math.floor((SOLDIER.statCaps.tu - s.tu) / 10) + 2);
    s.health += rng.int(0, Math.floor((SOLDIER.statCaps.health - s.health) / 10) + 2);
    s.strength += rng.int(0, Math.floor((SOLDIER.statCaps.strength - s.strength) / 10) + 2);
    s.stamina += rng.int(0, Math.floor((SOLDIER.statCaps.stamina - s.stamina) / 15) + 2);
    s.reactions += rng.int(1, 4);
    s.firing += rng.int(1, 6);
    s.throwing += rng.int(0, 3);
    s.melee += rng.int(0, 3);
    s.bravery += rng.percent(40) ? 10 : 0;
  }
  // psionic training is only part of the veterans' resume
  s.psiSkill = psionics && tier >= 2 && rng.percent(35 + tier * 10) ? rng.int(16 + tier * 6, 30 + tier * 12) : 0;
  for (const k of keys) s[k] = Math.min(SOLDIER.statCaps[k], s[k]);
  const gender = rng.percent(25) ? 1 : 0;
  const pi = priceUnit("soldier", "SOLDIER", s, psionics, undefined, timeOfDay);
  if (s.psiSkill > 0) pi.notes.push("Psionically trained");
  return { id, kind: "soldier", type: "SOLDIER", name: soldierName(rng, gender === 1), rank: RANKS[tier], gender, look: rng.int(0, 3), stats: s, price: pi.price, notes: pi.notes };
}

const ALIEN_TYPES = [...UNITS.values()].filter((u) => u.type !== "MALE_CIVILIAN" && u.type !== "FEMALE_CIVILIAN" && !u.type.startsWith("STR_TANK") && !u.type.startsWith("STR_HOVERTANK"));
const HWP_TYPES = [...UNITS.values()].filter((u) => u.type.startsWith("STR_TANK") || u.type.startsWith("STR_HOVERTANK"));

function hwpAllowed(u: UnitRule, tech: TechLevel): boolean {
  if (u.type === "STR_TANK_LASER_CANNON") return techAllowed("laser", tech);
  if (u.type.startsWith("STR_HOVERTANK")) return techAllowed("alien", tech);
  return true;
}

function makeNonHuman(rng: RNG, id: string, u: UnitRule, kind: "alien" | "hwp", psionics: boolean, timeOfDay: UnitTraits["timeOfDay"]): Recruit {
  const s: Stats = { ...u.stats };
  // individual variation so two Sectoid Soldiers aren't identical
  for (const k of Object.keys(s) as (keyof Stats)[]) {
    if (s[k] > 0 && k !== "psiStrength") s[k] = Math.max(1, Math.round(s[k] * (0.9 + rng.float() * 0.2)));
  }
  if (!psionics) s.psiSkill = 0;
  const pi = priceUnit(kind, u.type, s, psionics, undefined, timeOfDay);
  return { id, kind, type: u.type, name: tr(u.type), rank: u.rank ? tr(u.rank) : kind === "hwp" ? "HWP" : "", gender: 0, look: 0, stats: s, price: pi.price, notes: pi.notes };
}

/** Unit types a co-op scenario's enemy can field: every alien race and rank, terror units and tanks. */
export const ENEMY_UNIT_TYPES = [...ALIEN_TYPES, ...HWP_TYPES].map((u) => u.type);

/** One enemy for a co-op scenario: `type` is a unit rule type or "SOLDIER:<rank 0-5>". */
export function scenarioRecruit(type: string, rng: RNG, id: string, settings: MatchSettings): Recruit | null {
  const time = pricingTime(settings.timeOfDay);
  const soldier = /^SOLDIER:([0-5])$/.exec(type);
  if (soldier) return makeSoldier(rng, id, Number(soldier[1]), settings.psionics, time);
  const u = UNITS.get(type);
  if (!u || !ENEMY_UNIT_TYPES.includes(type)) return null;
  return makeNonHuman(rng, id, u, HWP_TYPES.includes(u) ? "hwp" : "alien", settings.psionics, time);
}

/** The shared hiring pool for a match (every player gets an identical copy). */
export function generatePool(settings: MatchSettings, seed: number): Recruit[] {
  const rng = new RNG(seed ^ 0x9001);
  const pool: Recruit[] = [];
  const n = settings.poolSize;
  const alienShare = settings.allowAliens ? 0.4 : 0;
  const hwpShare = settings.allowHWP ? 0.08 : 0;
  const nAliens = Math.round(n * alienShare);
  const nHwp = Math.max(settings.allowHWP ? 2 : 0, Math.round(n * hwpShare));
  const nSoldiers = Math.max(1, n - nAliens - nHwp);
  // rank spread: plenty of rookies, a handful of elites
  const tiers = [0, 0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 5];
  for (let i = 0; i < nSoldiers; i++) pool.push(makeSoldier(rng, "s" + i, i < tiers.length ? tiers[i] : rng.pick(tiers), settings.psionics, pricingTime(settings.timeOfDay)));
  if (nAliens) {
    const types = rng.shuffle([...ALIEN_TYPES]);
    for (let i = 0; i < nAliens; i++) pool.push(makeNonHuman(rng, "a" + i, types[i % types.length], "alien", settings.psionics, pricingTime(settings.timeOfDay)));
  }
  const hwps = HWP_TYPES.filter((u) => hwpAllowed(u, settings.techLevel));
  for (let i = 0; i < nHwp && hwps.length; i++) pool.push(makeNonHuman(rng, "h" + i, hwps[i % hwps.length], "hwp", settings.psionics, pricingTime(settings.timeOfDay)));
  return pool;
}

// ------------------------------------------------------------------------------------------
// loadout validation
// ------------------------------------------------------------------------------------------

export interface LoadoutCheck {
  ok: boolean;
  cost: number;
  seats: number;
  errors: string[];
}

export function checkLoadout(settings: MatchSettings, pool: Recruit[], l: Loadout): LoadoutCheck {
  const errors: string[] = [];
  let cost = 0, seats = 0;
  const allowed = new Set(catalogFor(settings).map((c) => c.type));
  const armors = new Set(armorsFor(settings));
  const seen = new Set<string>();
  for (const m of l.squad) {
    const r = pool.find((p) => p.id === m.recruitId);
    if (!r) {
      errors.push("Unknown recruit");
      continue;
    }
    if (seen.has(r.id)) errors.push(`${r.name} hired twice`);
    seen.add(r.id);
    cost += r.price;
    seats += seatsFor(r);
    if (r.kind === "soldier") {
      if (!armors.has(m.armor || "STR_NONE_UC")) errors.push("Armor not allowed");
      cost += armorPrice(m.armor || "STR_NONE_UC");
    }
    if (r.kind === "hwp" && m.items.length) errors.push(`${r.name} cannot carry items`);
    // a living weapon (Chryssalid claws, Celatid spit...) already fills the right hand
    const innate = r.kind === "alien" ? livingWeaponFor(unitRule(r.type)) : null;
    const placed: PlacedItem[] = innate ? [{ type: innate, slot: "STR_RIGHT_HAND", x: 0, y: 0 }] : [];
    for (const it of m.items) {
      if (it.slot === "STR_GROUND" || !fitsSlot(placed, it.type, it.slot, it.x, it.y)) errors.push(`${r.name}: ${tr(it.type)} doesn't fit there`);
      else placed.push(it);
      if (!allowed.has(it.type)) errors.push(`${tr(it.type)} not available`);
      cost += itemPrice(it.type);
      if (it.ammo) {
        if (!allowed.has(it.ammo)) errors.push(`${tr(it.ammo)} not available`);
        if (!itemRule(it.type).compatibleAmmo.includes(it.ammo)) errors.push("Wrong ammo");
        cost += itemPrice(it.ammo);
      }
    }
  }
  for (const t of l.stash) {
    if (!allowed.has(t)) errors.push(`${tr(t)} not available`);
    cost += itemPrice(t);
  }
  if (!l.squad.length) errors.push("Hire at least one unit");
  // co-op scenarios give each person their own share of the Skyranger; free-for-all squads get a whole one
  const limit = settings.mode === "coop" ? settings.scenario.seatsPerPlayer : settings.squadLimit;
  if (seats > limit) errors.push(`Squad needs ${seats} seats, limit is ${limit}${settings.mode === "coop" ? " each" : ""}`);
  if (cost > settings.budget) errors.push(`Over budget by $${(cost - settings.budget).toLocaleString()}`);
  return { ok: errors.length === 0, cost, seats, errors };
}

// ------------------------------------------------------------------------------------------
// supply drops
// ------------------------------------------------------------------------------------------

type Kit = string[];
const BASIC: Kit[] = [
  ["STR_RIFLE", "STR_RIFLE_CLIP", "STR_RIFLE_CLIP"], ["STR_PISTOL", "STR_PISTOL_CLIP"], ["STR_GRENADE", "STR_GRENADE"],
  ["STR_HIGH_EXPLOSIVE"], ["STR_MEDI_KIT"], ["STR_SMOKE_GRENADE", "STR_SMOKE_GRENADE"], ["STR_ELECTRO_FLARE", "STR_ELECTRO_FLARE"],
  ["STR_RIFLE_CLIP", "STR_RIFLE_CLIP", "STR_PISTOL_CLIP"], ["STR_HC_AP_AMMO", "STR_HC_HE_AMMO"], ["STR_AC_AP_AMMO", "STR_AC_HE_AMMO"],
  ["STR_SMALL_ROCKET", "STR_LARGE_ROCKET"],
];
const ADVANCED: Kit[] = [
  ["STR_HEAVY_CANNON", "STR_HC_AP_AMMO", "STR_HC_HE_AMMO"], ["STR_AUTO_CANNON", "STR_AC_AP_AMMO", "STR_AC_I_AMMO"],
  ["STR_ROCKET_LAUNCHER", "STR_LARGE_ROCKET", "STR_INCENDIARY_ROCKET"], ["STR_LASER_RIFLE"], ["STR_LASER_PISTOL"], ["STR_HEAVY_LASER"],
  ["STR_PROXIMITY_GRENADE", "STR_PROXIMITY_GRENADE"], ["STR_MOTION_SCANNER"], ["STR_STUN_ROD"], ["STR_MEDI_KIT", "STR_HIGH_EXPLOSIVE"],
];
const ALIEN: Kit[] = [
  ["STR_PLASMA_RIFLE", "STR_PLASMA_RIFLE_CLIP"], ["STR_PLASMA_PISTOL", "STR_PLASMA_PISTOL_CLIP"], ["STR_HEAVY_PLASMA", "STR_HEAVY_PLASMA_CLIP"],
  ["STR_ALIEN_GRENADE", "STR_ALIEN_GRENADE"], ["STR_SMALL_LAUNCHER", "STR_STUN_BOMB", "STR_STUN_BOMB"], ["STR_BLASTER_LAUNCHER", "STR_BLASTER_BOMB"],
  ["STR_MIND_PROBE"], ["STR_HEAVY_PLASMA_CLIP", "STR_PLASMA_RIFLE_CLIP"], ["STR_PSI_AMP"],
];

/** A drop's contents: `kits` kits (battles from before the setting existed roll 2 or 3). */
export function rollSupplyDrop(rng: RNG, tier: LootTier, psionics: boolean, kits?: number): string[] {
  const pickTier = (): Kit[] => {
    if (tier === "basic") return BASIC;
    if (tier === "advanced") return ADVANCED;
    if (tier === "alien") return ALIEN;
    const r = rng.int(0, 99);
    return r < 45 ? BASIC : r < 80 ? ADVANCED : ALIEN;
  };
  const out: string[] = [];
  const n = kits ?? rng.int(2, 3);
  for (let k = 0; k < n; k++) {
    let kit = rng.pick(pickTier());
    if (!psionics && kit.includes("STR_PSI_AMP")) kit = rng.pick(ALIEN.filter((x) => !x.includes("STR_PSI_AMP")));
    out.push(...kit);
  }
  return out.filter((t) => ITEMS.has(t));
}

// ------------------------------------------------------------------------------------------
// budget guide (shown while setting up a match)
// ------------------------------------------------------------------------------------------

export interface BudgetGuide {
  prices: string[];
  examples: string[];
}

function money(n: number) {
  return "$" + Math.round(n).toLocaleString("en-US");
}
function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Rules of thumb and concrete squads for the chosen budget, priced from a reference pool. */
export function budgetGuide(s: MatchSettings): BudgetGuide {
  const pool = generatePool({ ...s, poolSize: 80 }, 12345);
  const soldiers = pool.filter((p) => p.kind === "soldier");
  const rookie = median(soldiers.filter((p) => p.rank === "STR_ROOKIE").map((p) => p.price)) || 13000;
  const vet = median(soldiers.filter((p) => ["STR_CAPTAIN", "STR_COLONEL", "STR_COMMANDER"].includes(p.rank)).map((p) => p.price)) || 30000;
  const aliens = pool.filter((p) => p.kind === "alien").sort((a, b) => a.price - b.price);
  const hwps = pool.filter((p) => p.kind === "hwp").sort((a, b) => a.price - b.price);
  const has = (t: string) => catalogFor(s).some((c) => c.type === t);
  const kit = (...types: string[]) => types.reduce((a, t) => a + itemPrice(t), 0);
  const basicKit = kit("STR_RIFLE", "STR_RIFLE_CLIP", "STR_RIFLE_CLIP", "STR_GRENADE", "STR_GRENADE");
  const bestRifle = has("STR_PLASMA_RIFLE") ? { name: "plasma rifle", cost: kit("STR_PLASMA_RIFLE", "STR_PLASMA_RIFLE_CLIP", "STR_PLASMA_RIFLE_CLIP", "STR_ALIEN_GRENADE") }
    : has("STR_LASER_RIFLE") ? { name: "laser rifle", cost: kit("STR_LASER_RIFLE", "STR_GRENADE", "STR_GRENADE") }
    : { name: "auto-cannon", cost: kit("STR_AUTO_CANNON", "STR_AC_AP_AMMO", "STR_AC_HE_AMMO", "STR_GRENADE") };
  const armors = armorsFor(s);
  const bestArmor = armors.includes("STR_POWER_SUIT_UC") ? { name: "power suit", cost: armorPrice("STR_POWER_SUIT_UC") }
    : armors.includes("STR_PERSONAL_ARMOR_UC") ? { name: "personal armor", cost: armorPrice("STR_PERSONAL_ARMOR_UC") } : null;

  const prices = [
    `Rookie soldier ≈ ${money(rookie)}; veteran (captain or better) ≈ ${money(vet)}.`,
    `Rifle, 2 clips and 2 grenades ≈ ${money(basicKit)}; ${bestRifle.name.replace(/s$/, "")} kit ≈ ${money(bestRifle.cost)}.`,
  ];
  if (bestArmor) prices.push(`Armor: personal ${money(armorPrice("STR_PERSONAL_ARMOR_UC"))}${armors.includes("STR_POWER_SUIT_UC") ? `, power suit ${money(armorPrice("STR_POWER_SUIT_UC"))}, flying suit ${money(armorPrice("STR_FLYING_SUIT_UC"))}` : ""}.`);
  if (aliens.length) prices.push(`Aliens run from ${money(aliens[0].price)} (${aliens[0].name}) to ${money(aliens[aliens.length - 1].price)} (${aliens[aliens.length - 1].name}).`);
  if (hwps.length) prices.push(`Tanks (4 seats each) cost ${money(hwps[0].price)}–${money(hwps[hwps.length - 1].price)}, ammo included.`);

  const B = s.budget;
  const examples: string[] = [];
  const swarmEach = rookie + basicKit;
  const swarm = Math.min(s.squadLimit, Math.floor(B / swarmEach));
  if (swarm > 0) examples.push(`Swarm: ${swarm} rookies with rifles & grenades ≈ ${money(swarm * swarmEach)}${swarm === s.squadLimit && B - swarm * swarmEach > 20000 ? ` (seat limit reached; ${money(B - swarm * swarmEach)} left for upgrades)` : ""}.`);
  const eliteEach = vet + bestRifle.cost + (bestArmor?.cost ?? 0);
  const elite = Math.min(s.squadLimit, Math.floor(B / eliteEach));
  const pl = (n: number, w: string) => (n > 1 ? (w.endsWith("armor") ? w : w + "s") : w.endsWith("armor") ? w : "a " + w);
  if (elite > 0) examples.push(`Elite: ${elite} veteran${elite > 1 ? "s" : ""} with ${pl(elite, bestRifle.name)}${bestArmor ? ` in ${pl(elite, bestArmor.name)}` : ""} ≈ ${money(elite * eliteEach)}.`);
  else examples.push(`Elite: one fully kitted veteran costs ≈ ${money(eliteEach)} — more than this budget.`);
  const monsters = [...aliens].reverse().filter((a) => a.price <= B * 0.7);
  if (monsters.length) {
    const m = monsters[0];
    const left = B - m.price;
    const extra = Math.min(s.squadLimit - (m.notes.some((n) => n.startsWith("Large")) ? 4 : 1), Math.floor(left / swarmEach));
    examples.push(`Monster: a ${m.name} (${money(m.price)})${extra > 0 ? ` backed by ${extra} armed rookie${extra > 1 ? "s" : ""}` : ""}.`);
  }
  if (B < swarmEach * 3) examples.push("Tight budget: expect knife-fights with 1–2 soldiers each.");
  return { prices, examples };
}
