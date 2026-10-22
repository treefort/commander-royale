// The authoritative action processor: validates and fully resolves player commands, including
// reaction fire, explosions, deaths and chain reactions, recording events for every player.
import { type Battle, type Unit, type Item, isOut, unitHeight, floatHeight, Phase } from "./state.ts";
import { type Pos, type ActionType, VoxelType, DIR_UP, DIR_DOWN, UnitStatus, DX, DY, directionTo, distanceSq, tileDistance, MAX_VIEW_DISTANCE_SQR, posEq } from "./defs.ts";
import { TilePart } from "../formats/terrain.ts";
import { BattleEvents, appearance } from "./events.ts";
import { Pathfinder } from "./pathfinding.ts";
import {
  calculateFOV, refreshVisibleUnits, recalculateAllFOV, calculateLine, calculateParabola, canTargetUnit, canTargetTile, originVoxel,
  hit, explode, findTerrainExplosion, unitOpensDoor, closeUfoDoors, validMeleeRange, validateThrow, validThrowRange, positionFromEnd,
  ITEM_DROP_VOXEL_OFFSET, applyGravity, calculateTerrainLighting, calculateUnitLighting, calculateSunShading, recalcAllLighting,
  isUnitVisibleTo, visible, sightOriginVoxel, horizontalBlockage, ignite, destroyPart,
} from "./tileengine.ts";
import {
  actionTUs, firingAccuracy, throwingAccuracy, reactionScore, checkViewSector, mainHandWeapon, meleeWeapon, ammoOf, roundsLeft,
  prepareUnitTurn, heal, carriedWeight, recoverTimeUnits, damageModifier, unitCanAct, damageUnit,
} from "./unitops.ts";
import {
  BattleType, DamageType, itemRule, armorRule, unitRule, explosionRadius, livingWeaponFor, INVENTORY_SLOTS, INVENTORY_COSTS,
  ITEMS, type SlotId, type ItemRule, tr,
} from "../rules/index.ts";
import { createUnit, spawnGroundItem } from "./units.ts";
import { openSkyTiles, canStand } from "./mapgen.ts";
import { rollSupplyDrop } from "../rules/catalog.ts";
import { recordCommand, recordEvents } from "./stats.ts";

export type Hand = "STR_RIGHT_HAND" | "STR_LEFT_HAND";

export type Command =
  | { c: "move"; unit: number; to: Pos }
  | { c: "turn"; unit: number; to: Pos }
  | { c: "kneel"; unit: number }
  | { c: "shoot"; unit: number; hand: Hand; mode: "snap" | "aimed" | "auto"; target: Pos }
  | { c: "launch"; unit: number; hand: Hand; waypoints: Pos[] }
  | { c: "throw"; unit: number; hand: Hand; target: Pos }
  | { c: "prime"; unit: number; hand: Hand; fuse: number }
  | { c: "melee"; unit: number; hand: Hand; target: Pos }
  | { c: "psi"; unit: number; hand: Hand | "innate"; target: Pos }
  | { c: "medikit"; unit: number; hand: Hand; target: number; part: number; mode: "heal" | "stim" | "pain" }
  | { c: "scan"; unit: number; hand: Hand }
  | { c: "probe"; unit: number; hand: Hand; target: Pos }
  | { c: "inv"; unit: number; item: number; slot: SlotId; x: number; y: number }
  | { c: "load"; unit: number; weapon: number; ammo: number }
  | { c: "unload"; unit: number; weapon: number }
  | { c: "hand"; unit: number; hand: Hand }
  | { c: "endturn" }
  | { c: "surrender" };

export interface ActionResult {
  ok: boolean;
  error?: string;
  events: BattleEvents;
  /** results only the acting player receives (motion scanner, mind probe) */
  privateData?: unknown;
}

const NOT_ENOUGH_TU = "STR_NOT_ENOUGH_TIME_UNITS";

export class GameRules {
  constructor(public b: Battle) {}

  apply(player: number, cmd: Command): ActionResult {
    const res = this.applyInner(player, cmd);
    recordEvents(this.b, res.events);
    return res;
  }

  private applyInner(player: number, cmd: Command): ActionResult {
    const b = this.b;
    const ev = new BattleEvents(b);
    const res: ActionResult = { ok: true, events: ev };
    if (b.phase !== Phase.PLAYING) return { ok: false, error: "STR_GAME_OVER", events: ev };
    if (cmd.c === "surrender") {
      this.surrender(player, ev);
      return res;
    }
    if (player !== b.current) return { ok: false, error: "STR_NOT_YOUR_TURN", events: ev };
    if (cmd.c === "endturn") {
      this.endTurn(ev);
      return res;
    }
    const invalid = validateCommand(b, cmd);
    if (invalid) return { ok: false, error: invalid, events: ev };
    const u = b.unit(cmd.unit);
    if (!u || u.owner !== player || !unitCanAct(u)) return { ok: false, error: "STR_INVALID_UNIT", events: ev };
    const tuBefore = u.tu;
    let err: string | undefined;
    switch (cmd.c) {
      case "move": err = this.move(u, cmd.to, ev); break;
      case "turn": err = this.turn(u, cmd.to, ev); break;
      case "kneel": err = this.kneel(u, ev); break;
      case "shoot": err = this.shoot(u, cmd.hand, cmd.mode, cmd.target, ev); break;
      case "launch": err = this.launch(u, cmd.hand, cmd.waypoints, ev); break;
      case "throw": err = this.throwItem(u, cmd.hand, cmd.target, ev); break;
      case "prime": err = this.prime(u, cmd.hand, cmd.fuse); break;
      case "melee": err = this.melee(u, cmd.hand, cmd.target, ev); break;
      case "psi": err = this.psi(u, cmd.hand, cmd.target, ev); break;
      case "medikit": err = this.medikit(u, cmd.hand, cmd.target, cmd.part, cmd.mode, ev); break;
      case "scan": {
        const r = this.scan(u, cmd.hand);
        if (typeof r === "string") err = r;
        else res.privateData = r;
        break;
      }
      case "probe": {
        const r = this.probe(u, cmd.hand, cmd.target);
        if (typeof r === "string") err = r;
        else res.privateData = r;
        break;
      }
      case "inv": err = this.inventoryMove(u, cmd.item, cmd.slot, cmd.x, cmd.y, ev); break;
      case "load": err = this.load(u, cmd.weapon, cmd.ammo); break;
      case "unload": err = this.unload(u, cmd.weapon); break;
      case "hand": u.activeHand = cmd.hand; break;
    }
    this.settle(ev);
    // a player who lost their last unit during their own turn hands the turn on
    for (let guard = 0; guard < b.players.length && b.phase === Phase.PLAYING && b.players[b.current].eliminated; guard++) this.endTurn(ev);
    if (err) {
      res.ok = false;
      res.error = err;
    } else recordCommand(b, u, cmd.c, tuBefore);
    return res;
  }

  // ------------------------------------------------------------------------------------------
  // movement
  // ------------------------------------------------------------------------------------------

  /** Recomputes what changed after a unit moved: its own sight, and who now sees it. */
  private afterUnitMoved(u: Unit) {
    const b = this.b;
    calculateUnitLighting(b);
    calculateFOV(b, u, true);
    for (const o of b.units) {
      if (o === u || isOut(o) || o.owner === u.owner) continue;
      if (distanceSq(o.pos, u.pos, false) <= MAX_VIEW_DISTANCE_SQR + 4 || o.visibleUnits.includes(u.id)) refreshVisibleUnits(b, o);
    }
  }

  move(u: Unit, to: Pos, ev: BattleEvents): string | undefined {
    const b = this.b;
    if (u.kneeled) {
      const e = this.kneel(u, ev);
      if (e) return e;
    }
    let pf = new Pathfinder(b, u);
    const path = pf.calculate(to);
    if (!path || !path.length) return "STR_NO_PATH";
    const spottedBefore = u.spottedThisTurn.length;
    let i = 0;
    while (i < path.length) {
      if (isOut(u) || !unitCanAct(u)) break;
      const dir = path[i];
      let { cost, dest } = pf.tuCost(u.pos, dir);
      if (cost >= 255) return "STR_PATH_BLOCKED";
      const energy = dir >= DIR_UP ? 0 : cost;
      if (cost > u.tu) return NOT_ENOUGH_TU;
      if (Math.floor(energy / 2) > u.energy) return "STR_NOT_ENOUGH_ENERGY";
      // face the direction of travel (free while walking)
      if (dir < DIR_UP && dir !== u.dir) {
        u.dir = dir;
        if (u.turretType >= 0) u.turretDir = dir;
        ev.push({ t: "turn", unit: u.id, dir }, ev.seers(u));
        calculateFOV(b, u, true);
        if (u.spottedThisTurn.length > spottedBefore) break;
      }
      if (dir < DIR_UP) {
        const door = unitOpensDoor(b, ev, u, false, dir);
        if (door === 4) return NOT_ENOUGH_TU;
        if (door === 0 || door === 1) {
          this.afterTerrainChange(ev, u.pos);
          pf = new Pathfinder(b, u);
          ({ cost, dest } = pf.tuCost(u.pos, dir));
          if (cost >= 255) break;
          if (cost > u.tu) return NOT_ENOUGH_TU;
        }
      }
      // bumping into a unit we didn't know about ends the move
      let blocked = false;
      for (let x = 0; x < u.size; x++)
        for (let y = 0; y < u.size; y++) {
          const t = b.idx(dest.x + x, dest.y + y, dest.z);
          const o = b.unitOnTile(t);
          if (o && o !== u) blocked = true;
          const below = b.idx(dest.x + x, dest.y + y, dest.z - 1);
          const ob = below >= 0 ? b.unitOnTile(below) : undefined;
          if (ob && ob !== u && -b.terrainLevel(below) + floatHeight(ob) + unitHeight(ob) >= 28) blocked = true;
        }
      if (blocked) {
        u.dir = dir < DIR_UP ? dir : u.dir;
        calculateFOV(b, u, true);
        break;
      }
      const seersBefore = ev.seers(u);
      u.tu -= cost;
      u.energy = Math.max(0, u.energy - Math.floor(energy / 2));
      const from = { ...u.pos };
      b.placeUnit(u, dest);
      const below = b.idx(dest.x, dest.y, dest.z - 1);
      u.floating = u.movementType === 1 && b.hasNoFloor(b.idxP(dest), below) && dest.z > 0;
      u.motionPoints += u.size > 1 ? 30 : u.baseHeights.stand > 16 ? 4 : 3;
      this.afterUnitMoved(u);
      ev.push({ t: "move", unit: u.id, from, to: { ...dest }, dir: u.dir, fly: u.floating || dir >= DIR_UP, app: appearance(b, u) }, seersBefore | ev.seers(u));
      i++;
      // walkers who end up over a hole drop down
      if (u.movementType !== 1 && dest.z > 0 && b.hasNoFloor(b.idxP(dest), below)) applyGravity(b, ev, b.idxP(dest));
      if (this.checkProximityGrenades(u, ev)) break;
      if (u.spottedThisTurn.length > spottedBefore) break; // "enemy spotted": stop to let the player react
      if (this.checkReactionFire(u, ev)) break;
    }
    return undefined;
  }

  turn(u: Unit, to: Pos, ev: BattleEvents, free = false, turretOnly = false): string | undefined {
    const b = this.b;
    const target = directionTo(u.pos, to);
    const current = turretOnly ? u.turretDir : u.dir;
    if (target === current && !free) {
      // already facing it: try to open a door instead
      const door = unitOpensDoor(b, ev, u, true, u.dir);
      if (door === 4) return NOT_ENOUGH_TU;
      if (door === 0 || door === 1) this.afterTerrainChange(ev, u.pos);
      return undefined;
    }
    const spotted = u.spottedThisTurn.length;
    let d = current;
    while (d !== target) {
      const delta = (target - d + 8) % 8;
      if (!free) {
        if (u.tu < 1) return NOT_ENOUGH_TU;
        u.tu -= 1;
      }
      d = (d + (delta <= 4 ? 1 : 7)) % 8;
      if (turretOnly) u.turretDir = d;
      else {
        u.dir = d;
        if (u.turretType >= 0) u.turretDir = d;
      }
      ev.push({ t: "turn", unit: u.id, dir: u.dir, turret: u.turretDir }, ev.seers(u));
      calculateFOV(b, u, true);
      if (!free && u.spottedThisTurn.length > spotted) break;
    }
    return undefined;
  }

  kneel(u: Unit, ev: BattleEvents): string | undefined {
    if (u.type !== "SOLDIER" || u.floating) return "STR_CANNOT_KNEEL";
    const cost = u.kneeled ? 8 : 4;
    if (u.tu < cost) return NOT_ENOUGH_TU;
    u.tu -= cost;
    u.kneeled = !u.kneeled;
    ev.push({ t: "kneel", unit: u.id, kneeled: u.kneeled }, ev.seers(u));
    this.afterUnitMoved(u);
    this.checkReactionFire(u, ev);
    return undefined;
  }

  // ------------------------------------------------------------------------------------------
  // firing
  // ------------------------------------------------------------------------------------------

  private weaponIn(u: Unit, hand: Hand): Item | undefined {
    return this.b.itemInSlot(u, hand);
  }

  private targetVoxelFor(u: Unit, target: Pos, origin: Pos, forReaction = false): Pos | null {
    const b = this.b;
    const tt = b.idxP(target);
    const scan: Pos = { x: 0, y: 0, z: 0 };
    const tu = b.unitOnTile(tt);
    if (tu && (forReaction || isUnitVisibleTo(b, tu, u.owner))) {
      if (tu === u) return { x: target.x * 16 + 8, y: target.y * 16 + 8, z: target.z * 24 };
      if (canTargetUnit(b, origin, tt, scan, u)) return scan;
      return null;
    }
    if (b.part(tt, TilePart.OBJECT)) return canTargetTile(b, origin, tt, TilePart.OBJECT, scan, u) ? scan : { x: target.x * 16 + 8, y: target.y * 16 + 8, z: target.z * 24 + 10 };
    if (b.part(tt, TilePart.NORTHWALL)) return canTargetTile(b, origin, tt, TilePart.NORTHWALL, scan, u) ? scan : { x: target.x * 16 + 8, y: target.y * 16, z: target.z * 24 + 9 };
    if (b.part(tt, TilePart.WESTWALL)) return canTargetTile(b, origin, tt, TilePart.WESTWALL, scan, u) ? scan : { x: target.x * 16, y: target.y * 16 + 8, z: target.z * 24 + 9 };
    if (b.part(tt, TilePart.FLOOR)) return canTargetTile(b, origin, tt, TilePart.FLOOR, scan, u) ? scan : { x: target.x * 16 + 8, y: target.y * 16 + 8, z: target.z * 24 + 2 };
    return { x: target.x * 16 + 8, y: target.y * 16 + 8, z: target.z * 24 + 12 };
  }

  /** The original accuracy spread: deviate the target voxel then extend the line through it. */
  private applyAccuracy(origin: Pos, target: Pos, accuracy: number, weapon: ItemRule, action: ActionType, keepRange: boolean, extendLine: boolean): Pos {
    const b = this.b;
    const t = { ...target };
    const xdiff = origin.x - t.x, ydiff = origin.y - t.y;
    const realDistance = Math.sqrt(xdiff * xdiff + ydiff * ydiff);
    let maxRange = keepRange ? realDistance : 16 * 1000;
    if (action === "hit") maxRange = 46;
    if (action !== "throw" && action !== "hit") {
      let modifier = 0;
      const upper = weapon.aimRange, lower = weapon.minRange;
      if (realDistance / 16 < lower) modifier = (weapon.dropoff * (lower - realDistance / 16)) / 100;
      else if (upper < realDistance / 16) modifier = (weapon.dropoff * (realDistance / 16 - upper)) / 100;
      accuracy = Math.max(0, accuracy - modifier);
    }
    const xDist = Math.abs(origin.x - t.x), yDist = Math.abs(origin.y - t.y), zDist = Math.abs(origin.z - t.z);
    const xyShift = Math.floor(xDist / 2) <= yDist ? Math.floor(xDist / 4) + yDist : Math.floor((xDist + yDist) / 2);
    const zShift = xyShift <= zDist ? Math.floor(xyShift / 2) + zDist : xyShift + Math.floor(zDist / 2);
    let deviation = b.rng.int(0, 100) - Math.trunc(accuracy * 100);
    deviation += deviation >= 0 ? 50 : 10;
    deviation = Math.max(1, Math.floor((zShift * deviation) / 200));
    t.x += b.rng.int(0, deviation) - Math.floor(deviation / 2);
    t.y += b.rng.int(0, deviation) - Math.floor(deviation / 2);
    t.z += Math.floor(b.rng.int(0, Math.floor(deviation / 2)) / 2) - Math.floor(deviation / 8);
    if (extendLine) {
      const rotation = Math.atan2(t.y - origin.y, t.x - origin.x);
      const tilt = Math.atan2(t.z - origin.z, Math.sqrt((t.x - origin.x) ** 2 + (t.y - origin.y) ** 2));
      t.x = Math.trunc(origin.x + maxRange * Math.cos(rotation) * Math.cos(tilt));
      t.y = Math.trunc(origin.y + maxRange * Math.sin(rotation) * Math.cos(tilt));
      t.z = Math.trunc(origin.z + maxRange * Math.sin(tilt));
    }
    return t;
  }

  private spendBullet(weapon: Item) {
    const b = this.b;
    const ammo = ammoOf(b, weapon);
    if (!ammo || ammo.id === weapon.id) return;
    ammo.ammoQty--;
    if (ammo.ammoQty <= 0) {
      b.removeItem(ammo);
      weapon.ammo = -1;
    }
  }

  shoot(u: Unit, hand: Hand, mode: "snap" | "aimed" | "auto", target: Pos, ev: BattleEvents, reaction = false): string | undefined {
    const b = this.b;
    const weapon = this.weaponIn(u, hand);
    if (!weapon) return "STR_NO_WEAPON";
    const wr = itemRule(weapon.type);
    if (wr.battleType !== BattleType.FIREARM) return "STR_NO_WEAPON";
    const tuKey = mode === "snap" ? wr.tuSnap : mode === "aimed" ? wr.tuAimed : wr.tuAuto;
    b.actingWeapon = weapon.type;
    if (!tuKey) return "STR_ACTION_NOT_POSSIBLE";
    if (wr.waypoints && mode === "aimed") return "STR_ACTION_NOT_POSSIBLE";
    const cost = actionTUs(u, mode, wr);
    if (!reaction && u.tu < cost) return NOT_ENOUGH_TU;
    const ammo = ammoOf(b, weapon);
    if (!ammo) return "STR_NO_AMMUNITION_LOADED";
    if (roundsLeft(b, weapon) <= 0) return "STR_NO_ROUNDS_LEFT";
    if (distanceSq(u.pos, target, false) > wr.maxRange * wr.maxRange) return "STR_OUT_OF_RANGE";
    if (b.idxP(target) < 0) return "STR_OUT_OF_RANGE";
    const ar = itemRule(ammo.type);

    // turn to face the target (free while targeting; tanks turn their turret)
    if (!reaction) this.turn(u, target, ev, true, u.turretType >= 0);
    const shots = mode === "auto" ? wr.autoShots : 1;
    let fired = 0;
    for (let s = 0; s < shots; s++) {
      if (isOut(u) || roundsLeft(b, weapon) <= 0) break;
      const origin = originVoxel(b, u, target, false);
      let impact: number;
      let path: Pos[] = [];
      if (wr.arcingShot) {
        const r = this.arcPath(u, target, origin, firingAccuracy(b, u, mode, weapon) / 100, wr, 10);
        if (!r) {
          if (fired === 0) return "STR_NO_LINE_OF_FIRE";
          break;
        }
        path = r.path;
        impact = r.impact;
      } else {
        const tv = this.targetVoxelFor(u, target, origin, reaction);
        if (!tv) {
          if (fired === 0) return "STR_NO_LINE_OF_FIRE";
          break;
        }
        // first shot: make sure the line actually reaches what we aimed at
        if (s === 0) {
          const probe: Pos[] = [];
          const test = calculateLine(b, origin, tv, false, probe, { excludeUnit: u });
          if (test !== VoxelType.EMPTY && probe.length) {
            const hp = { x: probe[0].x >> 4, y: probe[0].y >> 4, z: Math.floor(probe[0].z / 24) };
            let ok = true;
            if (test === VoxelType.UNIT) {
              let hu = b.unitOnTile(b.idxP(hp));
              if (!hu) hu = b.unitOnTile(b.idx(hp.x, hp.y, hp.z - 1));
              const tu = b.unitOnTile(b.idxP(target));
              ok = !tu || hu === tu;
            } else if (!(hp.x === target.x && hp.y === target.y && hp.z === target.z)) {
              if (test === VoxelType.NORTHWALL) ok = hp.y - 1 === target.y;
              else if (test === VoxelType.WESTWALL) ok = hp.x - 1 === target.x;
              else ok = false;
            }
            if (!ok) return "STR_NO_LINE_OF_FIRE";
          }
        }
        const acc = firingAccuracy(b, u, mode, weapon) / 100;
        const tv2 = this.applyAccuracy(origin, tv, acc, wr, mode, false, true);
        const traj: Pos[] = [];
        impact = calculateLine(b, origin, tv2, true, traj, { excludeUnit: u });
        path = traj;
      }
      if (s === 0 && !reaction) {
        u.tu -= cost;
      }
      fired++;
      this.spendBullet(weapon);
      const end = path.length ? path[path.length - 1] : origin;
      ev.push({ t: "aim", unit: u.id, aiming: true }, ev.seers(u));
      const vis = ev.seers(u) | (b.unitOnTile(b.idxP(target)) ? ev.seers(b.unitOnTile(b.idxP(target))) : 0);
      ev.push({ t: "shot", unit: u.id, weapon: weapon.type, bullet: wr.bulletSprite >= 0 ? wr.bulletSprite : ar.bulletSprite, sound: ar.fireSound >= 0 ? ar.fireSound : wr.fireSound, path: wr.arcingShot ? sample(path, 3) : [origin, end], impact }, vis);
      if (impact !== VoxelType.OUTOFBOUNDS && impact !== VoxelType.EMPTY) {
        const radius = explosionRadius(ar);
        const at = radius && impact !== VoxelType.UNIT ? positionFromEnd(path, -2) : end;
        this.impact(u, ar, at, ev);
      }
    }
    ev.push({ t: "aim", unit: u.id, aiming: false }, ev.seers(u));
    if (!reaction) this.checkReactionFire(u, ev);
    return undefined;
  }

  /** Arcing projectile (celatid spit / thrown items): returns the parabola and what it hit. */
  private arcPath(u: Unit, target: Pos, origin: Pos, accuracy: number, rule: ItemRule, weight: number) {
    const b = this.b;
    const tt = b.idxP(target);
    const tu = b.unitOnTile(tt);
    const base = { x: target.x * 16 + 8, y: target.y * 16 + 8, z: target.z * 24 + 1 - b.terrainLevel(tt) };
    const targets: Pos[] = [];
    if (tu) {
      const z0 = base.z + floatHeight(tu);
      targets.push({ ...base, z: z0 + Math.floor(unitHeight(tu) / 2) + 1 }, { ...base, z: z0 + 2 }, { ...base, z: z0 + unitHeight(tu) - 1 });
    } else targets.push(base);
    let found: { curvature: number } | null = null;
    let tv = targets[0];
    for (const t of targets) {
      found = validateThrow(b, u, weight, false, origin, t, target);
      if (found) {
        tv = t;
        break;
      }
    }
    if (!found) return null;
    const dev = this.applyAccuracy(origin, tv, accuracy, rule, "throw", true, false);
    const path: Pos[] = [];
    const impact = calculateParabola(b, origin, dev, true, path, u, found.curvature, { x: 0, y: 0, z: 0 });
    return { path, impact };
  }

  /** A projectile/explosive arrives at a voxel. */
  private impact(attacker: Unit | null, ammo: ItemRule, at: Pos, ev: BattleEvents, item?: Item) {
    const b = this.b;
    const radius = explosionRadius(ammo);
    const tile = b.idx(at.x >> 4, at.y >> 4, Math.floor(at.z / 24));
    const vis = ev.tileSeers(tile) | ev.seers(b.unitOnTile(tile));
    if (radius > 0) {
      ev.push({ t: "explosion", at: { ...at }, power: ammo.power, frame: ammo.hitAnimation >= 0 ? ammo.hitAnimation : 0, small: ammo.power <= 80 }, vis);
      explode(b, ev, at, ammo.power, ammo.damageType, radius, attacker);
    } else {
      ev.push({ t: "hit", at: { ...at }, anim: ammo.hitAnimation, sound: ammo.hitSound }, vis);
      hit(b, ev, at, ammo.power, ammo.damageType, attacker);
    }
    void item;
    this.settle(ev, attacker);
  }

  launch(u: Unit, hand: Hand, waypoints: Pos[], ev: BattleEvents): string | undefined {
    const b = this.b;
    const weapon = this.weaponIn(u, hand);
    if (!weapon) return "STR_NO_WEAPON";
    const wr = itemRule(weapon.type);
    if (!wr.waypoints) return "STR_ACTION_NOT_POSSIBLE";
    const ammo = ammoOf(b, weapon);
    if (!ammo) return "STR_NO_AMMUNITION_LOADED";
    const ar = itemRule(ammo.type);
    const cost = actionTUs(u, "launch", wr);
    if (u.tu < cost) return NOT_ENOUGH_TU;
    if (!waypoints.length || waypoints.length > wr.waypoints) return "STR_ACTION_NOT_POSSIBLE";
    u.tu -= cost;
    b.actingWeapon = weapon.type;
    this.turn(u, waypoints[0], ev, true);
    // the blaster bomb flies from waypoint to waypoint
    let origin = originVoxel(b, u, waypoints[0], false);
    const full: Pos[] = [origin];
    let impact = VoxelType.EMPTY as number;
    for (let w = 0; w < waypoints.length; w++) {
      const wp = waypoints[w];
      let tv = { x: wp.x * 16 + 8, y: wp.y * 16 + 8, z: wp.z * 24 + 16 };
      if (w > 0 && posEq(wp, waypoints[w - 1])) tv = { ...tv, z: wp.z * 24 + 2 };
      const last = w === waypoints.length - 1;
      tv = this.applyAccuracy(origin, tv, 0.6, wr, "launch", false, last);
      const traj: Pos[] = [];
      impact = calculateLine(b, origin, tv, true, traj, { excludeUnit: u });
      full.push(...traj.slice(1));
      if (impact !== VoxelType.EMPTY) break;
      origin = traj[traj.length - 1];
    }
    this.spendBullet(weapon);
    const end = full[full.length - 1];
    ev.push({ t: "shot", unit: u.id, weapon: weapon.type, bullet: wr.bulletSprite, sound: wr.fireSound, path: sample(full, 4), impact }, ev.seers(u));
    if (impact !== VoxelType.OUTOFBOUNDS && impact !== VoxelType.EMPTY) this.impact(u, ar, positionFromEnd(full, -2) ?? end, ev);
    this.checkReactionFire(u, ev);
    return undefined;
  }

  prime(u: Unit, hand: Hand, fuse: number): string | undefined {
    const it = this.weaponIn(u, hand);
    if (!it) return "STR_NO_ITEM";
    const r = itemRule(it.type);
    if (r.battleType !== BattleType.GRENADE && r.battleType !== BattleType.PROXIMITYGRENADE) return "STR_ACTION_NOT_POSSIBLE";
    if (it.fuse >= 0) return "STR_GRENADE_IS_ACTIVATED";
    const cost = actionTUs(u, "prime", r);
    if (u.tu < cost) return NOT_ENOUGH_TU;
    u.tu -= cost;
    it.fuse = r.battleType === BattleType.PROXIMITYGRENADE ? 0 : Math.max(0, Math.min(23, Math.floor(fuse)));
    return undefined;
  }

  throwItem(u: Unit, hand: Hand, target: Pos, ev: BattleEvents): string | undefined {
    const b = this.b;
    const it = this.weaponIn(u, hand);
    if (!it) return "STR_NO_ITEM";
    const r = itemRule(it.type);
    if (r.fixedWeapon) return "STR_ACTION_NOT_POSSIBLE";
    const cost = actionTUs(u, "throw", r);
    if (u.tu < cost) return NOT_ENOUGH_TU;
    const tt = b.idxP(target);
    if (tt < 0) return "STR_OUT_OF_RANGE";
    let tgt = { ...target };
    if (b.terrainLevel(tt) === -24 && tgt.z + 1 < b.sz) tgt.z += 1;
    let weight = r.weight;
    const a = ammoOf(b, it);
    if (a && a.id !== it.id) weight += itemRule(a.type).weight;
    this.turn(u, tgt, ev, true);
    const origin = originVoxel(b, u, tgt, true);
    if (!validThrowRange(b, u, weight, origin, tgt)) return "STR_OUT_OF_RANGE";
    const ttile = b.idxP(tgt);
    const tv = { x: tgt.x * 16 + 8, y: tgt.y * 16 + 8, z: tgt.z * 24 + 1 - b.terrainLevel(ttile) };
    const v = validateThrow(b, u, weight, true, origin, tv, tgt);
    if (!v) return "STR_UNABLE_TO_THROW_HERE";
    u.tu -= cost;
    let path: Pos[] = [];
    let land: Pos = tgt;
    for (let attempt = 0; attempt < 20; attempt++) {
      const dev = this.applyAccuracy(origin, tv, throwingAccuracy(b, u) / 100, r, "throw", true, false);
      const delta = { x: dev.x - tv.x, y: dev.y - tv.y, z: dev.z - tv.z };
      path = [];
      const test = calculateParabola(b, origin, tv, true, path, u, v.curvature, delta);
      const lp = positionFromEnd(path, ITEM_DROP_VOXEL_OFFSET);
      land = { x: lp.x >> 4, y: lp.y >> 4, z: Math.max(0, Math.floor(lp.z / 24)) };
      const lt = b.idxP(land);
      const obj = lt >= 0 ? b.part(lt, TilePart.OBJECT) : null;
      if (test !== VoxelType.OUTOFBOUNDS && lt >= 0 && !(obj && obj.tuWalk === 255 && !(obj.bigWall !== 0 && (obj.bigWall < 1 || obj.bigWall > 3)))) break;
    }
    land.x = Math.max(0, Math.min(b.sx - 1, land.x));
    land.y = Math.max(0, Math.min(b.sy - 1, land.y));
    land.z = Math.max(0, Math.min(b.sz - 1, land.z));
    b.detachItem(it);
    it.previousOwner = u.id;
    b.actingWeapon = it.type;
    ev.push({ t: "throw", unit: u.id, item: it.type, path: sample(path, 3) }, ev.seers(u));
    b.moveItemToTile(it, b.idxP(land));
    applyGravity(b, ev, b.idxP(land));
    if (r.battleType === BattleType.FLARE) {
      calculateTerrainLighting(b);
      ev.terrainChanged = true;
    }
    ev.itemsChanged = true;
    this.settle(ev);
    this.checkReactionFire(u, ev);
    return undefined;
  }

  melee(u: Unit, hand: Hand, target: Pos, ev: BattleEvents, reaction = false): string | undefined {
    const b = this.b;
    let weapon = this.weaponIn(u, hand);
    if (!weapon || itemRule(weapon.type).battleType !== BattleType.MELEE) weapon = meleeWeapon(b, u) ?? undefined;
    if (!weapon) return "STR_NO_WEAPON";
    const wr = itemRule(weapon.type);
    const cost = actionTUs(u, "hit", wr);
    if (!reaction && u.tu < cost) return NOT_ENOUGH_TU;
    const dir = directionTo(u.pos, target);
    const victim = validMeleeRange(b, u, u.pos, dir, null);
    if (!victim) return "STR_THERE_IS_NO_ONE_THERE";
    if (!reaction) {
      this.turn(u, victim.pos, ev, true);
      u.tu -= cost;
    }
    const vt = b.idxP(victim.pos);
    b.actingWeapon = weapon.type;
    const voxel = { x: victim.pos.x * 16 + 8, y: victim.pos.y * 16 + 8, z: victim.pos.z * 24 + floatHeight(victim) + Math.floor(unitHeight(victim) / 2) - b.terrainLevel(vt) };
    const success = b.rng.percent(firingAccuracy(b, u, "hit", weapon));
    ev.push({ t: "melee", unit: u.id, at: voxel, sound: wr.meleeSound, hit: success }, ev.seers(u) | ev.seers(victim));
    if (success) {
      if (wr.zombieUnit && victim.type === "SOLDIER" && !victim.spawnUnit) {
        victim.respawn = true;
        victim.spawnUnit = wr.zombieUnit;
        victim.spawnOwner = u.owner;
      }
      let power = wr.power;
      const ammo = ammoOf(b, weapon);
      const type = ammo ? itemRule(ammo.type).damageType : DamageType.STUN;
      if (ammo) power = itemRule(ammo.type).power;
      if (wr.strengthApplied) power += u.stats.strength;
      const diff = { x: Math.max(-1, Math.min(1, u.pos.x - victim.pos.x)), y: Math.max(-1, Math.min(1, u.pos.y - victim.pos.y)), z: 0 };
      hit(b, ev, { x: voxel.x + diff.x, y: voxel.y + diff.y, z: voxel.z }, power, type, u);
      this.settle(ev, u);
    }
    return undefined;
  }

  psi(u: Unit, hand: Hand | "innate", target: Pos, ev: BattleEvents): string | undefined {
    const b = this.b;
    if (!b.settings.psionics) return "STR_ACTION_NOT_POSSIBLE";
    let cost = 25;
    if (hand === "innate") {
      if (!u.psiWeapon) return "STR_ACTION_NOT_POSSIBLE";
    } else {
      const amp = this.weaponIn(u, hand);
      if (!amp || itemRule(amp.type).battleType !== BattleType.PSIAMP) return "STR_ACTION_NOT_POSSIBLE";
      if (u.stats.psiSkill <= 0) return "STR_NO_PSI_SKILL";
      cost = actionTUs(u, "mindcontrol", itemRule(amp.type));
    }
    if (u.tu < cost) return NOT_ENOUGH_TU;
    const victim = b.unitOnTile(b.idxP(target));
    if (!victim || victim.owner === u.owner || isOut(victim) || !isUnitVisibleTo(b, victim, u.owner)) return "STR_INVALID_TARGET";
    u.tu -= cost;
    let attack = (u.stats.psiStrength * u.stats.psiSkill) / 50.0;
    let defense = victim.stats.psiStrength + (victim.stats.psiSkill > 0 ? 10.0 + victim.stats.psiSkill / 5.0 : 10.0);
    attack -= tileDistance(u.pos, victim.pos);
    attack += b.rng.int(0, 55);
    defense += 20; // mind control is harder than a panic attack
    const success = attack > defense;
    ev.push({ t: "psi", unit: u.id, target: victim.id, success, sound: 36 }, ev.seers(u) | ev.seers(victim) | (1 << victim.originalOwner));
    if (success) {
      victim.owner = u.owner;
      victim.mindControllerId = u.id;
      recoverTimeUnits(b, victim);
      victim.kneeled = false;
      calculateUnitLighting(b);
      calculateFOV(b, victim, true);
      for (const o of b.units) if (!isOut(o)) refreshVisibleUnits(b, o);
      ev.msg("STR_MIND_CONTROL_SUCCESSFUL", 1 << u.owner);
      ev.msg("STR_IS_UNDER_ALIEN_CONTROL", 1 << victim.originalOwner, victim.name);
    } else {
      ev.msg("STR_MIND_CONTROL_FAILED", 1 << u.owner);
    }
    return undefined;
  }

  medikit(u: Unit, hand: Hand, targetId: number, part: number, mode: "heal" | "stim" | "pain", ev: BattleEvents): string | undefined {
    const b = this.b;
    const kit = this.weaponIn(u, hand);
    if (!kit || itemRule(kit.type).battleType !== BattleType.MEDIKIT) return "STR_ACTION_NOT_POSSIBLE";
    const r = itemRule(kit.type);
    const target = b.unit(targetId);
    if (!target) return "STR_INVALID_TARGET";
    // the patient must be the user, adjacent, or lying (unconscious) next to them
    const close = target === u || (Math.abs(target.pos.x - u.pos.x) <= 1 && Math.abs(target.pos.y - u.pos.y) <= 1 && target.pos.z === u.pos.z);
    if (!close) return "STR_INVALID_TARGET";
    if (target.status === UnitStatus.DEAD) return "STR_INVALID_TARGET";
    const cost = actionTUs(u, "use", r);
    if (u.tu < cost) return NOT_ENOUGH_TU;
    const uses = kitUses(kit, r);
    if (mode === "heal") {
      if (uses[1] <= 0) return "STR_NO_MEDIKIT_LEFT";
      if (!target.wounds[part]) return "STR_NO_FATAL_WOUND";
      heal(target, part, r.woundRecovery, r.healthRecovery);
      uses[1]--;
    } else if (mode === "stim") {
      if (uses[2] <= 0) return "STR_NO_MEDIKIT_LEFT";
      target.energy = Math.min(target.stats.stamina, target.energy + r.energyRecovery);
      target.stun = Math.max(0, target.stun - r.stunRecovery);
      uses[2]--;
    } else {
      if (uses[0] <= 0) return "STR_NO_MEDIKIT_LEFT";
      // without morale, painkillers instead numb the pain of one wound for a turn: small stun recovery
      target.stun = Math.max(0, target.stun - 2);
      uses[0]--;
    }
    kit.uses = uses;
    u.tu -= cost;
    if (target.status === UnitStatus.UNCONSCIOUS && target.stun < target.health) this.revive(target, ev);
    return undefined;
  }

  scan(u: Unit, hand: Hand): string | { blips: { x: number; y: number; size: number }[] } {
    const b = this.b;
    const it = this.weaponIn(u, hand);
    if (!it || itemRule(it.type).battleType !== BattleType.SCANNER) return "STR_ACTION_NOT_POSSIBLE";
    const cost = actionTUs(u, "use", itemRule(it.type));
    if (u.tu < cost) return NOT_ENOUGH_TU;
    u.tu -= cost;
    const blips: { x: number; y: number; size: number }[] = [];
    for (const o of b.units) {
      if (o.owner === u.owner || isOut(o) || !o.motionPoints) continue;
      if (Math.abs(o.pos.x - u.pos.x) > 10 || Math.abs(o.pos.y - u.pos.y) > 10) continue;
      blips.push({ x: o.pos.x - u.pos.x, y: o.pos.y - u.pos.y, size: Math.min(5, Math.ceil(o.motionPoints / 4)) });
    }
    return { blips };
  }

  probe(u: Unit, hand: Hand, target: Pos): string | { unit: number; stats: unknown } {
    const b = this.b;
    const it = this.weaponIn(u, hand);
    if (!it || itemRule(it.type).battleType !== BattleType.MINDPROBE) return "STR_ACTION_NOT_POSSIBLE";
    const victim = b.unitOnTile(b.idxP(target));
    if (!victim || victim.owner === u.owner || !isUnitVisibleTo(b, victim, u.owner)) return "STR_INVALID_TARGET";
    const cost = actionTUs(u, "use", itemRule(it.type));
    if (u.tu < cost) return NOT_ENOUGH_TU;
    u.tu -= cost;
    return {
      unit: victim.id,
      stats: { name: victim.name, rank: victim.rank, stats: victim.stats, tu: victim.tu, energy: victim.energy, health: victim.health, stun: victim.stun, armor: victim.armorNow, wounds: victim.wounds },
    };
  }

  // ------------------------------------------------------------------------------------------
  // inventory
  // ------------------------------------------------------------------------------------------

  private slotOf(it: Item): SlotId {
    return it.tile >= 0 ? "STR_GROUND" : (it.slot as SlotId);
  }

  fits(u: Unit, it: Item, slot: SlotId, x: number, y: number): boolean {
    const b = this.b;
    const r = itemRule(it.type);
    const def = INVENTORY_SLOTS[slot];
    if (def.type === 2) return true;
    if (def.type === 1) return !b.items.some((o) => o !== it && o.owner === u.id && o.slot === slot);
    for (let i = 0; i < r.invWidth; i++)
      for (let j = 0; j < r.invHeight; j++) {
        if (!def.cells.some(([cx, cy]) => cx === x + i && cy === y + j)) return false;
      }
    // overlap with items already in the slot
    for (const o of b.items) {
      if (o === it || o.owner !== u.id || o.slot !== slot) continue;
      const or = itemRule(o.type);
      if (x < o.sx + or.invWidth && o.sx < x + r.invWidth && y < o.sy + or.invHeight && o.sy < y + r.invHeight) return false;
    }
    return true;
  }

  inventoryMove(u: Unit, itemId: number, slot: SlotId, x: number, y: number, ev: BattleEvents, free = false): string | undefined {
    const b = this.b;
    if (!u.hasInventory) return "STR_ACTION_NOT_POSSIBLE";
    const it = b.item(itemId);
    if (!it) return "STR_NO_ITEM";
    const here = b.idxP(u.pos);
    const from = this.slotOf(it);
    if (from === "STR_GROUND") {
      if (it.tile !== here) return "STR_NO_ITEM";
    } else if (it.owner !== u.id) return "STR_NO_ITEM";
    if (itemRule(it.type).fixedWeapon) return "STR_ACTION_NOT_POSSIBLE";
    if (!INVENTORY_SLOTS[slot]) return "STR_ACTION_NOT_POSSIBLE";
    if (!this.fits(u, it, slot, x, y)) return "STR_NOT_ENOUGH_SPACE";
    const cost = from === slot ? 0 : INVENTORY_COSTS[from][slot] ?? 0;
    if (!free && u.tu < cost) return NOT_ENOUGH_TU;
    if (!free) u.tu -= cost;
    if (slot === "STR_GROUND") {
      b.moveItemToTile(it, here);
      applyGravity(b, ev, here);
      if (itemRule(it.type).battleType === BattleType.FLARE) {
        calculateTerrainLighting(b);
        ev.terrainChanged = true;
      }
    } else {
      b.moveItemToUnit(it, u, slot, x, y);
      if (it.unitId >= 0) {
        // carrying an unconscious body
        const body = b.unit(it.unitId);
        if (body) body.pos = { ...u.pos };
      }
    }
    ev.itemsChanged = true;
    return undefined;
  }

  load(u: Unit, weaponId: number, ammoId: number, free = false): string | undefined {
    const b = this.b;
    const w = b.item(weaponId), a = b.item(ammoId);
    if (!w || !a) return "STR_NO_ITEM";
    const here = b.idxP(u.pos);
    const mine = (it: Item) => it.owner === u.id || it.tile === here;
    if (!mine(w) || !mine(a)) return "STR_NO_ITEM";
    const wr = itemRule(w.type);
    if (!wr.compatibleAmmo.includes(a.type)) return "STR_WRONG_AMMUNITION_FOR_THIS_WEAPON";
    if (w.ammo >= 0) return "STR_WEAPON_IS_ALREADY_LOADED";
    if (!free && u.tu < 15) return NOT_ENOUGH_TU;
    if (!free) u.tu -= 15;
    b.detachItem(a);
    a.owner = -2;
    w.ammo = a.id;
    return undefined;
  }

  unload(u: Unit, weaponId: number, free = false): string | undefined {
    const b = this.b;
    const w = b.item(weaponId);
    if (!w || w.owner !== u.id) return "STR_NO_ITEM";
    const a = ammoOf(b, w);
    if (!a || a.id === w.id) return "STR_NO_AMMUNITION_LOADED";
    const others = b.items.filter((o) => o.owner === u.id && (o.slot === "STR_RIGHT_HAND" || o.slot === "STR_LEFT_HAND") && o !== w);
    if (others.length) return "STR_BOTH_HANDS_MUST_BE_EMPTY";
    if (!free && u.tu < 8) return NOT_ENOUGH_TU;
    if (!free) u.tu -= 8;
    w.ammo = -1;
    b.moveItemToUnit(w, u, "STR_RIGHT_HAND", 0, 0);
    b.moveItemToUnit(a, u, "STR_LEFT_HAND", 0, 0);
    return undefined;
  }

  // ------------------------------------------------------------------------------------------
  // reactions
  // ------------------------------------------------------------------------------------------

  private reactionType(reactor: Unit, target: Unit): { kind: "hit" | "snap"; weapon: Item } | null {
    const b = this.b;
    const mw = meleeWeapon(b, reactor);
    if (mw) {
      const cost = actionTUs(reactor, "hit", itemRule(mw.type));
      if (validMeleeRange(b, reactor, reactor.pos, reactor.dir, target) && cost > 0 && reactor.tu > cost) return { kind: "hit", weapon: mw };
    }
    const w = mainHandWeapon(b, reactor, true);
    if (w) {
      const r = itemRule(w.type);
      const cost = actionTUs(reactor, "snap", r);
      if (r.battleType !== BattleType.MELEE && r.tuSnap && distanceSq(reactor.pos, target.pos, false) < r.maxRange * r.maxRange && cost > 0 && reactor.tu > cost) return { kind: "snap", weapon: w };
    }
    return null;
  }

  /** Units of other squads that see `mover` may snap-fire at it, best reactions first. */
  checkReactionFire(mover: Unit, ev: BattleEvents): boolean {
    const b = this.b;
    if (isOut(mover) || mover.owner !== b.current) return false;
    const spotters: Unit[] = [];
    for (const o of b.units) {
      if (isOut(o) || o.health === 0 || o.stun >= o.health || o.owner === mover.owner) continue;
      if (distanceSq(mover.pos, o.pos, false) > MAX_VIEW_DISTANCE_SQR) continue;
      const gotHit = b.hitBy.get(o.id)?.has(mover.id) ?? false;
      if (!(checkViewSector(o, mover.pos) || gotHit)) continue;
      const origin = originVoxel(b, o, mover.pos, false);
      const scan = { x: 0, y: 0, z: 0 };
      if (!canTargetUnit(b, origin, b.idxP(mover.pos), scan, o)) continue;
      if (!visible(b, o, b.idxP(mover.pos))) continue;
      if (!o.visibleUnits.includes(mover.id)) o.visibleUnits.push(mover.id);
      if (this.reactionType(o, mover)) spotters.push(o);
    }
    let reacted = false;
    let guard = 0;
    while (spotters.length && guard++ < 50 && !isOut(mover)) {
      let best: Unit | null = null;
      let bestScore = -1;
      for (const s of spotters) {
        if (isOut(s) || !this.reactionType(s, mover)) continue;
        const sc = reactionScore(s);
        if (sc > bestScore) {
          bestScore = sc;
          best = s;
        }
      }
      if (!best || reactionScore(mover) > bestScore) break;
      const rt = this.reactionType(best, mover)!;
      const cost = actionTUs(best, rt.kind, itemRule(rt.weapon.type));
      best.tu -= cost;
      ev.push({ t: "reaction", unit: best.id, target: mover.id }, ev.seers(best) | ev.seers(mover));
      // reacting units turn to face their target
      const d = directionTo(best.pos, mover.pos);
      if (best.turretType >= 0) best.turretDir = d;
      else best.dir = d;
      ev.push({ t: "turn", unit: best.id, dir: best.dir, turret: best.turretDir }, ev.seers(best));
      const hand = (rt.weapon.slot ?? "STR_RIGHT_HAND") as Hand;
      const err = rt.kind === "hit" ? this.melee(best, hand, mover.pos, ev, true) : this.shoot(best, hand, "snap", mover.pos, ev, true);
      if (err) {
        best.tu += cost;
        spotters.splice(spotters.indexOf(best), 1);
        continue;
      }
      reacted = true;
    }
    return reacted;
  }

  private checkProximityGrenades(u: Unit, ev: BattleEvents): boolean {
    const b = this.b;
    for (let x = -1; x <= u.size; x++)
      for (let y = -1; y <= u.size; y++) {
        const t = b.idx(u.pos.x + x, u.pos.y + y, u.pos.z);
        if (t < 0) continue;
        for (const id of [...b.itemsOnTile(t)]) {
          const it = b.item(id);
          if (!it) continue;
          const r = itemRule(it.type);
          if (r.battleType === BattleType.PROXIMITYGRENADE && it.fuse === 0) {
            b.actingWeapon = it.type;
            const p = b.posOf(t);
            const at = { x: p.x * 16 + 8, y: p.y * 16 + 8, z: p.z * 24 - b.terrainLevel(t) };
            b.removeItem(it);
            this.impact(b.unit(it.previousOwner) ?? null, r, at, ev);
            return true;
          }
        }
      }
    return false;
  }

  // ------------------------------------------------------------------------------------------
  // casualties & world updates
  // ------------------------------------------------------------------------------------------

  private afterTerrainChange(ev: BattleEvents, near?: Pos) {
    const b = this.b;
    calculateSunShading(b);
    calculateTerrainLighting(b);
    calculateUnitLighting(b);
    for (const u of b.units) {
      if (isOut(u)) continue;
      if (!near || distanceSq(u.pos, near, false) <= MAX_VIEW_DISTANCE_SQR * 2) calculateFOV(b, u, true);
      else refreshVisibleUnits(b, u);
    }
    ev.terrainChanged = false;
  }

  /** Resolves everything pending: deaths, knock-outs, zombies, exploding corpses, terrain chain reactions. */
  settle(ev: BattleEvents, attacker: Unit | null = null) {
    const b = this.b;
    for (let guard = 0; guard < 30; guard++) {
      let changed = false;
      // zombification of living infected soldiers happens immediately
      for (const u of [...b.units]) {
        if (u.respawn && u.health > 0 && u.health >= u.stun && !isOut(u)) {
          this.convertUnit(u, ev);
          changed = true;
        }
      }
      for (const u of [...b.units]) {
        if (u.status === UnitStatus.DEAD || u.status === UnitStatus.IGNORE_ME) continue;
        if (u.health === 0) {
          this.die(u, ev, attacker, u.status === UnitStatus.UNCONSCIOUS);
          changed = true;
        } else if (u.stun >= u.health && u.status !== UnitStatus.UNCONSCIOUS) {
          this.knockOut(u, ev);
          changed = true;
        }
      }
      while (ev.pendingDeathExplosions.length) {
        const id = ev.pendingDeathExplosions.shift()!;
        const u = b.unit(id);
        if (!u) continue;
        const geo = ITEMS.get(u.race + "_CORPSE") ?? ITEMS.get("STR_CYBERDISC_CORPSE")!;
        const power = geo.power || 120;
        const at = { x: u.pos.x * 16 + 16, y: u.pos.y * 16 + 16, z: u.pos.z * 24 + 12 };
        ev.push({ t: "explosion", at, power, frame: 0, small: false }, ev.tileSeers(b.idxP(u.pos)));
        explode(b, ev, at, power, DamageType.HE, explosionRadius(geo) || 6, u);
        ev.focus = u.pos;
        changed = true;
      }
      const t = findTerrainExplosion(b);
      if (t >= 0) {
        const power = b.explosive[t];
        const type = b.explosiveType[t];
        b.explosive[t] = 0;
        const p = b.posOf(t);
        const at = { x: p.x * 16 + 8, y: p.y * 16 + 8, z: p.z * 24 };
        const dt = type === 0 ? DamageType.HE : type === 5 ? DamageType.IN : type === 6 ? DamageType.STUN : DamageType.SMOKE;
        ev.push({ t: "explosion", at, power, frame: 0, small: power <= 80 }, ev.tileSeers(t));
        explode(b, ev, at, power, dt, Math.floor(power / 10), null);
        ev.focus = p;
        changed = true;
      }
      if (ev.terrainChanged) {
        this.afterTerrainChange(ev, ev.focus ?? undefined);
        changed = true;
      }
      if (!changed) break;
    }
    if (ev.changedTiles.size || ev.itemsChanged) ev.push({ t: "terrain" }, ev.all());
    this.checkElimination(ev);
  }

  private dropInventory(u: Unit) {
    const b = this.b;
    const here = b.idxP(u.pos);
    for (const it of b.unitItems(u)) {
      if (itemRule(it.type).fixedWeapon) continue;
      b.moveItemToTile(it, here);
    }
  }

  private removeBodyItem(u: Unit) {
    const b = this.b;
    for (const it of [...b.items]) if (it.unitId === u.id) b.removeItem(it);
  }

  /** The unit's body lies on the ground as an item (or several, for 2x2 units). */
  private placeCorpse(u: Unit, unconscious: boolean) {
    const b = this.b;
    const corpses = armorRule(u.armor).corpseBattle;
    let i = u.size * u.size - 1;
    for (let y = u.size - 1; y >= 0; y--)
      for (let x = u.size - 1; x >= 0; x--) {
        const t = b.idx(u.pos.x + x, u.pos.y + y, u.pos.z);
        const type = corpses[i] ?? corpses[0];
        i--;
        if (t < 0 || !type || !ITEMS.has(type)) continue;
        b.createItem(type, { tile: t, slot: "STR_GROUND", unitId: u.id });
        applyGravity(b, new BattleEvents(b), t);
      }
    void unconscious;
  }

  private die(u: Unit, ev: BattleEvents, attacker: Unit | null, wasUnconscious: boolean) {
    const b = this.b;
    const carried = b.items.find((it) => it.unitId === u.id && it.owner >= 0);
    if (carried) {
      // killed while being carried: the body item becomes a corpse in the carrier's hands
      const holder = b.unit(carried.owner)!;
      u.pos = { ...holder.pos };
    }
    ev.push({ t: "collapse", unit: u.id, dead: true }, ev.seers(u) | ev.tileSeers(b.idxP(u.pos)));
    if (!wasUnconscious) {
      ev.msg("STR_HAS_BEEN_KILLED", 1 << u.originalOwner, u.name);
      this.dropInventory(u);
    }
    if (attacker && attacker !== u) {
      attacker.kills++;
      u.killedBy = attacker.owner;
    }
    b.clearUnitTiles(u);
    u.status = UnitStatus.DEAD;
    u.visibleUnits = [];
    const spawn = u.spawnUnit;
    u.respawn = false;
    if (spawn) {
      // zombies burst into a chryssalid on death
      this.removeBodyItem(u);
      this.spawn(spawn, u.spawnOwner >= 0 ? u.spawnOwner : u.owner, u.pos, u.dir, ev);
      return;
    }
    if (!carried) {
      if (!wasUnconscious) this.placeCorpse(u, false);
      else for (const it of b.items) if (it.unitId === u.id) it.type = armorRule(u.armor).corpseBattle[0] ?? it.type;
    }
    for (const o of b.units) o.visibleUnits = o.visibleUnits.filter((id) => id !== u.id);
  }

  private knockOut(u: Unit, ev: BattleEvents) {
    const b = this.b;
    ev.push({ t: "collapse", unit: u.id, dead: false }, ev.seers(u) | ev.tileSeers(b.idxP(u.pos)));
    ev.msg("STR_HAS_BECOME_UNCONSCIOUS", 1 << u.originalOwner, u.name);
    if (unitRule2(u)?.capturable === false) {
      // robots and large units can't be stunned: they're destroyed
      u.health = 0;
      this.die(u, ev, null, false);
      return;
    }
    this.dropInventory(u);
    b.clearUnitTiles(u);
    u.status = UnitStatus.UNCONSCIOUS;
    u.kneeled = false;
    u.visibleUnits = [];
    this.placeCorpse(u, true);
    for (const o of b.units) o.visibleUnits = o.visibleUnits.filter((id) => id !== u.id);
  }

  private revive(u: Unit, ev: BattleEvents) {
    const b = this.b;
    if (u.status !== UnitStatus.UNCONSCIOUS || u.stun >= u.health || u.health <= 0) return false;
    const body = b.items.find((it) => it.unitId === u.id);
    let at = u.pos;
    if (body && body.owner >= 0) at = b.unit(body.owner)!.pos;
    else if (body && body.tile >= 0) at = b.posOf(body.tile);
    const spot = this.findFreeSpot(at, u.size);
    if (!spot) return false;
    if (body) b.removeItem(body);
    u.status = UnitStatus.STANDING;
    b.placeUnit(u, spot);
    u.tu = 0;
    calculateFOV(b, u, true);
    for (const o of b.units) if (!isOut(o) && o.owner !== u.owner) refreshVisibleUnits(b, o);
    ev.push({ t: "spawn", unit: u.id }, ev.seers(u));
    return true;
  }

  findFreeSpot(near: Pos, size: number): Pos | null {
    const b = this.b;
    for (let r = 0; r <= 3; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const dz of [0, 1, -1]) {
            const p = { x: near.x + dx, y: near.y + dy, z: near.z + dz };
            if (p.z < 0 || p.z >= b.sz) continue;
            if (canStand(b, p, size)) return p;
          }
        }
    return null;
  }

  private spawn(type: string, owner: number, at: Pos, dir: number, ev: BattleEvents): Unit | null {
    const b = this.b;
    const rule = unitRule(type);
    const spot = this.findFreeSpot(at, armorRule(rule.armor).size);
    if (!spot) return null;
    const nu = createUnit(b, { id: "spawn", kind: "alien", type, name: tr(type), rank: tr(rule.rank), gender: 0, look: 0, stats: { ...rule.stats }, price: 0, notes: [] }, "", owner, spot, dir);
    nu.tu = 0;
    calculateUnitLighting(b);
    calculateFOV(b, nu, true);
    for (const o of b.units) if (!isOut(o)) refreshVisibleUnits(b, o);
    ev.push({ t: "spawn", unit: nu.id }, ev.seers(nu));
    return nu;
  }

  /** A soldier struck by a chryssalid turns into a zombie at once. */
  private convertUnit(u: Unit, ev: BattleEvents) {
    const b = this.b;
    const type = u.spawnUnit;
    const owner = u.spawnOwner >= 0 ? u.spawnOwner : u.owner;
    u.respawn = false;
    this.removeBodyItem(u);
    this.dropInventory(u);
    b.clearUnitTiles(u);
    u.status = UnitStatus.DEAD;
    u.health = 0;
    ev.push({ t: "collapse", unit: u.id, dead: true }, ev.seers(u));
    ev.msg("STR_HAS_BEEN_KILLED", 1 << u.originalOwner, u.name);
    for (const o of b.units) o.visibleUnits = o.visibleUnits.filter((id) => id !== u.id);
    const z = this.spawn(type, owner, u.pos, u.dir, ev);
    if (z) z.spawnOwner = owner;
  }

  private checkElimination(ev: BattleEvents) {
    const b = this.b;
    if (b.phase !== Phase.PLAYING) return;
    for (const p of b.players) {
      if (p.eliminated) continue;
      const alive = b.units.some((u) => u.originalOwner === p.index && !isOut(u) && u.health > 0);
      if (!alive) {
        p.eliminated = true;
        this.releaseControlled(p.index);
        ev.msg("STR_PLAYER_ELIMINATED", ev.all(), p.name);
      }
    }
    const left = b.players.filter((p) => !p.eliminated);
    if (left.length <= 1) {
      b.phase = Phase.FINISHED;
      b.winner = left.length ? left[0].index : -1;
      ev.msg("STR_GAME_OVER", ev.all(), left.length ? left[0].name : "");
    }
  }

  /** Units a departing player mind-controls return to their owners. */
  private releaseControlled(player: number) {
    for (const u of this.b.units) {
      if (u.owner === player && u.originalOwner !== player) {
        u.owner = u.originalOwner;
        u.mindControllerId = -1;
      }
    }
  }

  surrender(player: number, ev: BattleEvents) {
    const b = this.b;
    const p = b.players[player];
    if (!p || p.eliminated) return;
    p.surrendered = true;
    p.eliminated = true;
    this.releaseControlled(player);
    for (const u of b.units) {
      if (u.originalOwner === player && !isOut(u)) {
        // the squad is evacuated from the field
        this.dropInventory(u);
        b.clearUnitTiles(u);
        u.status = UnitStatus.IGNORE_ME;
      }
    }
    for (const o of b.units) o.visibleUnits = o.visibleUnits.filter((id) => b.unit(id)?.status !== UnitStatus.IGNORE_ME);
    ev.msg("STR_PLAYER_SURRENDERED", ev.all(), p.name);
    this.checkElimination(ev);
    if (b.phase === Phase.PLAYING && b.current === player) this.endTurn(ev);
  }

  // ------------------------------------------------------------------------------------------
  // turns
  // ------------------------------------------------------------------------------------------

  endTurn(ev: BattleEvents) {
    const b = this.b;
    closeUfoDoors(b, ev);
    // primed grenades with the fuse run out explode now
    for (let guard = 0; guard < 100; guard++) {
      const g = b.items.find((it) => it.tile >= 0 && it.fuse === 0 && itemRule(it.type).battleType === BattleType.GRENADE);
      if (!g) break;
      const t = g.tile;
      const p = b.posOf(t);
      const at = { x: p.x * 16 + 8, y: p.y * 16 + 8, z: p.z * 24 - b.terrainLevel(t) };
      const r = itemRule(g.type);
      const thrower = b.unit(g.previousOwner) ?? null;
      b.actingWeapon = g.type;
      b.removeItem(g);
      this.impact(thrower, r, at, ev);
    }
    for (const it of b.items) {
      const r = itemRule(it.type);
      if ((r.battleType === BattleType.GRENADE || r.battleType === BattleType.PROXIMITYGRENADE) && it.fuse > 0) it.fuse--;
    }
    this.settle(ev);
    if (b.phase !== Phase.PLAYING) return;
    // next player still in the game
    let next = b.current;
    let wrapped = false;
    for (let k = 0; k < b.players.length; k++) {
      next = (next + 1) % b.players.length;
      if (next === 0) wrapped = true;
      if (!b.players[next].eliminated) break;
    }
    if (wrapped) this.newRound(ev);
    this.beginTurn(next, ev);
  }

  /** Environment ticks once per full round: fire & smoke spread, unconscious units wake up, supply drops. */
  private newRound(ev: BattleEvents) {
    const b = this.b;
    b.round++;
    const onFire: number[] = [];
    for (let i = 0; i < b.size; i++) if (b.fire[i] > 0) onFire.push(i);
    for (const t of onFire) {
      if (b.overlaps[t] !== 0) continue;
      b.fire[t]--;
      ev.tileChanged(t);
      if (b.fire[t]) {
        const p = b.posOf(t);
        for (let dir = 0; dir <= 6; dir += 2) {
          const n = b.idx(p.x + DX[dir], p.y + DY[dir], p.z);
          if (n >= 0 && horizontalBlockage(b, t, n, DamageType.IN, false) === 0) ignite(b, ev, n, b.smoke[t]);
        }
      } else {
        b.smoke[t] = 0;
        const obj = b.part(t, TilePart.OBJECT);
        const fl = b.part(t, TilePart.FLOOR);
        if (obj && obj.flammable !== 255 && obj.armor !== 255) {
          destroyPart(b, ev, t, TilePart.OBJECT);
          destroyPart(b, ev, t, TilePart.FLOOR);
        } else if (!obj && fl && fl.flammable !== 255 && fl.armor !== 255) destroyPart(b, ev, t, TilePart.FLOOR);
        applyGravity(b, ev, t);
      }
    }
    const smoky: number[] = [];
    for (let i = 0; i < b.size; i++) if (b.smoke[i] > 0) smoky.push(i);
    for (const t of smoky) {
      const p = b.posOf(t);
      if (b.fire[t] === 0) {
        b.smoke[t]--;
        ev.tileChanged(t);
        if (b.smoke[t]) {
          for (let dir = 0; dir <= 6; dir += 2) {
            const n = b.idx(p.x + DX[dir], p.y + DY[dir], p.z);
            if (n >= 0 && horizontalBlockage(b, t, n, DamageType.SMOKE, false) === 0) {
              if (b.smoke[n] === 0 || (b.fire[n] === 0 && b.overlaps[n] !== 0)) addSmoke(b, n, b.smoke[t], ev);
            }
          }
        }
      } else {
        const up = b.idx(p.x, p.y, p.z + 1);
        if (up >= 0 && b.hasNoFloor(up, t)) addSmoke(b, up, Math.floor(b.smoke[t] / 2), ev);
        for (let dir = 0; dir <= 6; dir += 2) {
          const n = b.idx(p.x + DX[dir], p.y + DY[dir], p.z);
          if (n >= 0 && horizontalBlockage(b, t, n, DamageType.SMOKE, false) === 0) addSmoke(b, n, Math.floor(b.smoke[t] / 2), ev);
        }
      }
    }
    for (let i = 0; i < b.size; i++) {
      if (b.smoke[i] !== 0) this.tileNewTurn(i, ev);
      b.overlaps[i] = 0;
    }
    calculateTerrainLighting(b);
    for (const u of b.units) if (u.status === UnitStatus.UNCONSCIOUS) this.revive(u, ev);
    this.supplyDrops(ev);
    this.settle(ev);
  }

  /** Units standing in fire burn; smoke knocks people out (Tile::prepareNewTurn). */
  private tileNewTurn(t: number, ev: BattleEvents) {
    const b = this.b;
    if (b.overlaps[t] !== 0 && b.smoke[t] !== 0 && b.fire[t] === 0) b.smoke[t] = Math.max(0, Math.min(15, Math.floor(b.smoke[t] / b.overlaps[t]) - 1));
    const u = b.unitOnTile(t);
    if (!b.smoke[t] || !u || isOut(u)) return;
    if (b.fire[t]) {
      if (u.size === 1 || !u.hitByFire) {
        u.hitByFire = true;
        const dmg = damageUnit(b, u, { x: 0, y: 0, z: 0 }, b.smoke[t], DamageType.IN, true);
        ev.damage(u, dmg, DamageType.IN, null);
        if (b.rng.percent(40 * damageModifier(u, DamageType.IN))) {
          const burn = b.rng.int(0, Math.floor(5 * damageModifier(u, DamageType.IN)));
          if (u.fire < burn) u.fire = burn;
        }
      }
    } else if (damageModifier(u, DamageType.SMOKE) > 0 && u.size === 1) {
      damageUnit(b, u, { x: 0, y: 0, z: 0 }, Math.floor(b.smoke[t] / 4) + 1, DamageType.SMOKE, true);
    }
  }

  beginTurn(player: number, ev: BattleEvents) {
    const b = this.b;
    b.current = player;
    b.hitBy.clear();
    for (const u of b.units) if (u.owner === player) prepareUnitTurn(b, u);
    calculateUnitLighting(b);
    recalculateAllFOV(b);
    this.settle(ev);
    ev.push({ t: "msg", text: "STR_TURN_BEGINS", arg: b.players[player].name }, ev.all());
  }

  // ------------------------------------------------------------------------------------------
  // supply drops
  // ------------------------------------------------------------------------------------------

  /** A random spot from `spots` that a squad can actually walk to (not a rooftop or a walled-off yard). */
  private reachableDropSpot(spots: Pos[]): Pos | null {
    const b = this.b;
    const walkers = b.units.filter((u) => !isOut(u) && u.movementType !== 1 && u.size === 1);
    if (!walkers.length) return null;
    const pool = [...spots];
    for (let tries = 0; tries < 25 && pool.length; tries++) {
      const p = pool.splice(b.rng.int(0, pool.length - 1), 1)[0];
      // any ground unit with a path there will do; units are ignored as obstacles only where unknown
      const w = walkers[tries % walkers.length];
      if (posEq(w.pos, p) || new Pathfinder(b, w).calculate(p)) return p;
    }
    return null;
  }

  private supplyDrops(ev: BattleEvents) {
    const b = this.b;
    const sd = b.settings.supplyDrops;
    if (!sd.enabled) return;
    // drop anything due this round
    for (const d of b.supply) {
      if (!d.dropped && d.dropRound <= b.round) {
        d.dropped = true;
        const t = b.idxP(d.pos);
        for (const type of d.items) spawnGroundItem(b, type, t);
        applyGravity(b, ev, t);
        ev.itemsChanged = true;
        ev.push({ t: "supply", pos: d.pos, dropped: true, round: d.dropRound }, ev.all());
        ev.msg("STR_SUPPLY_DROP_LANDED", ev.all());
      }
    }
    // announce the next one `warningRounds` ahead
    const scheduled = b.supply.filter((d) => !d.dropped).length;
    if (scheduled) return;
    const last = b.supply.length ? b.supply[b.supply.length - 1].dropRound : 0;
    const nextRound = last ? last + sd.everyRounds : sd.everyRounds + 1;
    if (b.round < nextRound - sd.warningRounds) return;
    const spots = openSkyTiles(b, 4);
    if (!spots.length) return;
    const cx = b.sx / 2, cy = b.sy / 2;
    // favour the middle of the map so everyone has a fair run at it
    const central = spots.filter((p) => Math.abs(p.x - cx) < b.sx * 0.3 && Math.abs(p.y - cy) < b.sy * 0.3);
    const pos = this.reachableDropSpot(central.length ? central : spots) ?? b.rng.pick(central.length ? central : spots);
    const items = rollSupplyDrop(b.rng, sd.tier, b.settings.psionics);
    const drop = { id: b.supply.length + 1, pos, dropRound: nextRound, announcedRound: b.round, dropped: false, items };
    b.supply.push(drop);
    ev.push({ t: "supply", pos, dropped: false, round: nextRound }, ev.all());
    ev.msg("STR_SUPPLY_DROP_INBOUND", ev.all(), String(nextRound - b.round));
    if (drop.dropRound <= b.round) this.supplyDrops(ev);
  }
}

function unitRule2(u: Unit) {
  if (u.type === "SOLDIER") return null;
  try {
    return unitRule(u.type);
  } catch {
    return null;
  }
}

function addSmoke(b: Battle, t: number, smoke: number, ev: BattleEvents) {
  if (b.fire[t] !== 0) return;
  if (b.overlaps[t] === 0) b.smoke[t] = Math.max(1, Math.min(15, b.smoke[t] + smoke));
  else b.smoke[t] += smoke;
  b.overlaps[t]++;
  ev.tileChanged(t);
}

function kitUses(kit: Item, r: ItemRule): number[] {
  return kit.uses ?? [r.painKiller, r.heal, r.stimulant];
}

function sample(path: Pos[], step: number): Pos[] {
  if (path.length <= 2) return path.map((p) => ({ ...p }));
  const out: Pos[] = [];
  for (let i = 0; i < path.length; i += step) out.push({ ...path[i] });
  const last = path[path.length - 1];
  if (out[out.length - 1] !== last) out.push({ ...last });
  return out;
}

export { recalcAllLighting, sightOriginVoxel, livingWeaponFor, carriedWeight };

const HANDS = new Set(["STR_RIGHT_HAND", "STR_LEFT_HAND"]);
const MODES = new Set(["snap", "aimed", "auto"]);
const MEDI = new Set(["heal", "stim", "pain"]);

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}
function validPos(b: Battle, p: unknown): boolean {
  const q = p as Pos;
  return !!q && isInt(q.x) && isInt(q.y) && isInt(q.z) && b.idxP(q) >= 0;
}

/** Rejects malformed or out-of-range commands before they reach the rules. */
function validateCommand(b: Battle, cmd: Command): string | null {
  const c = cmd as Command & Record<string, unknown>;
  if (!isInt(c.unit)) return "STR_INVALID_COMMAND";
  if ("hand" in c && !(HANDS.has(c.hand as string) || (cmd.c === "psi" && c.hand === "innate"))) return "STR_INVALID_COMMAND";
  switch (cmd.c) {
    case "move": case "turn": return validPos(b, cmd.to) ? null : "STR_INVALID_COMMAND";
    case "shoot": return MODES.has(cmd.mode) && validPos(b, cmd.target) ? null : "STR_INVALID_COMMAND";
    case "throw": case "melee": case "psi": case "probe": return validPos(b, cmd.target) ? null : "STR_INVALID_COMMAND";
    case "launch": return Array.isArray(cmd.waypoints) && cmd.waypoints.length > 0 && cmd.waypoints.length <= 20 && cmd.waypoints.every((w) => validPos(b, w)) ? null : "STR_INVALID_COMMAND";
    case "prime": return isInt(cmd.fuse) ? null : "STR_INVALID_COMMAND";
    case "medikit": return isInt(cmd.target) && isInt(cmd.part) && cmd.part >= 0 && cmd.part <= 5 && MEDI.has(cmd.mode) ? null : "STR_INVALID_COMMAND";
    case "inv": return isInt(cmd.item) && Object.prototype.hasOwnProperty.call(INVENTORY_SLOTS, cmd.slot) && isInt(cmd.x) && isInt(cmd.y) ? null : "STR_INVALID_COMMAND";
    case "load": return isInt(cmd.weapon) && isInt(cmd.ammo) ? null : "STR_INVALID_COMMAND";
    case "unload": return isInt(cmd.weapon) ? null : "STR_INVALID_COMMAND";
  }
  return null;
}
