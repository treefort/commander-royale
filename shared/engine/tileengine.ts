// Port of the original battlescape "tile engine": voxel tracing, vision, lighting, blockage,
// explosions, doors and gravity. Coordinates: tiles are 16x16x24 voxels.
import { type Battle, type Unit, isOut, unitHeight, floatHeight } from "./state.ts";
import { TilePart, type MapData } from "../formats/terrain.ts";
import {
  type Pos, VoxelType, BigWall, DX, DY, MAX_VIEW_DISTANCE, MAX_VIEW_DISTANCE_SQR, MAX_VOXEL_VIEW_DISTANCE, MAX_DARKNESS_TO_SEE_UNITS,
  DIR_UP, DIR_DOWN, UnitStatus, vectorToDirection, directionTo, tileDistance, distanceSq,
} from "./defs.ts";
import { DamageType, BattleType, itemRule } from "../rules/index.ts";
import { damageUnit, damageModifier, checkViewSector, FIRE_DAMAGE_MIN, FIRE_DAMAGE_MAX } from "./unitops.ts";
import type { BattleEvents } from "./events.ts";

export const HEIGHT_FROM_CENTER = [0, -2, 2, -4, 4, -6, 6, -8, 8, -12, 12];

// ------------------------------------------------------------------------------------------
// voxel checks
// ------------------------------------------------------------------------------------------

export interface TraceOpts {
  excludeUnit?: Unit | null;
  excludeAllUnits?: boolean;
  excludeAllBut?: Unit | null;
}

export function voxelCheck(b: Battle, vx: number, vy: number, vz: number, o: TraceOpts = {}): VoxelType {
  if (vx < 0 || vy < 0 || vz < 0) return VoxelType.OUTOFBOUNDS;
  const tx = vx >> 4, ty = vy >> 4, tz = Math.floor(vz / 24);
  const ti = b.idx(tx, ty, tz);
  if (ti < 0) return VoxelType.OUTOFBOUNDS;
  const below = tz > 0 ? b.idx(tx, ty, tz - 1) : -1;
  const unitHere = b.unitOnTile(ti);
  const unitBelow = below >= 0 ? b.unitOnTile(below) : undefined;
  if (b.isVoid(ti) && !unitHere && !unitBelow) return VoxelType.EMPTY;

  const floor = b.part(ti, TilePart.FLOOR);
  if (floor && floor.gravLift && (vz % 24 === 0 || vz % 24 === 1)) {
    const bf = below >= 0 ? b.part(below, TilePart.FLOOR) : null;
    if (!(bf && bf.gravLift)) return VoxelType.FLOOR;
  }

  const lx = 15 - (vx & 15);
  const ly = vy & 15;
  const layer = Math.floor((vz % 24) / 2);
  for (let p = TilePart.FLOOR; p <= TilePart.OBJECT; p++) {
    if ((p === TilePart.WESTWALL || p === TilePart.NORTHWALL) && b.isUfoDoorOpen(ti, p)) continue;
    const md = b.part(ti, p);
    if (md) {
      const idx = md.loft[layer] * 16 + ly;
      if (b.lib.voxels[idx] & (1 << lx)) return p as unknown as VoxelType;
    }
  }

  if (!o.excludeAllUnits) {
    let unit = unitHere;
    let tileForUnit = ti;
    if (!unit && b.hasNoFloor(ti, below) && below >= 0) {
      unit = unitBelow;
      tileForUnit = below;
    }
    if (unit && unit !== o.excludeUnit && (!o.excludeAllBut || unit === o.excludeAllBut) && !isOut(unit)) {
      let terrainHeight = 0;
      for (let x = 0; x < unit.size; x++)
        for (let y = 0; y < unit.size; y++) {
          const tl = b.terrainLevel(b.idx(unit.pos.x + x, unit.pos.y + y, unit.pos.z));
          if (tl < terrainHeight) terrainHeight = tl;
        }
      const tz2 = unit.pos.z * 24 + floatHeight(unit) - terrainHeight;
      if (vz > tz2 && vz <= tz2 + unitHeight(unit)) {
        let part = 0;
        if (unit.size > 1) {
          const tp = b.posOf(tileForUnit);
          const parts = [1, 0, 3, 2];
          part = parts[tp.x - unit.pos.x + (tp.y - unit.pos.y) * 2] ?? 0;
        }
        const loft = unit.loftemps[part] ?? unit.loftemps[0];
        if (b.lib.voxels[loft * 16 + ly] & (1 << lx)) return VoxelType.UNIT;
      }
    }
  }
  return VoxelType.EMPTY;
}

/**
 * 3D Bresenham. With doVoxelCheck the trace stops at the first solid voxel (returning its type, and
 * pushing the impact voxel). Without, it walks tiles and accumulates vision blockage (returns >127 when blocked).
 */
export function calculateLine(
  b: Battle, origin: Pos, target: Pos, storeTrajectory: boolean, trajectory: Pos[] | null,
  o: TraceOpts = {}, doVoxelCheck = true,
): number {
  let x0 = origin.x, x1 = target.x, y0 = origin.y, y1 = target.y, z0 = origin.z, z1 = target.z;
  const swapXY = Math.abs(y1 - y0) > Math.abs(x1 - x0);
  if (swapXY) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
  const swapXZ = Math.abs(z1 - z0) > Math.abs(x1 - x0);
  if (swapXZ) { [x0, z0] = [z0, x0]; [x1, z1] = [z1, x1]; }
  const deltaX = Math.abs(x1 - x0), deltaY = Math.abs(y1 - y0), deltaZ = Math.abs(z1 - z0);
  let driftXY = deltaX >> 1, driftXZ = deltaX >> 1;
  const stepX = x0 > x1 ? -1 : 1, stepY = y0 > y1 ? -1 : 1, stepZ = z0 > z1 ? -1 : 1;
  let y = y0, z = z0;
  let lastX = origin.x, lastY = origin.y, lastZ = origin.z;
  let steps = 0;
  let result: number;
  // (x, y, z) walk in swapped space; c* are the real coordinates (no tuple allocation: this is the hottest loop)
  let cx = 0, cy = 0, cz = 0;
  for (let x = x0; ; x += stepX) {
    cx = x; cy = y; cz = z;
    if (swapXZ) { const t = cx; cx = cz; cz = t; }
    if (swapXY) { const t = cx; cx = cy; cy = t; }
    if (storeTrajectory && trajectory) trajectory.push({ x: cx, y: cy, z: cz });
    if (doVoxelCheck) {
      result = voxelCheck(b, cx, cy, cz, o);
      if (result !== VoxelType.EMPTY) {
        if (trajectory) trajectory.push({ x: cx, y: cy, z: cz });
        return result;
      }
    } else {
      const from = b.idx(lastX, lastY, lastZ), to = b.idx(cx, cy, cz);
      const tempRes = verticalBlockage(b, from, to, DamageType.NONE);
      result = horizontalBlockage(b, from, to, DamageType.NONE, steps < 2);
      steps++;
      if (result === -1) {
        if (tempRes > 127) result = 0;
        else return result;
      }
      result += tempRes;
      if (result > 127) return result;
      lastX = cx; lastY = cy; lastZ = cz;
    }
    if (x === x1) break;
    driftXY -= deltaY;
    driftXZ -= deltaZ;
    if (driftXY < 0) {
      y += stepY;
      driftXY += deltaX;
      if (doVoxelCheck) {
        cx = x; cy = y; cz = z;
        if (swapXZ) { const t = cx; cx = cz; cz = t; }
        if (swapXY) { const t = cx; cx = cy; cy = t; }
        result = voxelCheck(b, cx, cy, cz, o);
        if (result !== VoxelType.EMPTY) {
          if (trajectory) trajectory.push({ x: cx, y: cy, z: cz });
          return result;
        }
      }
    }
    if (driftXZ < 0) {
      z += stepZ;
      driftXZ += deltaX;
      if (doVoxelCheck) {
        cx = x; cy = y; cz = z;
        if (swapXZ) { const t = cx; cx = cz; cz = t; }
        if (swapXY) { const t = cx; cx = cy; cy = t; }
        result = voxelCheck(b, cx, cy, cz, o);
        if (result !== VoxelType.EMPTY) {
          if (trajectory) trajectory.push({ x: cx, y: cy, z: cz });
          return result;
        }
      }
    }
  }
  return VoxelType.EMPTY;
}

/** Thrown items: a parabola built from short line segments. */
export function calculateParabola(
  b: Battle, origin: Pos, target: Pos, storeTrajectory: boolean, trajectory: Pos[] | null,
  excludeUnit: Unit | null, curvature: number, delta: Pos,
): number {
  const ro = Math.sqrt((target.x - origin.x) ** 2 + (target.y - origin.y) ** 2 + (target.z - origin.z) ** 2);
  if (ro === 0) return VoxelType.EMPTY;
  let fi = Math.acos((target.z - origin.z) / ro);
  let te = Math.atan2(target.y - origin.y, target.x - origin.x);
  te += ((delta.x / ro) / 2) * Math.PI;
  fi += (((delta.z + delta.y) / ro) / 14) * Math.PI * curvature;
  const zA = Math.sqrt(ro) * curvature;
  const zK = (4.0 * zA) / ro / ro;
  let x = origin.x, y = origin.y, z = origin.z;
  let i = 8;
  let result: number = VoxelType.EMPTY;
  let last: Pos = { x, y, z };
  if (storeTrajectory && trajectory) trajectory.push({ ...last });
  let guard = 0;
  while (z > 0 && guard++ < 4000) {
    x = Math.trunc(origin.x + i * Math.cos(te) * Math.sin(fi));
    y = Math.trunc(origin.y + i * Math.sin(te) * Math.sin(fi));
    z = Math.trunc(origin.z + i * Math.cos(fi) - zK * (i - ro / 2.0) * (i - ro / 2.0) + zA);
    const next: Pos = { x, y, z };
    if (storeTrajectory && trajectory) trajectory.pop();
    result = calculateLine(b, last, next, storeTrajectory, storeTrajectory ? trajectory : null, { excludeUnit });
    if (result !== VoxelType.EMPTY) {
      if (!storeTrajectory && trajectory) result = calculateLine(b, last, next, false, trajectory, { excludeUnit });
      break;
    }
    last = next;
    ++i;
  }
  return result;
}

// ------------------------------------------------------------------------------------------
// blockage (vision / explosions / smoke / fire)
// ------------------------------------------------------------------------------------------

function mdBlock(md: MapData, type: DamageType): number {
  switch (type) {
    case DamageType.NONE: return md.stopLOS ? 255 : 0;
    case DamageType.SMOKE: return md.blockSmoke ? 256 : 0;
    case DamageType.HE:
    case DamageType.IN:
    case DamageType.STUN: return md.heBlock;
    default: return 0;
  }
}

export function blockage(b: Battle, tile: number, part: TilePart, type: DamageType, direction = -1, checkingFromOrigin = false): number {
  let block = 0;
  if (tile < 0) return 0;
  const md = b.part(tile, part);
  if (md) {
    let check = true;
    let wall = -1;
    if (direction !== -1) {
      const obj = b.part(tile, TilePart.OBJECT);
      wall = obj ? obj.bigWall : 0;
      if (type !== DamageType.SMOKE && checkingFromOrigin && (wall === BigWall.NESW || wall === BigWall.NWSE)) check = false;
      switch (direction) {
        case 0: if (wall === BigWall.WEST || wall === BigWall.EAST || wall === BigWall.SOUTH || wall === BigWall.EAST_AND_SOUTH) check = false; break;
        case 1: if (wall === BigWall.WEST || wall === BigWall.SOUTH) check = false; break;
        case 2: if (wall === BigWall.NORTH || wall === BigWall.SOUTH || wall === BigWall.WEST || wall === BigWall.WEST_AND_NORTH) check = false; break;
        case 3: if (wall === BigWall.NORTH || wall === BigWall.WEST || wall === BigWall.WEST_AND_NORTH) check = false; break;
        case 4: if (wall === BigWall.WEST || wall === BigWall.EAST || wall === BigWall.NORTH || wall === BigWall.WEST_AND_NORTH) check = false; break;
        case 5: if (wall === BigWall.NORTH || wall === BigWall.EAST) check = false; break;
        case 6: if (wall === BigWall.NORTH || wall === BigWall.SOUTH || wall === BigWall.EAST || wall === BigWall.EAST_AND_SOUTH) check = false; break;
        case 7: if (wall === BigWall.SOUTH || wall === BigWall.EAST || wall === BigWall.EAST_AND_SOUTH) check = false; break;
        case 8:
        case 9: if (wall !== 0 && wall !== BigWall.BLOCK) check = false; break;
      }
    } else if (part === TilePart.FLOOR && mdBlock(md, type) === 0) {
      if (type !== DamageType.NONE) block += md.armor;
      else if (!md.noFloor) return 256;
    }
    if (check) {
      if (type === DamageType.SMOKE && wall !== 0 && !b.isUfoDoorOpen(tile, part)) return 256;
      block += mdBlock(md, type);
    }
  }
  if (b.isUfoDoorOpen(tile, part)) block = 0;
  return block;
}

function rel(b: Battle, tile: number, dx: number, dy: number): number {
  const p = b.posOf(tile);
  return b.idx(p.x + dx, p.y + dy, p.z);
}

export function horizontalBlockage(b: Battle, start: number, end: number, type: DamageType, skipObject: boolean): number {
  if (start < 0 || end < 0) return 0;
  const sp = b.posOf(start), ep = b.posOf(end);
  if (sp.z !== ep.z) return 0;
  const direction = vectorToDirection(ep.x - sp.x, ep.y - sp.y);
  if (direction === -1) return 0;
  let block = 0;
  const N = rel(b, start, 0, -1), E = rel(b, start, 1, 0), S = rel(b, start, 0, 1), W = rel(b, start, -1, 0);
  const objBW = (t: number) => {
    const o = t >= 0 ? b.part(t, TilePart.OBJECT) : null;
    return o ? o.bigWall : -999;
  };
  const NONE = type === DamageType.NONE;
  switch (direction) {
    case 0: block = blockage(b, start, TilePart.NORTHWALL, type); break;
    case 1:
      if (NONE) {
        block = blockage(b, start, TilePart.NORTHWALL, type) + blockage(b, end, TilePart.WESTWALL, type);
        if (N >= 0 && b.part(N, TilePart.OBJECT) && objBW(N) !== BigWall.NESW) block += blockage(b, N, TilePart.OBJECT, type, 3);
        if (block === 0) break;
        block = blockage(b, E, TilePart.NORTHWALL, type) + blockage(b, E, TilePart.WESTWALL, type);
        if (E >= 0 && b.part(E, TilePart.OBJECT) && objBW(E) !== BigWall.NESW) block += blockage(b, E, TilePart.OBJECT, type, 7);
      } else {
        block = Math.floor((blockage(b, start, TilePart.NORTHWALL, type) + blockage(b, end, TilePart.WESTWALL, type)) / 2)
          + Math.floor((blockage(b, E, TilePart.WESTWALL, type) + blockage(b, E, TilePart.NORTHWALL, type)) / 2);
        block += Math.floor((blockage(b, N, TilePart.OBJECT, type, 4) + blockage(b, E, TilePart.OBJECT, type, 6)) / 2);
      }
      break;
    case 2: block = blockage(b, end, TilePart.WESTWALL, type); break;
    case 3:
      if (NONE) {
        block = blockage(b, S, TilePart.NORTHWALL, type) + blockage(b, end, TilePart.WESTWALL, type);
        if (S >= 0 && b.part(S, TilePart.OBJECT) && objBW(S) !== BigWall.NWSE) block += blockage(b, S, TilePart.OBJECT, type, 1);
        if (block === 0) break;
        block = blockage(b, E, TilePart.WESTWALL, type) + blockage(b, end, TilePart.NORTHWALL, type);
        if (E >= 0 && b.part(E, TilePart.OBJECT) && objBW(E) !== BigWall.NWSE) block += blockage(b, E, TilePart.OBJECT, type, 5);
      } else {
        block = Math.floor((blockage(b, end, TilePart.WESTWALL, type) + blockage(b, end, TilePart.NORTHWALL, type)) / 2)
          + Math.floor((blockage(b, E, TilePart.WESTWALL, type) + blockage(b, S, TilePart.NORTHWALL, type)) / 2);
        block += Math.floor((blockage(b, S, TilePart.OBJECT, type, 0) + blockage(b, E, TilePart.OBJECT, type, 6)) / 2);
      }
      break;
    case 4: block = blockage(b, end, TilePart.NORTHWALL, type); break;
    case 5:
      if (NONE) {
        block = blockage(b, S, TilePart.NORTHWALL, type) + blockage(b, S, TilePart.WESTWALL, type);
        if (S >= 0 && b.part(S, TilePart.OBJECT) && objBW(S) !== BigWall.NESW) block += blockage(b, S, TilePart.OBJECT, type, 7);
        if (block === 0) break;
        block = blockage(b, start, TilePart.WESTWALL, type) + blockage(b, end, TilePart.NORTHWALL, type);
        if (W >= 0 && b.part(W, TilePart.OBJECT) && objBW(W) !== BigWall.NESW) block += blockage(b, W, TilePart.OBJECT, type, 3);
      } else {
        block = Math.floor((blockage(b, end, TilePart.NORTHWALL, type) + blockage(b, start, TilePart.WESTWALL, type)) / 2)
          + Math.floor((blockage(b, S, TilePart.WESTWALL, type) + blockage(b, S, TilePart.NORTHWALL, type)) / 2);
        block += Math.floor((blockage(b, S, TilePart.OBJECT, type, 0) + blockage(b, W, TilePart.OBJECT, type, 2)) / 2);
      }
      break;
    case 6: block = blockage(b, start, TilePart.WESTWALL, type); break;
    case 7:
      if (NONE) {
        block = blockage(b, start, TilePart.NORTHWALL, type) + blockage(b, N, TilePart.WESTWALL, type);
        if (N >= 0 && b.part(N, TilePart.OBJECT) && objBW(N) !== BigWall.NWSE) block += blockage(b, N, TilePart.OBJECT, type, 5);
        if (block === 0) break;
        block = blockage(b, start, TilePart.WESTWALL, type) + blockage(b, W, TilePart.NORTHWALL, type);
        if (W >= 0 && b.part(W, TilePart.OBJECT) && objBW(W) !== BigWall.NWSE) block += blockage(b, W, TilePart.OBJECT, type, 1);
      } else {
        block = Math.floor((blockage(b, start, TilePart.WESTWALL, type) + blockage(b, start, TilePart.NORTHWALL, type)) / 2)
          + Math.floor((blockage(b, N, TilePart.WESTWALL, type) + blockage(b, W, TilePart.NORTHWALL, type)) / 2);
        block += Math.floor((blockage(b, N, TilePart.OBJECT, type, 4) + blockage(b, W, TilePart.OBJECT, type, 2)) / 2);
      }
      break;
  }
  if (!skipObject || (NONE && b.isBigWall(start))) block += blockage(b, start, TilePart.OBJECT, type, direction);
  let d2 = direction + 4;
  if (d2 > 7) d2 -= 8;
  if (!NONE) {
    if (b.isBigWall(end)) block += blockage(b, end, TilePart.OBJECT, type, d2, true);
  } else if (block <= 127) {
    if (blockage(b, end, TilePart.OBJECT, type, d2, true) > 127) return -1;
  }
  return block;
}

export function verticalBlockage(b: Battle, start: number, end: number, type: DamageType, skipObject = false): number {
  if (start < 0 || end < 0) return 0;
  const sp = b.posOf(start), ep = b.posOf(end);
  const direction = ep.z - sp.z;
  if (direction === 0) return 0;
  let block = 0;
  let x = sp.x, y = sp.y, z = sp.z;
  if (direction < 0) {
    block += blockage(b, start, TilePart.FLOOR, type);
    if (!skipObject) block += blockage(b, start, TilePart.OBJECT, type, DIR_DOWN);
    if (x !== ep.x || y !== ep.y) {
      x = ep.x; y = ep.y;
      const cur = b.idx(x, y, z);
      block += horizontalBlockage(b, start, cur, type, skipObject);
      block += blockage(b, cur, TilePart.FLOOR, type);
      if (!skipObject) block += blockage(b, cur, TilePart.OBJECT, type, DIR_DOWN);
    }
  } else {
    z += 1;
    let cur = b.idx(x, y, z);
    block += blockage(b, cur, TilePart.FLOOR, type);
    if (!skipObject) block += blockage(b, cur, TilePart.OBJECT, type, DIR_UP);
    if (x !== ep.x || y !== ep.y) {
      x = ep.x; y = ep.y;
      cur = b.idx(x, y, z);
      block += horizontalBlockage(b, start, cur, type, skipObject);
      block += blockage(b, cur, TilePart.FLOOR, type);
      if (!skipObject) block += blockage(b, cur, TilePart.OBJECT, type, DIR_UP);
    }
  }
  return block;
}

// ------------------------------------------------------------------------------------------
// lighting
// ------------------------------------------------------------------------------------------

export function calculateSunShading(b: Battle) {
  const power = 15 - b.globalShade;
  const layerSize = b.sx * b.sy;
  for (let i = 0; i < b.size; i++) {
    let p = power;
    if (b.globalShade <= 4) {
      const z0 = Math.floor(i / layerSize);
      let block = 0;
      for (let z = b.sz - 1; z > z0; z--) {
        const t = i + (z - z0) * layerSize;
        block += blockage(b, t, TilePart.FLOOR, DamageType.NONE);
        block += blockage(b, t, TilePart.OBJECT, DamageType.NONE, DIR_DOWN);
      }
      if (block > 0) p -= 2;
    }
    b.light[i * 3] = Math.max(0, p);
  }
}

function addLight(b: Battle, center: Pos, power: number, layer: number, target?: Uint8Array) {
  for (let x = 0; x <= power; x++)
    for (let y = 0; y <= power; y++) {
      const distance = Math.round(Math.sqrt(x * x + y * y));
      const v = power - distance;
      if (v <= 0) continue;
      for (let z = 0; z < b.sz; z++) {
        for (const [sx, sy] of [[1, 1], [-1, -1], [-1, 1], [1, -1]]) {
          const t = b.idx(center.x + sx * x, center.y + sy * y, z);
          if (t < 0) continue;
          if (target) {
            if (target[t] < v) target[t] = v;
          } else if (b.light[t * 3 + layer] < v) b.light[t * 3 + layer] = v;
        }
      }
    }
}

export const PERSONAL_LIGHT = 15;

export function calculateTerrainLighting(b: Battle) {
  for (let i = 0; i < b.size; i++) b.light[i * 3 + 1] = 0;
  for (let i = 0; i < b.size; i++) {
    const f = b.part(i, TilePart.FLOOR), o = b.part(i, TilePart.OBJECT);
    if (f && f.lightSource) addLight(b, b.posOf(i), f.lightSource, 1);
    if (o && o.lightSource) addLight(b, b.posOf(i), o.lightSource, 1);
    if (b.fire[i]) addLight(b, b.posOf(i), 15, 1);
  }
  for (const it of b.items) {
    if (it.tile >= 0 && itemRule(it.type).battleType === BattleType.FLARE) addLight(b, b.posOf(it.tile), itemRule(it.type).power, 1);
  }
}

export function calculateUnitLighting(b: Battle) {
  for (let i = 0; i < b.size; i++) b.light[i * 3 + 2] = 0;
  for (const p of b.personal) p.fill(0);
  for (const u of b.units) {
    if (isOut(u)) continue;
    if (u.fire) addLight(b, u.pos, 15, 2);
    // like the original's soldier lighting, but each squad only lights the map for itself
    const pl = b.personal[u.owner];
    if (pl && b.globalShade > 0) addLight(b, u.pos, PERSONAL_LIGHT, 0, pl);
  }
}

export function recalcAllLighting(b: Battle) {
  calculateSunShading(b);
  calculateTerrainLighting(b);
  calculateUnitLighting(b);
}

// ------------------------------------------------------------------------------------------
// vision
// ------------------------------------------------------------------------------------------

export function sightOriginVoxel(b: Battle, u: Unit): Pos {
  const t = b.idxP(u.pos);
  const o: Pos = { x: u.pos.x * 16 + 8, y: u.pos.y * 16 + 8, z: u.pos.z * 24 };
  o.z += -b.terrainLevel(t);
  o.z += unitHeight(u) + floatHeight(u) - 1;
  const above = b.idx(u.pos.x, u.pos.y, u.pos.z + 1);
  if (u.size > 1) {
    o.x += 8;
    o.y += 8;
    o.z += 1;
  }
  if (o.z >= (u.pos.z + 1) * 24 && (above < 0 || !b.hasNoFloor(above, -1))) {
    while (o.z >= (u.pos.z + 1) * 24) o.z--;
  }
  return o;
}

/** Whether `viewer` can see the unit standing on `tile` (range, darkness, LOS, smoke). */
export function visible(b: Battle, viewer: Unit, tile: number): boolean {
  const target = b.unitOnTile(tile);
  if (!target || isOut(target)) return false;
  const tp = b.posOf(tile);
  const dist = tileDistance(viewer.pos, tp);
  if ((!viewer.nightVision && dist > 9 && b.shade(tile, viewer.owner) > MAX_DARKNESS_TO_SEE_UNITS) || dist > MAX_VIEW_DISTANCE) return false;
  if (viewer.owner === target.owner) return true;
  const origin = sightOriginVoxel(b, viewer);
  const scan: Pos = { x: 0, y: 0, z: 0 };
  let seen = canTargetUnit(b, origin, tile, scan, viewer);
  if (seen) {
    const traj: Pos[] = [];
    calculateLine(b, origin, scan, true, traj, { excludeUnit: viewer });
    let visibleDistance = traj.length;
    let lastT = -2;
    for (const v of traj) {
      const t = b.idx(v.x >> 4, v.y >> 4, Math.floor(v.z / 24));
      if (t !== lastT) lastT = t;
      if (t >= 0 && b.fire[t] === 0) visibleDistance += Math.floor(b.smoke[t] / 3);
      if (visibleDistance > MAX_VOXEL_VIEW_DISTANCE) {
        seen = false;
        break;
      }
    }
  }
  return seen;
}

/** Finds a voxel on the target unit reachable by a straight line from `origin`. */
export function canTargetUnit(b: Battle, origin: Pos, tile: number, scan: Pos, exclude: Unit | null, potentialUnit?: Unit): boolean {
  const tp = b.posOf(tile);
  const target: Pos = { x: tp.x * 16 + 8, y: tp.y * 16 + 8, z: tp.z * 24 };
  const hypothetical = !!potentialUnit;
  const pu = potentialUnit ?? b.unitOnTile(tile);
  if (!pu) return false;
  if (pu === exclude) return false;
  const targetMinHeight = target.z - b.terrainLevel(tile) + floatHeight(pu);
  let unitRadius = pu.loftemps[0];
  const targetSize = pu.size - 1;
  const xOffset = pu.pos.x - tp.x, yOffset = pu.pos.y - tp.y;
  if (targetSize > 0) unitRadius = 3;
  const relX0 = target.x - origin.x, relY0 = target.y - origin.y;
  const len = Math.sqrt(relX0 * relX0 + relY0 * relY0) || 1;
  const normal = unitRadius / len;
  const relX = Math.floor(relY0 * normal + 0.5);
  const relY = Math.floor(-relX0 * normal + 0.5);
  const slice = [0, 0, relX, relY, -relX, -relY, relY, -relX, -relY, relX];
  let heightRange = isOut(pu) ? 12 : unitHeight(pu);
  const targetMaxHeight = targetMinHeight + heightRange;
  const targetCenter = Math.floor((targetMaxHeight + targetMinHeight) / 2);
  heightRange = Math.floor(heightRange / 2);
  if (heightRange > 10) heightRange = 10;
  if (heightRange <= 0) heightRange = 0;
  for (let i = 0; i <= heightRange; i++) {
    scan.z = targetCenter + HEIGHT_FROM_CENTER[i];
    for (let j = 0; j < 5; j++) {
      if (i < heightRange - 1 && j > 2) break;
      scan.x = target.x + slice[j * 2];
      scan.y = target.y + slice[j * 2 + 1];
      const traj: Pos[] = [];
      const test = calculateLine(b, origin, scan, false, traj, { excludeUnit: exclude });
      if (test === VoxelType.UNIT) {
        for (let x = 0; x <= targetSize; x++)
          for (let y = 0; y <= targetSize; y++) {
            if ((traj[0].x >> 4) === (scan.x >> 4) + x + xOffset && (traj[0].y >> 4) === (scan.y >> 4) + y + yOffset &&
              traj[0].z >= targetMinHeight && traj[0].z <= targetMaxHeight) return true;
          }
      } else if (test === VoxelType.EMPTY && hypothetical && traj.length) {
        return true;
      }
    }
  }
  return false;
}

const SLICE_OBJECT_SPIRAL = [8, 8, 8, 6, 10, 6, 10, 8, 10, 10, 8, 10, 6, 10, 6, 8, 6, 6,
  8, 4, 10, 4, 12, 4, 12, 6, 12, 8, 12, 10, 12, 12, 10, 12, 8, 12, 6, 12, 4, 12, 4, 10, 4, 8, 4, 6, 4, 4, 6, 4,
  8, 1, 12, 1, 15, 1, 15, 4, 15, 8, 15, 12, 15, 15, 12, 15, 8, 15, 4, 15, 1, 15, 1, 12, 1, 8, 1, 4, 1, 1, 4, 1];
const WEST_WALL_SPIRAL = [0, 7, 0, 9, 0, 6, 0, 11, 0, 4, 0, 13, 0, 2];
const NORTH_WALL_SPIRAL = [7, 0, 9, 0, 6, 0, 11, 0, 4, 0, 13, 0, 2, 0];

/** Finds a voxel of a terrain part that a straight line from origin can hit. */
export function canTargetTile(b: Battle, origin: Pos, tile: number, part: TilePart | -1, scan: Pos, exclude: Unit | null): boolean {
  const tp = b.posOf(tile);
  const tv: Pos = { x: tp.x * 16, y: tp.y * 16, z: tp.z * 24 };
  let spiral: number[];
  let count: number;
  let minZ = 0, maxZ = 0, minFound = false, maxFound = false;
  if (part === TilePart.OBJECT) { spiral = SLICE_OBJECT_SPIRAL; count = 41; }
  else if (part === TilePart.NORTHWALL) { spiral = NORTH_WALL_SPIRAL; count = 7; }
  else if (part === TilePart.WESTWALL) { spiral = WEST_WALL_SPIRAL; count = 7; }
  else if (part === TilePart.FLOOR) { spiral = SLICE_OBJECT_SPIRAL; count = 41; minFound = maxFound = true; }
  else { spiral = SLICE_OBJECT_SPIRAL; count = 41; minFound = maxFound = true; minZ = maxZ = 12; }
  const want = part as number;
  if (!minFound) {
    for (let j = 1; j < 12 && !minFound; j++)
      for (let i = 0; i < count; i++)
        if (voxelCheck(b, tv.x + spiral[i * 2], tv.y + spiral[i * 2 + 1], tv.z + j * 2, { excludeAllUnits: true }) === want) {
          minZ = j * 2;
          minFound = true;
          break;
        }
  }
  if (!minFound) return false;
  if (!maxFound) {
    for (let j = 10; j >= 0 && !maxFound; j--)
      for (let i = 0; i < count; i++)
        if (voxelCheck(b, tv.x + spiral[i * 2], tv.y + spiral[i * 2 + 1], tv.z + j * 2, { excludeAllUnits: true }) === want) {
          maxZ = j * 2;
          maxFound = true;
          break;
        }
  }
  if (!maxFound) return false;
  if (minZ > maxZ) minZ = maxZ;
  const rangeZ = Math.min(10, maxZ - minZ);
  const centerZ = Math.floor((maxZ + minZ) / 2);
  for (let j = 0; j <= rangeZ; j++) {
    scan.z = tv.z + centerZ + HEIGHT_FROM_CENTER[j];
    for (let i = 0; i < count; i++) {
      scan.x = tv.x + spiral[i * 2];
      scan.y = tv.y + spiral[i * 2 + 1];
      const traj: Pos[] = [];
      const test = calculateLine(b, origin, scan, false, traj, { excludeUnit: exclude });
      if (test === want && want !== -1) {
        if ((traj[0].x >> 4) === (scan.x >> 4) && (traj[0].y >> 4) === (scan.y >> 4) && Math.floor(traj[0].z / 24) === Math.floor(scan.z / 24)) return true;
      }
    }
  }
  return false;
}

/**
 * Recomputes what a unit sees: the enemy units in view and (for its owner) newly discovered tiles.
 * Returns ids of enemy units that became visible.
 */
export function calculateFOV(b: Battle, u: Unit, tiles = true): number[] {
  const oldVisible = new Set(u.visibleUnits);
  u.visibleUnits = [];
  if (isOut(u)) return [];
  const center = u.pos;
  const dir = u.turretType >= 0 ? u.turretDir : u.dir;
  const swap = dir === 0 || dir === 4;
  const signX = [1, 1, 1, 1, -1, -1, -1, -1];
  const signY = [-1, -1, -1, 1, 1, 1, -1, -1];
  let eye = { ...u.pos };
  if (unitHeight(u) + floatHeight(u) - b.terrainLevel(b.idxP(u.pos)) >= 24 + 4) {
    const above = b.idx(eye.x, eye.y, eye.z + 1);
    if (above >= 0 && b.hasNoFloor(above, -1)) eye.z++;
  }
  const disc = b.discovered[u.owner];
  const newly: number[] = [];
  for (let x = 0; x <= MAX_VIEW_DISTANCE; x++) {
    const y1 = dir % 2 ? 0 : -x;
    const y2 = dir % 2 ? MAX_VIEW_DISTANCE : x;
    for (let y = y1; y <= y2; y++) {
      if (x * x + y * y > MAX_VIEW_DISTANCE_SQR) continue;
      const tx = center.x + signX[dir] * (swap ? y : x);
      const ty = center.y + signY[dir] * (swap ? x : y);
      if (tx < 0 || ty < 0 || tx >= b.sx || ty >= b.sy) continue;
      for (let z = 0; z < b.sz; z++) {
        const t = b.idx(tx, ty, z);
        const vu = b.unitOnTile(t);
        if (vu && !isOut(vu) && vu.owner !== u.owner && b.unitAt[t] && visible(b, u, t)) {
          if (!u.visibleUnits.includes(vu.id)) {
            u.visibleUnits.push(vu.id);
            if (!oldVisible.has(vu.id)) newly.push(vu.id);
            if (!u.spottedThisTurn.includes(vu.id)) u.spottedThisTurn.push(vu.id);
          }
        }
        if (tiles && disc && disc[t] !== 7) {
          for (let xo = 0; xo < u.size; xo++)
            for (let yo = 0; yo < u.size; yo++) {
              const traj: Pos[] = [];
              const tst = calculateLine(b, { x: eye.x + xo, y: eye.y + yo, z: eye.z }, { x: tx, y: ty, z }, true, traj, { excludeUnit: u }, false);
              let n = traj.length;
              if (tst > 127) n--;
              for (let k = 0; k < n; k++) {
                const p = traj[k];
                const pi = b.idx(p.x, p.y, p.z);
                if (pi < 0) continue;
                disc[pi] |= 7;
                const e = b.idx(p.x + 1, p.y, p.z);
                if (e >= 0) disc[e] |= 1;
                const s = b.idx(p.x, p.y + 1, p.z);
                if (s >= 0) disc[s] |= 2;
              }
            }
        }
      }
    }
  }
  return newly;
}

/** Only re-checks which enemies `u` sees (no tile discovery) — cheap, used when others move. */
export function refreshVisibleUnits(b: Battle, u: Unit): number[] {
  return calculateFOV(b, u, false);
}

export function recalculateAllFOV(b: Battle) {
  for (const u of b.units) if (!isOut(u)) calculateFOV(b, u, true);
}

/** Units of other players that can currently see `target`. */
export function isUnitVisibleTo(b: Battle, target: Unit, player: number): boolean {
  if (target.owner === player) return true;
  for (const u of b.units) {
    if (u.owner === player && !isOut(u) && u.visibleUnits.includes(target.id)) return true;
  }
  return false;
}

// ------------------------------------------------------------------------------------------
// projectile origin
// ------------------------------------------------------------------------------------------

export function originVoxel(b: Battle, actor: Unit, target: Pos, throwing: boolean, fromTile?: Pos): Pos {
  const dirYshift = [1, 1, 8, 15, 15, 15, 8, 1];
  const dirXshift = [8, 14, 15, 15, 8, 1, 1, 1];
  const origin = { ...(fromTile ?? actor.pos) };
  const tile = b.idxP(origin);
  const above = b.idx(origin.x, origin.y, origin.z + 1);
  const ov: Pos = { x: origin.x * 16, y: origin.y * 16, z: origin.z * 24 };
  ov.z += -b.terrainLevel(tile);
  ov.z += unitHeight(actor) + floatHeight(actor);
  ov.z -= throwing ? 3 : 4;
  if (ov.z >= (origin.z + 1) * 24) {
    if (above >= 0 && b.hasNoFloor(above, -1)) {
      origin.z++;
    } else {
      while (ov.z >= (origin.z + 1) * 24) ov.z--;
      ov.z -= 4;
    }
  }
  const d = directionTo(origin, target);
  ov.x += dirXshift[d] * actor.size;
  ov.y += dirYshift[d] * actor.size;
  return ov;
}

// ------------------------------------------------------------------------------------------
// damage: hits and explosions
// ------------------------------------------------------------------------------------------

export const DAMAGE_RANGE = 100;
export const EXPLOSIVE_DAMAGE_RANGE = 50;

/** A bullet/melee hit on a voxel. Returns the unit hit (if any). */
/** `range`: how far (%) a hit on a unit may roll either side of `power` (the original's 0-200%, HE's 50-150%). */
export function hit(b: Battle, ev: BattleEvents, center: Pos, power: number, type: DamageType, attacker: Unit | null, range?: number): Unit | null {
  const ti = b.idx(center.x >> 4, center.y >> 4, Math.floor(center.z / 24));
  if (ti < 0) return null;
  let bu = b.unitOnTile(ti) ?? null;
  const part = voxelCheck(b, center.x, center.y, center.z, { excludeUnit: attacker });
  if (part >= VoxelType.FLOOR && part <= VoxelType.OBJECT) {
    const rnd = b.rng.int(Math.floor(power / 4), Math.floor((power * 3) / 4));
    damageTile(b, ev, ti, part as unknown as TilePart, rnd);
  } else if (part === VoxelType.UNIT) {
    const rng = range ?? (type === DamageType.HE ? EXPLOSIVE_DAMAGE_RANGE : DAMAGE_RANGE);
    const rnd = b.rng.int(Math.floor((power * (100 - rng)) / 100), Math.floor((power * (100 + rng)) / 100));
    let verticalOffset = 0;
    if (!bu) {
      const below = b.idx(center.x >> 4, center.y >> 4, Math.floor(center.z / 24) - 1);
      const ub = below >= 0 ? b.unitOnTile(below) : undefined;
      if (ub) {
        bu = ub;
        verticalOffset = 24;
      }
    }
    if (bu && bu.health !== 0 && bu.stun < bu.health) {
      const sz = bu.size * 8;
      const tgt = { x: bu.pos.x * 16 + sz, y: bu.pos.y * 16 + sz, z: bu.pos.z * 24 + floatHeight(bu) - b.terrainLevel(ti) };
      const relative = { x: center.x - tgt.x, y: center.y - tgt.y, z: center.z - tgt.z - verticalOffset };
      const dmg = damageUnit(b, bu, relative, rnd, type);
      ev.damage(bu, dmg, type, attacker);
      if (attacker) noteHit(b, bu, attacker);
      if ((bu.specab === 1 || bu.specab === 3) && !isOut(bu) && (bu.health === 0 || bu.stun >= bu.health)) {
        if (type !== DamageType.STUN && type !== DamageType.HE && type !== DamageType.IN && type !== DamageType.MELEE) ev.pendingDeathExplosions.push(bu.id);
      }
    }
  }
  applyGravity(b, ev, ti);
  ev.focus = b.posOf(ti);
  return bu;
}

function noteHit(b: Battle, victim: Unit, attacker: Unit) {
  let s = b.hitBy.get(victim.id);
  if (!s) b.hitBy.set(victim.id, (s = new Set()));
  s.add(attacker.id);
}

function damageTile(b: Battle, ev: BattleEvents, ti: number, part: TilePart, power: number) {
  const md = b.part(ti, part);
  if (md && power >= md.armor) {
    destroyPart(b, ev, ti, part);
    ev.terrainChanged = true;
  }
}

/** Replaces a tile part with its "dead" version and arms chained terrain explosions. */
export function destroyPart(b: Battle, ev: BattleEvents, ti: number, part: TilePart): void {
  const md = b.part(ti, part);
  if (md) {
    if (md.gravLift) return;
    b.setPart(ti, part, -1);
    if (md.dieMCD) {
      const dead = b.lib.mapData[md.dieMCD];
      b.setPart(ti, dead.objectType, md.dieMCD);
    }
    if (md.heStrength) {
      if (b.explosive[ti] < md.heStrength) {
        b.explosive[ti] = md.heStrength;
        b.explosiveType[ti] = md.heType;
      }
    }
    ev.tileChanged(ti);
  }
  // blasting through the bottom level leaves scorched earth
  if (part === TilePart.FLOOR && b.posOf(ti).z === 0 && !b.part(ti, TilePart.FLOOR)) {
    b.setPart(ti, TilePart.FLOOR, b.lib.datasetStart[0] + 1);
    ev.tileChanged(ti);
  }
}

function flammability(b: Battle, ti: number, part: TilePart): number {
  const md = b.part(ti, part);
  return md ? md.flammable : 255;
}
function fuelOf(b: Battle, ti: number, part: TilePart): number {
  const md = b.part(ti, part);
  return md ? md.fuel : 0;
}
function tileFlammability(b: Battle, ti: number): number {
  let flam = 255;
  for (let p = 0; p < 4; p++) {
    const md = b.part(ti, p as TilePart);
    if (md && md.flammable < flam) flam = md.flammable;
  }
  return flam;
}
function tileFuel(b: Battle, ti: number): number {
  let fuel = 0;
  for (let p = 0; p < 4; p++) {
    const md = b.part(ti, p as TilePart);
    if (md && md.fuel > fuel) fuel = md.fuel;
  }
  return fuel;
}

export function ignite(b: Battle, ev: BattleEvents, ti: number, power: number) {
  const flam = tileFlammability(b, ti);
  if (flam === 255) return;
  power = Math.max(0, power - Math.floor(flam / 10) + 15);
  if (b.rng.percent(power) && tileFuel(b, ti)) {
    if (b.fire[ti] === 0) {
      b.smoke[ti] = 15 - clamp(Math.floor(flam / 10), 1, 12);
      b.overlaps[ti] = 1;
      b.fire[ti] = tileFuel(b, ti) + 1;
      ev.tileChanged(ti);
    }
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Spherical-ish raycast explosion (HE, incendiary, smoke, stun). */
export function explode(b: Battle, ev: BattleEvents, center: Pos, power: number, type: DamageType, maxRadius: number, attacker: Unit | null) {
  const cz = Math.floor(center.z / 24) + 0.5;
  const cx = (center.x >> 4) + 0.5;
  const cy = (center.y >> 4) + 0.5;
  let hitSide = 0;
  let diagonalWall = 0;
  if (type === DamageType.IN) power = Math.floor(power / 2);
  const vdec = 1000; // the original game's explosions stay (almost) flat on one level
  const dmgRng = type === DamageType.HE ? EXPLOSIVE_DAMAGE_RANGE : DAMAGE_RANGE;
  const originTile = b.idx(Math.floor(cx), Math.floor(cy), Math.floor(cz));
  if (originTile < 0) return;
  if (b.isBigWall(originTile)) {
    diagonalWall = b.part(originTile, TilePart.OBJECT)!.bigWall;
    if (diagonalWall === BigWall.NWSE) hitSide = (center.x % 16) - (center.y % 16) > 0 ? 1 : -1;
    if (diagonalWall === BigWall.NESW) hitSide = (center.x % 16) + (center.y % 16) - 15 > 0 ? 1 : -1;
  }
  const affected = new Set<number>();
  const he = new Map<number, number>(); // tile -> explosive power applied
  const deg = Math.PI / 180;
  for (let fi = -90; fi <= 90; fi += 5) {
    for (let te = 0; te <= 360; te += 3) {
      const cosTe = Math.cos(te * deg), sinTe = Math.sin(te * deg), sinFi = Math.sin(fi * deg), cosFi = Math.cos(fi * deg);
      let origin = originTile;
      let dest = origin;
      let l = 0;
      let pw = power;
      while (pw > 0 && l <= maxRadius) {
        if (type === DamageType.HE) {
          if ((he.get(dest) ?? 0) < pw) he.set(dest, pw);
        }
        if (!affected.has(dest)) {
          affected.add(dest);
          const min = Math.floor((pw * (100 - dmgRng)) / 100);
          const max = Math.floor((pw * (100 + dmgRng)) / 100);
          let bu = b.unitOnTile(dest) ?? null;
          const dp = b.posOf(dest);
          const below = dp.z > 0 ? b.idx(dp.x, dp.y, dp.z - 1) : -1;
          if (!bu && dp.z > 0 && b.hasNoFloor(dest, below)) {
            bu = b.unitOnTile(below) ?? null;
            if (bu && unitHeight(bu) + floatHeight(bu) - b.terrainLevel(below) <= 24) bu = null;
          }
          switch (type) {
            case DamageType.STUN:
              if (bu) {
                const d = tileDistance(dp, { x: Math.floor(cx), y: Math.floor(cy), z: Math.floor(cz) });
                const rel = d < 2 ? { x: 0, y: 0, z: 0 } : { x: Math.floor(cx) - dp.x, y: Math.floor(cy) - dp.y, z: Math.floor(cz) - dp.z };
                const dmg = damageUnit(b, bu, rel, b.rng.int(min, max), type);
                ev.damage(bu, dmg, type, attacker);
              }
              for (const id of [...b.itemsOnTile(dest)]) {
                const it = b.item(id);
                const body = it && it.unitId >= 0 ? b.unit(it.unitId) : undefined;
                if (body) damageUnit(b, body, { x: 0, y: 0, z: 0 }, b.rng.int(min, max), type);
              }
              break;
            case DamageType.HE: {
              if (bu) {
                const groundZero = (Math.abs(dp.x - Math.floor(cx)) < 2 && Math.abs(dp.y - Math.floor(cy)) < 2 && dp.z === Math.floor(cz)) || dp.z > Math.floor(cz);
                const rel = groundZero ? { x: 0, y: 0, z: 0 } : { x: Math.floor(cx) - dp.x, y: Math.floor(cy) - dp.y, z: Math.floor(cz) + 5 - dp.z };
                const dmg = damageUnit(b, bu, rel, b.rng.int(min, max), type);
                ev.damage(bu, dmg, type, attacker);
                if (attacker) noteHit(b, bu, attacker);
              }
              for (const id of [...b.itemsOnTile(dest)]) {
                const it = b.item(id);
                if (!it) continue;
                if (pw > itemRule(it.type).armor) {
                  const body = it.unitId >= 0 ? b.unit(it.unitId) : undefined;
                  if (body && body.status === UnitStatus.UNCONSCIOUS) body.health = 0;
                  b.removeItem(it);
                  ev.itemsChanged = true;
                }
              }
              break;
            }
            case DamageType.SMOKE:
              if (b.smoke[dest] < 10 && b.terrainLevel(dest) > -24) {
                b.fire[dest] = 0;
                b.smoke[dest] = b.rng.int(7, 15);
                ev.tileChanged(dest);
              }
              break;
            case DamageType.IN:
              if (!b.isVoid(dest)) {
                if (b.fire[dest] === 0 && (b.part(dest, TilePart.FLOOR) || b.part(dest, TilePart.OBJECT))) {
                  b.fire[dest] = tileFuel(b, dest) + 1;
                  b.smoke[dest] = clamp(15 - Math.floor(tileFlammability(b, dest) / 10), 1, 12);
                  ev.tileChanged(dest);
                }
                if (bu) {
                  const resistance = damageModifier(bu, DamageType.IN);
                  if (resistance > 0) {
                    const dmg = damageUnit(b, bu, { x: 0, y: 0, z: 12 - b.terrainLevel(dest) }, b.rng.int(FIRE_DAMAGE_MIN, FIRE_DAMAGE_MAX), DamageType.IN, true);
                    ev.damage(bu, dmg, DamageType.IN, attacker);
                    const burn = b.rng.int(0, Math.floor(5 * resistance));
                    if (bu.fire < burn) bu.fire = burn;
                  }
                }
              }
              break;
          }
        }
        l += 1;
        const tx = Math.floor(cx + l * sinTe * cosFi);
        const ty = Math.floor(cy + l * cosTe * cosFi);
        const tz = Math.floor(cz + l * sinFi);
        origin = dest;
        dest = b.idx(tx, ty, tz);
        if (dest < 0) break;
        pw -= 10;
        if (b.posOf(origin).z !== tz) pw -= vdec;
        if (type === DamageType.IN) {
          const op = b.posOf(origin);
          const d = vectorToDirection(op.x - tx, op.y - ty);
          if (d !== -1 && d % 2) pw -= 5;
        }
        if (l > 0.5) {
          if (l > 1.5) {
            pw -= verticalBlockage(b, origin, dest, type, false) * 2;
            pw -= horizontalBlockage(b, origin, dest, type, false) * 2;
          } else {
            let skipObject = diagonalWall === 0;
            if (diagonalWall === BigWall.NESW) {
              if (hitSide < 0 && te >= 135 && te < 315) skipObject = true;
              if (hitSide > 0 && (te < 135 || te > 315)) skipObject = true;
            }
            if (diagonalWall === BigWall.NWSE) {
              if (hitSide > 0 && te >= 45 && te < 225) skipObject = true;
              if (hitSide < 0 && (te < 45 || te > 225)) skipObject = true;
            }
            pw -= verticalBlockage(b, origin, dest, type, skipObject) * 2;
            pw -= horizontalBlockage(b, origin, dest, type, skipObject) * 2;
          }
        }
      }
    }
  }
  if (type === DamageType.HE) {
    for (const [t, p] of he) detonate(b, ev, t, p);
    for (const t of affected) {
      applyGravity(b, ev, t);
      const p = b.posOf(t);
      const above = b.idx(p.x, p.y, p.z + 1);
      if (above >= 0) applyGravity(b, ev, above);
    }
  }
  ev.terrainChanged = true;
}

/** Applies explosive power to the 9 parts around/inside a tile (the actual destruction). */
export function detonate(b: Battle, ev: BattleEvents, ti: number, explosive: number) {
  if (explosive === 0) return;
  const p = b.posOf(ti);
  const parts = [TilePart.FLOOR, TilePart.WESTWALL, TilePart.NORTHWALL, TilePart.FLOOR, TilePart.WESTWALL, TilePart.NORTHWALL, TilePart.OBJECT, TilePart.OBJECT, TilePart.OBJECT];
  const tiles = [
    b.idx(p.x, p.y, p.z + 1), b.idx(p.x + 1, p.y, p.z), b.idx(p.x, p.y + 1, p.z),
    ti, ti, ti, ti, b.idx(p.x, p.y - 1, p.z), b.idx(p.x - 1, p.y, p.z),
  ];
  let bigwallDestroyed = true;
  let skipNorthWest = false;
  for (let i = 8; i >= 0; i--) {
    const t = tiles[i];
    if (t < 0 || !b.part(t, parts[i])) continue;
    const bigwall = b.part(t, parts[i])!.bigWall;
    if (i > 6 && !(bigwall === 1 || bigwall === 8 || (i === 8 && bigwall === 6) || (i === 7 && bigwall === 7))) continue;
    if (bigwall !== 0) skipNorthWest = true;
    if (!bigwallDestroyed && i < 6) continue;
    if (skipNorthWest && (i === 2 || i === 1)) continue;
    let remaining = explosive;
    let destroyed = false;
    let volume = 0;
    let cur = parts[i];
    let fireProof = flammability(b, t, cur);
    let fuel = fuelOf(b, t, cur) + 1;
    const md0 = b.part(t, cur)!;
    for (let j = 0; j < 12; j++) if (md0.loft[j] !== 0) volume++;
    if (i === 6 && (bigwall === 2 || bigwall === 3) && 2 * md0.armor > remaining) bigwallDestroyed = false;
    let guard = 0;
    while (guard++ < 8) {
      const md = b.part(t, cur);
      if (!md || 2 * md.armor > remaining || md.armor === 255) break;
      if (i === 6 && (bigwall === 2 || bigwall === 3)) bigwallDestroyed = true;
      if (i === 6 && (bigwall === 6 || bigwall === 7 || bigwall === 8)) skipNorthWest = false;
      remaining -= 2 * md.armor;
      destroyed = true;
      const next = md.dieMCD ? b.lib.mapData[md.dieMCD].objectType : cur;
      destroyPart(b, ev, t, cur);
      cur = next;
      if (b.part(t, cur)) {
        fireProof = flammability(b, t, cur);
        fuel = fuelOf(b, t, cur) + 1;
      }
    }
    if (2 * fireProof < remaining) {
      if (b.part(t, TilePart.FLOOR) || b.part(t, TilePart.OBJECT)) {
        b.fire[t] = fuel;
        b.smoke[t] = clamp(15 - Math.floor(fireProof / 10), 1, 12);
        ev.tileChanged(t);
      }
    }
    if (destroyed) {
      if (b.fire[t] && !b.part(t, TilePart.FLOOR) && !b.part(t, TilePart.OBJECT)) b.fire[t] = 0;
      if (!b.fire[t]) {
        const smoke = b.rng.int(1, Math.floor(volume / 2) + 3) + Math.floor(volume / 2);
        if (smoke > b.smoke[t]) b.smoke[t] = clamp(smoke, 0, 15);
      }
      ev.tileChanged(t);
    }
  }
}

/** Finds a tile with armed terrain explosives (exploding barrels, fuel, ...). */
export function findTerrainExplosion(b: Battle): number {
  for (let i = 0; i < b.size; i++) if (b.explosive[i]) return i;
  return -1;
}

// ------------------------------------------------------------------------------------------
// gravity
// ------------------------------------------------------------------------------------------

export function applyGravity(b: Battle, ev: BattleEvents, ti: number): number {
  if (ti < 0) return ti;
  const occupant = b.unitOnTile(ti);
  const items = b.itemsOnTile(ti);
  if (!items.length && !occupant) return ti;
  if (occupant && !isOut(occupant) && occupant.movementType !== 1) {
    const p = { ...occupant.pos };
    while (p.z > 0) {
      let canFall = true;
      for (let y = 0; y < occupant.size && canFall; y++)
        for (let x = 0; x < occupant.size && canFall; x++) {
          const t = b.idx(p.x + x, p.y + y, p.z);
          const tb = b.idx(p.x + x, p.y + y, p.z - 1);
          if (!b.hasNoFloor(t, tb)) canFall = false;
          else if (b.unitOnTile(tb) && b.unitOnTile(tb) !== occupant) canFall = false;
        }
      if (!canFall) break;
      p.z--;
    }
    if (p.z !== occupant.pos.z) {
      ev.unitFell(occupant, p);
      b.placeUnit(occupant, p);
    }
  }
  let p = b.posOf(ti);
  let rt = ti;
  while (p.z >= 0) {
    rt = b.idxP(p);
    const rtb = b.idx(p.x, p.y, p.z - 1);
    if (!b.hasNoFloor(rt, rtb)) break;
    if (p.z === 0) break;
    p = { x: p.x, y: p.y, z: p.z - 1 };
  }
  if (rt !== ti) {
    for (const id of [...items]) {
      const it = b.item(id)!;
      b.moveItemToTile(it, rt);
      if (it.unitId >= 0) {
        const u = b.unit(it.unitId);
        if (u) u.pos = b.posOf(rt);
      }
    }
    ev.itemsChanged = true;
  }
  return rt;
}

// ------------------------------------------------------------------------------------------
// doors
// ------------------------------------------------------------------------------------------

/**
 * Opens a door in the given direction. Returns -1 no door, 0 normal door opened, 1 ufo door opened,
 * 4 not enough TUs.
 */
export function unitOpensDoor(b: Battle, ev: BattleEvents, u: Unit, rClick: boolean, dir: number): number {
  let door = -1;
  let tuCost = 0;
  const size = u.size;
  const z = b.terrainLevel(b.idxP(u.pos)) < -12 ? 1 : 0;
  for (let x = 0; x < size && door === -1; x++)
    for (let y = 0; y < size && door === -1; y++) {
      const checks: [number, number, TilePart][] = [];
      switch (dir) {
        case 0: checks.push([0, 0, TilePart.NORTHWALL]); if (x !== 0) checks.push([0, -1, TilePart.WESTWALL]); break;
        case 1: checks.push([0, 0, TilePart.NORTHWALL], [1, -1, TilePart.WESTWALL]); if (rClick) checks.push([1, 0, TilePart.WESTWALL], [1, 0, TilePart.NORTHWALL]); break;
        case 2: checks.push([1, 0, TilePart.WESTWALL]); break;
        case 3: if (!y) checks.push([1, 1, TilePart.WESTWALL]); if (!x) checks.push([1, 1, TilePart.NORTHWALL]); if (rClick) checks.push([1, 0, TilePart.WESTWALL], [0, 1, TilePart.NORTHWALL]); break;
        case 4: checks.push([0, 1, TilePart.NORTHWALL]); break;
        case 5: checks.push([0, 0, TilePart.WESTWALL], [-1, 1, TilePart.NORTHWALL]); if (rClick) checks.push([0, 1, TilePart.WESTWALL], [0, 1, TilePart.NORTHWALL]); break;
        case 6: checks.push([0, 0, TilePart.WESTWALL]); if (y !== 0) checks.push([-1, 0, TilePart.NORTHWALL]); break;
        case 7: checks.push([0, 0, TilePart.WESTWALL], [0, 0, TilePart.NORTHWALL]); if (x) checks.push([-1, -1, TilePart.WESTWALL]); if (y) checks.push([-1, -1, TilePart.NORTHWALL]); if (rClick) checks.push([0, -1, TilePart.WESTWALL], [-1, 0, TilePart.NORTHWALL]); break;
      }
      for (const [dx, dy, part] of checks) {
        if (door !== -1) break;
        const t = b.idx(u.pos.x + x + dx, u.pos.y + y + dy, u.pos.z + z);
        if (t < 0) continue;
        const md = b.part(t, part);
        if (!md) continue;
        const cost = md.tuWalk;
        if (md.door) {
          if (u.size > 1) continue;
          if (u.tu < cost) { door = 4; break; }
          // only part of a large unit standing in the doorway keeps a door shut
          const occupant = b.unitOnTile(t);
          if (occupant && occupant !== u && !(occupant.pos.x === b.posOf(t).x && occupant.pos.y === b.posOf(t).y)) continue;
          const alt = b.lib.mapData[md.altMCD];
          b.setPart(t, part, -1);
          if (alt) b.setPart(t, alt.objectType, md.altMCD);
          ev.tileChanged(t);
          ev.door(t, false);
          door = 0;
          tuCost = rClick ? cost : 0;
        } else if (md.ufoDoor && !b.isUfoDoorOpen(t, part)) {
          if (u.tu < cost) { door = 4; break; }
          b.doorOpen[t] |= 1 << part;
          ev.tileChanged(t);
          ev.door(t, true);
          openAdjacentUfoDoors(b, ev, t, part);
          door = 1;
          tuCost = cost;
        }
      }
    }
  if (tuCost > 0) {
    if (u.tu >= tuCost) u.tu -= tuCost;
    else return 4;
  }
  if (door === 0 || door === 1) ev.terrainChanged = true;
  return door;
}

function openAdjacentUfoDoors(b: Battle, ev: BattleEvents, t: number, part: TilePart) {
  const p = b.posOf(t);
  const west = part === TilePart.WESTWALL;
  for (const step of [1, -1]) {
    for (let i = step; Math.abs(i) < 20; i += step) {
      const n = west ? b.idx(p.x, p.y + i, p.z) : b.idx(p.x + i, p.y, p.z);
      const md = n >= 0 ? b.part(n, part) : null;
      if (md && md.ufoDoor) {
        b.doorOpen[n] |= 1 << part;
        ev.tileChanged(n);
      } else break;
    }
  }
}

export function closeUfoDoors(b: Battle, ev: BattleEvents): number {
  let closed = 0;
  for (let i = 0; i < b.size; i++) {
    if (!b.doorOpen[i]) continue;
    // don't slam a door shut on a unit standing in the doorway
    if (b.unitAt[i]) continue;
    b.doorOpen[i] = 0;
    ev.tileChanged(i);
    closed++;
  }
  if (closed) ev.terrainChanged = true;
  return closed;
}

// ------------------------------------------------------------------------------------------
// melee & throwing validation
// ------------------------------------------------------------------------------------------

export function validMeleeRange(b: Battle, attacker: Unit, from: Pos, direction: number, target: Unit | null): Unit | null {
  if (direction < 0 || direction > 7) return null;
  const size = attacker.size - 1;
  let chosen: Unit | null = null;
  for (let x = 0; x <= size; x++)
    for (let y = 0; y <= size; y++) {
      const o = b.idx(from.x + x, from.y + y, from.z);
      let tt = b.idx(from.x + x + DX[direction], from.y + y + DY[direction], from.z);
      const above = b.idx(from.x + x + DX[direction], from.y + y + DY[direction], from.z + 1);
      const below = b.idx(from.x + x + DX[direction], from.y + y + DY[direction], from.z - 1);
      if (tt < 0 || o < 0) continue;
      if (b.terrainLevel(o) <= -16 && above >= 0 && !b.hasNoFloor(above, tt)) tt = above;
      else if (below >= 0 && b.hasNoFloor(tt, below) && !b.unitOnTile(tt) && b.terrainLevel(below) <= -16) tt = below;
      const tu = b.unitOnTile(tt);
      if (tu && (!target || tu === target)) {
        const ov = { x: b.posOf(o).x * 16 + 8, y: b.posOf(o).y * 16 + 8, z: b.posOf(o).z * 24 + unitHeight(attacker) + floatHeight(attacker) - 4 - b.terrainLevel(o) };
        const scan = { x: 0, y: 0, z: 0 };
        if (canTargetUnit(b, ov, tt, scan, attacker)) {
          if (target) return tu;
          if (!chosen || (tu.owner !== attacker.owner && chosen.owner === attacker.owner)) chosen = tu;
        }
      }
    }
  return chosen;
}

export function maxThrowDistance(weight: number, strength: number, level: number): number {
  let curZ = level + 0.5;
  let dz = 1.0;
  let dist = 0;
  while (dist < 4000) {
    dist += 8;
    if (dz < -1) curZ -= 8;
    else curZ += dz * 8;
    if (curZ < 0 && dz < 0) {
      dz = Math.max(dz, -1.0);
      if (Math.abs(dz) > 1e-10) dist -= curZ / dz;
      break;
    }
    dz -= Math.floor((50 * weight) / Math.max(1, strength)) / 100;
    if (dz <= -2.0) break;
  }
  return dist;
}

export function validThrowRange(b: Battle, actor: Unit, weight: number, origin: Pos, target: Pos): boolean {
  const tt = b.idxP(target);
  const zd = origin.z - (target.z * 24 + 2 - b.terrainLevel(tt));
  const maxDistance = (maxThrowDistance(weight, actor.stats.strength, zd) + 8) / 16.0;
  const xd = target.x - actor.pos.x, yd = target.y - actor.pos.y;
  return Math.sqrt(xd * xd + yd * yd) <= maxDistance;
}

export const ITEM_DROP_VOXEL_OFFSET = -2;

export function positionFromEnd(traj: Pos[], offset: number): Pos {
  const i = traj.length + offset - 1;
  return traj[Math.max(0, Math.min(traj.length - 1, i))];
}

/** Finds a parabola curvature that lands on the target tile. */
export function validateThrow(b: Battle, actor: Unit, weight: number, isThrow: boolean, origin: Pos, targetVoxel: Pos, targetTile: Pos): { curvature: number; voxelType: number } | null {
  let curvature = 0.5;
  if (isThrow) curvature = Math.max(0.48, 1.73 / Math.sqrt(Math.sqrt(actor.stats.strength / Math.max(1, weight))) + (actor.kneeled ? 0.1 : 0));
  else curvature = 1.73 / Math.sqrt(Math.sqrt(70.0 / 10.0)) + (actor.kneeled ? 0.1 : 0);
  const tt = b.idxP(targetTile);
  const obj = tt >= 0 ? b.part(tt, TilePart.OBJECT) : null;
  if (isThrow && obj && obj.tuWalk === 255 && !(obj.bigWall !== 0 && (obj.bigWall < 1 || obj.bigWall > 3))) return null;
  if (isThrow && !validThrowRange(b, actor, weight, origin, targetTile)) return null;
  const targetPos = { x: targetVoxel.x >> 4, y: targetVoxel.y >> 4, z: Math.floor(targetVoxel.z / 24) };
  while (curvature < 5.0) {
    const traj: Pos[] = [];
    const test = calculateParabola(b, origin, targetVoxel, true, traj, actor, curvature, { x: 0, y: 0, z: 0 });
    const land = positionFromEnd(traj, ITEM_DROP_VOXEL_OFFSET);
    const lp = { x: land.x >> 4, y: land.y >> 4, z: Math.floor(land.z / 24) };
    if (test !== VoxelType.OUTOFBOUNDS && lp.x === targetPos.x && lp.y === targetPos.y && lp.z === targetPos.z) return { curvature, voxelType: test };
    curvature += 0.5;
  }
  return null;
}

export { distanceSq, tileDistance };

/** Whether any of `player`'s units currently has a clear tile-space line of sight to `tile`. */
export function canSeeTile(b: Battle, player: number, tile: number): boolean {
  if (tile < 0) return false;
  const p = b.posOf(tile);
  for (const u of b.units) {
    if (u.owner !== player || isOut(u)) continue;
    if (distanceSq(u.pos, p, false) > MAX_VIEW_DISTANCE_SQR) continue;
    if (Math.abs(u.pos.x - p.x) <= 1 && Math.abs(u.pos.y - p.y) <= 1 && Math.abs(u.pos.z - p.z) <= 1) return true;
    if (!checkViewSector(u, p)) continue;
    const r = calculateLine(b, u.pos, p, false, null, { excludeUnit: u }, false);
    if (r <= 127) return true;
  }
  return false;
}
