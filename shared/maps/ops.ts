// Map editing operations, shared by the map editor's tools and AI recipes (recipe.ts): floors, walls, whole
// buildings with doors, windows, storeys and stairs, scattered trees, roads, ruins, original blocks and UFOs.
// Coordinates are tiles: x runs west to east, y north to south, z is the level (0 = ground).
import type { Battle, FileSource, Rect } from "../engine/state.ts";
import { TilePart } from "../formats/terrain.ts";
import { RNG } from "../engine/rng.ts";
import { canStand } from "../engine/mapgen.ts";
import { type Material, type Compass, material, MATERIALS } from "./catalog.ts";
import { ensureDataset, placeBlock, placeUfo } from "./build.ts";

export interface EditCtx {
  b: Battle;
  files: FileSource;
  rng: RNG;
  zones: Rect[];
  ufo: Rect | null;
  /** things that didn't go as asked (the op still did what it could) */
  warnings: string[];
}

export type Point = [number, number] | [number, number, number] | { x: number; y: number; z?: number };
export type Area = [number, number, number, number] | Rect;

export function rectOf(a: Area | undefined, b: Battle): Rect {
  if (!a) return { x: 0, y: 0, w: b.sx, h: b.sy };
  const [x, y, w, h] = Array.isArray(a) ? a : [a.x, a.y, a.w, a.h];
  const r = { x: Math.round(Number(x)), y: Math.round(Number(y)), w: Math.round(Number(w)), h: Math.round(Number(h)) };
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w < 1 || r.h < 1) throw new Error(`bad area ${JSON.stringify(a)}: give [x, y, width, length]`);
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y);
  const x1 = Math.min(b.sx, r.x + r.w), y1 = Math.min(b.sy, r.y + r.h);
  if (x1 <= x0 || y1 <= y0) throw new Error(`area ${JSON.stringify(a)} is outside the ${b.sx}x${b.sy} map`);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function pointOf(p: Point | undefined, z = 0): { x: number; y: number; z: number } {
  if (!p) throw new Error("missing position: give [x, y] or [x, y, level]");
  const [x, y, zz] = Array.isArray(p) ? p : [p.x, p.y, p.z];
  const out = { x: Math.round(Number(x)), y: Math.round(Number(y)), z: zz === undefined ? z : Math.round(Number(zz)) };
  if (![out.x, out.y, out.z].every(Number.isFinite)) throw new Error(`bad position ${JSON.stringify(p)}`);
  return out;
}

// ---- materials ----

/** A material by name, or a raw part "<DATASET>:<number>" (e.g. "URBAN:14"). */
export function findMaterial(ref: string): Material {
  const m = material(ref);
  if (m) return m;
  const raw = /^([A-Z0-9_]+):(\d+)$/.exec(ref.trim());
  if (raw) return { name: ref, kind: "object", dataset: raw[1], part: Number(raw[2]) };
  const close = MATERIALS.filter((x) => x.name.includes(ref) || ref.includes(x.name)).slice(0, 5).map((x) => x.name);
  throw new Error(`unknown material "${ref}"${close.length ? ` (did you mean ${close.join(", ")}?)` : ""}`);
}

/** A material's part as a global id in this battle (its part set is added if the map doesn't have it). */
export function partId(ctx: EditCtx, m: Material, key: "part" | "west" | "north" | "low" | "high"): number {
  const local = m[key];
  if (local === undefined) throw new Error(`${m.name} has no ${key} part`);
  const start = ensureDataset(ctx.b, m.dataset, ctx.files);
  const id = start + local;
  if (id >= ctx.b.lib.mapData.length || local < 0) throw new Error(`${m.dataset} has no part ${local}`);
  return id;
}

/** The slot a part goes in by its own data (a few records say nonsense: those are objects). */
export function slotOf(b: Battle, id: number): TilePart {
  const t = b.lib.mapData[id].objectType;
  return t >= TilePart.FLOOR && t <= TilePart.OBJECT ? t : TilePart.OBJECT;
}

/** Puts a part in a slot (by default the one it belongs in: floor, west wall, north wall or object). */
export function putPart(b: Battle, x: number, y: number, z: number, id: number, slot = slotOf(b, id)): boolean {
  const t = b.idx(x, y, z);
  if (t < 0) return false;
  b.setPart(t, slot, id);
  return true;
}

function need(m: Material, kinds: string[], what: string) {
  if (!kinds.includes(m.kind)) throw new Error(`${m.name} is a ${m.kind}, not ${what}`);
}

/** The material of `kind` that goes with `like` (same set, sharing the first word of the name if one does). */
function companion(like: Material, kinds: Material["kind"][], extra?: (m: Material) => boolean): Material | null {
  const word = like.name.split("-")[0];
  const pool = MATERIALS.filter((m) => kinds.includes(m.kind) && (!extra || extra(m)));
  return pool.find((m) => m.dataset === like.dataset && m.name.split("-")[0] === word)
    ?? pool.find((m) => m.dataset === like.dataset)
    ?? null;
}

// ---- operations ----

/** Floor on every tile of an area (one level). */
export function opFloor(ctx: EditCtx, mat: Material, area: Rect, z = 0) {
  const id = mat.kind === "floor" || mat.kind === "debris" ? partId(ctx, mat, "part") : mat.part !== undefined ? partId(ctx, mat, "part") : -1;
  if (id < 0 || ctx.b.lib.mapData[id].objectType !== TilePart.FLOOR) throw new Error(`${mat.name} isn't a floor`);
  for (let x = area.x; x < area.x + area.w; x++) for (let y = area.y; y < area.y + area.h; y++) putPart(ctx.b, x, y, z, id, TilePart.FLOOR);
}

/**
 * Clears an area: without `z`, everything on every level but the ground floor (open ground); with `z`, that level's
 * walls and objects (its floor stays).
 */
export function opClear(ctx: EditCtx, area: Rect, z?: number) {
  const b = ctx.b;
  for (let k = z ?? 0; k <= (z ?? b.sz - 1); k++)
    for (let x = area.x; x < area.x + area.w; x++)
      for (let y = area.y; y < area.y + area.h; y++) {
        const t = b.idx(x, y, k);
        if (t < 0) continue;
        for (const p of [TilePart.WESTWALL, TilePart.NORTHWALL, TilePart.OBJECT]) b.setPart(t, p, -1);
        if (z === undefined && k > 0) b.setPart(t, TilePart.FLOOR, -1);
      }
}

/** Removes some parts of every tile in an area on one level. */
export function opErase(ctx: EditCtx, area: Rect, z: number, slots: TilePart[]) {
  for (let x = area.x; x < area.x + area.w; x++)
    for (let y = area.y; y < area.y + area.h; y++) {
      const t = ctx.b.idx(x, y, z);
      if (t >= 0) for (const p of slots) ctx.b.setPart(t, p, -1);
    }
}

/**
 * A straight wall along a grid line between two corner points: sharing x, a north-south run of west walls; sharing
 * y, a west-east run of north walls. `storeys` levels high from `z`.
 */
export function opWall(ctx: EditCtx, mats: Material[], from: { x: number; y: number }, to: { x: number; y: number }, z = 0, storeys = 1) {
  for (const m of mats) need(m, ["wall", "window", "door", "fence"], "a wall, window, door or fence");
  if (from.x !== to.x && from.y !== to.y) throw new Error("walls run along grid lines: from and to must share x (a north-south wall) or y (a west-east wall)");
  // several materials take turns along the wall (fences that alternate, a wall with a window every so often...)
  const along = from.y === to.y ? "north" : "west";
  const ids = mats.map((m) => partId(ctx, m, along));
  for (let s = 0; s < storeys; s++) {
    if (along === "north") for (let x = Math.min(from.x, to.x), i = 0; x < Math.max(from.x, to.x); x++, i++) putPart(ctx.b, x, from.y, z + s, ids[i % ids.length], TilePart.NORTHWALL);
    else for (let y = Math.min(from.y, to.y), i = 0; y < Math.max(from.y, to.y); y++, i++) putPart(ctx.b, from.x, y, z + s, ids[i % ids.length], TilePart.WESTWALL);
  }
}

export interface BuildingSpec {
  wall: Material;
  window?: Material | null;
  door?: Material | null;
  /** interior floor (every storey; the ground storey keeps the ground if not given) */
  floor?: Material | null;
  /** a flat roof on top (false: none) */
  roof?: Material | false | null;
  storeys?: number;
  z?: number;
  /** doors on the ground storey: a side (centred), or a side and how far along it */
  doors?: (Compass | { side: Compass; at?: number })[];
  windows?: "none" | "few" | "some" | "many";
  stairs?: Material | false | null;
}

/**
 * A building: walls round the area on every storey (with windows, and doors on the ground storey), floors inside,
 * stairs between storeys and a flat roof. Whatever stood inside is cleared.
 */
export function opBuilding(ctx: EditCtx, area: Rect, spec: BuildingSpec) {
  const b = ctx.b;
  const { x, y, w, h } = area;
  need(spec.wall, ["wall", "fence"], "a wall");
  const z = spec.z ?? 0;
  const storeys = Math.max(1, Math.min(spec.storeys ?? 1, b.sz - z));
  if ((spec.storeys ?? 1) > storeys) ctx.warnings.push(`building at ${x},${y}: only ${storeys} storeys fit under the map's ${b.sz} levels`);
  const window = spec.window === null ? null : spec.window ?? companion(spec.wall, ["window"]);
  const door = spec.door === null ? null : spec.door ?? companion(spec.wall, ["door"]) ?? MATERIALS.find((m) => m.kind === "door" && m.dataset === "URBAN") ?? null;
  const corner = companion(spec.wall, ["corner"]);
  const floor = spec.floor ?? companion(spec.wall, ["floor"], (m) => !m.roof) ?? MATERIALS.find((m) => m.kind === "floor" && m.dataset === "URBAN" && !m.roof)!;
  const roof = spec.roof === false ? null : spec.roof ?? companion(spec.wall, ["floor"], (m) => !!m.roof) ?? floor;
  // inside is cleared
  for (let k = z; k < Math.min(b.sz, z + storeys + 1); k++)
    for (let xx = x; xx < x + w; xx++)
      for (let yy = y; yy < y + h; yy++) {
        const t = b.idx(xx, yy, k);
        if (t < 0) continue;
        b.setPart(t, TilePart.OBJECT, -1);
        if (xx > x) b.setPart(t, TilePart.WESTWALL, -1);
        if (yy > y) b.setPart(t, TilePart.NORTHWALL, -1);
      }
  // where the doors go: side -> offsets along it
  const doorAt = new Map<Compass, Set<number>>();
  for (const d of spec.doors ?? ["south"]) {
    const side = typeof d === "string" ? d : d.side;
    const len = side === "north" || side === "south" ? w : h;
    const at = typeof d === "string" || d.at === undefined ? Math.floor((len - 1) / 2) : Math.max(0, Math.min(len - 1, Math.round(d.at)));
    if (!doorAt.has(side)) doorAt.set(side, new Set());
    doorAt.get(side)!.add(at);
  }
  const every = spec.windows === "none" || !window ? 0 : spec.windows === "many" ? 2 : spec.windows === "few" ? 4 : 3;
  const piece = (side: Compass, i: number, len: number, storey: number): Material => {
    if (storey === 0 && doorAt.get(side)?.has(i) && door) return door;
    if (every && window && i > 0 && i < len - 1 && i % every === 1) return window;
    return spec.wall;
  };
  for (let s = 0; s < storeys; s++) {
    const k = z + s;
    const N = TilePart.NORTHWALL, W = TilePart.WESTWALL;
    for (let i = 0; i < w; i++) {
      putPart(b, x + i, y, k, partId(ctx, piece("north", i, w, s), "north"), N);
      if (y + h < b.sy) putPart(b, x + i, y + h, k, partId(ctx, piece("south", i, w, s), "north"), N);
    }
    for (let i = 0; i < h; i++) {
      putPart(b, x, y + i, k, partId(ctx, piece("west", i, h, s), "west"), W);
      if (x + w < b.sx) putPart(b, x + w, y + i, k, partId(ctx, piece("east", i, h, s), "west"), W);
    }
    // the post that closes the outer south-east corner
    if (corner && x + w < b.sx && y + h < b.sy) putPart(b, x + w, y + h, k, partId(ctx, corner, "part"), W);
    if (s > 0 || spec.floor) opFloor(ctx, floor, area, k);
  }
  if (roof && z + storeys < b.sz) opFloor(ctx, roof, area, z + storeys);
  else if (roof && storeys > 1) ctx.warnings.push(`building at ${x},${y}: no room for a roof above storey ${storeys}`);
  // stairs up from each storey to the next
  if (storeys > 1 && spec.stairs !== false) {
    const st = spec.stairs ?? companion(spec.wall, ["stairs"]) ?? MATERIALS.find((m) => m.kind === "stairs") ?? null;
    if (!st) ctx.warnings.push(`building at ${x},${y}: no stairs in the catalog, so its upper storeys can only be reached by flying`);
    else {
      const used = new Set<string>();
      for (let s = 0; s + 1 < storeys; s++) {
        const spot = stairSpot(area, st.dir ?? "north", used, s);
        if (!spot) {
          ctx.warnings.push(`building at ${x},${y}: too small inside for stairs (needs 3 tiles in a row along the way they climb)`);
          break;
        }
        placeStairs(ctx, st, spot.x, spot.y, z + s);
      }
    }
  }
}

const STEP: Record<Compass, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

/** Where stairs climbing `dir` fit inside an area (low step, high step and the landing all inside), corners alternating. */
function stairSpot(a: Rect, dir: Compass, used: Set<string>, n: number): { x: number; y: number } | null {
  const [dx, dy] = STEP[dir];
  const inside = (x: number, y: number) => x >= a.x && y >= a.y && x < a.x + a.w && y < a.y + a.h;
  const spots: { x: number; y: number; d: number }[] = [];
  const corners = [[a.x, a.y], [a.x + a.w - 1, a.y + a.h - 1], [a.x + a.w - 1, a.y], [a.x, a.y + a.h - 1]];
  const [cx, cy] = corners[n % 4];
  for (let x = a.x; x < a.x + a.w; x++)
    for (let y = a.y; y < a.y + a.h; y++) {
      const tiles = [[x, y], [x + dx, y + dy], [x + 2 * dx, y + 2 * dy]];
      if (!tiles.every(([tx, ty]) => inside(tx, ty) && !used.has(`${tx},${ty}`))) continue;
      spots.push({ x, y, d: Math.abs(x - cx) + Math.abs(y - cy) });
    }
  spots.sort((p, q) => p.d - q.d);
  const s = spots[0];
  if (!s) return null;
  for (let k = 0; k < 3; k++) used.add(`${s.x + k * dx},${s.y + k * dy}`);
  return s;
}

/** Stairs from level z: the low step at (x, y), the high step next to it the way they climb, and a hole above both. */
export function placeStairs(ctx: EditCtx, st: Material, x: number, y: number, z: number) {
  need(st, ["stairs"], "stairs");
  const b = ctx.b;
  const [dx, dy] = STEP[st.dir ?? "north"];
  const lo = partId(ctx, st, "low"), hi = partId(ctx, st, "high");
  for (const [k, id] of [[0, lo], [1, hi]] as const) {
    const t = b.idx(x + k * dx, y + k * dy, z);
    if (t < 0) throw new Error(`stairs at ${x},${y} run off the map`);
    b.setPart(t, TilePart.OBJECT, id);
    const above = b.idx(x + k * dx, y + k * dy, z + 1);
    if (above >= 0) {
      b.setPart(above, TilePart.FLOOR, -1);
      b.setPart(above, TilePart.OBJECT, -1);
    }
  }
  // the landing: clear of anything in the way
  const land = b.idx(x + 2 * dx, y + 2 * dy, z + 1);
  if (land >= 0) b.setPart(land, TilePart.OBJECT, -1);
}

/** One thing at a spot: an object, a corner post, a multi-tile object (from its north-west tile) or stairs. */
export function opObject(ctx: EditCtx, mat: Material, at: { x: number; y: number; z: number }) {
  if (mat.kind === "stairs") return placeStairs(ctx, mat, at.x, at.y, at.z);
  if (mat.kind === "multi") {
    const start = ensureDataset(ctx.b, mat.dataset, ctx.files);
    for (const [dx, dy, p, dz] of mat.parts ?? []) putPart(ctx.b, at.x + dx, at.y + dy, at.z + (dz ?? 0), start + p);
    return;
  }
  if (mat.part === undefined) throw new Error(`${mat.name} is a ${mat.kind}: use a wall op (or a building's door/window) for it`);
  putPart(ctx.b, at.x, at.y, at.z, partId(ctx, mat, "part"), mat.kind === "corner" ? TilePart.WESTWALL : undefined);
}

export type HillStyle = "sand" | "rock" | "snow" | "grass";

/** The terrain's own kind of hill (others borrow the mountains'). */
export function hillStyleFor(terrain: string): HillStyle {
  return terrain === "DESERT" ? "sand" : terrain === "POLAR" ? "snow" : terrain === "FOREST" || terrain === "CULTA" || terrain === "JUNGLE" ? "grass" : "rock";
}

const OPP: Record<string, string> = { n: "south", s: "north", e: "west", w: "east", nw: "se", ne: "sw", se: "nw", sw: "ne" };
const TIERS = ["low", "mid", "high"] as const;

/** The hill piece for a ring tile (`at`: n/s/e/w edge or nw/ne/se/sw corner) or the flat top after `tier` rings. */
function hillPiece(style: HillStyle, tier: number, at: string | null): string {
  const t = TIERS[tier];
  if (style === "grass") {
    if (!at) return ["hill-step", "hill-top", "hill-plateau"][tier];
    return `hill-${t}-${at.length === 1 ? "edge" : "corner"}-${at}`;
  }
  if (style === "snow") return at ? (at.length === 1 ? `snow-ramp-${OPP[at]}` : `snow-corner-out-${OPP[at]}`) : "snow-raised";
  if (!at) return [`${style}-raised-8`, `${style}-raised-16`, `${style}-block`][tier];
  return at.length === 1 ? `${style}-ramp-${t}-${OPP[at]}` : `${style}-corner-out-${t}-${OPP[at]}`;
}

/**
 * A hill filling an area: rings of slopes climbing to a flat top, `height` 1 (8 high), 2 (16) or 3 (a full level:
 * soldiers on top stand a level up). Snow only goes to 1. The area needs 2 tiles more each way per step of height.
 */
export function opHill(ctx: EditCtx, area: Rect, height: number, style: HillStyle, z = 0) {
  let h = Math.max(1, Math.min(style === "snow" ? 1 : 3, Math.round(height)));
  if (h < height) ctx.warnings.push(`hill: ${style} hills only go ${h} high`);
  const fit = Math.floor((Math.min(area.w, area.h) - 1) / 2);
  if (fit < 1) throw new Error("a hill needs an area at least 3x3");
  if (fit < h) {
    ctx.warnings.push(`hill: a ${area.w}x${area.h} area only fits a hill ${fit} high`);
    h = fit;
  }
  const b = ctx.b;
  for (let x = area.x; x < area.x + area.w; x++)
    for (let y = area.y; y < area.y + area.h; y++) {
      const ring = Math.min(x - area.x, y - area.y, area.x + area.w - 1 - x, area.y + area.h - 1 - y);
      let name: string;
      if (ring >= h) name = hillPiece(style, h - 1, null);
      else {
        const n = y - area.y === ring, s = area.y + area.h - 1 - y === ring, w = x - area.x === ring, e = area.x + area.w - 1 - x === ring;
        const at = (n ? "n" : s ? "s" : "") + (w ? "w" : e ? "e" : "");
        name = hillPiece(style, ring, at);
      }
      const t = b.idx(x, y, z);
      if (t < 0) continue;
      b.setPart(t, TilePart.WESTWALL, -1);
      b.setPart(t, TilePart.NORTHWALL, -1);
      putPart(b, x, y, z, partId(ctx, findMaterial(name), "part"), TilePart.OBJECT);
    }
}

/** The tiles a material covers when placed at (x, y). */
function footprint(mat: Material, x: number, y: number): [number, number][] {
  if (mat.kind === "multi") return (mat.parts ?? []).filter((p) => !p[3]).map(([dx, dy]) => [x + dx, y + dy]);
  if (mat.kind === "stairs") {
    const [dx, dy] = STEP[mat.dir ?? "north"];
    return [[x, y], [x + dx, y + dy]];
  }
  return [[x, y]];
}

function inRects(rs: Rect[], x: number, y: number, margin = 0) {
  return rs.some((r) => x >= r.x - margin && y >= r.y - margin && x < r.x + r.w + margin && y < r.y + r.h + margin);
}

/**
 * Objects dotted about an area on open ground: `count` of them, or `density` (0-1) of the free tiles. Landing zones
 * and the UFO stay clear unless `anywhere`; `indoors` allows tiles with something overhead.
 */
export function opScatter(ctx: EditCtx, mats: Material[], area: Rect, opts: { count?: number; density?: number; z?: number; spacing?: number; anywhere?: boolean; indoors?: boolean }) {
  const b = ctx.b;
  const z = opts.z ?? 0;
  const free = (x: number, y: number) => {
    const t = b.idx(x, y, z);
    if (t < 0 || b.part(t, TilePart.OBJECT) || b.part(t, TilePart.WESTWALL) || b.part(t, TilePart.NORTHWALL)) return false;
    if (!b.part(t, TilePart.FLOOR) || !canStand(b, { x, y, z }, 1)) return false;
    if (!opts.anywhere && (inRects(ctx.zones, x, y) || (ctx.ufo && inRects([ctx.ufo], x, y, 1)))) return false;
    if (!opts.indoors) for (let k = z + 1; k < b.sz; k++) for (let p = 0; p < 4; p++) if (b.parts[b.idx(x, y, k) * 4 + p] >= 0) return false;
    return true;
  };
  const spots: [number, number][] = [];
  for (let x = area.x; x < area.x + area.w; x++) for (let y = area.y; y < area.y + area.h; y++) if (free(x, y)) spots.push([x, y]);
  const want = opts.count !== undefined ? Math.max(0, Math.round(opts.count)) : Math.round(Math.max(0, Math.min(1, opts.density ?? 0.1)) * spots.length);
  const spacing = Math.max(0, opts.spacing ?? 0);
  const taken: [number, number][] = [];
  ctx.rng.shuffle(spots);
  let placed = 0;
  for (const [x, y] of spots) {
    if (placed >= want) break;
    if (spacing && taken.some(([tx, ty]) => Math.max(Math.abs(tx - x), Math.abs(ty - y)) < spacing)) continue;
    const mat = mats[ctx.rng.int(0, mats.length - 1)];
    const cells = footprint(mat, x, y);
    if (!cells.every(([cx, cy]) => cx < area.x + area.w && cy < area.y + area.h && free(cx, cy))) continue;
    opObject(ctx, mat, { x, y, z });
    taken.push([x, y]);
    placed++;
  }
  if (placed < want) ctx.warnings.push(`scatter: placed ${placed} of ${want} (no more free open ground in the area)`);
}

/** A road, path, river bank...: floor along a line through `points`, `width` tiles wide, with what stood there cleared. */
export function opPath(ctx: EditCtx, mat: Material, points: { x: number; y: number }[], width = 1, z = 0) {
  const b = ctx.b;
  const id = partId(ctx, mat, "part");
  if (b.lib.mapData[id].objectType !== TilePart.FLOOR) throw new Error(`${mat.name} isn't a floor`);
  const cells = new Set<number>();
  const half = Math.floor((Math.max(1, width) - 1) / 2);
  const stamp = (cx: number, cy: number) => {
    for (let dx = 0; dx < width; dx++)
      for (let dy = 0; dy < width; dy++) {
        const x = cx - half + dx, y = cy - half + dy;
        if (x >= 0 && y >= 0 && x < b.sx && y < b.sy) cells.add(y * b.sx + x);
      }
  };
  if (points.length === 1) stamp(points[0].x, points[0].y);
  for (let i = 0; i + 1 < points.length; i++) {
    let { x: x0, y: y0 } = points[i];
    const { x: x1, y: y1 } = points[i + 1];
    const sx = Math.sign(x1 - x0), sy = Math.sign(y1 - y0), dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    let err = dx + dy;
    for (;;) {
      stamp(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
  for (const c of cells) {
    const x = c % b.sx, y = Math.floor(c / b.sx);
    for (let k = z; k < b.sz; k++) {
      const t = b.idx(x, y, k);
      b.setPart(t, TilePart.OBJECT, -1);
      if (k > z) b.setPart(t, TilePart.FLOOR, -1);
      // walls between two tiles of the path go; the ones along its sides stay
      if (cells.has(y * b.sx + x - 1)) b.setPart(t, TilePart.WESTWALL, -1);
      if (cells.has((y - 1) * b.sx + x)) b.setPart(t, TilePart.NORTHWALL, -1);
    }
    b.setPart(b.idx(x, y, z), TilePart.FLOOR, id);
  }
}

/** Battle damage: about `amount` (0-1) of the walls, objects and upper floors in an area wrecked or gone. */
export function opRuin(ctx: EditCtx, area: Rect, amount = 0.4, z?: number) {
  const b = ctx.b;
  for (let k = z ?? 0; k <= (z ?? b.sz - 1); k++)
    for (let x = area.x; x < area.x + area.w; x++)
      for (let y = area.y; y < area.y + area.h; y++) {
        const t = b.idx(x, y, k);
        if (t < 0) continue;
        for (const p of [TilePart.FLOOR, TilePart.WESTWALL, TilePart.NORTHWALL, TilePart.OBJECT]) {
          const md = b.part(t, p);
          if (!md || (p === TilePart.FLOOR && k === 0) || !ctx.rng.percent(Math.round(amount * 100))) continue;
          // the destroyed form, if it goes in the same slot
          const die = md.dieMCD ? b.lib.mapData[md.dieMCD] : null;
          b.setPart(t, p, -1);
          if (die && ctx.rng.percent(70)) b.setPart(t, die.objectType, md.dieMCD);
        }
      }
}

/** Copies an area (every level) so its north-west corner lands at `to`. */
export function opCopy(ctx: EditCtx, area: Rect, to: { x: number; y: number }) {
  const b = ctx.b;
  const buf = new Int16Array(area.w * area.h * b.sz * 4);
  let i = 0;
  for (let k = 0; k < b.sz; k++)
    for (let y = area.y; y < area.y + area.h; y++)
      for (let x = area.x; x < area.x + area.w; x++) for (let p = 0; p < 4; p++) buf[i++] = b.parts[b.idx(x, y, k) * 4 + p];
  i = 0;
  for (let k = 0; k < b.sz; k++)
    for (let y = 0; y < area.h; y++)
      for (let x = 0; x < area.w; x++)
        for (let p = 0; p < 4; p++) {
          const t = b.idx(to.x + x, to.y + y, k);
          const v = buf[i++];
          if (t >= 0) b.setPart(t, p as TilePart, v);
        }
}

export function opBlock(ctx: EditCtx, name: string, at: { x: number; y: number; z: number }) {
  placeBlock(ctx.b, name, at.x, at.y, at.z, ctx.files);
}

export function opUfo(ctx: EditCtx, type: string, at: { x: number; y: number }) {
  ctx.ufo = placeUfo(ctx.b, type, at.x, at.y, ctx.files);
}
