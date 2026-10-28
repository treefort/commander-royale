// Custom maps from the command line, for people and AI agents: the recipe reference, compiling a recipe (with
// warnings, playability checks, a top-down plan and an isometric preview to look at), and a link that opens it in
// the map editor to save.
//
//   bun tools/map.ts reference [--terrain URBAN] [--server <address>]   what /maps.txt serves (one terrain: shorter)
//   bun tools/map.ts build <recipe.json | '<json>' | -> [--out map.json] [--plan plan.png] [--iso iso.png]
//                    [--level <z>] [--server <address>]
//   bun tools/map.ts render <map.json> [--plan plan.png] [--iso iso.png] [--level <z>]   a map saved from the editor
//   bun tools/map.ts blocks <out-dir> [--terrain URBAN]   a picture of every original map block (to choose from)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { compileRecipe } from "../shared/maps/recipe.ts";
import { mapsReference } from "../shared/maps/docs.ts";
import { mapBattle, checkMap, placeBlock, blockNames, blockInfo } from "../shared/maps/build.ts";
import { sanitizeMapDoc, type MapDoc } from "../shared/maps/format.ts";
import { Battle, TerrainLib } from "../shared/engine/state.ts";
import { defaultSettings } from "../shared/protocol.ts";
import { recalcAllLighting } from "../shared/engine/tileengine.ts";
import { Assets } from "../client/render/assets.ts";
import { MapRenderer, type MapViewState, mapToScreen } from "../client/render/mapview.ts";
import { Surface } from "../client/render/surface.ts";
import { drawPlan } from "../client/render/plan.ts";
import { encodeRgbaPng } from "./png.ts";
import { files, has } from "./gamefiles.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const server = (flag("server") ?? "http://localhost:3000").replace(/\/+$/, "");
const terrain = flag("terrain")?.toUpperCase();
const out = flag("out");
const planPng = flag("plan");
const isoPng = flag("iso");
const levelArg = flag("level");
const [cmd, input] = args;

let assets: Assets | null = null;
const art = () => (assets ??= new Assets(files, has));

/** An isometric picture of the whole map, fully lit, from `level` down (all of it by default). */
function iso(b: Battle, level: number): { width: number; height: number; png: Uint8Array } {
  const r = new MapRenderer(art());
  b.discovered[0]?.fill(7);
  recalcAllLighting(b);
  const W = (b.sx + b.sy) * 16 + 64, H = (b.sx + b.sy) * 8 + b.sz * 24 + 80;
  const s = new Surface(W, H);
  const o = mapToScreen({ x: 0, y: b.sy - 1, z: 0 });
  const st: MapViewState = {
    player: 0, camera: { x: -o.x + 16, y: b.sz * 24 + 16, z: Math.min(b.sz - 1, level) }, showAllLayers: level >= b.sz - 1,
    cursor: { x: 0, y: 0, z: 0, kind: "none", size: 1, visible: false }, selected: -1, anims: new Map(), poses: new Map(),
    projectile: null, explosions: [], flash: false, animFrame: 0, teamColors: [], supplyMarkers: [], crates: new Set(), path: null, doorAnim: new Map(),
  };
  r.draw(s, b, st);
  return { width: W, height: H, png: encodeRgbaPng(W, H, s.toRGBA(art().pal) as Uint8Array) };
}

function plan(b: Battle, doc: MapDoc, level: number, file: string) {
  const p = drawPlan(b, art(), { scale: 8, level, zones: doc.zones, ufo: doc.ufo, grid: true, labels: true });
  writeFileSync(file, encodeRgbaPng(p.width, p.height, new Uint8Array(p.rgba.buffer)));
  console.log(`plan of level ${level} (8 px per tile, lines every 10 tiles, zones numbered): ${file}`);
}

function pictures(doc: MapDoc) {
  const level = levelArg === undefined ? 0 : Number(levelArg);
  if (planPng) plan(mapBattle(doc, files), doc, level, planPng);
  if (isoPng) {
    const i = iso(mapBattle(doc, files), levelArg === undefined ? 99 : level);
    writeFileSync(isoPng, i.png);
    console.log(`isometric view${levelArg === undefined ? "" : ` up to level ${level}`} (north-west corner at the top-left edge): ${isoPng}`);
  }
}

function readJson(what: string): unknown {
  const text = what === "-" ? readFileSync(0, "utf8") : what.trim().startsWith("{") ? what : readFileSync(what, "utf8");
  return JSON.parse(text);
}

if (cmd === "reference") {
  console.log(mapsReference(server, terrain));
} else if (cmd === "build" && input) {
  const recipe = readJson(input);
  const { doc, warnings, issues } = compileRecipe(recipe, files);
  console.log(`"${doc.name}": ${doc.terrain}, ${doc.size[0]}x${doc.size[1]} tiles, ${doc.size[2]} levels, ${doc.zones.length} landing zones${doc.ufo ? ", a UFO" : ""}; part sets ${doc.datasets.join(", ")}`);
  if (warnings.length) console.log(`\nWarnings (fix the recipe):\n${warnings.map((w) => `  - ${w}`).join("\n")}`);
  if (issues.length) console.log(`\nPlayability:\n${issues.map((i) => `  - ${i.level}: ${i.text}`).join("\n")}`);
  if (!warnings.length && !issues.length) console.log("No warnings, no playability problems.");
  if (out) {
    writeFileSync(out, JSON.stringify(doc));
    console.log(`\nmap document: ${out} (Import it in the map editor)`);
  }
  pictures(doc);
  console.log(`\nOpen it in the map editor to look around, change it and save it (the person must be signed in):\n${server}/maps/new?recipe=${encodeURIComponent(JSON.stringify(recipe))}`);
} else if (cmd === "render" && input) {
  const doc = sanitizeMapDoc(readJson(input));
  const b = mapBattle(doc, files);
  const issues = checkMap(b, doc.zones, doc.ufo);
  console.log(`"${doc.name}": ${doc.terrain}, ${doc.size.join("x")}${issues.length ? "\n" + issues.map((i) => `  - ${i.level}: ${i.text}`).join("\n") : ", no playability problems"}`);
  pictures(doc);
} else if (cmd === "blocks" && input) {
  mkdirSync(input, { recursive: true });
  for (const name of blockNames()) {
    const info = blockInfo(name)!;
    if (terrain && info.rule.name !== terrain && !name.startsWith(terrain)) continue;
    const d = files(`MAPS/${name}.MAP`);
    const b = new Battle(new TerrainLib(["BLANKS"], files), defaultSettings(), 1);
    b.initMap(d[1], d[0], d[2], 1);
    placeBlock(b, name, 0, 0, 0, files);
    writeFileSync(join(input, `${name}.png`), iso(b, 99).png);
  }
  console.log(`block pictures in ${input}`);
} else {
  console.log(readFileSync(import.meta.path, "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(cmd ? 1 : 0);
}
