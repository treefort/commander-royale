// Custom maps: a battle map made in the map editor (or compiled from an AI's recipe), stored on the server and
// chosen in a match's settings instead of a generated map. The tiles are the original game's terrain parts.
import type { Rect } from "../engine/state.ts";
import { TERRAINS, UFO_TERRAINS, CRAFT_TERRAINS } from "../rules/index.ts";

export interface MapDoc {
  v: 1;
  name: string;
  description: string;
  /** the terrain (environment) it's made from: its music and the generator's base, e.g. "URBAN" */
  terrain: string;
  /** the terrain part sets (TERRAIN/<name>.MCD) the tiles use; a tile part is an index into all of them in order */
  datasets: string[];
  /** width (x, west to east), length (y, north to south) and levels (z, ground up) in tiles */
  size: [number, number, number];
  /** the tile parts (`encodeParts`): 4 per tile (floor, west wall, north wall, object), -1 = none */
  parts: string;
  /** where squads land, in tiles; a battle uses as many as it has sides, spread out (more are made at the edge) */
  zones: Rect[];
  /** a landed UFO's area: co-op enemies placed "At the UFO" start around it */
  ufo: Rect | null;
}

export const MAP_LIMITS = { minSide: 10, maxSide: 100, maxLevels: 8, maxZones: 16, maxDatasets: 16 };

/** Every terrain part set there is (what the editor can add to a map). */
export function allDatasets(): string[] {
  const sets = new Set<string>();
  for (const t of [...TERRAINS.values(), ...UFO_TERRAINS.values(), ...CRAFT_TERRAINS]) for (const d of t.mapDataSets) sets.add(d);
  return [...sets];
}

/** Terrains a map can be made from (the environments, plus the X-COM base). */
export function mapTerrains(): string[] {
  return [...TERRAINS.keys()];
}

/** Tile parts as runs of (value, count) Int16 pairs, base64. Most of a map is empty sky or the same floor. */
export function encodeParts(parts: Int16Array): string {
  const runs: number[] = [];
  for (let i = 0; i < parts.length; ) {
    const v = parts[i];
    let n = 1;
    while (i + n < parts.length && parts[i + n] === v && n < 32767) n++;
    runs.push(v, n);
    i += n;
  }
  const u8 = new Uint8Array(Int16Array.from(runs).buffer);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeParts(s: string, count: number): Int16Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length & ~1);
  for (let i = 0; i < u8.length; i++) u8[i] = bin.charCodeAt(i);
  const runs = new Int16Array(u8.buffer);
  const out = new Int16Array(count).fill(-1);
  let k = 0;
  for (let i = 0; i + 1 < runs.length && k < count; i += 2) {
    const n = Math.min(runs[i + 1], count - k);
    if (n > 0) out.fill(runs[i], k, k + n);
    k += Math.max(0, n);
  }
  return out;
}

/** Problems that stop a map document from being used at all (bad size, unknown part sets...). */
export function mapDocErrors(raw: unknown): string[] {
  const d = raw as Partial<MapDoc>;
  const errors: string[] = [];
  if (!d || typeof d !== "object") return ["not a map"];
  if (d.v !== 1) errors.push("unknown map version (v must be 1)");
  const [sx, sy, sz] = Array.isArray(d.size) ? d.size : [];
  const side = (n: unknown) => Number.isInteger(n) && (n as number) >= MAP_LIMITS.minSide && (n as number) <= MAP_LIMITS.maxSide;
  if (!side(sx) || !side(sy)) errors.push(`width and length must be ${MAP_LIMITS.minSide}-${MAP_LIMITS.maxSide} tiles`);
  if (!Number.isInteger(sz) || sz! < 1 || sz! > MAP_LIMITS.maxLevels) errors.push(`levels must be 1-${MAP_LIMITS.maxLevels}`);
  if (!TERRAINS.has(String(d.terrain))) errors.push(`unknown terrain "${d.terrain}"`);
  const known = new Set(allDatasets());
  if (!Array.isArray(d.datasets) || !d.datasets.length || d.datasets.length > MAP_LIMITS.maxDatasets) errors.push("datasets: 1-16 terrain part sets");
  else for (const x of d.datasets) if (!known.has(x)) errors.push(`unknown terrain part set "${x}"`);
  if (typeof d.parts !== "string") errors.push("parts missing");
  if (!Array.isArray(d.zones)) errors.push("zones missing");
  return errors;
}

/** A map document made safe to store: limits applied, names trimmed, zones inside the map. Throws if unusable. */
export function sanitizeMapDoc(raw: unknown): MapDoc {
  const errors = mapDocErrors(raw);
  if (errors.length) throw new Error(errors.join("; "));
  const d = raw as MapDoc;
  const [sx, sy, sz] = d.size;
  const rect = (r: Partial<Rect> | null | undefined): Rect | null => {
    if (!r || typeof r !== "object") return null;
    const x = clamp(r.x, 0, sx - 1), y = clamp(r.y, 0, sy - 1);
    const w = clamp(r.w, 1, sx - x), h = clamp(r.h, 1, sy - y);
    return { x, y, w, h };
  };
  return {
    v: 1,
    name: String(d.name ?? "").trim().slice(0, 40) || "Untitled map",
    description: String(d.description ?? "").slice(0, 1000),
    terrain: d.terrain,
    datasets: [...d.datasets],
    size: [sx, sy, sz],
    parts: d.parts,
    zones: d.zones.map(rect).filter((r): r is Rect => !!r).slice(0, MAP_LIMITS.maxZones),
    ufo: rect(d.ufo),
  };
}

function clamp(v: unknown, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo;
}

/** The game files a map needs to be drawn or played (its part sets). */
export function mapFiles(datasets: string[]): string[] {
  return datasets.flatMap((d) => [`TERRAIN/${d}.MCD`, `TERRAIN/${d}.PCK`, `TERRAIN/${d}.TAB`]);
}
