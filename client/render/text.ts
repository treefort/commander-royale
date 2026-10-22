// Text with the original BIGLETS/SMALLSET fonts. Glyph pixels hold 1..5 and are shifted by the color.
import type { BitmapFont } from "../../shared/formats/images.ts";
import type { Surface } from "./surface.ts";

export interface TextOpts {
  align?: "left" | "center" | "right";
  width?: number;
  contrast?: boolean;
  color2?: number;
}

// OpenXcom's metrics: trimmed glyph width plus the font's spacing; a space is half a glyph
function advance(f: BitmapFont, code: number): number {
  if (code === 32) return f.glyphW >> 1;
  const g = f.glyphs.get(code) ?? f.glyphs.get(63);
  return g ? g.width + f.spacing : f.glyphW;
}

export function textWidth(f: BitmapFont, s: string): number {
  let w = 0;
  for (const ch of s) if (ch !== "") w += advance(f, ch.charCodeAt(0));
  return Math.max(0, w);
}

export function drawText(surf: Surface, f: BitmapFont, s: string, x: number, y: number, color: number, o: TextOpts = {}) {
  const w = textWidth(f, s);
  if (o.width !== undefined) {
    if (o.align === "center") x += Math.floor((o.width - w) / 2);
    else if (o.align === "right") x += o.width - w;
  }
  const mul = o.contrast === false ? 1 : 3;
  let cur = color;
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === "\x01") {
      cur = cur === color ? (o.color2 ?? color) : color;
      continue;
    }
    if (code === 32) {
      x += advance(f, 32);
      continue;
    }
    const g = f.glyphs.get(code) ?? f.glyphs.get(63);
    if (!g) continue;
    for (let yy = 0; yy < f.glyphH; yy++)
      for (let xx = g.left; xx < g.left + g.width; xx++) {
        const v = g.pixels[yy * f.glyphW + xx];
        if (v) surf.setPixel(x + xx - g.left, y + yy, cur + v * mul);
      }
    x += g.width + f.spacing;
  }
}

/** Splits text into lines that fit `width`. */
export function wrapText(f: BitmapFont, s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const t = line ? line + " " + word : word;
      if (textWidth(f, t) > width && line) {
        out.push(line);
        line = word;
      } else line = t;
    }
    out.push(line);
  }
  return out;
}

/** OpenXcom-style beveled frame (thick borders built from a 16-color ramp). */
export function drawFrame(surf: Surface, x: number, y: number, w: number, h: number, color: number, thickness: number, bg: number, contrast = true) {
  const mul = contrast ? 2 : 1;
  let c = color + Math.floor(((1 + thickness) * mul) / 2);
  const darkest = (color & 0xf0) + 15;
  for (let i = 0; i < thickness; i++) {
    surf.rect(x + i, y + i, w - i * 2, h - i * 2, thickness > 5 && (i === 0 || i === thickness - 1) ? darkest : c);
    if (i < Math.floor(thickness / 2)) c -= mul;
    else c += mul;
  }
  if (bg >= 0) surf.fillRect(x + thickness, y + thickness, w - thickness * 2, h - thickness * 2, bg);
}
