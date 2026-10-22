import { deflateSync } from "node:zlib";
import type { IndexedImage, Palette } from "../shared/formats/images.ts";

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Lays frames out on a grid (with a magenta background so transparency is visible), scaled up. */
export function sheetToPng(frames: IndexedImage[], pal: Palette, cols: number, scale = 2, bg = [40, 0, 40]): Uint8Array {
  const fw = Math.max(...frames.map((f) => f.width));
  const fh = Math.max(...frames.map((f) => f.height));
  const rows = Math.ceil(frames.length / cols);
  const W = cols * (fw + 1) * scale;
  const H = rows * (fh + 1) * scale;
  const rgba = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    rgba[i * 4] = bg[0];
    rgba[i * 4 + 1] = bg[1];
    rgba[i * 4 + 2] = bg[2];
    rgba[i * 4 + 3] = 255;
  }
  frames.forEach((f, idx) => {
    const ox = (idx % cols) * (fw + 1) * scale;
    const oy = Math.floor(idx / cols) * (fh + 1) * scale;
    for (let y = 0; y < f.height; y++)
      for (let x = 0; x < f.width; x++) {
        const c = f.pixels[y * f.width + x];
        if (!c) continue;
        for (let sy = 0; sy < scale; sy++)
          for (let sx = 0; sx < scale; sx++) {
            const p = ((oy + y * scale + sy) * W + ox + x * scale + sx) * 4;
            rgba[p] = pal[c * 3];
            rgba[p + 1] = pal[c * 3 + 1];
            rgba[p + 2] = pal[c * 3 + 2];
          }
      }
  });
  return encodeRgbaPng(W, H, rgba);
}
