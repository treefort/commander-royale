// Combat value model behind recruit prices. Calibrated with bot-vs-bot duels (tools/duels.ts):
// at equal money, a squad of any one kind of hire should beat a mixed reference platoon about
// half the time.
//
// In a firefight a squad's strength grows with the square of its numbers (Lanchester), so a unit
// worth q times as much in combat (offense x durability) is fairly priced at about sqrt(q) times
// as much. Durability is health scaled by how much armor cuts damage from a typical mix of guns
// (damage rolls 0-200% of power, then armor is subtracted); offense is expected damage per turn.
import { DamageType, BattleType, itemRule, armorRule, explosionRadius, ITEMS, type ItemRule, type Stats, type ArmorRule } from "./index.ts";

/** The guns a unit can expect to be shot with: rifle, heavy cannon AP, laser rifle, plasma rifle, rocket. */
const THREATS: { power: number; type: DamageType }[] = [
  { power: 30, type: DamageType.AP }, { power: 56, type: DamageType.AP }, { power: 60, type: DamageType.LASER },
  { power: 80, type: DamageType.PLASMA }, { power: 75, type: DamageType.HE },
];
/** Armor the unit's own shots meet: unarmored soldiers, lightly armored aliens, power suits / Mutons. */
const TARGET_ARMOR = [8, 12, 20, 30, 45];

/** Expected damage of one hit rolled uniformly in [0, 2P] against armor A. */
export function expectedDamage(power: number, armor: number): number {
  if (power <= 0) return 0;
  if (armor >= 2 * power) return 0;
  return (2 * power - armor) ** 2 / (4 * power);
}

/** How many times longer a unit lasts than an unarmored one against the threat mix. */
export function armorMultiplier(a: ArmorRule): number {
  // facing weights: shots mostly come from the front and sides
  const sides = [[a.front, 0.4], [a.side, 0.4], [a.rear, 0.15], [a.under, 0.05]] as const;
  let total = 0;
  for (const t of THREATS) {
    const p = t.power * (a.damageModifier[t.type] ?? 1);
    let e = 0;
    for (const [armor, w] of sides) e += w * expectedDamage(p, armor);
    // explosions hit the underside with less spread; treat them like the rest
    total += t.power / Math.max(e, t.power * 0.04);
  }
  return total / THREATS.length;
}

/** Expected damage per turn dealt with `weapon` (loaded with `ammo`) by a unit with these stats. */
export function weaponOffense(weapon: ItemRule, ammo: ItemRule | null, s: Stats): number {
  const dmgRule = ammo ?? weapon;
  const type = dmgRule.damageType;
  let power = dmgRule.power || weapon.power;
  if (weapon.battleType === BattleType.MELEE) {
    if (weapon.strengthApplied) power += s.strength;
    const acc = Math.min(1, (weapon.skillApplied ? s.melee / 100 : 1) * (weapon.accuracyMelee / 100));
    const cost = weapon.flatRate ? weapon.tuMelee / Math.max(1, s.tu) : weapon.tuMelee / 100;
    // only half the time is anyone in reach
    return 0.5 * (0.6 / Math.max(0.05, cost)) * acc * avgDamage(power, type === DamageType.STUN ? DamageType.STUN : type);
  }
  if (weapon.battleType !== BattleType.FIREARM) return 0;
  const radius = type === DamageType.HE || type === DamageType.IN || type === DamageType.STUN ? explosionRadius(dmgRule) : 0;
  let best = 0;
  const modes: [number, number, number][] = [[weapon.accuracySnap, weapon.tuSnap, 1], [weapon.accuracyAimed, weapon.tuAimed, 1], [weapon.accuracyAuto, weapon.tuAuto, weapon.autoShots]];
  for (const [acc, tu, shots] of modes) {
    if (!tu || !acc) continue;
    // 60% of the turn goes on shooting, the rest on moving
    const cost = weapon.flatRate ? tu / Math.max(1, s.tu) : tu / 100;
    const perTurn = 0.6 / cost;
    let hit = Math.min(0.95, (s.firing / 100) * (acc / 100));
    // a blast still hurts on a near miss, and may catch more than one target
    if (radius) hit = Math.max(hit, 0.55);
    const dmg = avgDamage(power, type) * (radius ? 1 + Math.min(4, radius) * 0.2 : 1);
    best = Math.max(best, perTurn * shots * hit * dmg);
  }
  return best;
}

function avgDamage(power: number, _type: DamageType): number {
  let e = 0;
  for (const a of TARGET_ARMOR) e += expectedDamage(power, a);
  return e / TARGET_ARMOR.length;
}

export interface UnitTraits {
  stats: Stats;
  armor: string;
  weapon: string | null; // innate weapon, or the reference gun for units that carry one
  ammo: string | null;
  psionic: boolean; // can make psi attacks (innate, or a soldier with psi skill)
  psionics: boolean; // psionics are on in this match
  nightVision: boolean;
  timeOfDay: "day" | "dusk" | "night";
  zombifies: boolean;
  spawnsOnDeath: boolean;
  explodesOnDeath: boolean;
}

/** Probability a psi attack by these stats takes control of an average defender (psi strength 40, untrained). */
export function mindControlChance(s: Stats, distance = 8): number {
  const attack = (s.psiStrength * s.psiSkill) / 50 - distance;
  const defense = 40 + 10 + 20;
  // success if attack + U(0..55) > defense
  return Math.max(0, Math.min(1, (55 - (defense - attack)) / 56));
}

export function combatValue(t: UnitTraits): { offense: number; durability: number } {
  const s = t.stats;
  const armor = armorRule(t.armor);
  let offense = t.weapon && ITEMS.has(t.weapon) ? weaponOffense(itemRule(t.weapon), t.ammo && ITEMS.has(t.ammo) ? itemRule(t.ammo) : null, s) : 0;
  // reaction fire on the enemy's turn
  offense *= 1 + s.reactions / 200;
  // a successful mind control turns an enemy for a turn (duels: worth less than it looks, as attempts are rare)
  if (t.psionic && t.psionics) offense += 0.5 * mindControlChance(s) * 40;
  if (t.nightVision) offense *= t.timeOfDay === "night" ? 1.35 : t.timeOfDay === "dusk" ? 1.15 : 1;
  if (t.zombifies) offense *= 1.3;
  if (t.explodesOnDeath) offense *= 1.1;
  // getting there: more time units, more often in position; flying goes anywhere
  offense *= Math.pow(Math.max(20, s.tu) / 60, 0.4) * (armor.movementType === 1 ? 1.1 : 1);
  let durability = s.health * armorMultiplier(armor);
  if (t.spawnsOnDeath) durability *= 1.5;
  // strong-willed units resist being mind controlled
  if (t.psionics) durability *= 1 + (s.psiStrength - 50) / 500;
  return { offense, durability };
}
