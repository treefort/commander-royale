// Per-unit rules: damage resolution, accuracy, action costs, turn recovery.
import { type Battle, type Unit, type Item, isOut, unitHeight } from "./state.ts";
import { type ActionType, type Pos, Side, BodyPart, UnitStatus } from "./defs.ts";
import { BattleType, DamageType, armorRule, itemRule, type ItemRule } from "../rules/index.ts";

export const FIRE_DAMAGE_MIN = 5, FIRE_DAMAGE_MAX = 10;

export function damageModifier(u: Unit, type: DamageType): number {
  return armorRule(u.armor).damageModifier[type] ?? 1;
}

/**
 * Applies damage to a unit. `relative` is the hit voxel relative to the unit's center bottom;
 * (0,0,0) means "from below/ground zero" (under armor).
 */
export function damageUnit(b: Battle, u: Unit, relative: Pos, power: number, type: DamageType, ignoreArmor = false): number {
  let side = Side.FRONT;
  let bodypart = BodyPart.TORSO;
  if (power <= 0) return 0;
  power = Math.floor(power * damageModifier(u, type));
  if (type === DamageType.SMOKE) type = DamageType.STUN;
  if (!ignoreArmor) {
    if (relative.x === 0 && relative.y === 0 && relative.z === 0) {
      side = Side.UNDER;
    } else {
      let relativeDirection: number;
      const ax = Math.abs(relative.x), ay = Math.abs(relative.y);
      if (ay > ax * 2) relativeDirection = 8 + 4 * (relative.y > 0 ? 1 : 0);
      else if (ax > ay * 2) relativeDirection = 10 + 4 * (relative.x < 0 ? 1 : 0);
      else if (relative.x < 0) relativeDirection = relative.y > 0 ? 13 : 15;
      else relativeDirection = relative.y > 0 ? 11 : 9;
      switch ((((relativeDirection - u.dir) % 8) + 8) % 8) {
        case 0: side = Side.FRONT; break;
        case 1: side = b.rng.int(0, 2) < 2 ? Side.FRONT : Side.RIGHT; break;
        case 2: side = Side.RIGHT; break;
        case 3: side = b.rng.int(0, 2) < 2 ? Side.REAR : Side.RIGHT; break;
        case 4: side = Side.REAR; break;
        case 5: side = b.rng.int(0, 2) < 2 ? Side.REAR : Side.LEFT; break;
        case 6: side = Side.LEFT; break;
        case 7: side = b.rng.int(0, 2) < 2 ? Side.FRONT : Side.LEFT; break;
      }
      if (relative.z >= unitHeight(u)) bodypart = BodyPart.HEAD;
      else if (relative.z > 4) bodypart = side === Side.LEFT ? BodyPart.LEFTARM : side === Side.RIGHT ? BodyPart.RIGHTARM : BodyPart.TORSO;
      else bodypart = side === Side.LEFT ? BodyPart.LEFTLEG : side === Side.RIGHT ? BodyPart.RIGHTLEG : (b.rng.int(BodyPart.RIGHTLEG, BodyPart.LEFTLEG) as BodyPart);
    }
    power -= u.armorNow[side];
  }
  if (power > 0) {
    if (type === DamageType.STUN) {
      u.stun += power;
    } else {
      u.health = Math.max(0, u.health - power);
      if (type !== DamageType.IN) {
        if (damageModifier(u, DamageType.STUN) > 0) u.stun += b.rng.int(0, Math.floor(power / 4));
        if (u.woundable && b.rng.int(0, 10) < power) u.wounds[bodypart] += b.rng.int(1, 3);
        u.armorNow[side] = Math.max(0, u.armorNow[side] - Math.floor(power / 10) - 1);
      }
    }
  }
  return power < 0 ? 0 : power;
}

export function totalWounds(u: Unit): number {
  return u.wounds.reduce((a, b) => a + b, 0);
}

export function actionTUs(u: Unit, action: ActionType, rule: ItemRule | null): number {
  if (!rule) return 0;
  let cost = 0;
  switch (action) {
    case "prime": cost = 50; break;
    case "throw": cost = 25; break;
    case "auto": cost = rule.tuAuto; break;
    case "snap": cost = rule.tuSnap; break;
    case "hit": cost = rule.tuMelee; break;
    case "launch":
    case "aimed": cost = rule.tuAimed; break;
    case "use":
    case "mindcontrol":
    case "panic": cost = rule.tuUse; break;
    default: cost = 0;
  }
  if (!rule.flatRate || action === "throw" || action === "prime") cost = Math.floor((u.stats.tu * cost) / 100);
  return cost;
}

export function accuracyModifier(b: Battle, u: Unit, item: Item | null): number {
  let wounds = u.wounds[BodyPart.HEAD];
  if (item) {
    const r = itemRule(item.type);
    if (r.twoHanded) wounds += u.wounds[BodyPart.RIGHTARM] + u.wounds[BodyPart.LEFTARM];
    else wounds += item.slot === "STR_RIGHT_HAND" ? u.wounds[BodyPart.RIGHTARM] : u.wounds[BodyPart.LEFTARM];
  }
  return Math.max(10, Math.floor((25 * u.health) / u.stats.health) + 75 - 10 * wounds);
}

export function firingAccuracy(b: Battle, u: Unit, action: ActionType, item: Item): number {
  const r = itemRule(item.type);
  let weaponAcc = r.accuracySnap;
  if (action === "aimed" || action === "launch") weaponAcc = r.accuracyAimed;
  else if (action === "auto") weaponAcc = r.accuracyAuto;
  else if (action === "hit") {
    if (r.skillApplied) return Math.floor((Math.floor((u.stats.melee * r.accuracyMelee) / 100) * accuracyModifier(b, u, item)) / 100);
    return Math.floor((r.accuracyMelee * accuracyModifier(b, u, item)) / 100);
  }
  let result = Math.floor((u.stats.firing * weaponAcc) / 100);
  if (u.kneeled) result = Math.floor((result * 115) / 100);
  if (r.twoHanded && b.itemInSlot(u, "STR_RIGHT_HAND") && b.itemInSlot(u, "STR_LEFT_HAND")) result = Math.floor((result * 80) / 100);
  return Math.floor((result * accuracyModifier(b, u, item)) / 100);
}

export function throwingAccuracy(b: Battle, u: Unit): number {
  return (u.stats.throwing * accuracyModifier(b, u, null)) / 100;
}

export function reactionScore(u: Unit): number {
  return (u.stats.reactions * u.tu) / u.stats.tu;
}

export function checkViewSector(u: Unit, p: Pos): boolean {
  const dx = p.x - u.pos.x;
  const dy = u.pos.y - p.y;
  switch (u.dir) {
    case 0: return dx + dy >= 0 && dy - dx >= 0;
    case 1: return dx >= 0 && dy >= 0;
    case 2: return dx + dy >= 0 && dy - dx <= 0;
    case 3: return dy <= 0 && dx >= 0;
    case 4: return dx + dy <= 0 && dy - dx <= 0;
    case 5: return dx <= 0 && dy <= 0;
    case 6: return dx + dy <= 0 && dy - dx >= 0;
    case 7: return dy >= 0 && dx <= 0;
  }
  return false;
}

export function carriedWeight(b: Battle, u: Unit, excluding?: Item): number {
  let w = 0;
  for (const it of b.items) {
    if (it.owner !== u.id || it === excluding) continue;
    const r = itemRule(it.type);
    if (r.fixedWeapon) continue;
    w += r.weight;
    if (it.ammo >= 0 && it.ammo !== it.id) {
      const a = b.item(it.ammo);
      if (a) w += itemRule(a.type).weight;
    }
  }
  return w;
}

export function recoverTimeUnits(b: Battle, u: Unit) {
  let rec = u.stats.tu;
  const weight = carriedWeight(b, u);
  if (weight > 0) {
    const enc = u.stats.strength / weight;
    if (enc < 1) rec = Math.floor(enc * rec);
  }
  rec -= Math.floor((rec * ((u.wounds[BodyPart.LEFTLEG] + u.wounds[BodyPart.RIGHTLEG]) * 10)) / 100);
  u.tu = Math.max(0, rec);
  if (!isOut(u)) {
    let en = u.energyRecovery;
    en -= Math.floor((u.energy * (u.wounds[BodyPart.TORSO] * 10)) / 100);
    u.energy = Math.max(0, Math.min(u.stats.stamina, u.energy + en));
  }
}

/** Start-of-turn processing for a unit about to act: wounds, burning, stun recovery, TU refresh. */
export function prepareUnitTurn(b: Battle, u: Unit) {
  if (u.status === UnitStatus.IGNORE_ME) return;
  u.spottedThisTurn = [];
  if (u.owner !== u.originalOwner) {
    // mind control wears off when the controller's next turn comes round; the unit's
    // own turn processing (wounds, fire, stun) happens on its owner's turn
    u.owner = u.originalOwner;
    u.mindControllerId = -1;
    return;
  }
  recoverTimeUnits(b, u);
  u.motionPoints = 0;
  u.health -= totalWounds(u);
  if (!u.hitByFire && u.fire > 0) {
    u.health -= Math.floor(damageModifier(u, DamageType.IN) * b.rng.int(FIRE_DAMAGE_MIN, FIRE_DAMAGE_MAX));
    u.fire--;
  }
  if (u.health < 0) u.health = 0;
  if (u.stun > 0 && (u.size === 1 || !isOut(u))) u.stun = Math.max(0, u.stun - 1);
  u.hitByFire = false;
}

export function heal(u: Unit, part: number, woundAmount: number, healthAmount: number) {
  if (part < 0 || part > 5 || !u.wounds[part]) return;
  u.wounds[part] = Math.max(0, u.wounds[part] - woundAmount);
  u.health = Math.min(u.stats.health, u.health + healthAmount);
}

/** The weapon a unit uses for reaction fire: loaded, quickest snap shot. */
export function mainHandWeapon(b: Battle, u: Unit, quickest = true): Item | null {
  const loaded = (it: Item | undefined) => {
    if (!it) return null;
    if (it.ammo < 0) return null;
    const a = b.item(it.ammo);
    if (!a) return null;
    if (a.id !== it.id && a.ammoQty <= 0) return null;
    return it;
  };
  const r = loaded(b.itemInSlot(u, "STR_RIGHT_HAND"));
  const l = loaded(b.itemInSlot(u, "STR_LEFT_HAND"));
  if (r && !l) return r;
  if (l && !r) return l;
  if (!r || !l) return null;
  const tr = itemRule(r.type).tuSnap, tl = itemRule(l.type).tuSnap;
  if (tl <= 0 && tr > 0) return r;
  if (tr <= 0 && tl > 0) return l;
  if (!quickest) return u.activeHand === "STR_LEFT_HAND" ? l : r;
  return tl >= tr ? r : l;
}

export function meleeWeapon(b: Battle, u: Unit): Item | null {
  for (const slot of ["STR_RIGHT_HAND", "STR_LEFT_HAND"] as const) {
    const it = b.itemInSlot(u, slot);
    if (it && itemRule(it.type).battleType === BattleType.MELEE) return it;
  }
  return null;
}

export function ammoOf(b: Battle, it: Item): Item | null {
  if (it.ammo < 0) return null;
  return b.item(it.ammo) ?? null;
}

/** Rounds left in a weapon; Infinity for built-in power (lasers, living weapons). */
export function roundsLeft(b: Battle, it: Item): number {
  const a = ammoOf(b, it);
  if (!a) return 0;
  if (a.id === it.id) return Infinity;
  return a.ammoQty;
}

export function isSelectableBy(u: Unit, player: number): boolean {
  return u.owner === player && !isOut(u);
}

export function unitCanAct(u: Unit): boolean {
  return !isOut(u) && u.health > 0 && u.stun < u.health;
}
