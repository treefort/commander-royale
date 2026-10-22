// Decoded game graphics, built from a synchronous FileSource (preloaded in the browser).
import { type IndexedImage, type Palette, type BitmapFont, decodePalette, decodePck, decodeSpk, decodeScr, decodeDatFrames, decodeFont } from "../../shared/formats/images.ts";
import type { FileSource } from "../../shared/engine/state.ts";

export class Assets {
  pal: Palette;
  palettes: Palette[] = [];
  private sets = new Map<string, IndexedImage[]>();
  private images = new Map<string, IndexedImage>();
  small: BitmapFont;
  big: BitmapFont;

  constructor(public files: FileSource, public has: (path: string) => boolean) {
    const palData = files("GEODATA/PALETTES.DAT");
    for (let i = 0; i < 5; i++) this.palettes.push(decodePalette(palData, i));
    this.pal = this.palettes[4];
    this.small = decodeFont(files("GEODATA/SMALLSET.DAT"), 8, 9, -1);
    this.big = decodeFont(files("GEODATA/BIGLETS.DAT"), 16, 16, 0);
  }

  pck(path: string, w = 32, h = 40): IndexedImage[] {
    let s = this.sets.get(path);
    if (!s) {
      const tab = path.replace(/\.PCK$/i, ".TAB");
      s = decodePck(this.files(path), this.has(tab) ? this.files(tab) : null, w, h);
      this.sets.set(path, s);
    }
    return s;
  }
  terrain(dataset: string): IndexedImage[] {
    return this.pck(`TERRAIN/${dataset}.PCK`);
  }
  unitSheet(name: string): IndexedImage[] {
    return this.pck(`UNITS/${name}`, 32, name === "BIGOBS.PCK" ? 48 : 40);
  }
  dat(path: string, w: number, h: number): IndexedImage[] {
    let s = this.sets.get(path);
    if (!s) {
      s = decodeDatFrames(this.files(path), w, h);
      this.sets.set(path, s);
    }
    return s;
  }
  spk(path: string): IndexedImage {
    let i = this.images.get(path);
    if (!i) {
      i = decodeSpk(this.files(path));
      this.images.set(path, i);
    }
    return i;
  }
  scr(path: string): IndexedImage {
    let i = this.images.get(path);
    if (!i) {
      i = decodeScr(this.files(path));
      this.images.set(path, i);
    }
    return i;
  }
}

/** Every file the battlescape client needs; preloaded before entering a match. */
export function battleFileList(datasets: string[]): string[] {
  const units = ["BIGOBS", "CELATID", "CHRYS", "CIVF", "CIVM", "CYBER", "ETHEREAL", "FLOATER", "FLOOROB", "HANDOB", "MUTON", "SECTOID", "SILACOID", "SNAKEMAN", "TANKS", "XCOM_0", "XCOM_1", "XCOM_2", "X_REAP", "X_ROB", "ZOMBIE"];
  const files = ["GEODATA/PALETTES.DAT", "GEODATA/SMALLSET.DAT", "GEODATA/BIGLETS.DAT", "GEODATA/LOFTEMPS.DAT", "GEODATA/SCANG.DAT",
    "UFOGRAPH/ICONS.PCK", "UFOGRAPH/TAC00.SCR", "UFOGRAPH/TAC01.SCR", "UFOGRAPH/CURSOR.PCK", "UFOGRAPH/CURSOR.TAB", "UFOGRAPH/SMOKE.PCK", "UFOGRAPH/SMOKE.TAB",
    "UFOGRAPH/HIT.PCK", "UFOGRAPH/HIT.TAB", "UFOGRAPH/X1.PCK", "UFOGRAPH/X1.TAB", "UFOGRAPH/SPICONS.DAT", "UFOGRAPH/MEDIBORD.PCK", "UFOGRAPH/MEDIBITS.DAT",
    "UFOGRAPH/SCANBORD.PCK", "UFOGRAPH/UNIBORD.PCK", "UFOGRAPH/DETBORD.PCK", "UFOGRAPH/DETBORD2.PCK", "UFOGRAPH/DETBLOB.DAT",
    "SOUND/SAMPLE2.CAT", "SOUND/SAMPLE.CAT"];
  for (const u of units) files.push(`UNITS/${u}.PCK`, `UNITS/${u}.TAB`);
  for (const g of ["0F0", "0F1", "0F2", "0F3", "0M0", "0M1", "0M2", "0M3", "1F0", "1F1", "1F2", "1F3", "1M0", "1M1", "1M2", "1M3"]) files.push(`UFOGRAPH/MAN_${g}.SPK`);
  files.push("UFOGRAPH/MAN_2.SPK", "UFOGRAPH/MAN_3.SPK");
  for (const d of new Set(datasets)) files.push(`TERRAIN/${d}.MCD`, `TERRAIN/${d}.PCK`, `TERRAIN/${d}.TAB`);
  return files;
}
