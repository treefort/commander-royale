// Map recipes: a map described as JSON (what an AI assistant writes, see docs.ts) compiled into a map document.
// A recipe starts from flat ground or the terrain's own generator, lays out original map blocks on a 10x10 grid,
// then runs edit operations (ops.ts) in order. Compiling is deterministic: the same recipe gives the same map.
import { Battle, TerrainLib, type FileSource, type Rect } from "../engine/state.ts";
import { TERRAINS, UFO_TERRAINS } from "../rules/index.ts";
import { BIOMES, defaultSettings, type Biome } from "../protocol.ts";
import { generateMap } from "../engine/mapgen.ts";
import { TilePart } from "../formats/terrain.ts";
import { RNG } from "../engine/rng.ts";
import { type MapDoc, MAP_LIMITS } from "./format.ts";
import { battleDoc, blockInfo, blockFiles, checkMap, standable, type MapIssue } from "./build.ts";
import { MATERIALS, type Material, type Compass } from "./catalog.ts";
import {
  type EditCtx, type Area, type Point, rectOf, pointOf, findMaterial, opFloor, opClear, opErase, opWall, opBuilding, opObject,
  opScatter, opPath, opRuin, opCopy, opBlock, opUfo, opHill, hillStyleFor, putPart, partId, type HillStyle,
} from "./ops.ts";

export interface Recipe {
  name?: string;
  description?: string;
  terrain: string;
  /** tiles: [width, length], or one number for a square (default 50) */
  size?: number | [number, number];
  /** levels (default: 4, or more if a block or building needs them) */
  levels?: number;
  seed?: number;
  /** "flat": just ground; "generated": the terrain's own random map (as in a normal match) to build on */
  base?: "flat" | "generated";
  /** flat base: the ground's floor material (default: the terrain's usual ground) */
  ground?: string;
  /** generated base: a landed UFO in the middle, as the match setting (a type, "random" or "none") */
  ufo?: string;
  /** rows of 10x10 cells, west to east, separated by spaces: an original block's name, or "." to leave the cell */
  blocks?: string[];
  ops?: Op[];
  /** landing zones as [x, y, width, length], or how many to place round the edge (default 4) */
  zones?: Area[] | number;
}

export type Op = { op: string; [k: string]: unknown };

export interface CompiledMap {
  doc: MapDoc;
  /** what didn't go as asked (each says which op) */
  warnings: string[];
  /** playability checks on the result (landing zones, walking between them) */
  issues: MapIssue[];
}

/** Each terrain's usual ground (the commonest floor outdoors in its original blocks): a flat base's floor. */
const GROUND: Record<string, string> = {
  URBAN: "grass", CULTA: "farm-grass", FOREST: "forest-grass", JUNGLE: "jungle-grass", DESERT: "sand", MOUNT: "mountain-ground",
  POLAR: "snow", MARS: "mars-sand", UBASE: "cave-rock-floor", XBASE: "base-floor",
};
export function defaultGround(terrain: string): string | null {
  if (GROUND[terrain]) return GROUND[terrain];
  const sets = TERRAINS.get(terrain)?.mapDataSets ?? [];
  return MATERIALS.find((m) => m.kind === "floor" && !m.roof && sets.includes(m.dataset) && m.dataset !== "BLANKS")?.name ?? null;
}

function sizeOf(r: Recipe): [number, number] {
  const s = r.size ?? 50;
  const [w, l] = Array.isArray(s) ? s : [s, s];
  const side = (n: unknown) => Math.max(MAP_LIMITS.minSide, Math.min(MAP_LIMITS.maxSide, Math.round(Number(n)) || 50));
  return [side(w), side(l)];
}

function blockGrid(r: Recipe): string[][] {
  return (r.blocks ?? []).map((row) => String(row).trim().split(/\s+/).filter(Boolean));
}

/** Every game file compiling a recipe can touch (to preload them in the browser). */
export function recipeFiles(r: Recipe): string[] {
  const out = new Set<string>(["GEODATA/LOFTEMPS.DAT"]);
  const t = TERRAINS.get(String(r.terrain));
  for (const d of t?.mapDataSets ?? []) out.add(`TERRAIN/${d}.MCD`);
  if (r.base === "generated" && t) {
    for (const b of t.mapBlocks) out.add(`MAPS/${b.name}.MAP`);
    for (const u of UFO_TERRAINS.values()) {
      for (const d of u.mapDataSets) out.add(`TERRAIN/${d}.MCD`);
      out.add(`MAPS/${u.mapBlocks[0].name}.MAP`);
    }
  }
  const blocks = blockGrid(r).flat().filter((n) => n !== ".");
  for (const op of r.ops ?? []) {
    if (op?.op === "block" && typeof op.name === "string") blocks.push(op.name);
    if (op?.op === "ufo" && typeof op.type === "string") {
      const u = UFO_TERRAINS.get(op.type);
      if (u) blocks.push(u.mapBlocks[0].name);
    }
  }
  for (const n of blocks) for (const f of blockFiles(n)) out.add(f);
  // materials can come from any part set
  for (const m of MATERIALS) out.add(`TERRAIN/${m.dataset}.MCD`);
  return [...out];
}

/** Levels the recipe needs: what it asks for, its blocks' heights, its buildings' storeys and roofs. */
function levelsFor(r: Recipe, files: FileSource): number {
  let need = Math.max(1, Math.round(Number(r.levels)) || 4);
  for (const name of [...blockGrid(r).flat(), ...(r.ops ?? []).filter((o) => o?.op === "block").map((o) => String(o.name))]) {
    if (!blockInfo(name)) continue;
    try {
      need = Math.max(need, files(`MAPS/${name.toUpperCase()}.MAP`)[2]);
    } catch {
      /* reported when it's placed */
    }
  }
  for (const o of r.ops ?? []) if (o?.op === "building") need = Math.max(need, (Number(o.z) || 0) + (Number(o.storeys) || 1) + (o.roof === false ? 0 : 1));
  return Math.min(MAP_LIMITS.maxLevels, need);
}

/** Compiles a recipe. Throws only if it can't make a map at all (unknown terrain); everything else is a warning. */
export function compileRecipe(raw: unknown, files: FileSource): CompiledMap {
  if (!raw || typeof raw !== "object") throw new Error("a recipe is a JSON object");
  const r = raw as Recipe;
  const terrain = String(r.terrain ?? "").toUpperCase();
  const rule = TERRAINS.get(terrain);
  if (!rule) throw new Error(`unknown terrain "${r.terrain}": one of ${[...TERRAINS.keys()].join(", ")}`);
  const warnings: string[] = [];
  const [sx, sy] = sizeOf(r);
  const sz = levelsFor(r, files);
  const seed = Number.isFinite(Number(r.seed)) ? Number(r.seed) >>> 0 : 1;
  let b: Battle;
  let ufo: Rect | null = null;

  if (r.base === "generated") {
    // the terrain's own generator, on a square at least as big, cut down to size
    const n = Math.max(1, Math.ceil(Math.max(sx, sy) / 10));
    const biome = (BIOMES.some((x) => x.id === terrain) ? terrain : "URBAN") as Biome;
    if (biome !== terrain) warnings.push(`base: the ${terrain} terrain has no generator; using flat ground`);
    const settings = { ...defaultSettings(), biome, mapBlocks: n, ufo: UFO_TERRAINS.has(String(r.ufo)) || r.ufo === "random" ? String(r.ufo) : "none", timeOfDay: "day" as const };
    if (biome === terrain) {
      const gen = generateMap(settings, 0, seed, files);
      b = new Battle(gen.battle.lib, defaultSettings(), seed);
      b.initMap(sx, sy, Math.max(sz, gen.battle.sz), 1);
      for (let z = 0; z < gen.battle.sz; z++)
        for (let y = 0; y < sy; y++)
          for (let x = 0; x < sx; x++) for (let p = 0; p < 4; p++) b.parts[b.idx(x, y, z) * 4 + p] = gen.battle.parts[gen.battle.idx(x, y, z) * 4 + p];
      ufo = gen.ufo && gen.ufo.x + gen.ufo.w <= sx && gen.ufo.y + gen.ufo.h <= sy ? gen.ufo : null;
    } else b = flat();
  } else b = flat();

  function flat(): Battle {
    const lib = new TerrainLib(rule!.mapDataSets, files);
    const bb = new Battle(lib, defaultSettings(), seed);
    bb.initMap(sx, sy, sz, 1);
    return bb;
  }
  b.terrainName = terrain;
  const ctx: EditCtx = { b, files, rng: new RNG(seed ^ 0x6d61), zones: [], ufo, warnings };
  if (r.base !== "generated" || !b.parts.some((v) => v >= 0)) {
    const groundName = r.ground ?? defaultGround(terrain);
    try {
      if (!groundName) throw new Error(`no ground material known for ${terrain}`);
      opFloor(ctx, findMaterial(groundName), { x: 0, y: 0, w: sx, h: sy }, 0);
    } catch (e) {
      warnings.push(`ground: ${(e as Error).message}`);
    }
  }

  // the block grid
  blockGrid(r).forEach((row, gy) =>
    row.forEach((name, gx) => {
      if (name === "." || name === "_") return;
      try {
        if (gx * 10 >= sx || gy * 10 >= sy) throw new Error("outside the map");
        opBlock(ctx, name, { x: gx * 10, y: gy * 10, z: 0 });
      } catch (e) {
        warnings.push(`blocks row ${gy + 1}, cell ${gx + 1} (${name}): ${(e as Error).message}`);
      }
    }));

  // the recipe's landing zones first, so scattered things keep clear of them
  if (Array.isArray(r.zones)) {
    for (const z of r.zones) {
      try {
        ctx.zones.push(rectOf(z, b));
      } catch (e) {
        warnings.push(`zones: ${(e as Error).message}`);
      }
    }
  }

  (r.ops ?? []).forEach((op, i) => {
    try {
      runOp(ctx, op);
    } catch (e) {
      warnings.push(`ops[${i}] (${op?.op ?? "?"}): ${(e as Error).message}`);
    }
  });

  // landing zones: the recipe's, or open ground spread round the edge
  let zones: Rect[] = ctx.zones;
  if (zones.length < 2) {
    const want = typeof r.zones === "number" ? Math.max(2, Math.min(MAP_LIMITS.maxZones, Math.round(r.zones))) : 4;
    zones = [...zones, ...autoZones(b, want - zones.length, zones, ctx.ufo)];
  }
  const doc = battleDoc(b, {
    name: String(r.name ?? "").slice(0, 40) || "AI map", description: String(r.description ?? "").slice(0, 1000), terrain, zones, ufo: ctx.ufo,
  });
  return { doc, warnings, issues: checkMap(b, zones, ctx.ufo) };
}

/** `n` landing zones (10x10, or smaller on a small map) on the edge: open ground, as far apart as they go. */
export function autoZones(b: Battle, n: number, have: Rect[] = [], ufo: Rect | null = null): Rect[] {
  const w = Math.min(10, Math.floor(b.sx / 3)), h = Math.min(10, Math.floor(b.sy / 3));
  const cands: (Rect & { open: number })[] = [];
  const xs = [...new Set([0, ...Array.from({ length: Math.floor((b.sx - w) / 5) + 1 }, (_, i) => i * 5), b.sx - w])].filter((x) => x >= 0 && x <= b.sx - w);
  const ys = [...new Set([0, ...Array.from({ length: Math.floor((b.sy - h) / 5) + 1 }, (_, i) => i * 5), b.sy - h])].filter((y) => y >= 0 && y <= b.sy - h);
  for (const x of xs)
    for (const y of ys) {
      if (x !== 0 && y !== 0 && x !== b.sx - w && y !== b.sy - h) continue;
      const r = { x, y, w, h };
      if (ufo && x < ufo.x + ufo.w && ufo.x < x + w && y < ufo.y + ufo.h && ufo.y < y + h) continue;
      cands.push({ ...r, open: standable(b, r).filter((p) => p.z === 0).length });
    }
  const out: Rect[] = [];
  const centre = (z: Rect) => [z.x + z.w / 2, z.y + z.h / 2];
  const all = [...have];
  while (out.length < n && cands.length) {
    let best = -1, score = -Infinity;
    cands.forEach((c, i) => {
      const [cx, cy] = centre(c);
      const far = all.length ? Math.min(...all.map((o) => Math.hypot(centre(o)[0] - cx, centre(o)[1] - cy))) : Math.hypot(cx, cy);
      if (all.some((o) => c.x < o.x + o.w && o.x < c.x + c.w && c.y < o.y + o.h && o.y < c.y + c.h)) return;
      const s = far * (c.open >= 30 ? 1 : 0.4 + c.open / 50);
      if (s > score) {
        score = s;
        best = i;
      }
    });
    if (best < 0) break;
    const [pick] = cands.splice(best, 1);
    const z = { x: pick.x, y: pick.y, w: pick.w, h: pick.h };
    out.push(z);
    all.push(z);
  }
  return out;
}

const COMPASS = ["north", "south", "east", "west"];
export const OPS = ["block", "ufo", "floor", "clear", "erase", "wall", "building", "object", "scatter", "path", "hill", "ruin", "copy", "part", "zone"];
const SLOTS: Record<string, TilePart> = { floor: TilePart.FLOOR, west: TilePart.WESTWALL, north: TilePart.NORTHWALL, object: TilePart.OBJECT };

function mat(v: unknown, what: string): Material {
  if (typeof v !== "string" || !v) throw new Error(`${what}: give a material name`);
  return findMaterial(v);
}
function optMat(v: unknown, what: string): Material | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === false || v === "none") return null;
  return mat(v, what);
}
function num(v: unknown, def: number): number {
  const n = Number(v);
  return v === undefined || !Number.isFinite(n) ? def : n;
}
function list<T>(v: unknown): T[] {
  return v === undefined ? [] : Array.isArray(v) ? (v as T[]) : [v as T];
}

/** One recipe op. */
export function runOp(ctx: EditCtx, o: Op) {
  const b = ctx.b;
  const z = num(o.z, 0);
  switch (o.op) {
    case "block":
      return opBlock(ctx, String(o.name), pointOf(o.at as Point, z));
    case "ufo": {
      const type = String(o.type);
      if (!UFO_TERRAINS.has(type)) throw new Error(`unknown UFO type "${type}": one of ${[...UFO_TERRAINS.keys()].join(", ")}`);
      return opUfo(ctx, type, pointOf(o.at as Point));
    }
    case "floor":
      return opFloor(ctx, mat(o.material, "floor"), rectOf(o.area as Area, b), z);
    case "clear":
      return opClear(ctx, rectOf(o.area as Area, b), o.z === undefined ? undefined : z);
    case "erase": {
      const slots = list<string>(o.parts ?? ["floor", "west", "north", "object"]).map((p) => {
        if (!(p in SLOTS)) throw new Error(`parts: floor, west, north or object (not "${p}")`);
        return SLOTS[p];
      });
      return opErase(ctx, rectOf(o.area as Area, b), z, slots);
    }
    case "wall":
      return opWall(ctx, list<string>(o.materials ?? o.material).map((x) => mat(x, "wall")), pointOf(o.from as Point), pointOf(o.to as Point), z, Math.max(1, num(o.storeys, 1)));
    case "building": {
      const doors = list<Compass | { side: Compass; at?: number }>(o.doors ?? "south");
      for (const d of doors) if (!COMPASS.includes(typeof d === "string" ? d : d?.side)) throw new Error(`doors: north, south, east or west (or {"side": ..., "at": n})`);
      const windows = o.windows === undefined ? undefined : String(o.windows);
      if (windows && !["none", "few", "some", "many"].includes(windows)) throw new Error(`windows: none, few, some or many`);
      return opBuilding(ctx, rectOf(o.area as Area, b), {
        wall: mat(o.wall ?? o.material, "wall"), window: optMat(o.window, "window"), door: optMat(o.door, "door"), floor: optMat(o.floor, "floor"),
        roof: o.roof === false ? false : optMat(o.roof, "roof"), stairs: o.stairs === false ? false : optMat(o.stairs, "stairs"),
        storeys: Math.max(1, Math.round(num(o.storeys, 1))), z, doors, windows: windows as "none" | "few" | "some" | "many" | undefined,
      });
    }
    case "object":
    case "place": {
      const m = mat(o.material, "object");
      for (const p of (Array.isArray(o.at) && Array.isArray(o.at[0]) ? o.at : [o.at]) as Point[]) opObject(ctx, m, pointOf(p, z));
      return;
    }
    case "scatter": {
      const mats = list<string>(o.materials ?? o.material).map((x) => mat(x, "scatter"));
      if (!mats.length) throw new Error("scatter: give material (or materials: [...])");
      return opScatter(ctx, mats, rectOf(o.area as Area | undefined, b), {
        count: o.count === undefined ? undefined : num(o.count, 0), density: o.density === undefined ? undefined : num(o.density, 0.1),
        z, spacing: num(o.spacing, 0), anywhere: !!o.anywhere, indoors: !!o.indoors,
      });
    }
    case "path":
    case "road":
      return opPath(ctx, mat(o.material, "path"), list<Point>(o.points).map((p) => pointOf(p)), Math.max(1, Math.round(num(o.width, 1))), z);
    case "ruin":
      return opRuin(ctx, rectOf(o.area as Area | undefined, b), Math.max(0, Math.min(1, num(o.amount, 0.4))), o.z === undefined ? undefined : z);
    case "copy":
      return opCopy(ctx, rectOf(o.area as Area, b), pointOf(o.to as Point));
    case "part": {
      const slot = SLOTS[String(o.slot)];
      if (slot === undefined) throw new Error(`slot: floor, west, north or object`);
      const p = pointOf(o.at as Point, z);
      const t = b.idx(p.x, p.y, p.z);
      if (t < 0) throw new Error(`${p.x},${p.y},${p.z} is outside the map`);
      if (o.material === null || o.material === "none") return b.setPart(t, slot, -1);
      const m = mat(o.material, "part");
      const key = slot === TilePart.WESTWALL ? "west" : slot === TilePart.NORTHWALL ? "north" : "part";
      return putPart(b, p.x, p.y, p.z, partId(ctx, m, m[key] !== undefined ? key : "part"));
    }
    case "zone":
      ctx.zones.push(rectOf(o.area as Area, b));
      return;
    case "hill": {
      const style = (o.style === undefined ? hillStyleFor(b.terrainName) : String(o.style)) as HillStyle;
      if (!["sand", "rock", "snow", "grass"].includes(style)) throw new Error(`style: sand, rock, snow or grass`);
      return opHill(ctx, rectOf(o.area as Area, b), num(o.height, 2), style, z);
    }
    default:
      throw new Error(`unknown op "${o?.op}" (${OPS.join(", ")})`);
  }
}
