// Decoders for the original X-COM image formats. All images are 8-bit palette indexed;
// index 0 is transparent everywhere in the battlescape.

export interface IndexedImage {
  width: number;
  height: number;
  pixels: Uint8Array; // palette indices, row-major
}

export type Palette = Uint8Array; // 256 * 3 bytes, 0..255 RGB

/** PALETTES.DAT holds 5 palettes of 256 VGA (6-bit) colors plus 6 bytes of padding each. */
export function decodePalette(data: Uint8Array, index: number): Palette {
  const offset = index * (768 + 6);
  const pal = new Uint8Array(768);
  for (let i = 0; i < 768; i++) pal[i] = Math.min(255, data[offset + i] * 4);
  return pal;
}

/** Number of frames described by a TAB file (16-bit offsets in UFO). */
export function tabFrameCount(tab: Uint8Array | null): number {
  if (!tab) return 1;
  const dv = new DataView(tab.buffer, tab.byteOffset, tab.byteLength);
  // a 32-bit table starts with a 0 dword; 16-bit tables have a nonzero second word
  if (tab.byteLength >= 4 && dv.getUint32(0, true) === 0) {
    return Math.floor(tab.byteLength / 4);
  }
  return Math.floor(tab.byteLength / 2);
}

/**
 * PCK: per frame, first byte = number of fully transparent rows to skip, then pixel bytes,
 * 0xFE n = skip n transparent pixels, 0xFF = end of frame. Frames are stored back to back.
 */
export function decodePck(pck: Uint8Array, tab: Uint8Array | null, width: number, height: number): IndexedImage[] {
  const frames: IndexedImage[] = [];
  const count = tabFrameCount(tab);
  let p = 0;
  for (let f = 0; f < count && p < pck.length; f++) {
    const pixels = new Uint8Array(width * height);
    let pos = pck[p++] * width;
    while (p < pck.length) {
      const v = pck[p++];
      if (v === 255) break;
      if (v === 254) {
        pos += pck[p++];
      } else {
        if (pos < pixels.length) pixels[pos] = v;
        pos++;
      }
    }
    frames.push({ width, height, pixels });
  }
  return frames;
}

/** SPK: 16-bit LE commands. 0xFFFF n = skip n*2 pixels, 0xFFFE n = n*2 literal pixels, 0xFFFD = end. */
export function decodeSpk(data: Uint8Array, width = 320, height = 200): IndexedImage {
  const pixels = new Uint8Array(width * height);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0;
  let pos = 0;
  while (p + 2 <= data.length) {
    const flag = dv.getUint16(p, true);
    p += 2;
    if (flag === 0xffff) {
      const n = dv.getUint16(p, true);
      p += 2;
      pos += n * 2;
    } else if (flag === 0xfffe) {
      const n = dv.getUint16(p, true);
      p += 2;
      for (let i = 0; i < n * 2; i++) {
        if (pos < pixels.length) pixels[pos] = data[p];
        pos++;
        p++;
      }
    } else if (flag === 0xfffd) {
      break;
    }
  }
  return { width, height, pixels };
}

/** SCR: raw 320x200 bytes. */
export function decodeScr(data: Uint8Array, width = 320, height = 200): IndexedImage {
  const pixels = new Uint8Array(width * height);
  pixels.set(data.subarray(0, Math.min(data.length, pixels.length)));
  return { width, height, pixels };
}

/** Raw DAT sprite sheets: consecutive frames of width*height bytes. */
export function decodeDatFrames(data: Uint8Array, width: number, height: number): IndexedImage[] {
  const size = width * height;
  const frames: IndexedImage[] = [];
  for (let off = 0; off + size <= data.length; off += size) {
    frames.push({ width, height, pixels: data.slice(off, off + size) });
  }
  return frames;
}

/** LBM (ILBM/PBM) is only used for a couple of screens; not needed for the battlescape. */

export interface FontGlyph {
  width: number; // trimmed advance width
  pixels: Uint8Array; // glyphW*glyphH color offsets (0 = transparent)
  left: number;
}

export interface BitmapFont {
  glyphW: number;
  glyphH: number;
  spacing: number;
  glyphs: Map<number, FontGlyph>;
}

/**
 * BIGLETS.DAT (16x16) and SMALLSET.DAT (8x9): consecutive glyphs starting at '!' (33).
 * Pixel values are color offsets added to the text color's palette block.
 */
export function decodeFont(data: Uint8Array, glyphW: number, glyphH: number, spacing: number): BitmapFont {
  const glyphs = new Map<number, FontGlyph>();
  const size = glyphW * glyphH;
  const count = Math.floor(data.length / size);
  for (let i = 0; i < count; i++) {
    const pixels = data.slice(i * size, (i + 1) * size);
    let left = -1;
    let right = -1;
    for (let x = 0; x < glyphW; x++) {
      for (let y = 0; y < glyphH; y++) {
        if (pixels[y * glyphW + x]) {
          if (left < 0) left = x;
          right = x;
        }
      }
    }
    if (left < 0) {
      left = 0;
      right = Math.floor(glyphW / 2) - 1;
    }
    glyphs.set(33 + i, { width: right - left + 1, pixels, left });
  }
  return { glyphW, glyphH, spacing, glyphs };
}
