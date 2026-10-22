// Creating battle units from recruits (X-COM soldiers, alien race/ranks, HWPs).
import { type Battle, type Unit } from "./state.ts";
import { UnitStatus, type Pos } from "./defs.ts";
import { SOLDIER, armorRule, unitRule, itemRule, livingWeaponFor, hwpAmmoFor, type Stats } from "../rules/index.ts";
import type { Recruit } from "../protocol.ts";

export function createUnit(b: Battle, r: Recruit, armorType: string, owner: number, pos: Pos, dir: number): Unit {
  const isSoldier = r.kind === "soldier";
  const rule = isSoldier ? null : unitRule(r.type);
  const armor = armorRule(isSoldier ? armorType || "STR_NONE_UC" : rule!.armor);
  const stats: Stats = { ...r.stats };
  const u: Unit = {
    id: b.nextUnitId++,
    owner,
    originalOwner: owner,
    type: isSoldier ? "SOLDIER" : r.type,
    race: isSoldier ? "STR_HUMAN" : rule!.race,
    name: r.name,
    rank: r.rank,
    rankInt: 0,
    gender: r.gender,
    look: r.look,
    armor: armor.type,
    stats,
    baseHeights: isSoldier
      ? { stand: SOLDIER.standHeight, kneel: SOLDIER.kneelHeight, float: 0 }
      : { stand: rule!.standHeight, kneel: rule!.kneelHeight, float: rule!.floatHeight },
    pos: { ...pos },
    dir,
    turretDir: dir,
    turretType: -1,
    tu: stats.tu,
    energy: stats.stamina,
    health: stats.health,
    stun: 0,
    morale: 100,
    kneeled: false,
    floating: false,
    status: UnitStatus.STANDING,
    armorMax: [armor.front, armor.side, armor.side, armor.rear, armor.under],
    armorNow: [armor.front, armor.side, armor.side, armor.rear, armor.under],
    wounds: [0, 0, 0, 0, 0, 0],
    fire: 0,
    loftemps: armor.loftempsSet,
    movementType: armor.movementType,
    size: armor.size,
    specab: rule ? rule.specab : 0,
    spawnUnit: rule ? rule.spawnUnit : "",
    spawnOwner: -1,
    respawn: false,
    deathSound: isSoldier ? (r.gender ? SOLDIER.deathFemale : SOLDIER.deathMale) : rule!.deathSound,
    moveSound: rule ? rule.moveSound : -1,
    energyRecovery: isSoldier ? Math.floor(stats.tu / 3) : rule!.energyRecovery,
    woundable: isSoldier,
    nightVision: r.kind === "alien",
    hasInventory: r.kind !== "hwp",
    visibleUnits: [],
    spottedThisTurn: [],
    mindControllerId: -1,
    kills: 0,
    activeHand: "STR_RIGHT_HAND",
    psiWeapon: r.kind === "alien" && stats.psiSkill > 0 && b.settings.psionics,
    hitByFire: false,
    motionPoints: 0,
    killedBy: -1,
    value: r.price,
    recruitId: r.id,
    hwp: r.kind === "hwp",
  };
  if (!b.settings.psionics) {
    u.stats.psiSkill = 0;
  }
  b.addUnit(u);
  b.placeUnit(u, pos);

  // innate weapons: terror unit attacks, HWP turrets (with their magazine)
  if (rule) {
    const w = livingWeaponFor(rule);
    if (w) {
      const wr = itemRule(w);
      const it = b.createItem(w);
      b.moveItemToUnit(it, u, "STR_RIGHT_HAND", 0, 0);
      if (wr.compatibleAmmo.length) {
        const ammoType = hwpAmmoFor(rule)!;
        const a = b.createItem(ammoType, { ammoQty: itemRule(ammoType).clipSize });
        a.owner = -2; // loaded clips live inside their weapon
        it.ammo = a.id;
      } else {
        it.ammo = it.id;
      }
      if (wr.turretType >= 0) u.turretType = wr.turretType;
    }
  }
  return u;
}

/** Puts a newly created item into a unit's inventory slot (used when deploying loadouts). */
export function giveItem(b: Battle, u: Unit, type: string, slot: string, x: number, y: number, ammoType?: string) {
  const r = itemRule(type);
  const it = b.createItem(type);
  b.moveItemToUnit(it, u, slot as never, x, y);
  if (r.clipSize === -1 || (r.battleType === 3 && !r.compatibleAmmo.length) || (r.battleType !== 1 && r.battleType !== 2 && !r.compatibleAmmo.length)) {
    it.ammo = it.id;
  }
  if (r.battleType === 2) it.ammoQty = r.clipSize;
  if (ammoType) {
    const a = b.createItem(ammoType, { ammoQty: itemRule(ammoType).clipSize });
    a.owner = -2;
    it.ammo = a.id;
  }
  return it;
}

/** Creates a loose item on the ground (stash, supply drops). */
export function spawnGroundItem(b: Battle, type: string, tile: number) {
  const r = itemRule(type);
  const it = b.createItem(type, { tile, slot: "STR_GROUND" });
  if (r.clipSize === -1 || (r.battleType !== 1 && r.battleType !== 2 && !r.compatibleAmmo.length)) it.ammo = it.id;
  if (r.battleType === 2) it.ammoQty = r.clipSize;
  return it;
}
