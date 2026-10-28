// Names for the original terrain parts ("materials") and notes on the original map blocks, so people and AI
// assistants can say "red-brick-wall" instead of "URBAN:14". Hand-labelled from the sprites in catalog/*.json.
import urban from "./catalog/urban.json";
import rural from "./catalog/rural.json";
import wild from "./catalog/wild.json";
import alien from "./catalog/alien.json";
import xbase from "./catalog/xbase.json";

export type MaterialKind = "floor" | "wall" | "window" | "door" | "fence" | "corner" | "object" | "stairs" | "multi" | "debris";
export type Compass = "north" | "south" | "east" | "west";

export interface Material {
  name: string;
  kind: MaterialKind;
  /** the part set it's in; part numbers below are within it */
  dataset: string;
  label?: string;
  /** floor, corner, object, debris */
  part?: number;
  /** wall, window, door, fence */
  west?: number;
  north?: number;
  /** stairs: the lower and higher step, and the way you climb */
  low?: number;
  high?: number;
  dir?: Compass;
  /** multi: [dx, dy, part, dz?] from the north-west tile (dz: levels up, e.g. a tree's crown) */
  parts?: [number, number, number, number?][];
  /** a floor that's a roof */
  roof?: boolean;
  /** an object nobody can walk through */
  blocks?: boolean;
}

interface CatalogFile {
  datasets: Record<string, Omit<Material, "dataset">[]>;
  blocks: Record<string, string>;
}

const FILES = [urban, rural, wild, alien, xbase] as unknown as CatalogFile[];

export const MATERIALS: Material[] = [];
const byName = new Map<string, Material>();
/** what each original map block holds (for the reference and the editor) */
export const BLOCK_NOTES: Record<string, string> = {};
for (const f of FILES) {
  for (const [dataset, list] of Object.entries(f.datasets ?? {}))
    for (const m of list) {
      const mat = { ...m, dataset } as Material;
      // a name used twice is reachable as "<DATASET>:<name>" (the first keeps the plain name)
      if (!byName.has(mat.name)) byName.set(mat.name, mat);
      byName.set(`${dataset}:${mat.name}`, mat);
      MATERIALS.push(mat);
    }
  Object.assign(BLOCK_NOTES, f.blocks ?? {});
}

/** A material by name ("red-brick-wall", or "URBAN:red-brick-wall"). */
export function material(name: string): Material | null {
  return byName.get(name) ?? byName.get(name.toLowerCase()) ?? null;
}

/** The materials in some part sets, in catalog order. */
export function materialsIn(datasets: string[]): Material[] {
  const set = new Set(datasets);
  return MATERIALS.filter((m) => set.has(m.dataset));
}

/** The name a part set's part goes by (for the editor's palette), if it has one. */
export function partName(dataset: string, part: number): { name: string; kind: MaterialKind } | null {
  for (const m of MATERIALS) {
    if (m.dataset !== dataset) continue;
    if (m.part === part || m.west === part || m.north === part || m.low === part || m.high === part || m.parts?.some((p) => p[2] === part)) {
      const side = m.west === part && m.north !== undefined ? " (west)" : m.north === part && m.west !== undefined ? " (north)" : m.low === part ? " (low step)" : m.high === part ? " (high step)" : "";
      return { name: m.name + side, kind: m.kind };
    }
  }
  return null;
}
