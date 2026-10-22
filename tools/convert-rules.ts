// One-off converter: OpenXcom's xcom1 rulesets (data transcribed from the original game) -> shared/rules/generated.json.
// usage: bun tools/convert-rules.ts <path-to-openxcom-bin>
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

const bin = process.argv[2];
const std = join(bin, "standard", "xcom1");
const y = (f: string) => Bun.YAML.parse(readFileSync(join(std, f), "utf8")) as any;

const items = y("items.rul").items;
const units = y("units.rul").units;
const armors = y("armors.rul").armors;
const terrains = y("terrains.rul").terrains;
const ufos = y("ufos.rul").ufos;
const crafts = y("crafts.rul").crafts;
const pedia = y("ufopaedia.rul").ufopaedia;

const ufoTerrains = ufos
  .filter((u: any) => u.battlescapeTerrainData)
  .map((u: any) => ({ type: u.type, ...u.battlescapeTerrainData }));
const craftTerrains = crafts
  .filter((c: any) => c.battlescapeTerrainData)
  .map((c: any) => ({ type: c.type, ...c.battlescapeTerrainData }));

const pediaImages: Record<string, string> = {};
for (const p of pedia) if (p.image_id) pediaImages[p.id] = p.image_id;

// BulletSprites.png: 105x33 8-bit palettized, 3x3 cells, 35 particles x 11 bullet types.
function readBullets(): number[][][] {
  const b = new Uint8Array(readFileSync(join(std, "Resources/BulletSprites/BulletSprites.png")));
  let p = 8;
  const idat: Uint8Array[] = [];
  let w = 0, h = 0;
  while (p < b.length) {
    const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    const type = String.fromCharCode(...b.slice(p + 4, p + 8));
    const data = b.slice(p + 8, p + 8 + len);
    if (type === "IHDR") {
      w = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      h = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
    }
    if (type === "IDAT") idat.push(data);
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat.map((x) => Buffer.from(x))));
  const px = (x: number, yy: number) => raw[yy * (w + 1) + 1 + x];
  const out: number[][][] = [];
  for (let r = 0; r < h / 3; r++) {
    const row: number[][] = [];
    for (let c = 0; c < w / 3; c++) {
      const cell: number[] = [];
      for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 3; xx++) cell.push(px(c * 3 + xx, r * 3 + yy));
      row.push(cell);
    }
    out.push(row);
  }
  return out;
}

const out = { items, units, armors, terrains, ufoTerrains, craftTerrains, pediaImages, bullets: readBullets() };
writeFileSync(join(import.meta.dir, "..", "shared", "rules", "generated.json"), JSON.stringify(out));
console.log("items", items.length, "units", units.length, "armors", armors.length, "terrains", terrains.length, "ufos", ufoTerrains.length);
