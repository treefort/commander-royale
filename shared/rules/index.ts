// Typed access to the original UFO Defense rules (transcribed via OpenXcom's xcom1 rulesets),
// with engine defaults applied, plus the multiplayer catalog/pricing layered on top.
import data from "./generated.json" with { type: "json" };
import strings from "./strings.json" with { type: "json" };

export const enum DamageType { NONE = 0, AP = 1, IN = 2, HE = 3, LASER = 4, PLASMA = 5, STUN = 6, MELEE = 7, ACID = 8, SMOKE = 9 }
export const enum BattleType { NONE = 0, FIREARM = 1, AMMO = 2, MELEE = 3, GRENADE = 4, PROXIMITYGRENADE = 5, MEDIKIT = 6, SCANNER = 7, MINDPROBE = 8, PSIAMP = 9, FLARE = 10, CORPSE = 11 }
export const enum MovementType { WALK = 0, FLY = 1, SLIDE = 2 }
export const enum SpecAb { NONE = 0, EXPLODE_ON_DEATH = 1, BURN_FLOOR = 2, BURN_AND_EXPLODE = 3 }

export interface Stats {
  tu: number; stamina: number; health: number; bravery: number; reactions: number; firing: number;
  throwing: number; strength: number; psiStrength: number; psiSkill: number; melee: number;
}

export interface ItemRule {
  type: string; name: string; weight: number; bigSprite: number; floorSprite: number; handSprite: number;
  bulletSprite: number; fireSound: number; hitSound: number; hitAnimation: number; power: number; damageType: DamageType;
  accuracyAuto: number; accuracySnap: number; accuracyAimed: number; accuracyMelee: number;
  tuAuto: number; tuSnap: number; tuAimed: number; tuMelee: number; tuUse: number;
  clipSize: number; battleType: BattleType; twoHanded: boolean; fixedWeapon: boolean; waypoints: number;
  invWidth: number; invHeight: number; painKiller: number; heal: number; stimulant: number;
  woundRecovery: number; healthRecovery: number; stunRecovery: number; energyRecovery: number;
  armor: number; blastRadius: number; flatRate: boolean; arcingShot: boolean;
  maxRange: number; aimRange: number; snapRange: number; autoRange: number; minRange: number; dropoff: number;
  autoShots: number; strengthApplied: boolean; skillApplied: boolean; meleeSound: number; meleePower: number; meleeHitSound: number;
  compatibleAmmo: string[]; zombieUnit: string; turretType: number; recover: boolean;
}

export interface UnitRule {
  type: string; race: string; rank: string; stats: Stats; armor: string; standHeight: number; kneelHeight: number; floatHeight: number;
  value: number; deathSound: number[]; moveSound: number; energyRecovery: number; specab: SpecAb; livingWeapon: boolean;
  spawnUnit: string; capturable: boolean;
  /** OpenXcom AI personality: turns an enemy stays "known" after being seen, and 0 (cautious) .. 2 (reckless) */
  intelligence: number; aggression: number;
}

export interface ArmorRule {
  type: string; spriteSheet: string; spriteInv: string; corpseBattle: string[]; front: number; side: number; rear: number; under: number;
  drawingRoutine: number; movementType: MovementType; size: number; damageModifier: number[]; loftempsSet: number[];
  forcedTorso: number; constantAnimation: boolean; deathFrames: number; allowInv: boolean;
}

export interface MapBlockRule { name: string; width: number; length: number; groups: number[] }
export interface TerrainRule { name: string; mapDataSets: string[]; mapBlocks: MapBlockRule[]; script?: string }

const S = strings as unknown as Record<string, string>;
export function tr(key: string): string {
  return S[key] ?? key.replace(/^STR_/, "").replace(/_/g, " ");
}

function toItem(r: any): ItemRule {
  return {
    type: r.type, name: r.name ?? r.type, weight: r.weight ?? 3, bigSprite: r.bigSprite ?? -1, floorSprite: r.floorSprite ?? -1,
    handSprite: r.handSprite ?? 120, bulletSprite: r.bulletSprite ?? -1, fireSound: r.fireSound ?? -1, hitSound: r.hitSound ?? -1,
    hitAnimation: r.hitAnimation ?? -1, power: r.power ?? 0, damageType: r.damageType ?? 0,
    accuracyAuto: r.accuracyAuto ?? 0, accuracySnap: r.accuracySnap ?? 0, accuracyAimed: r.accuracyAimed ?? 0, accuracyMelee: r.accuracyMelee ?? 0,
    tuAuto: r.tuAuto ?? 0, tuSnap: r.tuSnap ?? 0, tuAimed: r.tuAimed ?? 0, tuMelee: r.tuMelee ?? 0, tuUse: r.tuUse ?? 0,
    clipSize: r.clipSize ?? 0, battleType: r.battleType ?? 0, twoHanded: !!r.twoHanded, fixedWeapon: !!r.fixedWeapon, waypoints: r.waypoints ?? 0,
    invWidth: r.invWidth ?? 1, invHeight: r.invHeight ?? 1, painKiller: r.painKiller ?? 0, heal: r.heal ?? 0, stimulant: r.stimulant ?? 0,
    woundRecovery: r.woundRecovery ?? 0, healthRecovery: r.healthRecovery ?? 0, stunRecovery: r.stunRecovery ?? 0, energyRecovery: r.energyRecovery ?? 0,
    armor: r.armor ?? 20, blastRadius: r.blastRadius ?? -1, flatRate: !!r.flatRate, arcingShot: !!r.arcingShot,
    maxRange: r.maxRange ?? 200, aimRange: r.aimRange ?? 200, snapRange: r.snapRange ?? 15, autoRange: r.autoRange ?? 7, minRange: r.minRange ?? 0,
    dropoff: r.dropoff ?? 2, autoShots: r.autoShots ?? 3, strengthApplied: !!r.strengthApplied, skillApplied: r.skillApplied ?? true,
    meleeSound: r.meleeSound ?? 39, meleePower: r.meleePower ?? 0, meleeHitSound: r.meleeHitSound ?? -1,
    compatibleAmmo: r.compatibleAmmo ?? [], zombieUnit: r.zombieUnit ?? "", turretType: r.turretType ?? -1, recover: r.recover ?? true,
  };
}

export const ITEMS = new Map<string, ItemRule>();
for (const r of (data as any).items) ITEMS.set(r.type, toItem(r));
// zombie corpse is referenced by armor but absent from the item list
if (!ITEMS.has("STR_ZOMBIE_CORPSE")) ITEMS.set("STR_ZOMBIE_CORPSE", { ...ITEMS.get("STR_CORPSE")!, type: "STR_ZOMBIE_CORPSE", name: "STR_CORPSE" });

export const ARMORS = new Map<string, ArmorRule>();
for (const r of (data as any).armors) {
  ARMORS.set(r.type, {
    type: r.type, spriteSheet: r.spriteSheet, spriteInv: r.spriteInv ?? "", corpseBattle: r.corpseBattle ?? [],
    front: r.frontArmor ?? 0, side: r.sideArmor ?? 0, rear: r.rearArmor ?? 0, under: r.underArmor ?? 0,
    drawingRoutine: r.drawingRoutine ?? 0, movementType: r.movementType ?? 0, size: r.size ?? 1,
    damageModifier: r.damageModifier ?? [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], loftempsSet: r.loftempsSet ?? [3],
    forcedTorso: r.forcedTorso ?? 0, constantAnimation: !!r.constantAnimation, deathFrames: r.deathFrames ?? 3, allowInv: r.allowInv ?? true,
  });
}

export const UNITS = new Map<string, UnitRule>();
for (const r of (data as any).units) {
  UNITS.set(r.type, {
    type: r.type, race: r.race ?? r.type, rank: r.rank ?? "", stats: { ...r.stats }, armor: r.armor,
    standHeight: r.standHeight, kneelHeight: r.kneelHeight, floatHeight: r.floatHeight ?? 0, value: r.value ?? 0,
    deathSound: Array.isArray(r.deathSound) ? r.deathSound : r.deathSound != null ? [r.deathSound] : [],
    moveSound: r.moveSound ?? -1, energyRecovery: r.energyRecovery ?? 30, specab: r.specab ?? 0, livingWeapon: !!r.livingWeapon,
    spawnUnit: r.spawnUnit ?? "", capturable: r.capturable ?? true,
    intelligence: r.intelligence ?? 2, aggression: r.aggression ?? 1,
  });
}

/** X-COM soldier template (soldiers.rul). */
export const SOLDIER = {
  minStats: { tu: 50, stamina: 40, health: 25, bravery: 10, reactions: 30, firing: 40, throwing: 50, strength: 20, psiStrength: 0, psiSkill: 0, melee: 20 } as Stats,
  maxStats: { tu: 60, stamina: 70, health: 40, bravery: 60, reactions: 60, firing: 70, throwing: 80, strength: 40, psiStrength: 100, psiSkill: 16, melee: 40 } as Stats,
  statCaps: { tu: 80, stamina: 100, health: 60, bravery: 100, reactions: 100, firing: 120, throwing: 120, strength: 70, psiStrength: 100, psiSkill: 100, melee: 120 } as Stats,
  standHeight: 22, kneelHeight: 14, deathMale: [41, 42, 43], deathFemale: [44, 45, 46],
};

export const TERRAINS = new Map<string, TerrainRule>();
function normGroups(g: any): number[] {
  if (g == null) return [0];
  return Array.isArray(g) ? g : [g];
}
for (const t of (data as any).terrains) {
  TERRAINS.set(t.name, { name: t.name, mapDataSets: t.mapDataSets, script: t.script, mapBlocks: t.mapBlocks.map((b: any) => ({ name: b.name, width: b.width, length: b.length, groups: normGroups(b.groups) })) });
}
export const UFO_TERRAINS = new Map<string, TerrainRule>();
for (const t of (data as any).ufoTerrains) {
  UFO_TERRAINS.set(t.type, { name: t.name, mapDataSets: t.mapDataSets, mapBlocks: t.mapBlocks.map((b: any) => ({ name: b.name, width: b.width, length: b.length, groups: [0] })) });
}
export const CRAFT_TERRAIN: TerrainRule = (() => {
  const t = (data as any).craftTerrains.find((c: any) => c.type === "STR_SKYRANGER");
  return { name: t.name, mapDataSets: t.mapDataSets, mapBlocks: t.mapBlocks.map((b: any) => ({ name: b.name, width: b.width, length: b.length, groups: [0] })) };
})();

export const PEDIA_IMAGES: Record<string, string> = (data as any).pediaImages;
/** 11 bullet types x 35 particles x 3x3 palette indices. */
export const BULLETS: number[][][] = (data as any).bullets;

export function itemRule(type: string): ItemRule {
  const r = ITEMS.get(type);
  if (!r) throw new Error("unknown item " + type);
  return r;
}
export function unitRule(type: string): UnitRule {
  const r = UNITS.get(type);
  if (!r) throw new Error("unknown unit " + type);
  return r;
}
export function armorRule(type: string): ArmorRule {
  const r = ARMORS.get(type);
  if (!r) throw new Error("unknown armor " + type);
  return r;
}

export function explosionRadius(r: ItemRule): number {
  if (r.blastRadius !== -1) return r.blastRadius;
  let radius = 0;
  if (r.damageType === DamageType.IN) radius = Math.floor(r.power / 30) + 1;
  else if (r.damageType === DamageType.HE || r.damageType === DamageType.STUN || r.damageType === DamageType.SMOKE) radius = Math.floor(r.power / 20);
  return Math.min(11, radius);
}

/** The innate weapon given to living-weapon units: race STR_CHRYSSALID -> CHRYSSALID_WEAPON. */
export function livingWeaponFor(u: UnitRule): string | null {
  if (u.type.startsWith("STR_TANK_") || u.type.startsWith("STR_HOVERTANK_")) return u.type;
  if (!u.livingWeapon) return null;
  const w = u.race.substring(4) + "_WEAPON";
  return ITEMS.has(w) ? w : null;
}

/** Ammo that ships with HWPs (their turret is fixed; the magazine is part of the unit). */
export function hwpAmmoFor(u: UnitRule): string | null {
  const w = ITEMS.get(u.type);
  if (!w || !w.compatibleAmmo.length) return null;
  return w.compatibleAmmo[0];
}

export const INVENTORY_SLOTS = {
  STR_GROUND: { x: 0, y: 152, type: 2, cells: [] as [number, number][] },
  STR_RIGHT_HAND: { x: 0, y: 63, type: 1, cells: [] as [number, number][] },
  STR_LEFT_HAND: { x: 128, y: 63, type: 1, cells: [] as [number, number][] },
  STR_BELT: { x: 192, y: 104, type: 0, cells: [[0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [3, 1]] as [number, number][] },
  STR_RIGHT_LEG: { x: 0, y: 120, type: 0, cells: [[0, 0], [1, 0]] as [number, number][] },
  STR_LEFT_LEG: { x: 128, y: 120, type: 0, cells: [[0, 0], [1, 0]] as [number, number][] },
  STR_RIGHT_SHOULDER: { x: 16, y: 37, type: 0, cells: [[0, 0], [1, 0]] as [number, number][] },
  STR_LEFT_SHOULDER: { x: 112, y: 37, type: 0, cells: [[0, 0], [1, 0]] as [number, number][] },
  STR_BACK_PACK: { x: 192, y: 37, type: 0, cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] as [number, number][] },
};
export type SlotId = keyof typeof INVENTORY_SLOTS;
export const SLOT_W = 16, SLOT_H = 16, HAND_W = 2, HAND_H = 3, GROUND_W = 20, GROUND_H = 3;

/** TU cost of moving an item between inventory sections (inventories.rul). */
export const INVENTORY_COSTS: Record<SlotId, Partial<Record<SlotId, number>>> = {
  STR_GROUND: { STR_BACK_PACK: 20, STR_BELT: 12, STR_LEFT_HAND: 8, STR_LEFT_LEG: 10, STR_LEFT_SHOULDER: 12, STR_RIGHT_HAND: 8, STR_RIGHT_LEG: 10, STR_RIGHT_SHOULDER: 12 },
  STR_RIGHT_HAND: { STR_BACK_PACK: 14, STR_BELT: 8, STR_GROUND: 2, STR_LEFT_HAND: 4, STR_LEFT_LEG: 10, STR_LEFT_SHOULDER: 10, STR_RIGHT_LEG: 8, STR_RIGHT_SHOULDER: 10 },
  STR_LEFT_HAND: { STR_BACK_PACK: 14, STR_BELT: 8, STR_GROUND: 2, STR_LEFT_LEG: 8, STR_LEFT_SHOULDER: 10, STR_RIGHT_HAND: 4, STR_RIGHT_LEG: 10, STR_RIGHT_SHOULDER: 10 },
  STR_BELT: { STR_BACK_PACK: 16, STR_GROUND: 6, STR_LEFT_HAND: 4, STR_LEFT_LEG: 10, STR_LEFT_SHOULDER: 12, STR_RIGHT_HAND: 4, STR_RIGHT_LEG: 10, STR_RIGHT_SHOULDER: 12 },
  STR_RIGHT_LEG: { STR_BACK_PACK: 18, STR_BELT: 10, STR_GROUND: 6, STR_LEFT_HAND: 6, STR_LEFT_LEG: 10, STR_LEFT_SHOULDER: 10, STR_RIGHT_HAND: 4, STR_RIGHT_SHOULDER: 10 },
  STR_LEFT_LEG: { STR_BACK_PACK: 18, STR_BELT: 10, STR_GROUND: 6, STR_LEFT_HAND: 4, STR_LEFT_SHOULDER: 10, STR_RIGHT_HAND: 6, STR_RIGHT_LEG: 10, STR_RIGHT_SHOULDER: 10 },
  STR_RIGHT_SHOULDER: { STR_BACK_PACK: 16, STR_BELT: 10, STR_GROUND: 4, STR_LEFT_HAND: 3, STR_LEFT_LEG: 12, STR_LEFT_SHOULDER: 8, STR_RIGHT_HAND: 3, STR_RIGHT_LEG: 12 },
  STR_LEFT_SHOULDER: { STR_BACK_PACK: 16, STR_BELT: 10, STR_GROUND: 4, STR_LEFT_HAND: 3, STR_LEFT_LEG: 12, STR_RIGHT_HAND: 3, STR_RIGHT_LEG: 12, STR_RIGHT_SHOULDER: 8 },
  STR_BACK_PACK: { STR_BELT: 12, STR_GROUND: 10, STR_LEFT_HAND: 8, STR_LEFT_LEG: 16, STR_LEFT_SHOULDER: 14, STR_RIGHT_HAND: 8, STR_RIGHT_LEG: 16, STR_RIGHT_SHOULDER: 14 },
};

export interface PlacedItem { type: string; slot: string; x: number; y: number }

/** Whether `type` fits at x,y of `slot` next to the items already placed (ground always fits). */
export function fitsSlot(placed: PlacedItem[], type: string, slot: string, x: number, y: number): boolean {
  const def = (INVENTORY_SLOTS as Record<string, (typeof INVENTORY_SLOTS)[SlotId]>)[slot];
  if (!def || !ITEMS.has(type)) return false;
  if (def.type === 2) return true;
  if (def.type === 1) return x === 0 && y === 0 && !placed.some((p) => p.slot === slot);
  const r = itemRule(type);
  for (let i = 0; i < r.invWidth; i++)
    for (let j = 0; j < r.invHeight; j++) if (!def.cells.some(([cx, cy]) => cx === x + i && cy === y + j)) return false;
  return !placed.some((p) => {
    if (p.slot !== slot) return false;
    const o = itemRule(p.type);
    return x < p.x + o.invWidth && p.x < x + r.invWidth && y < p.y + o.invHeight && p.y < y + r.invHeight;
  });
}
