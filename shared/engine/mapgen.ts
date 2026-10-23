// Builds a battle map from the original 10x10 map blocks, following the original terrain scripts
// (roads for cities, landing zones, alien base tunnels) plus multiplayer deployment zones.
import { type FileSource, Battle, TerrainLib } from "./state.ts";
import { parseMap, TilePart } from "../formats/terrain.ts";
import { TERRAINS, UFO_TERRAINS, type TerrainRule, type MapBlockRule } from "../rules/index.ts";
import { resolveBiome, resolveTimeOfDay, type MatchSettings } from "../protocol.ts";
import type { Pos } from "./defs.ts";
import { RNG } from "./rng.ts";

interface Placed {
  block: MapBlockRule;
  cx: number;
  cy: number;
}

export interface GeneratedMap {
  battle: Battle;
  zones: { x: number; y: number; w: number; h: number }[];
  /** the landed UFO's footprint in tiles */
  ufo: { x: number; y: number; w: number; h: number } | null;
}

const UFO_TYPES = ["STR_SMALL_SCOUT", "STR_MEDIUM_SCOUT", "STR_LARGE_SCOUT", "STR_HARVESTER", "STR_ABDUCTOR", "STR_TERROR_SHIP", "STR_SUPPLY_SHIP"];

export function shadeFor(time: string): number {
  return time === "night" ? 15 : time === "dusk" ? 7 : 0;
}

/** Picks deployment cells spread evenly around the map border (opposite corners for 2 players). */
function zoneCells(n: number, players: number, rng: RNG): [number, number][] {
  const ring: [number, number][] = [];
  for (let x = 0; x < n; x++) ring.push([x, 0]);
  for (let y = 1; y < n; y++) ring.push([n - 1, y]);
  for (let x = n - 2; x >= 0; x--) ring.push([x, n - 1]);
  for (let y = n - 2; y >= 1; y--) ring.push([0, y]);
  const offset = rng.int(0, ring.length - 1);
  const out: [number, number][] = [];
  for (let i = 0; i < players; i++) out.push(ring[(offset + Math.round((i * ring.length) / players)) % ring.length]);
  return out;
}

export function generateMap(settings: MatchSettings, players: number, seed: number, files: FileSource): GeneratedMap {
  // normally resolved when the match starts; settle it here too so a battle never sees "RANDOM"
  if (settings.biome === "RANDOM") settings = { ...settings, biome: resolveBiome(settings.biome, seed) };
  if (settings.timeOfDay === "random") settings = { ...settings, timeOfDay: resolveTimeOfDay(settings.timeOfDay, seed) };
  const rng = new RNG(seed ^ 0x5eed);
  const terrain = TERRAINS.get(settings.biome)!;
  const n = settings.mapBlocks;
  const cells: (Placed | null | "res")[][] = Array.from({ length: n }, () => Array(n).fill(null));
  const placed: Placed[] = [];
  const blockSize = (b: MapBlockRule) => [Math.ceil(b.width / 10), Math.ceil(b.length / 10)];
  const free = (cx: number, cy: number, w: number, h: number) => {
    if (cx < 0 || cy < 0 || cx + w > n || cy + h > n) return false;
    for (let x = cx; x < cx + w; x++) for (let y = cy; y < cy + h; y++) if (cells[x][y] !== null) return false;
    return true;
  };
  const place = (block: MapBlockRule, cx: number, cy: number) => {
    const [w, h] = blockSize(block);
    const p: Placed = { block, cx, cy };
    for (let x = cx; x < cx + w; x++) for (let y = cy; y < cy + h; y++) cells[x][y] = p;
    placed.push(p);
  };
  const blocksIn = (groups: number[] | null, size?: number, indices?: number[]) =>
    terrain.mapBlocks.filter((b, i) => {
      if (indices && !indices.includes(i)) return false;
      if (groups && !b.groups.some((g) => groups.includes(g))) return false;
      if (size !== undefined && blockSize(b)[0] !== size) return false;
      return true;
    });

  // deployment zones: reserve one cell per player on the border
  const zc = zoneCells(n, players, rng);
  const landing = blocksIn([1], 1);
  const zoneSet = new Set(zc.map(([x, y]) => x + "," + y));
  for (const [x, y] of zc) cells[x][y] = "res";

  // UFO in the middle, sitting on landing-zone blocks
  let ufo: { rule: TerrainRule; cx: number; cy: number } | null = null;
  if (settings.ufo !== "none") {
    const type = settings.ufo === "random" ? rng.pick(UFO_TYPES) : settings.ufo;
    const rule = UFO_TERRAINS.get(type);
    if (rule) {
      const [w, h] = blockSize(rule.mapBlocks[0]);
      const cx = Math.floor((n - w) / 2), cy = Math.floor((n - h) / 2);
      if (free(cx, cy, w, h)) {
        const pads = landing.length ? landing : blocksIn([0], 1);
        for (let x = cx; x < cx + w; x++) for (let y = cy; y < cy + h; y++) place(rng.pick(pads), x, y);
        ufo = { rule, cx, cy };
      }
    }
  }

  const script = terrain.script ?? "DEFAULT";
  const addBlocks = (pool: MapBlockRule[], count: number) => {
    for (let k = 0; k < count && pool.length; k++) {
      const block = rng.pick(pool);
      const [w, h] = blockSize(block);
      const spots: [number, number][] = [];
      for (let x = 0; x <= n - w; x++) for (let y = 0; y <= n - h; y++) if (free(x, y, w, h)) spots.push([x, y]);
      if (!spots.length) continue;
      const [x, y] = rng.pick(spots);
      place(block, x, y);
    }
  };

  if (script === "URBAN") {
    // one vertical and/or horizontal road, crossing where they meet
    const ew = blocksIn([2], 1), ns = blocksIn([3], 1), cross = blocksIn([4], 1);
    const doV = rng.percent(50), doH = !doV || rng.percent(50);
    const col = rng.int(1, n - 2), row = rng.int(1, n - 2);
    for (let i = 0; i < n; i++) {
      if (doV && doH && i === row) continue;
      if (doV && cells[col][i] === null) place(rng.pick(ns), col, i);
      if (doH && cells[i][row] === null) place(rng.pick(ew), i, row);
    }
    if (doV && doH && cells[col][row] === null) place(rng.pick(cross), col, row);
    addBlocks(blocksIn([0], 2), 4);
    const fillIdx = [3, 4, 10, 11, 12, 13, 14];
    const freqs = [3, 3, 2, 2, 2, 2, 2];
    const weighted: MapBlockRule[] = [];
    fillIdx.forEach((bi, k) => {
      for (let f = 0; f < freqs[k]; f++) if (terrain.mapBlocks[bi]) weighted.push(terrain.mapBlocks[bi]);
    });
    fillCells(weighted.length ? weighted : blocksIn([0], 1));
  } else if (script === "FARM") {
    const pool = blocksIn(null, 1, Array.from({ length: 18 }, (_, i) => i + 1));
    const uses = new Map<string, number>();
    fillCells(pool, (b) => {
      const u = uses.get(b.name) ?? 0;
      if (u >= 3) return false;
      uses.set(b.name, u + 1);
      return true;
    });
  } else if (script === "JUNGLE") {
    const idx = [3, 4, 5, 6, 7, 8, 9, 10, 11];
    const freqs = [2, 2, 2, 2, 2, 2, 2, 1, 1];
    const weighted: MapBlockRule[] = [];
    idx.forEach((bi, k) => {
      for (let f = 0; f < freqs[k]; f++) if (terrain.mapBlocks[bi]) weighted.push(terrain.mapBlocks[bi]);
    });
    fillCells(weighted);
  } else if (script === "MARS") {
    addBlocks(blocksIn([2]), 1);
    fillCells(blocksIn([0], 1));
  } else if (settings.biome === "UBASE") {
    addBlocks(blocksIn([2], 1), 2);
    addBlocks(blocksIn([3], 2), 1);
    addBlocks(blocksIn([0], 2), 3);
    const weighted = [...blocksIn([0], 1), ...blocksIn([0], 1), ...blocksIn([0], 1), ...blocksIn([1], 1), ...blocksIn([1], 1)];
    fillCells(weighted);
  } else {
    // DEFAULT (forest, mountain), DESERT, POLAR: a few big blocks then fill
    addBlocks(blocksIn([0], 2), script === "DESERT" ? 3 : script === "POLAR" ? 1 : 2);
    fillCells(blocksIn([0], 1));
  }

  // deployment cells get open landing-zone blocks where the terrain has them
  for (const [x, y] of zc) {
    cells[x][y] = null;
    const pool = landing.length ? landing : blocksIn([0], 1).filter((b) => !b.groups.includes(5));
    place(rng.pick(pool.length ? pool : terrain.mapBlocks.filter((b) => blockSize(b)[0] === 1)), x, y);
  }

  function fillCells(pool: MapBlockRule[], accept?: (b: MapBlockRule) => boolean) {
    const fallback = blocksIn([0], 1).filter((b) => !b.groups.includes(5));
    for (let x = 0; x < n; x++)
      for (let y = 0; y < n; y++) {
        if (cells[x][y] !== null) continue;
        let tries = 0;
        let chosen: MapBlockRule | null = null;
        while (tries++ < 30) {
          const b = rng.pick(pool.length ? pool : fallback);
          const [w, h] = blockSize(b);
          if (w !== 1 || h !== 1) continue;
          if (accept && !accept(b)) continue;
          chosen = b;
          break;
        }
        if (!chosen) chosen = rng.pick(fallback.length ? fallback : terrain.mapBlocks);
        place(chosen, x, y);
      }
  }
  void zoneSet;

  // ---- load the block data ----
  const blockData = new Map<string, ReturnType<typeof parseMap>>();
  const loadBlock = (name: string) => {
    let d = blockData.get(name);
    if (!d) blockData.set(name, (d = parseMap(files(`MAPS/${name}.MAP`))));
    return d;
  };
  let sz = 1;
  for (const p of placed) sz = Math.max(sz, loadBlock(p.block.name).sizeZ);
  if (ufo) sz = Math.max(sz, loadBlock(ufo.rule.mapBlocks[0].name).sizeZ);
  sz = Math.max(sz, 4);

  const datasets = [...terrain.mapDataSets];
  const lib = new TerrainLib(datasets, files);
  let ufoStart = -1;
  if (ufo) {
    ufoStart = lib.mapData.length;
    for (const ds of ufo.rule.mapDataSets) lib.addDataset(ds, files);
  }
  const battle = new Battle(lib, settings, seed);
  battle.terrainName = terrain.name;
  battle.initMap(n * 10, n * 10, sz, players);
  battle.globalShade = shadeFor(settings.timeOfDay);

  for (const p of placed) writeBlock(battle, loadBlock(p.block.name), p.cx * 10, p.cy * 10, 0, false);
  if (ufo) writeBlock(battle, loadBlock(ufo.rule.mapBlocks[0].name), ufo.cx * 10, ufo.cy * 10, ufoStart, true);

  if (settings.biome === "UBASE") digTunnels(battle, placed, n);

  const zones = zc.map(([x, y]) => ({ x: x * 10, y: y * 10, w: 10, h: 10 }));
  const ufoRect = ufo ? { x: ufo.cx * 10, y: ufo.cy * 10, w: ufo.rule.mapBlocks[0].width, h: ufo.rule.mapBlocks[0].length } : null;
  return { battle, zones, ufo: ufoRect };
}

/** Copies a MAP block into the battle. Values index the concatenated MCD list starting at `start`. */
function writeBlock(b: Battle, d: ReturnType<typeof parseMap>, xoff: number, yoff: number, start: number, overlay: boolean) {
  // overlays (UFOs) sit on top of the highest floor at the block's origin
  let zoff = 0;
  if (overlay) {
    for (let z = b.sz - 1; z > 0; z--) {
      const t = b.idx(xoff, yoff, z);
      if (t >= 0 && b.part(t, TilePart.FLOOR)) {
        zoff = z;
        break;
      }
    }
  }
  for (let z = 0; z < d.sizeZ; z++)
    for (let y = 0; y < d.sizeY; y++)
      for (let x = 0; x < d.sizeX; x++) {
        const t = b.idx(xoff + x, yoff + y, z + zoff);
        if (t < 0) continue;
        const src = ((z * d.sizeY + y) * d.sizeX + x) * 4;
        for (let part = 0; part < 4; part++) {
          const v = d.parts[src + part];
          if (v > 0) {
            if (overlay) b.parts[t * 4 + TilePart.OBJECT] = -1;
            const id = start + v;
            if (id < b.lib.mapData.length) b.parts[t * 4 + part] = id;
          }
        }
      }
}

/** Alien base: open 3-tile corridors between neighbouring blocks (OpenXcom's digTunnel). */
function digTunnels(b: Battle, placed: Placed[], n: number) {
  const owner = (cx: number, cy: number) => placed.find((p) => cx >= p.cx && cy >= p.cy && cx < p.cx + Math.ceil(p.block.width / 10) && cy < p.cy + Math.ceil(p.block.length / 10));
  const base = b.lib.datasetStart;
  // replacements from the ALIENBASE script: set 2 (U_WALL02) entries 18 (west), 17 (north), 19 (corner); floor set 1 (U_BASE) entry 63
  const wWall = base[2] + 18, nWall = base[2] + 17, corner = base[2] + 19, floor = base[1] + 63;
  const level = 0;
  const R = { x: 3, y: 3, w: 3, h: 3 };
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const here = owner(i, j);
      if (!here) continue;
      if (i < n - 1 && owner(i + 1, j) && owner(i + 1, j) !== here) {
        for (let k = R.y; k !== R.y + R.h; k++) {
          let t = b.idx(i * 10 + 9, j * 10 + k, level);
          if (t < 0) continue;
          b.setPart(t, TilePart.WESTWALL, -1);
          b.setPart(t, TilePart.OBJECT, -1);
          b.setPart(t, TilePart.FLOOR, floor);
          t = b.idx((i + 1) * 10, j * 10 + k, level);
          b.setPart(t, TilePart.WESTWALL, -1);
          const obj = b.part(t, TilePart.OBJECT);
          if (obj && obj.tuWalk === 0) b.setPart(t, TilePart.OBJECT, -1);
        }
        b.setPart(b.idx(i * 10 + 9, j * 10 + R.y, level), TilePart.NORTHWALL, nWall);
        b.setPart(b.idx(i * 10 + 9, j * 10 + R.y + R.h, level), TilePart.NORTHWALL, nWall);
        const c = b.idx((i + 1) * 10, j * 10 + R.y, level);
        if (!b.part(c, TilePart.NORTHWALL)) b.setPart(c, TilePart.NORTHWALL, corner);
      }
      if (j < n - 1 && owner(i, j + 1) && owner(i, j + 1) !== here) {
        for (let k = R.x; k !== R.x + R.w; k++) {
          let t = b.idx(i * 10 + k, j * 10 + 9, level);
          if (t < 0) continue;
          b.setPart(t, TilePart.NORTHWALL, -1);
          b.setPart(t, TilePart.OBJECT, -1);
          b.setPart(t, TilePart.FLOOR, floor);
          t = b.idx(i * 10 + k, (j + 1) * 10, level);
          b.setPart(t, TilePart.NORTHWALL, -1);
          const obj = b.part(t, TilePart.OBJECT);
          if (obj && obj.tuWalk === 0) b.setPart(t, TilePart.OBJECT, -1);
        }
        b.setPart(b.idx(i * 10 + R.x, j * 10 + 9, level), TilePart.WESTWALL, wWall);
        b.setPart(b.idx(i * 10 + R.x + R.w, j * 10 + 9, level), TilePart.WESTWALL, wWall);
        const c = b.idx(i * 10 + R.x, (j + 1) * 10, level);
        if (!b.part(c, TilePart.WESTWALL)) b.setPart(c, TilePart.WESTWALL, corner);
      }
    }
}

/** Can a unit of the given size stand at p? */
export function canStand(b: Battle, p: Pos, size: number): boolean {
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++) {
      const t = b.idx(p.x + x, p.y + y, p.z);
      if (t < 0) return false;
      if (b.unitAt[t]) return false;
      const below = b.idx(p.x + x, p.y + y, p.z - 1);
      if (p.z > 0 && b.hasNoFloor(t, below)) return false;
      if (b.terrainLevel(t) === -24) return false;
      const obj = b.part(t, TilePart.OBJECT);
      if (obj && (obj.tuWalk === 255 || obj.bigWall)) return false;
      const fl = b.part(t, TilePart.FLOOR);
      if (fl && fl.tuWalk === 255) return false;
      if (size > 1 && x && y) {
        const nw = b.part(t, TilePart.NORTHWALL), ww = b.part(t, TilePart.WESTWALL);
        if (nw || ww) return false;
      }
      if (size > 1) {
        if (x === 1 && b.part(t, TilePart.WESTWALL)) return false;
        if (y === 1 && b.part(t, TilePart.NORTHWALL)) return false;
      }
    }
  return true;
}

/** Open ground with sky above it, used for supply drops. */
export function openSkyTiles(b: Battle, margin = 3): Pos[] {
  const out: Pos[] = [];
  for (let x = margin; x < b.sx - margin; x++)
    for (let y = margin; y < b.sy - margin; y++) {
      // the landing spot is the highest floor at x,y
      let z = -1;
      for (let k = b.sz - 1; k >= 0; k--) {
        const t = b.idx(x, y, k);
        const below = b.idx(x, y, k - 1);
        if (k === 0 || !b.hasNoFloor(t, below)) {
          z = k;
          break;
        }
      }
      if (z < 0) continue;
      const p = { x, y, z };
      if (!canStand(b, p, 1)) continue;
      // truly outdoors: nothing at all overhead (no roof, upper floor or overhang), and a clear tile
      // (no crate, table or bush to land on)
      let covered = false;
      for (let k = z + 1; k < b.sz && !covered; k++) {
        const t = b.idx(x, y, k);
        for (let part = 0; part < 4; part++) if (b.parts[t * 4 + part] >= 0) covered = true;
      }
      if (covered || b.part(b.idxP(p), TilePart.OBJECT)) continue;
      out.push(p);
    }
  return out;
}
