// Dev tool: decode original assets into PNG contact sheets for visual verification.
// usage: bun tools/dump.ts <outdir> <kind> <file> [w h cols]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { decodePalette, decodePck, decodeSpk, decodeScr, decodeDatFrames, decodeFont } from "../shared/formats/images.ts";
import { sheetToPng } from "./png.ts";

const G = join(import.meta.dir, "..", "gamedata");
const [outDir, kind, file, a, b, c] = process.argv.slice(2);
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const pal = decodePalette(readFileSync(join(G, "GEODATA/PALETTES.DAT")), Number(process.env.PAL ?? 4));
const read = (f: string) => new Uint8Array(readFileSync(join(G, f)));
const name = file.replace(/[\\/]/g, "_");

if (kind === "pck") {
  const w = Number(a ?? 32), h = Number(b ?? 40), cols = Number(c ?? 16);
  const tabFile = file.replace(/\.PCK$/i, ".TAB");
  const frames = decodePck(read(file), existsSync(join(G, tabFile)) ? read(tabFile) : null, w, h);
  writeFileSync(join(outDir, name + ".png"), sheetToPng(frames, pal, cols, 2));
  console.log(file, frames.length, "frames");
} else if (kind === "spk" || kind === "scr") {
  const img = kind === "spk" ? decodeSpk(read(file)) : decodeScr(read(file));
  writeFileSync(join(outDir, name + ".png"), sheetToPng([img], pal, 1, 2));
} else if (kind === "dat") {
  const w = Number(a), h = Number(b), cols = Number(c ?? 16);
  const frames = decodeDatFrames(read(file), w, h);
  writeFileSync(join(outDir, name + ".png"), sheetToPng(frames, pal, cols, 2));
  console.log(file, frames.length, "frames");
} else if (kind === "font") {
  const w = Number(a), h = Number(b);
  const font = decodeFont(read(file), w, h, 0);
  const frames = [...font.glyphs.values()].map((g) => ({ width: w, height: h, pixels: g.pixels.map((v) => (v ? v + 64 : 0)) }));
  writeFileSync(join(outDir, name + ".png"), sheetToPng(frames, pal, 32, 2));
  console.log(file, frames.length, "glyphs");
} else if (kind === "palette") {
  const frames = Array.from({ length: 256 }, (_, i) => ({ width: 8, height: 8, pixels: new Uint8Array(64).fill(i) }));
  writeFileSync(join(outDir, "palette.png"), sheetToPng(frames, pal, 16, 3, [0, 0, 0]));
}
