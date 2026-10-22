// How exposed a unit would be standing on a tile: which known enemies would have a line of fire, and
// how open the spot is in general (sightlines in from all around). Uses the same voxel line-of-fire
// test as real shots, on the terrain this player has explored (unexplored ground counts as open).
import { type Battle, type Unit, isOut } from "../../shared/engine/state.ts";
import { type Pos, tileDistance } from "../../shared/engine/defs.ts";
import { canTargetUnit, sightOriginVoxel } from "../../shared/engine/tileengine.ts";
import { TilePart } from "../../shared/formats/terrain.ts";

export interface Exposure {
  pos: Pos;
  /** enemies in view that could shoot the unit there */
  seenBy: number;
  /** share of sightlines from around the tile (6 and 12 tiles out, 16 directions) that reach the unit */
  exposure: number;
  /** the same if the unit kneels there (soldiers only, when standing now) */
  kneeling: number | null;
}

const DIRECTIONS = 16;
const DISTANCES = [6, 12];

export function exposureAt(b: Battle, u: Unit, dest: Pos, player: number): Exposure {
  const saved = { pos: { ...u.pos }, kneeled: u.kneeled };
  // stand the unit there for a moment (this is the client's copy of the battle; restored below)
  b.placeUnit(u, dest);
  try {
    const t = b.idxP(dest);
    const scan = { x: 0, y: 0, z: 0 };
    let seenBy = 0;
    for (const e of b.units) {
      if (e === u || e.owner === player || isOut(e) || e.pos.x < 0) continue;
      if (tileDistance(e.pos, dest) > 20) continue;
      if (canTargetUnit(b, sightOriginVoxel(b, e), t, scan, e)) seenBy++;
    }
    const measure = () => {
      let samples = 0, open = 0;
      for (let d = 0; d < DIRECTIONS; d++) {
        const a = (d / DIRECTIONS) * Math.PI * 2;
        for (const dist of DISTANCES) {
          const x = Math.round(dest.x + Math.cos(a) * dist), y = Math.round(dest.y + Math.sin(a) * dist);
          const st = b.idx(x, y, dest.z);
          if (st < 0) continue;
          // nobody can stand inside solid scenery to look from there
          const obj = b.part(st, TilePart.OBJECT);
          if (obj && obj.tuWalk === 255) continue;
          samples++;
          const eye = { x: x * 16 + 8, y: y * 16 + 8, z: dest.z * 24 - b.terrainLevel(st) + 20 };
          if (canTargetUnit(b, eye, t, scan, null)) open++;
        }
      }
      return samples ? open / samples : 0;
    };
    const exposure = measure();
    let kneeling: number | null = null;
    if (u.type === "SOLDIER" && !u.kneeled && !u.floating) {
      u.kneeled = true;
      kneeling = measure();
    }
    return { pos: { ...dest }, seenBy, exposure, kneeling };
  } finally {
    u.kneeled = saved.kneeled;
    b.placeUnit(u, saved.pos);
  }
}
