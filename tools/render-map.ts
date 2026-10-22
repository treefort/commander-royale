// Dev tool: generate a map and render it fully revealed to a PNG.
// usage: bun tools/render-map.ts <out.png> <biome> [blocks] [ufo] [time] [seed]
import { writeFileSync } from "node:fs";
import { generateMap } from "../shared/engine/mapgen.ts";
import { defaultSettings, type Biome, type TimeOfDay } from "../shared/protocol.ts";
import { recalcAllLighting } from "../shared/engine/tileengine.ts";
import { Assets } from "../client/render/assets.ts";
import { MapRenderer, type MapViewState, mapToScreen } from "../client/render/mapview.ts";
import { Surface } from "../client/render/surface.ts";
import { encodeRgbaPng } from "./png.ts";

import { files, has } from "./gamefiles.ts";
export { files, has };

if (import.meta.main) {
  const [out, biome = "URBAN", blocks = "5", ufo = "none", time = "day", seed = "42", level = "9"] = process.argv.slice(2);
  const settings = { ...defaultSettings(), biome: biome as Biome, mapBlocks: Number(blocks), ufo, timeOfDay: time as TimeOfDay };
  const t0 = performance.now();
  const { battle } = generateMap(settings, 2, Number(seed), files);
  recalcAllLighting(battle);
  for (const d of battle.discovered) d.fill(7);
  console.log("generated", battle.sx, battle.sy, battle.sz, (performance.now() - t0).toFixed(0), "ms");
  const assets = new Assets(files, has);
  const r = new MapRenderer(assets);
  const W = (battle.sx + battle.sy) * 16 + 64;
  const H = (battle.sx + battle.sy) * 8 + battle.sz * 24 + 80;
  const s = new Surface(W, H);
  const origin = mapToScreen({ x: 0, y: battle.sy - 1, z: 0 });
  const st: MapViewState = {
    player: 0, camera: { x: -origin.x + 16, y: battle.sz * 24 + 16, z: Math.min(battle.sz - 1, Number(level)) }, showAllLayers: Number(level) >= battle.sz,
    cursor: { x: 0, y: 0, z: 0, kind: "none", size: 1, visible: false }, selected: -1, anims: new Map(), poses: new Map(),
    projectile: null, explosions: [], flash: false, animFrame: 0, teamColors: [], supplyMarkers: [], crates: new Set(), path: null, doorAnim: new Map(),
  };
  const t1 = performance.now();
  r.draw(s, battle, st);
  console.log("rendered", W, H, (performance.now() - t1).toFixed(0), "ms");
  writeFileSync(out, encodeRgbaPng(W, H, s.toRGBA(assets.pal) as Uint8Array));
}
