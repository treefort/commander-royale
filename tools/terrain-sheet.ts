// Dev tool: a contact sheet of a terrain dataset's tile parts (index, part type), to name them in
// shared/maps/materials.ts. usage: bun tools/terrain-sheet.ts <out.png> <DATASET> [scale]
import { writeFileSync } from "node:fs";
import { parseMcd } from "../shared/formats/terrain.ts";
import { Assets } from "../client/render/assets.ts";
import { Surface } from "../client/render/surface.ts";
import { drawTinyText } from "../client/render/mapview.ts";
import { encodeRgbaPng } from "./png.ts";
import { files, has } from "./gamefiles.ts";

const [out, set, scaleArg = "2"] = process.argv.slice(2);
if (!out || !set) {
  console.error("usage: bun tools/terrain-sheet.ts <out.png> <DATASET> [scale]");
  process.exit(1);
}
const scale = Number(scaleArg);
const defs = parseMcd(files(`TERRAIN/${set}.MCD`), 0);
const assets = new Assets(files, has);
const sheet = assets.terrain(set);
const COLS = 10, CW = 36, CH = 50;
const rows = Math.ceil(defs.length / COLS);
const s = new Surface(COLS * CW, rows * CH);
s.clear(0);
const KIND = ["F", "W", "N", "O"];
defs.forEach((d, i) => {
  const x = (i % COLS) * CW, y = Math.floor(i / COLS) * CH;
  s.fillRect(x, y, CW - 1, CH - 1, 6 * 16 + 14);
  const spr = sheet[d.sprites[0]];
  if (spr) s.blit(spr, x + 2, y + 1 - d.yOffset);
  drawTinyText(s, `${i}${KIND[d.objectType]}`, x + 2, y + CH - 8, d.tuWalk === 255 ? 2 * 16 + 2 : 16 + 1);
});
const big = new Surface(s.width * scale, s.height * scale);
for (let yy = 0; yy < big.height; yy++)
  for (let xx = 0; xx < big.width; xx++) big.pixels[yy * big.width + xx] = s.pixels[Math.floor(yy / scale) * s.width + Math.floor(xx / scale)];
writeFileSync(out, encodeRgbaPng(big.width, big.height, big.toRGBA(assets.pal) as Uint8Array));
console.log(defs.map((d, i) => `${i}:${KIND[d.objectType]}${d.door ? " door" : ""}${d.ufoDoor ? " ufodoor" : ""}${d.bigWall ? " big" + d.bigWall : ""} walk${d.tuWalk} arm${d.armor} lvl${d.terrainLevel}${d.stopLOS ? " los" : ""}${d.noFloor ? " nofloor" : ""}${d.gravLift ? " lift" : ""} alt${d.altMCD} die${d.dieMCD}`).join("\n"));
