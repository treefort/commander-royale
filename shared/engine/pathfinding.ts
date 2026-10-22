// Movement costs and path search (port of the original/OpenXcom rules, A* + Bresenham shortcut).
import { type Battle, type Unit, isOut, unitHeight, floatHeight } from "./state.ts";
import { TilePart } from "../formats/terrain.ts";
import { type Pos, BigWall, DX, DY, DZ, DIR_UP, DIR_DOWN } from "./defs.ts";
import { isUnitVisibleTo } from "./tileengine.ts";

const FLY = 1;

export class Pathfinder {
  private known: Set<number> | null = null;
  private mt = 0;
  /** `ignore` is a unit the path may end in (a blaster bomb flying at its target). */
  constructor(public b: Battle, public unit: Unit, ignore?: Unit) {
    this.mt = unit.movementType;
    // the moving player only knows about units they can see (plus their own)
    this.known = new Set();
    for (const o of b.units) if (o !== unit && o !== ignore && !isOut(o) && isUnitVisibleTo(b, o, unit.owner)) this.known.add(o.id);
  }

  private tile(x: number, y: number, z: number) {
    return this.b.idx(x, y, z);
  }

  canFallDown(t: number, size = 1): boolean {
    const b = this.b;
    const p = b.posOf(t);
    for (let x = 0; x < size; x++)
      for (let y = 0; y < size; y++) {
        const c = b.idx(p.x + x, p.y + y, p.z);
        if (c < 0) return false;
        const cp = b.posOf(c);
        if (cp.z === 0) return false;
        if (!b.hasNoFloor(c, b.idx(cp.x, cp.y, cp.z - 1))) return false;
      }
    return true;
  }

  isBlockedPart(t: number, part: TilePart | "bigwall", bigWallExclusion = -1): boolean {
    const b = this.b;
    if (t < 0) return true;
    const obj = b.part(t, TilePart.OBJECT);
    const bw = obj ? obj.bigWall : 0;
    if (part === "bigwall") return !!obj && bw !== 0 && bw <= BigWall.NWSE && bw !== bigWallExclusion;
    const p = b.posOf(t);
    if (part === TilePart.WESTWALL) {
      if (obj && (bw === BigWall.WEST || bw === BigWall.WEST_AND_NORTH)) return true;
      const w = b.idx(p.x - 1, p.y, p.z);
      if (w < 0) return true;
      const wo = b.part(w, TilePart.OBJECT);
      if (wo && (wo.bigWall === BigWall.EAST || wo.bigWall === BigWall.EAST_AND_SOUTH)) return true;
    }
    if (part === TilePart.NORTHWALL) {
      if (obj && (bw === BigWall.NORTH || bw === BigWall.WEST_AND_NORTH)) return true;
      const n = b.idx(p.x, p.y - 1, p.z);
      if (n < 0) return true;
      const no = b.part(n, TilePart.OBJECT);
      if (no && (no.bigWall === BigWall.SOUTH || no.bigWall === BigWall.EAST_AND_SOUTH)) return true;
    }
    if (part === TilePart.FLOOR) {
      const occ = b.unitOnTile(t);
      if (occ) {
        if (occ === this.unit || isOut(occ)) return false;
        if (occ.owner === this.unit.owner) return true;
        if (this.known!.has(occ.id)) return true;
      } else if (b.noFloorAt(t) && this.mt !== FLY) {
        // large units never fall on others, and nobody falls onto large units
        let q = { ...p };
        while (q.z >= 0) {
          const qt = b.idx(q.x, q.y, q.z);
          const u2 = b.unitOnTile(qt);
          if (u2 && u2 !== this.unit) {
            if (this.unit.size > 1) return true;
            if (!isOut(u2) && u2.size > 1) return true;
          }
          if (!b.noFloorAt(qt)) break;
          q.z--;
        }
      }
    }
    if (b.tuCost(t, part, this.mt) === 255) return true;
    return false;
  }

  isBlockedDir(start: number, direction: number): boolean {
    const b = this.b;
    const p = b.posOf(start);
    const at = (dx: number, dy: number) => b.idx(p.x + dx, p.y + dy, p.z);
    switch (direction) {
      case 0: return this.isBlockedPart(start, TilePart.NORTHWALL);
      case 1:
        return this.isBlockedPart(start, TilePart.NORTHWALL) || this.isBlockedPart(at(1, -1), TilePart.WESTWALL) ||
          this.isBlockedPart(at(1, 0), TilePart.WESTWALL) || this.isBlockedPart(at(1, 0), TilePart.NORTHWALL) ||
          this.isBlockedPart(at(1, 0), "bigwall", BigWall.NESW) || this.isBlockedPart(at(0, -1), "bigwall", BigWall.NESW);
      case 2: return this.isBlockedPart(at(1, 0), TilePart.WESTWALL);
      case 3:
        return this.isBlockedPart(at(1, 0), TilePart.WESTWALL) || this.isBlockedPart(at(0, 1), TilePart.NORTHWALL) ||
          this.isBlockedPart(at(1, 1), TilePart.NORTHWALL) || this.isBlockedPart(at(1, 1), TilePart.WESTWALL) ||
          this.isBlockedPart(at(1, 0), "bigwall", BigWall.NWSE) || this.isBlockedPart(at(0, 1), "bigwall", BigWall.NWSE);
      case 4: return this.isBlockedPart(at(0, 1), TilePart.NORTHWALL);
      case 5:
        return this.isBlockedPart(start, TilePart.WESTWALL) || this.isBlockedPart(at(0, 1), TilePart.WESTWALL) ||
          this.isBlockedPart(at(0, 1), TilePart.NORTHWALL) || this.isBlockedPart(at(0, 1), "bigwall", BigWall.NESW) ||
          this.isBlockedPart(at(-1, 0), "bigwall", BigWall.NESW) || this.isBlockedPart(at(-1, 1), TilePart.NORTHWALL);
      case 6: return this.isBlockedPart(start, TilePart.WESTWALL);
      case 7:
        return this.isBlockedPart(start, TilePart.WESTWALL) || this.isBlockedPart(start, TilePart.NORTHWALL) ||
          this.isBlockedPart(at(-1, 0), TilePart.NORTHWALL) || this.isBlockedPart(at(0, -1), TilePart.WESTWALL) ||
          this.isBlockedPart(at(0, -1), "bigwall", BigWall.NWSE) || this.isBlockedPart(at(-1, 0), "bigwall", BigWall.NWSE);
    }
    return false;
  }

  validateUpDown(start: Pos, direction: number): boolean {
    const b = this.b;
    const st = b.idxP(start);
    const end = { x: start.x, y: start.y, z: start.z + DZ[direction] };
    const dt = b.idxP(end);
    const belowStart = b.idx(start.x, start.y, start.z - 1);
    const sf = b.part(st, TilePart.FLOOR);
    const df = dt >= 0 ? b.part(dt, TilePart.FLOOR) : null;
    if (sf && df && sf.gravLift && df.gravLift) return true;
    if (this.mt === FLY) {
      if (direction === DIR_UP && dt >= 0 && b.hasNoFloor(dt, st)) return true;
      if (direction === DIR_DOWN && dt >= 0 && b.hasNoFloor(st, belowStart)) return true;
    }
    return false;
  }

  /** TU cost of one step; also returns the real destination (stairs / falling adjust z). 255 = impossible. */
  tuCost(start: Pos, direction: number): { cost: number; dest: Pos } {
    const b = this.b;
    const u = this.unit;
    const dest: Pos = { x: start.x + DX[direction], y: start.y + DY[direction], z: start.z + DZ[direction] };
    let fellDown = false;
    let triedStairs = false;
    const size = u.size - 1;
    let partsUp = 0, partsDown = 0, partsFalling = 0;
    let totalCost = 0;
    for (let x = 0; x <= size; x++)
      for (let y = 0; y <= size; y++) {
        let cost = 0;
        let startTile = this.tile(start.x + x, start.y + y, start.z);
        let destTile = this.tile(dest.x + x, dest.y + y, dest.z);
        let belowDest = this.tile(dest.x + x, dest.y + y, dest.z - 1);
        const aboveDest = this.tile(dest.x + x, dest.y + y, dest.z + 1);
        if (startTile < 0 || destTile < 0) return { cost: 255, dest };
        if (!x && !y && this.mt !== FLY && this.canFallDown(startTile, size + 1)) {
          if (direction !== DIR_DOWN) return { cost: 255, dest };
          fellDown = true;
        }
        if (direction < DIR_UP && b.terrainLevel(startTile) > -16) {
          if (this.isBlockedDir(startTile, direction)) return { cost: 255, dest };
          if (b.terrainLevel(startTile) - b.terrainLevel(destTile) > 8) return { cost: 255, dest };
        }
        let vz = 0;
        if (direction < DIR_UP && b.terrainLevel(startTile) <= -16 && aboveDest >= 0 && !b.hasNoFloor(aboveDest, destTile)) {
          partsUp++;
          vz = 1;
          if (!triedStairs) {
            dest.z++;
            destTile = this.tile(dest.x + x, dest.y + y, dest.z);
            belowDest = this.tile(dest.x + x, dest.y + y, dest.z - 1);
            triedStairs = true;
          }
        } else if (direction < DIR_UP && !fellDown && this.mt !== FLY && belowDest >= 0 && this.canFallDown(destTile) && b.terrainLevel(belowDest) <= -12) {
          partsDown++;
          if (partsDown === (size + 1) * (size + 1)) {
            dest.z--;
            destTile = this.tile(dest.x + x, dest.y + y, dest.z);
            belowDest = this.tile(dest.x + x, dest.y + y, dest.z - 1);
            fellDown = true;
          }
        } else if (this.mt === FLY && belowDest >= 0) {
          const ub = b.unitOnTile(belowDest);
          if (ub && ub !== u && unitHeight(ub) + floatHeight(ub) - b.terrainLevel(belowDest) > 26) return { cost: 255, dest };
        }
        if (destTile < 0) return { cost: 255, dest };
        if (direction < DIR_UP && dest.z === start.z) {
          if (this.isBlockedDir(startTile, direction)) return { cost: 255, dest };
          if (b.terrainLevel(startTile) - b.terrainLevel(destTile) > 8) return { cost: 255, dest };
        } else if (direction >= DIR_UP && !fellDown) {
          if (this.validateUpDown({ x: start.x + x, y: start.y + y, z: start.z }, direction)) cost = 8;
          else return { cost: 255, dest };
        }
        if (this.mt !== FLY && !fellDown && this.canFallDown(startTile)) {
          partsFalling++;
          if (partsFalling === (size + 1) * (size + 1) && direction !== DIR_DOWN) return { cost: 0, dest };
        }
        startTile = this.tile(start.x + x, start.y + y, start.z + vz);
        if (direction < DIR_UP && partsUp !== 0) {
          if (this.isBlockedDir(startTile, direction)) return { cost: 255, dest };
          if (b.terrainLevel(startTile) - b.terrainLevel(destTile) > 8) return { cost: 255, dest };
        }
        let wallCounter = 0, wallTmp = 0, wallcost = 0;
        if (direction === 0 || direction === 7 || direction === 1) {
          wallTmp += b.tuCost(startTile, TilePart.NORTHWALL, this.mt);
          if (wallTmp > 0) { wallcost += wallTmp; wallCounter++; }
        }
        if (!fellDown && (direction === 2 || direction === 1 || direction === 3)) {
          wallTmp += b.tuCost(destTile, TilePart.WESTWALL, this.mt);
          if (wallTmp > 0) { wallcost += wallTmp; wallCounter++; }
        }
        if (!fellDown && (direction === 4 || direction === 3 || direction === 5)) {
          wallTmp += b.tuCost(destTile, TilePart.NORTHWALL, this.mt);
          if (wallTmp > 0) { wallcost += wallTmp; wallCounter++; }
        }
        if (direction === 6 || direction === 5 || direction === 7) {
          wallTmp += b.tuCost(startTile, TilePart.WESTWALL, this.mt);
          if (wallTmp > 0) { wallcost += wallTmp; wallCounter++; }
        }
        if (wallCounter > 0) wallcost = Math.floor(wallcost / wallCounter);
        if (x && y) {
          const nw = b.part(destTile, TilePart.NORTHWALL), ww = b.part(destTile, TilePart.WESTWALL);
          if ((nw && nw.door) || (ww && ww.door)) return { cost: 255, dest };
        }
        if (this.isBlockedPart(destTile, TilePart.FLOOR) || this.isBlockedPart(destTile, TilePart.OBJECT)) return { cost: 255, dest };
        if (direction < DIR_UP && !fellDown && b.hasNoFloor(destTile, -1)) cost = 4;
        if (direction < DIR_UP) {
          cost += b.tuCost(destTile, TilePart.FLOOR, this.mt);
          if (!fellDown && !triedStairs && b.part(destTile, TilePart.OBJECT)) cost += b.tuCost(destTile, TilePart.OBJECT, this.mt);
          if (vz > 0) cost++;
        }
        if (direction < DIR_UP && direction & 1) cost = Math.trunc(cost * 1.5);
        cost += wallcost;
        totalCost += cost;
      }
    if (size) {
      totalCost = Math.floor(totalCost / ((size + 1) * (size + 1)));
      let st = this.tile(dest.x + 1, dest.y + 1, dest.z);
      let dt = this.tile(dest.x, dest.y, dest.z);
      if (this.isBlockedDir(st, 7)) return { cost: 255, dest };
      if (!fellDown && Math.abs(b.terrainLevel(st) - b.terrainLevel(dt)) > 10) return { cost: 255, dest };
      st = this.tile(dest.x + 1, dest.y, dest.z);
      dt = this.tile(dest.x, dest.y + 1, dest.z);
      if (this.isBlockedDir(st, 5)) return { cost: 255, dest };
      if (!fellDown && Math.abs(b.terrainLevel(st) - b.terrainLevel(dt)) > 10) return { cost: 255, dest };
    }
    return { cost: totalCost, dest };
  }

  isOnStairs(start: Pos, end: Pos): boolean {
    const b = this.b;
    const tl = (x: number, y: number) => {
      const t = b.idx(x, y, end.z);
      return t >= 0 ? b.terrainLevel(t) : 0;
    };
    if (b.idx(end.x, end.y + 1, end.z) >= 0 && tl(end.x, end.y + 1) === -16) {
      if (b.idx(end.x, end.y + 2, end.z) >= 0 && tl(end.x, end.y + 2) !== -8) return false;
      for (let k = 1; k <= 3; k++) if (start.x === end.x && start.y === end.y + k && start.z === end.z) return true;
    }
    if (b.idx(end.x + 1, end.y, end.z) >= 0 && tl(end.x + 1, end.y) === -16) {
      if (b.idx(end.x + 2, end.y, end.z) >= 0 && tl(end.x + 2, end.y) !== -8) return false;
      for (let k = 1; k <= 3; k++) if (start.x === end.x + k && start.y === end.y && start.z === end.z) return true;
    }
    return false;
  }

  /** Returns a list of directions (first step first), or null if unreachable. */
  calculate(endPosition: Pos, maxTU = 100000): number[] | null {
    const b = this.b;
    const u = this.unit;
    const end = { ...endPosition };
    if (end.x > b.sx - u.size || end.y > b.sy - u.size || end.x < 0 || end.y < 0 || end.z < 0 || end.z >= b.sz) return null;
    let destTile = b.idxP(end);
    if (this.isBlockedPart(destTile, TilePart.FLOOR) || this.isBlockedPart(destTile, TilePart.OBJECT)) return null;
    if (this.isOnStairs(u.pos, end)) {
      end.z++;
      destTile = b.idxP(end);
    }
    while (end.z !== b.sz && destTile >= 0 && b.terrainLevel(destTile) === -24) {
      end.z++;
      destTile = b.idxP(end);
    }
    if (end.z >= b.sz || destTile < 0) return null;
    while (this.mt !== FLY && this.canFallDown(destTile, u.size)) {
      end.z--;
      destTile = b.idxP(end);
    }
    if (this.isBlockedPart(destTile, TilePart.FLOOR) || this.isBlockedPart(destTile, TilePart.OBJECT)) return null;
    if (u.size > 1) {
      for (const [x, y] of [[1, 0], [0, 1], [1, 1]]) {
        const ct = b.idx(end.x + x, end.y + y, end.z);
        if (ct < 0) return null;
        const cu = b.unitOnTile(ct);
        if (cu && cu !== u && (cu.owner === u.owner || this.known!.has(cu.id))) return null;
        if (x && y) {
          const nw = b.part(ct, TilePart.NORTHWALL), ww = b.part(ct, TilePart.WESTWALL);
          if ((nw && nw.door) || (ww && ww.door)) return null;
        }
      }
    }
    if (u.pos.z === end.z) {
      const p = this.bresenham(u.pos, end);
      if (p) return p;
    }
    return this.aStar(u.pos, end, maxTU);
  }

  private bresenham(origin: Pos, target: Pos): number[] | null {
    let x0 = origin.x, x1 = target.x, y0 = origin.y, y1 = target.y, z0 = origin.z, z1 = target.z;
    const swapXY = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    if (swapXY) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
    const swapXZ = Math.abs(z1 - z0) > Math.abs(x1 - x0);
    if (swapXZ) { [x0, z0] = [z0, x0]; [x1, z1] = [z1, x1]; }
    const dX = Math.abs(x1 - x0), dY = Math.abs(y1 - y0), dZ = Math.abs(z1 - z0);
    let driftXY = dX >> 1, driftXZ = dX >> 1;
    const sX = x0 > x1 ? -1 : 1, sY = y0 > y1 ? -1 : 1, sZ = z0 > z1 ? -1 : 1;
    let y = y0, z = z0;
    let last = { ...origin };
    let lastCost = -1;
    const path: number[] = [];
    for (let x = x0; x !== x1 + sX; x += sX) {
      let cx = x, cy = y, cz = z;
      if (swapXZ) [cx, cz] = [cz, cx];
      if (swapXY) [cx, cy] = [cy, cx];
      if (x !== x0 || y !== y0 || z !== z0) {
        const real = { x: cx, y: cy, z: cz };
        let dir = 0;
        for (; dir < 8; dir++) if (DX[dir] === cx - last.x && DY[dir] === cy - last.y) break;
        const { cost, dest } = this.tuCost(last, dir);
        const diag = (dir & 1) === 1;
        const lastDiag = lastCost + Math.floor(lastCost / 2);
        const costDiag = cost + Math.floor(cost / 2);
        if (dest.x === real.x && dest.y === real.y && dest.z === real.z && cost < 255 &&
          (cost === lastCost || (diag && cost === lastDiag) || (!diag && costDiag === lastCost) || lastCost === -1) &&
          !this.isBlockedDir(this.b.idxP(last), dir)) {
          path.push(dir);
        } else return null;
        if (cost !== 255) lastCost = cost;
        last = { x: cx, y: cy, z: cz };
      }
      driftXY -= dY;
      driftXZ -= dZ;
      if (driftXY < 0) { y += sY; driftXY += dX; }
      if (driftXZ < 0) { z += sZ; driftXZ += dX; }
    }
    return path;
  }

  private aStar(start: Pos, end: Pos, maxTU: number): number[] | null {
    const b = this.b;
    const n = b.size;
    const cost = new Float64Array(n).fill(Infinity);
    const prevDir = new Int8Array(n).fill(-1);
    const prevNode = new Int32Array(n).fill(-1);
    const checked = new Uint8Array(n);
    const heap = new MinHeap();
    const si = b.idxP(start), ei = b.idxP(end);
    const h = (p: Pos) => {
      // OpenXcom's heuristic: diagonal distance in TUs (8 per step)
      const dx = Math.abs(p.x - end.x), dy = Math.abs(p.y - end.y), dz = Math.abs(p.z - end.z);
      return 8 * (Math.max(dx, dy) + Math.min(dx, dy) / 2 + dz);
    };
    cost[si] = 0;
    heap.push(si, h(start));
    while (heap.size) {
      const cur = heap.pop();
      if (checked[cur]) continue;
      checked[cur] = 1;
      if (cur === ei) {
        const path: number[] = [];
        let k = cur;
        while (prevNode[k] >= 0) {
          path.push(prevDir[k]);
          k = prevNode[k];
        }
        return path.reverse();
      }
      const cp = b.posOf(cur);
      for (let d = 0; d < 10; d++) {
        const { cost: c, dest } = this.tuCost(cp, d);
        if (c >= 255) continue;
        const ni = b.idxP(dest);
        if (ni < 0 || checked[ni]) continue;
        const total = cost[cur] + c;
        if (total > maxTU) continue;
        if (total < cost[ni]) {
          cost[ni] = total;
          prevDir[ni] = d;
          prevNode[ni] = cur;
          heap.push(ni, total + h(dest));
        }
      }
    }
    return null;
  }

  /** Total TU (and energy) cost along a path from the unit's position. */
  pathCost(path: number[]): { tu: number; energy: number; positions: Pos[] } {
    let p = { ...this.unit.pos };
    let tu = 0, energy = 0;
    const positions: Pos[] = [];
    for (const d of path) {
      const { cost, dest } = this.tuCost(p, d);
      tu += cost;
      if (d < DIR_UP) energy += cost;
      p = dest;
      positions.push(dest);
    }
    return { tu, energy: Math.floor(energy / 2), positions };
  }
}

class MinHeap {
  private keys: number[] = [];
  private prio: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(k: number, p: number) {
    this.keys.push(k);
    this.prio.push(p);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): number {
    const top = this.keys[0];
    const lastK = this.keys.pop()!;
    const lastP = this.prio.pop()!;
    if (this.keys.length) {
      this.keys[0] = lastK;
      this.prio[0] = lastP;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.keys.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.keys.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}
