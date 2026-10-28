// Custom maps as battles: a map document made into a battle's map (to play it, or to edit it), and back.
import { Battle, TerrainLib, type FileSource, type Rect, type Unit } from "../engine/state.ts";
import { TilePart, parseMap, type MapBlockData } from "../formats/terrain.ts";
import { TERRAINS, UFO_TERRAINS, CRAFT_TERRAINS, type TerrainRule } from "../rules/index.ts";
import { defaultSettings, type MatchSettings } from "../protocol.ts";
import { RNG } from "../engine/rng.ts";
import { canStand, shadeFor, type GeneratedMap } from "../engine/mapgen.ts";
import { Pathfinder } from "../engine/pathfinding.ts";
import { DX, DY } from "../engine/defs.ts";
import { type MapDoc, MAP_LIMITS, decodeParts, encodeParts } from "./format.ts";

/** A battle with the map's tiles (no units) for `players` sides. */
export function mapBattle(doc: MapDoc, files: FileSource, settings: MatchSettings = defaultSettings(), players = 1, seed = 1): Battle {
  const lib = new TerrainLib(doc.datasets, files);
  const b = new Battle(lib, settings, seed);
  b.terrainName = doc.terrain;
  const [sx, sy, sz] = doc.size;
  b.initMap(sx, sy, sz, players);
  b.parts = decodeParts(doc.parts, sx * sy * sz * 4);
  // a part from a set the map no longer has (or never had) is dropped rather than drawn as something else
  for (let i = 0; i < b.parts.length; i++) if (b.parts[i] >= lib.mapData.length) b.parts[i] = -1;
  b.globalShade = shadeFor(settings.timeOfDay);
  b.ufoArea = doc.ufo ? { ...doc.ufo } : null;
  return b;
}

/** The map document for a battle's map as it is now. */
export function battleDoc(b: Battle, meta: { name: string; description: string; terrain: string; zones: Rect[]; ufo: Rect | null }): MapDoc {
  return {
    v: 1, name: meta.name, description: meta.description, terrain: meta.terrain, datasets: [...b.lib.datasetNames],
    size: [b.sx, b.sy, b.sz], parts: encodeParts(b.parts), zones: meta.zones.map((z) => ({ ...z })), ufo: meta.ufo ? { ...meta.ufo } : null,
  };
}

/** A blank map: `floor` (a global part id in the terrain's own sets) on the ground, nothing else. */
export function blankDoc(terrain: string, sx: number, sy: number, sz: number, floor: number, files: FileSource): MapDoc {
  const rule = TERRAINS.get(terrain)!;
  const lib = new TerrainLib(rule.mapDataSets, files);
  const b = new Battle(lib, defaultSettings(), 1);
  b.initMap(sx, sy, sz, 1);
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) b.parts[b.idx(x, y, 0) * 4] = floor;
  return battleDoc(b, { name: "Untitled map", description: "", terrain, zones: defaultZones(sx, sy), ufo: null });
}

/** Four landing zones, one in each corner (10x10 where there's room). */
export function defaultZones(sx: number, sy: number): Rect[] {
  const w = Math.min(10, Math.floor(sx / 2)), h = Math.min(10, Math.floor(sy / 2));
  return [{ x: 0, y: 0, w, h }, { x: sx - w, y: sy - h, w, h }, { x: sx - w, y: 0, w, h }, { x: 0, y: sy - h, w, h }];
}

/**
 * The map for a battle with `sides` sides: the document's tiles, and as many of its landing zones as there are
 * sides, spread as far apart as they go (the first one picked by the seed). Fewer zones than sides: the rest are
 * made at the edge when the battle is set up.
 */
export function customMap(doc: MapDoc, settings: MatchSettings, sides: number, seed: number, files: FileSource): GeneratedMap {
  const battle = mapBattle(doc, files, settings, sides, seed);
  return { battle, zones: pickZones(doc.zones, sides, seed), ufo: doc.ufo ? { ...doc.ufo } : null };
}

export function pickZones(zones: Rect[], n: number, seed: number): Rect[] {
  if (!zones.length || n <= 0) return [];
  const centre = (z: Rect) => ({ x: z.x + z.w / 2, y: z.y + z.h / 2 });
  const left = zones.map((z) => ({ ...z }));
  const out = left.splice(new RNG(seed ^ 0x2a7e).int(0, left.length - 1), 1);
  while (out.length < n && left.length) {
    let best = 0, bestD = -1;
    left.forEach((z, i) => {
      const c = centre(z);
      const d = Math.min(...out.map((o) => Math.hypot(centre(o).x - c.x, centre(o).y - c.y)));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    });
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

// ---- original map blocks and UFOs ----

/** Every original map block by name, with the terrain whose part sets its values index. */
const BLOCKS = new Map<string, { rule: TerrainRule; width: number; length: number }>();
for (const t of [...TERRAINS.values(), ...UFO_TERRAINS.values(), ...CRAFT_TERRAINS])
  for (const blk of t.mapBlocks) if (!BLOCKS.has(blk.name)) BLOCKS.set(blk.name, { rule: t, width: blk.width, length: blk.length });

export function blockInfo(name: string) {
  return BLOCKS.get(name.toUpperCase()) ?? null;
}
export function blockNames(): string[] {
  return [...BLOCKS.keys()];
}

/** The part set (and its first id) that a dataset adds to a battle, adding it if the battle doesn't have it yet. */
export function ensureDataset(b: Battle, name: string, files: FileSource): number {
  const k = b.lib.datasetNames.indexOf(name);
  if (k >= 0) return b.lib.datasetStart[k];
  if (b.lib.datasetNames.length >= MAP_LIMITS.maxDatasets) throw new Error(`a map can use at most ${MAP_LIMITS.maxDatasets} terrain part sets`);
  return b.lib.addDataset(name, files);
}

const mcdCounts = new Map<string, number>();
function mcdCount(name: string, files: FileSource): number {
  let n = mcdCounts.get(name);
  if (n === undefined) mcdCounts.set(name, (n = Math.floor(files(`TERRAIN/${name}.MCD`).length / 62)));
  return n;
}

/** The game files a block needs (its MAP and its terrain's part sets). */
export function blockFiles(name: string): string[] {
  const info = blockInfo(name);
  if (!info) return [];
  return [`MAPS/${name.toUpperCase()}.MAP`, ...info.rule.mapDataSets.map((d) => `TERRAIN/${d}.MCD`)];
}

/**
 * Copies an original map block into the battle with its north-west corner at (x, y, z). Its parts are mapped onto
 * the battle's part sets (sets it doesn't have yet are added), so a block from any terrain fits any map.
 * `overlay` (UFOs): walls and objects already there are cleared under it, and it sits on the highest floor at its corner.
 */
export function placeBlock(b: Battle, name: string, x: number, y: number, z: number, files: FileSource, overlay = false): Rect {
  const info = blockInfo(name);
  if (!info) throw new Error(`unknown map block "${name}"`);
  const d: MapBlockData = parseMap(files(`MAPS/${name.toUpperCase()}.MAP`));
  // block value -> battle part id
  const sets = info.rule.mapDataSets;
  const starts: number[] = [];
  let total = 0;
  for (const s of sets) {
    starts.push(total);
    total += mcdCount(s, files);
  }
  const remap = new Int16Array(total).fill(-1);
  sets.forEach((s, k) => {
    const n = mcdCount(s, files);
    let base = -1;
    for (let i = 0; i < n; i++) {
      if (i === 0 && k === 0) continue; // 0 = empty
      if (base < 0) base = ensureDataset(b, s, files);
      remap[starts[k] + i] = base + i;
    }
  });
  if (overlay) {
    for (let k = b.sz - 1; k > 0; k--) {
      const t = b.idx(x, y, k);
      if (t >= 0 && b.part(t, TilePart.FLOOR)) {
        z = k;
        break;
      }
    }
    // whatever stood where the hull comes down is gone (floors above the ground too)
    for (let yy = 0; yy < d.sizeY; yy++)
      for (let xx = 0; xx < d.sizeX; xx++) {
        let hull = false;
        for (let k = 0; k < d.sizeZ * 4 && !hull; k++) hull = d.parts[((Math.floor(k / 4) * d.sizeY + yy) * d.sizeX + xx) * 4 + (k & 3)] > 0;
        if (!hull) continue;
        for (let k = z; k < b.sz; k++) {
          const t = b.idx(x + xx, y + yy, k);
          if (t < 0) continue;
          for (const p of [TilePart.WESTWALL, TilePart.NORTHWALL, TilePart.OBJECT]) b.setPart(t, p, -1);
          if (k > z) b.setPart(t, TilePart.FLOOR, -1);
        }
      }
  } else {
    // a block replaces everything in its footprint, up to the sky
    for (let k = z + d.sizeZ; k < b.sz; k++)
      for (let yy = 0; yy < d.sizeY; yy++)
        for (let xx = 0; xx < d.sizeX; xx++) {
          const t = b.idx(x + xx, y + yy, k);
          if (t >= 0) for (let p = 0; p < 4; p++) b.setPart(t, p as TilePart, -1);
        }
  }
  for (let k = 0; k < d.sizeZ; k++)
    for (let yy = 0; yy < d.sizeY; yy++)
      for (let xx = 0; xx < d.sizeX; xx++) {
        const t = b.idx(x + xx, y + yy, z + k);
        if (t < 0) continue;
        const src = ((k * d.sizeY + yy) * d.sizeX + xx) * 4;
        for (let p = 0; p < 4; p++) {
          const v = d.parts[src + p];
          if (overlay ? v > 0 : true) b.setPart(t, p as TilePart, v > 0 && v < total ? remap[v] : -1);
        }
      }
  return { x, y, w: d.sizeX, h: d.sizeY };
}

/** Drops a landed UFO (an original UFO map) with its north-west corner at (x, y). */
export function placeUfo(b: Battle, type: string, x: number, y: number, files: FileSource): Rect {
  const rule = UFO_TERRAINS.get(type);
  if (!rule) throw new Error(`unknown UFO "${type}"`);
  return placeBlock(b, rule.mapBlocks[0].name, x, y, 0, files, true);
}

// ---- checks ----

export interface MapIssue {
  level: "error" | "warning";
  text: string;
}

/** Where a soldier can stand in a rectangle (any level). */
export function standable(b: Battle, r: Rect): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (let x = r.x; x < r.x + r.w; x++)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let z = 0; z < b.sz; z++) {
        const p = { x, y, z };
        const t = b.idxP(p);
        if (t < 0) continue;
        // standing needs something underfoot (a floor, or the top of whatever is below)
        if (z > 0 && b.noFloorAt(t)) continue;
        if (z === 0 && !b.part(t, TilePart.FLOOR) && !b.part(t, TilePart.OBJECT)) continue;
        if (canStand(b, p, 1)) out.push(p);
      }
  return out;
}

/** Every tile a soldier can walk to from `from` (stairs and lifts included). */
export function walkable(b: Battle, from: { x: number; y: number; z: number }[]): Uint8Array {
  const seen = new Uint8Array(b.size);
  const walker = { id: -1, owner: 0, size: 1, movementType: 0, pos: { x: 0, y: 0, z: 0 } } as unknown as Unit;
  const pf = new Pathfinder(b, walker);
  const queue: number[] = [];
  for (const p of from) {
    const t = b.idxP(p);
    if (t >= 0 && !seen[t]) {
      seen[t] = 1;
      queue.push(t);
    }
  }
  while (queue.length) {
    const t = queue.pop()!;
    const p = b.posOf(t);
    for (let dir = 0; dir < 10; dir++) {
      if (dir < 8 && (p.x + DX[dir] < 0 || p.y + DY[dir] < 0)) continue;
      const { cost, dest } = pf.tuCost(p, dir);
      if (cost >= 255) continue;
      // falling ends on whatever is below
      let q = dest;
      while (q.z > 0 && b.noFloorAt(b.idxP(q)) && b.terrainLevel(b.idx(q.x, q.y, q.z - 1)) !== -24) q = { ...q, z: q.z - 1 };
      const nt = b.idxP(q);
      if (nt < 0 || seen[nt]) continue;
      seen[nt] = 1;
      queue.push(nt);
    }
  }
  return seen;
}

/** What would make the map play badly: too few landing zones, zones with no room, zones you can't walk between. */
export function checkMap(b: Battle, zones: Rect[], ufo: Rect | null): MapIssue[] {
  const issues: MapIssue[] = [];
  if (zones.length < 2) issues.push({ level: "error", text: "A map needs at least 2 landing zones (one per squad; more are made at the edge when more squads play)." });
  const room = zones.map((z) => standable(b, z));
  zones.forEach((z, i) => {
    if (z.x + z.w > b.sx || z.y + z.h > b.sy) issues.push({ level: "error", text: `Landing zone ${i + 1} reaches past the edge of the map.` });
    if (room[i].length < 14) issues.push({ level: "warning", text: `Landing zone ${i + 1} has room for only ${room[i].length} soldiers (a full squad needs 14; the rest land nearby).` });
    zones.forEach((o, j) => {
      if (j > i && z.x < o.x + o.w && o.x < z.x + z.w && z.y < o.y + o.h && o.y < z.y + z.h) issues.push({ level: "warning", text: `Landing zones ${i + 1} and ${j + 1} overlap.` });
    });
  });
  const start = room.findIndex((r) => r.length);
  if (start >= 0) {
    const reach = walkable(b, room[start]);
    zones.forEach((_, i) => {
      if (i !== start && room[i].length && !room[i].some((p) => reach[b.idxP(p)])) issues.push({ level: "warning", text: `Nobody can walk from landing zone ${start + 1} to landing zone ${i + 1} (only fliers and explosives get through).` });
    });
    if (ufo) {
      const near = standable(b, { x: Math.max(0, ufo.x - 2), y: Math.max(0, ufo.y - 2), w: Math.min(b.sx, ufo.w + 4), h: Math.min(b.sy, ufo.h + 4) });
      if (!near.some((p) => reach[b.idxP(p)])) issues.push({ level: "warning", text: "The UFO can't be reached on foot from the landing zones." });
    }
  }
  return issues;
}

/**
 * A map as text, one character a tile, for an AI assistant asked to change it: `.` open ground, `,` floor with
 * something overhead (indoors), `o` an object you can walk through, `#` one you can't (or raised ground), `|` a
 * tile with a wall on its west or north edge, `D` a door there, `~` impassable ground (water), ` ` nothing, and the
 * landing zones' numbers on their open ground. Column numbers every 10 tiles along the top, row numbers down the side.
 */
export function asciiPlan(b: Battle, zones: Rect[], level = 0): string {
  const rows: string[] = [];
  let head = "    ";
  for (let x = 0; x < b.sx; x++) head += x % 10 === 0 ? String(x / 10 % 10) : " ";
  rows.push(head);
  for (let y = 0; y < b.sy; y++) {
    let line = String(y).padStart(3) + " ";
    for (let x = 0; x < b.sx; x++) {
      const t = b.idx(x, y, level);
      const fl = b.part(t, TilePart.FLOOR), obj = b.part(t, TilePart.OBJECT);
      const ww = b.part(t, TilePart.WESTWALL), nw = b.part(t, TilePart.NORTHWALL);
      let c = fl ? (fl.tuWalk === 255 ? "~" : ".") : " ";
      if (c === ".") {
        for (let k = level + 1; k < b.sz && c === "."; k++) if (b.part(b.idx(x, y, k), TilePart.FLOOR)) c = ",";
      }
      if (obj) c = obj.tuWalk === 255 || obj.bigWall || obj.terrainLevel <= -8 ? "#" : "o";
      if ((ww && (ww.door || ww.ufoDoor)) || (nw && (nw.door || nw.ufoDoor))) c = "D";
      else if (ww || nw) c = "|";
      if (c === "." || c === ",") {
        const z = zones.findIndex((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h);
        if (z >= 0) c = String((z + 1) % 10);
      }
      line += c;
    }
    rows.push(line.trimEnd());
  }
  return rows.join("\n");
}
