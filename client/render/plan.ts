// A top-down plan of a map, one level at a time: each tile in the colour of what's on it, walls as lines, doors
// in another colour, landing zones and the UFO outlined. The map editor's overview, and the preview AI tools see.
import type { Battle, Rect } from "../../shared/engine/state.ts";
import { TilePart, type MapData } from "../../shared/formats/terrain.ts";
import type { Assets } from "./assets.ts";

export const ZONE_COLORS: [number, number, number][] = [[80, 220, 90], [240, 90, 70], [80, 150, 255], [240, 200, 60], [200, 110, 240], [60, 220, 220], [250, 150, 60], [230, 230, 230]];

/** Average colour of each part's sprite (cached per battle's part list). */
const tints = new WeakMap<MapData[], ([number, number, number] | null)[]>();
function tintOf(b: Battle, assets: Assets, id: number): [number, number, number] | null {
  let list = tints.get(b.lib.mapData);
  if (!list) tints.set(b.lib.mapData, (list = []));
  if (list[id] !== undefined) return list[id];
  const md = b.lib.mapData[id];
  const img = assets.terrain(b.lib.datasetNames[md.set])[md.sprites[0]];
  let r = 0, g = 0, bl = 0, n = 0;
  if (img) {
    const pal = assets.pal;
    for (const c of img.pixels) {
      if (!c) continue;
      r += pal[c * 3];
      g += pal[c * 3 + 1];
      bl += pal[c * 3 + 2];
      n++;
    }
  }
  return (list[id] = n ? [r / n, g / n, bl / n] : null);
}

export interface PlanOptions {
  /** pixels per tile */
  scale: number;
  /** the level shown (lower ones show through, darker, where it's open) */
  level: number;
  zones?: Rect[];
  ufo?: Rect | null;
  /** grid lines every 10 tiles (and coordinates, when `labels`) */
  grid?: boolean;
  labels?: boolean;
}

/** Draws the plan into an RGBA buffer of (sx * scale) x (sy * scale) pixels. */
export function drawPlan(b: Battle, assets: Assets, o: PlanOptions, out?: Uint8ClampedArray): { width: number; height: number; rgba: Uint8ClampedArray } {
  const S = o.scale, W = b.sx * S, H = b.sy * S;
  const px = out && out.length === W * H * 4 ? out : new Uint8ClampedArray(W * H * 4);
  const put = (x: number, y: number, c: readonly number[], a = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    px[i] = px[i] * (1 - a) + c[0] * a;
    px[i + 1] = px[i + 1] * (1 - a) + c[1] * a;
    px[i + 2] = px[i + 2] * (1 - a) + c[2] * a;
    px[i + 3] = 255;
  };
  const rect = (x: number, y: number, w: number, h: number, c: readonly number[], a = 1) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, c, a);
  };
  const level = Math.max(0, Math.min(b.sz - 1, o.level));
  for (let y = 0; y < b.sy; y++)
    for (let x = 0; x < b.sx; x++) {
      // the floor or object seen from above at this level, or (open) below it, darker the further down
      let color: [number, number, number] = [16, 16, 20];
      for (let z = level; z >= 0; z--) {
        const t = b.idx(x, y, z);
        const obj = b.parts[t * 4 + TilePart.OBJECT], fl = b.parts[t * 4 + TilePart.FLOOR];
        const c = (obj >= 0 ? tintOf(b, assets, obj) : null) ?? (fl >= 0 ? tintOf(b, assets, fl) : null);
        if (!c) continue;
        const dim = 1 - (level - z) * 0.28;
        color = [c[0] * dim, c[1] * dim, c[2] * dim];
        if (obj >= 0 && fl >= 0 && z === level) {
          // an object on a floor: the floor round its edge
          const f = tintOf(b, assets, fl) ?? c;
          rect(x * S, y * S, S, S, f);
          const m = S >= 6 ? 1 : 0;
          rect(x * S + m, y * S + m, S - 2 * m, S - 2 * m, b.lib.mapData[obj].tuWalk === 255 ? c.map((v) => v * 0.7) : c);
          color = [-1, 0, 0];
        }
        break;
      }
      if (color[0] >= 0) rect(x * S, y * S, S, S, color);
    }
  // walls on this level: west walls on a tile's left edge, north walls on its top
  const lw = S >= 6 ? 2 : 1;
  for (let y = 0; y < b.sy; y++)
    for (let x = 0; x < b.sx; x++) {
      const t = b.idx(x, y, level);
      for (const p of [TilePart.WESTWALL, TilePart.NORTHWALL]) {
        const id = b.parts[t * 4 + p];
        if (id < 0) continue;
        const md = b.lib.mapData[id];
        const c = md.door || md.ufoDoor ? [250, 200, 60] : md.tuWalk === 255 && md.stopLOS ? [235, 235, 235] : md.stopLOS ? [235, 235, 235] : [170, 170, 190];
        if (p === TilePart.WESTWALL) rect(x * S, y * S, lw, S, c);
        else rect(x * S, y * S, S, lw, c);
      }
    }
  if (o.grid) {
    for (let x = 0; x <= b.sx; x += 10) rect(Math.min(W - 1, x * S), 0, 1, H, [255, 255, 255], 0.25);
    for (let y = 0; y <= b.sy; y += 10) rect(0, Math.min(H - 1, y * S), W, 1, [255, 255, 255], 0.25);
  }
  const outline = (r: Rect, c: readonly number[], thick: number) => {
    rect(r.x * S, r.y * S, r.w * S, thick, c);
    rect(r.x * S, (r.y + r.h) * S - thick, r.w * S, thick, c);
    rect(r.x * S, r.y * S, thick, r.h * S, c);
    rect((r.x + r.w) * S - thick, r.y * S, thick, r.h * S, c);
  };
  if (o.ufo) outline(o.ufo, [255, 80, 255], Math.max(1, S >> 2));
  (o.zones ?? []).forEach((z, i) => {
    rect(z.x * S, z.y * S, z.w * S, z.h * S, ZONE_COLORS[i % ZONE_COLORS.length], 0.18);
    outline(z, ZONE_COLORS[i % ZONE_COLORS.length], Math.max(1, S >> 2));
    digits(String(i + 1), z.x * S + 3, z.y * S + 3, Math.max(1, Math.floor(S / 4)), ZONE_COLORS[i % ZONE_COLORS.length]);
  });
  if (o.labels) {
    for (let x = 10; x < b.sx; x += 10) digits(String(x), x * S + 2, 2, 1, [255, 255, 255]);
    for (let y = 10; y < b.sy; y += 10) digits(String(y), 2, y * S + 2, 1, [255, 255, 255]);
  }
  return { width: W, height: H, rgba: px };

  function digits(s: string, x: number, y: number, k: number, c: readonly number[]) {
    for (const ch of s) {
      const g = GLYPHS[ch];
      if (g)
        for (let r = 0; r < 5; r++)
          for (let q = 0; q < 3; q++) {
            if (g[r] & (4 >> q)) rect(x + q * k, y + r * k, k, k, c);
            else rect(x + q * k, y + r * k, k, k, [0, 0, 0], 0.5);
          }
      x += 4 * k;
    }
  }
}

const GLYPHS: Record<string, number[]> = {
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7], "3": [7, 1, 7, 1, 7], "4": [5, 5, 7, 1, 1],
  "5": [7, 4, 7, 1, 7], "6": [7, 4, 7, 5, 7], "7": [7, 1, 1, 1, 1], "8": [7, 5, 7, 5, 7], "9": [7, 5, 7, 1, 7],
};
