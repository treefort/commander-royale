// 8-bit indexed drawing surface. The battlescape is rendered entirely in palette space so that
// the original shading (shifting within 16-color ramps) works exactly as in the DOS game.
import type { IndexedImage, Palette } from "../../shared/formats/images.ts";

export class Surface {
  pixels: Uint8Array;
  // optional clip rectangle
  cx0 = 0;
  cy0 = 0;
  cx1: number;
  cy1: number;
  constructor(public width: number, public height: number) {
    this.pixels = new Uint8Array(width * height);
    this.cx1 = width;
    this.cy1 = height;
  }

  clear(color = 0) {
    this.pixels.fill(color);
  }

  setClip(x0: number, y0: number, x1: number, y1: number) {
    this.cx0 = Math.max(0, x0);
    this.cy0 = Math.max(0, y0);
    this.cx1 = Math.min(this.width, x1);
    this.cy1 = Math.min(this.height, y1);
  }
  resetClip() {
    this.cx0 = 0;
    this.cy0 = 0;
    this.cx1 = this.width;
    this.cy1 = this.height;
  }

  /** Blits a sprite with X-COM shading: shade 0..15 darkens within the color's 16-entry ramp; >15 = black. */
  blitShade(img: IndexedImage, dx: number, dy: number, shade = 0, recolor?: Uint8Array | null, half?: "left" | "right") {
    const W = this.width;
    const x0 = Math.max(this.cx0, dx), y0 = Math.max(this.cy0, dy);
    let x1 = Math.min(this.cx1, dx + img.width), y1 = Math.min(this.cy1, dy + img.height);
    let xs = x0;
    if (half === "left") x1 = Math.min(x1, dx + (img.width >> 1));
    if (half === "right") xs = Math.max(x0, dx + (img.width >> 1));
    const src = img.pixels, dst = this.pixels, iw = img.width;
    if (shade >= 16) {
      for (let y = y0; y < y1; y++) {
        const so = (y - dy) * iw - dx, doff = y * W;
        for (let x = xs; x < x1; x++) if (src[so + x]) dst[doff + x] = 15;
      }
      return;
    }
    for (let y = y0; y < y1; y++) {
      const so = (y - dy) * iw - dx, doff = y * W;
      for (let x = xs; x < x1; x++) {
        let c = src[so + x];
        if (!c) continue;
        if (recolor) c = recolor[c];
        if (shade) {
          const ns = (c & 15) + shade;
          c = ns > 15 ? 15 : (c & 0xf0) | ns;
        }
        dst[doff + x] = c;
      }
    }
  }

  /** Plain blit (index 0 transparent). */
  blit(img: IndexedImage, dx: number, dy: number) {
    this.blitShade(img, dx, dy, 0);
  }

  /** Blit replacing every opaque pixel's ramp with `color`'s ramp (used for fonts / tinted sprites). */
  blitColor(img: IndexedImage, dx: number, dy: number, colorBase: number) {
    const W = this.width;
    const x0 = Math.max(this.cx0, dx), y0 = Math.max(this.cy0, dy);
    const x1 = Math.min(this.cx1, dx + img.width), y1 = Math.min(this.cy1, dy + img.height);
    for (let y = y0; y < y1; y++) {
      const so = (y - dy) * img.width - dx, doff = y * W;
      for (let x = x0; x < x1; x++) {
        const c = img.pixels[so + x];
        if (c) this.pixels[doff + x] = colorBase + c - 1;
      }
    }
  }

  fillRect(x: number, y: number, w: number, h: number, color: number) {
    const x0 = Math.max(this.cx0, x), y0 = Math.max(this.cy0, y);
    const x1 = Math.min(this.cx1, x + w), y1 = Math.min(this.cy1, y + h);
    for (let yy = y0; yy < y1; yy++) this.pixels.fill(color, yy * this.width + x0, yy * this.width + x1);
  }

  setPixel(x: number, y: number, c: number) {
    if (x >= this.cx0 && y >= this.cy0 && x < this.cx1 && y < this.cy1) this.pixels[y * this.width + x] = c;
  }
  getPixel(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.pixels[y * this.width + x];
  }

  rect(x: number, y: number, w: number, h: number, color: number) {
    this.fillRect(x, y, w, 1, color);
    this.fillRect(x, y + h - 1, w, 1, color);
    this.fillRect(x, y, 1, h, color);
    this.fillRect(x + w - 1, y, 1, h, color);
  }

  asImage(): IndexedImage {
    return { width: this.width, height: this.height, pixels: this.pixels };
  }

  /** Converts to RGBA using the palette (index 0 becomes opaque black unless `transparent0`). */
  toRGBA(pal: Palette, out?: Uint8ClampedArray | Uint8Array, transparent0 = false): Uint8ClampedArray | Uint8Array {
    const n = this.width * this.height;
    const o = out ?? new Uint8ClampedArray(n * 4);
    // build a 32-bit LUT once per palette for speed
    const lut = lutFor(pal);
    const o32 = new Uint32Array(o.buffer, o.byteOffset, n);
    const px = this.pixels;
    for (let i = 0; i < n; i++) o32[i] = lut[px[i]];
    if (transparent0) for (let i = 0; i < n; i++) if (!px[i]) o32[i] = 0;
    return o;
  }
}

const lutCache = new WeakMap<Palette, Uint32Array>();
export function lutFor(pal: Palette): Uint32Array {
  let lut = lutCache.get(pal);
  if (!lut) {
    lut = new Uint32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = (255 << 24) | (pal[i * 3 + 2] << 16) | (pal[i * 3 + 1] << 8) | pal[i * 3]; // little-endian RGBA
    lutCache.set(pal, lut);
  }
  return lut;
}
