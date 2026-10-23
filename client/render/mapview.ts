// Isometric battlescape renderer (port of the original/OpenXcom draw order).
import { Surface } from "./surface.ts";
import type { Assets } from "./assets.ts";
import { UnitSpriteBuilder, type UnitLook } from "./unitsprite.ts";
import { type Battle, type Unit, isOut, unitHeight, floatHeight } from "../../shared/engine/state.ts";
import { TilePart } from "../../shared/formats/terrain.ts";
import { type Pos, UnitStatus, DX, DY, STRANGER_ID } from "../../shared/engine/defs.ts";
import type { IndexedImage } from "../../shared/formats/images.ts";
import { itemRule, BULLETS } from "../../shared/rules/index.ts";

export const TILE_W = 32, TILE_H = 40;

export interface UnitAnim {
  from: Pos;
  to: Pos;
  phase: number; // 0..end
  end: number; // 8 straight / 16 diagonal
}

export interface Explosion {
  at: Pos; // voxel
  frame: number;
  delay: number;
  kind: "big" | "hit" | "smoke";
  first: number; // first frame index
  last: number;
}

export interface Projectile {
  path: Pos[]; // voxel positions
  pos: number; // index into path
  bullet: number; // bullet sprite row, -1 = none
  item?: string; // thrown item type
}

export type CursorKind = "none" | "normal" | "aim" | "psi" | "throw" | "waypoint";

export interface MapViewState {
  player: number;
  camera: { x: number; y: number; z: number }; // screen offset + view level
  showAllLayers: boolean;
  cursor: { x: number; y: number; z: number; kind: CursorKind; size: number; visible: boolean };
  selected: number; // unit id
  anims: Map<number, UnitAnim>;
  poses: Map<number, Partial<UnitLook>>; // status overrides (aiming, collapsing)
  projectile: Projectile | null;
  explosions: Explosion[];
  flash: boolean;
  animFrame: number; // 0..7
  teamColors: number[]; // palette base per player
  supplyMarkers: { pos: Pos; dropped: boolean; label: string }[];
  /** tiles holding a landed, not yet emptied supply crate */
  crates: Set<number>;
  /** blaster bomb waypoints being placed, and where the missile leaves from */
  waypoints?: { from: Pos; points: Pos[] };
  path: { pos: Pos; tu: number; ok: boolean }[] | null;
  /** exposure readout for the previewed destination */
  pathInfo?: { pos: Pos; seenBy: number; exposure: number; kneeling: number | null } | null;
  doorAnim: Map<number, number>; // tile -> current ufo door frame (1..7 opening)
}

export function mapToScreen(p: Pos): { x: number; y: number } {
  return { x: p.x * 16 - p.y * 16, y: p.x * 8 + p.y * 8 - p.z * 24 };
}

export function voxelToScreen(v: Pos): { x: number; y: number } {
  const mp = { x: v.x >> 4, y: v.y >> 4, z: Math.floor(v.z / 24) };
  const s = mapToScreen(mp);
  const dx = v.x - mp.x * 16, dy = v.y - mp.y * 16, dz = v.z - mp.z * 24;
  return { x: s.x + Math.trunc(dx - dy) + 16, y: s.y + Math.trunc(20 + dx / 2 + dy / 2 - dz) };
}

/** Screen pixel -> map tile on the given level (inverse of mapToScreen at the floor plane). */
export function screenToMap(sx: number, sy: number, cam: { x: number; y: number; z: number }, b: Battle): { x: number; y: number } {
  sy += -16 + cam.z * 24;
  const mY = -sx + cam.x + 2 * sy - 2 * cam.y;
  const mX = sy - cam.y - Math.trunc(mY / 4) - 8;
  const mapX = Math.trunc(mX / 8), mapY = Math.trunc(mY / 32);
  return { x: Math.max(-1, Math.min(b.sx, mapX)), y: Math.max(-1, Math.min(b.sy, mapY)) };
}

const ARROW = (() => {
  const f = 16, k = 15;
  const px = [0, 0, k, k, k, k, k, 0, 0, 0, 0, k, f, f, f, k, 0, 0, 0, 0, k, f, f, f, k, 0, 0, k, k, k, f, f, f, k, k, k,
    k, f, f, f, f, f, f, f, k, 0, k, f, f, f, f, f, k, 0, 0, 0, k, f, f, f, k, 0, 0, 0, 0, 0, k, f, k, 0, 0, 0, 0, 0, 0, 0, k, 0, 0, 0, 0];
  return { width: 9, height: 9, pixels: Uint8Array.from(px) } as IndexedImage;
})();

/** A small team-colored marker drawn above units so squads can be told apart. */
function teamMarker(color: number): IndexedImage {
  const k = 15;
  const c = color, d = color + 4;
  const px = [0, k, k, k, 0, k, c, c, d, k, k, c, d, d, k, 0, k, d, k, 0, 0, 0, k, 0, 0];
  return { width: 5, height: 5, pixels: Uint8Array.from(px) };
}

export class MapRenderer {
  private sprites: UnitSpriteBuilder;
  private spriteCache = new Map<number, { key: string; frames: IndexedImage[] }>();
  private markers = new Map<number, IndexedImage>();

  constructor(public assets: Assets) {
    this.sprites = new UnitSpriteBuilder(assets);
  }

  look(b: Battle, u: Unit, st: MapViewState): UnitLook {
    const anim = st.anims.get(u.id);
    const pose = st.poses.get(u.id) ?? {};
    const r = b.itemInSlot(u, "STR_RIGHT_HAND");
    const l = b.itemInSlot(u, "STR_LEFT_HAND");
    let status = u.status;
    let walkPhase = 0;
    if (anim) {
      status = UnitStatus.WALKING;
      walkPhase = anim.phase % 8;
    }
    if (pose.status !== undefined) status = pose.status;
    return {
      armor: u.armor, dir: pose.dir ?? u.dir, turretDir: pose.turretDir ?? u.turretDir, turretType: u.turretType, status, walkPhase,
      fallPhase: pose.fallPhase ?? 0, kneeled: u.kneeled, floating: u.floating, fly: u.movementType === 1, gender: u.gender, look: u.look,
      standHeight: u.baseHeights.stand, rightItem: r ? r.type : null, leftItem: l ? l.type : null, activeHand: u.activeHand, animFrame: st.animFrame,
    };
  }

  unitFrames(b: Battle, u: Unit, st: MapViewState): IndexedImage[] {
    const l = this.look(b, u, st);
    const key = JSON.stringify(l);
    const c = this.spriteCache.get(u.id);
    if (c && c.key === key) return c.frames;
    const frames = this.sprites.build(l, u.size);
    this.spriteCache.set(u.id, { key, frames });
    return frames;
  }

  private crateImg: IndexedImage | null = null;
  /** A small isometric wooden crate, in the nearest palette colours (shaded like terrain when drawn). */
  private crate(): IndexedImage {
    if (this.crateImg) return this.crateImg;
    const pal = this.assets.pal;
    const nearest = (r: number, g: number, b: number) => {
      let best = 1, bd = Infinity;
      for (let i = 1; i < 256; i++) {
        const d = (pal[i * 3] - r) ** 2 + (pal[i * 3 + 1] - g) ** 2 + (pal[i * 3 + 2] - b) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    };
    const top = nearest(196, 150, 84), right = nearest(150, 104, 52), left = nearest(108, 72, 36), edge = nearest(60, 38, 18), band = nearest(84, 84, 90);
    const W = 14, H = 13, pixels = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const dx = Math.abs(x + 0.5 - 7) / 7;
        const topHalf = 3.5 * (1 - dx); // diamond's half-height at this column
        const yTopFace = 3.5 - topHalf, yBottomOfTop = 3.5 + topHalf;
        let c = 0;
        if (y + 0.5 >= yTopFace && y + 0.5 <= yBottomOfTop) c = top;
        else if (y + 0.5 > yBottomOfTop && y + 0.5 <= yBottomOfTop + 6) {
          c = x < 7 ? left : right;
          if (Math.abs(y + 0.5 - (yBottomOfTop + 3)) < 0.6) c = band; // metal strap round the middle
        }
        if (c && (y + 0.5 > yBottomOfTop + 5.2 || x === 0 || x === W - 1 || x === 7 && y + 0.5 > yBottomOfTop - 0.5)) c = edge;
        pixels[y * W + x] = c;
      }
    this.crateImg = { width: W, height: H, pixels };
    return this.crateImg;
  }

  marker(color: number): IndexedImage {
    let m = this.markers.get(color);
    if (!m) this.markers.set(color, (m = teamMarker(color)));
    return m;
  }

  private tileSprite(b: Battle, t: number, part: TilePart, st: MapViewState): IndexedImage | null {
    const md = b.part(t, part);
    if (!md) return null;
    let frame = st.animFrame;
    if (md.ufoDoor) {
      const anim = st.doorAnim.get(t * 4 + part);
      frame = anim !== undefined ? anim : b.isUfoDoorOpen(t, part) ? 7 : 0;
    }
    const sheet = this.assets.terrain(b.lib.datasetNames[md.set]);
    return sheet[md.sprites[frame]] ?? null;
  }

  /** Draws the visible portion of the map onto `s` (palette indices). */
  draw(s: Surface, b: Battle, st: MapViewState, viewH = s.height) {
    const cam = st.camera;
    const disc = b.discovered[st.player] ?? b.discovered[0];
    const endZ = st.showAllLayers ? b.sz - 1 : cam.z;
    const smoke = this.assets.pck("UFOGRAPH/SMOKE.PCK");
    const cursor = this.assets.pck("UFOGRAPH/CURSOR.PCK");
    const floorob = this.assets.unitSheet("FLOOROB.PCK");

    // where each unit (part) gets drawn: moving units are drawn on the later of their two tiles
    const drawAt = new Map<number, { u: Unit; part: number; sx: number; sy: number; shadeT: number }[]>();
    for (const u of b.units) {
      if (isOut(u) || u.status === UnitStatus.IGNORE_ME) continue;
      const anim = st.anims.get(u.id);
      let base = u.pos;
      let ox = 0, oy = 0;
      if (anim) {
        const a = mapToScreen(anim.from), c = mapToScreen(anim.to);
        const t = anim.phase / anim.end;
        const la = levelOf(b, anim.from, u.size), lc = levelOf(b, anim.to, u.size);
        const later = order(anim.to) >= order(anim.from) ? anim.to : anim.from;
        base = later;
        const bs = mapToScreen(later);
        ox = Math.round(a.x + (c.x - a.x) * t) - bs.x;
        oy = Math.round(a.y + (c.y - a.y) * t + la + (lc - la) * t) - bs.y;
      } else {
        oy = levelOf(b, u.pos, u.size);
      }
      for (let x = 0; x < u.size; x++)
        for (let y = 0; y < u.size; y++) {
          const tp = { x: base.x + x, y: base.y + y, z: base.z };
          const ti = b.idxP(tp);
          if (ti < 0) continue;
          const sp = mapToScreen(tp);
          let list = drawAt.get(ti);
          if (!list) drawAt.set(ti, (list = []));
          list.push({ u, part: x + y * 2, sx: sp.x + ox, sy: sp.y + oy, shadeT: b.idxP(u.pos) });
        }
    }

    // visible tile range
    const range = this.visibleRange(s.width, viewH, b, cam);
    for (let z = 0; z <= endZ; z++) {
      for (let x = range.x0; x <= range.x1; x++) {
        for (let y = range.y0; y <= range.y1; y++) {
          const t = b.idx(x, y, z);
          if (t < 0) continue;
          const sp = mapToScreen({ x, y, z });
          const px = sp.x + cam.x, py = sp.y + cam.y;
          if (px <= -TILE_W || px >= s.width + TILE_W || py <= -TILE_H || py >= viewH + TILE_H) continue;
          const d = disc ? disc[t] : 7;
          const tileShade = d & 4 ? b.shade(t, st.player) : 16;

          let spr = this.tileSprite(b, t, TilePart.FLOOR, st);
          if (spr) s.blitShade(spr, px, py - b.part(t, TilePart.FLOOR)!.yOffset, tileShade);

          // cursor back half
          const curHere = this.cursorOn(st, x, y);
          if (curHere && cam.z === z && st.cursor.kind !== "none") {
            const u = b.unitOnTile(t);
            const f = st.cursor.kind === "aim" ? (u ? 7 + (st.animFrame >> 1) : 6) : u ? st.animFrame % 2 : 0;
            if (cursor[f]) s.blit(cursor[f], px, py);
          } else if (curHere && cam.z > z && st.cursor.kind !== "none") {
            s.blit(cursor[2], px, py);
          }

          if (!b.isVoid(t) || b.itemsOnTile(t).length) {
            spr = this.tileSprite(b, t, TilePart.WESTWALL, st);
            if (spr) {
              const md = b.part(t, TilePart.WESTWALL)!;
              const ws = (md.door || md.ufoDoor) && d & 1 ? b.shade(t, st.player) : d & 1 ? b.shade(t, st.player) : tileShade;
              s.blitShade(spr, px, py - md.yOffset, d & 1 || d & 4 ? ws : 16);
            }
            spr = this.tileSprite(b, t, TilePart.NORTHWALL, st);
            if (spr) {
              const md = b.part(t, TilePart.NORTHWALL)!;
              const ws = d & 2 ? b.shade(t, st.player) : tileShade;
              s.blitShade(spr, px, py - md.yOffset, d & 2 || d & 4 ? ws : 16, null, b.part(t, TilePart.WESTWALL) ? "right" : undefined);
            }
            const obj = b.part(t, TilePart.OBJECT);
            if (obj && (obj.bigWall < 6 || obj.bigWall === 9)) {
              spr = this.tileSprite(b, t, TilePart.OBJECT, st);
              if (spr) s.blitShade(spr, px, py - obj.yOffset, tileShade);
            }
            if (d & 4) {
              const top = topItemSprite(b, t);
              if (top >= 0 && floorob[top]) s.blitShade(floorob[top], px, py + b.terrainLevel(t), tileShade);
            }
          }

          // a supply crate sits on its tile like any other object (units stand on or beside it); on ground
          // you haven't explored it only shows on the minimap
          // (on ground you haven't explored it's drawn dimmed: everyone knows where drops land)
          if (st.crates.has(t)) s.blitShade(this.crate(), px + 9, py + 21 + b.terrainLevel(t), d & 4 ? tileShade : 9);

          // units
          const list = drawAt.get(t);
          if (list) {
            for (const e of list) {
              const frames = this.unitFrames(b, e.u, st);
              const f = frames[e.part];
              if (!f) continue;
              // (the Mysterious Stranger is seen even on ground you haven't explored)
              const us = d & 4 || e.u.id === STRANGER_ID ? b.shade(e.shadeT >= 0 ? e.shadeT : t, st.player) : 16;
              s.blitShade(f, e.sx + cam.x - 16, e.sy + cam.y, us);
              if (e.u.fire > 0) {
                const fr = smoke[4 + (st.animFrame >> 1)];
                if (fr) s.blit(fr, e.sx + cam.x, e.sy + cam.y);
              }
            }
          }

          // smoke & fire
          if (b.smoke[t] && d & 4) {
            let frame = 0;
            let shade = 0;
            if (!b.fire[t]) {
              frame = 8 + Math.floor(b.smoke[t] / 6.0 - 0.1);
              shade = tileShade;
            }
            const off = (t * 7) % 4;
            const a = (st.animFrame >> 1) + off;
            frame += a > 3 ? a - 4 : a;
            if (smoke[frame]) s.blitShade(smoke[frame], px, py, shade);
          }

          if (!b.isVoid(t)) {
            const obj = b.part(t, TilePart.OBJECT);
            if (obj && obj.bigWall >= 6 && obj.bigWall !== 9) {
              spr = this.tileSprite(b, t, TilePart.OBJECT, st);
              if (spr) s.blitShade(spr, px, py - obj.yOffset, tileShade);
            }
          }

          // cursor front half
          if (curHere && st.cursor.kind !== "none") {
            if (cam.z === z) {
              const u = b.unitOnTile(t);
              const f = st.cursor.kind === "aim" ? (u ? 7 + (st.animFrame >> 1) : 6) : u ? 3 + (st.animFrame % 2) : 3;
              if (cursor[f]) s.blit(cursor[f], px, py);
              const extra = st.cursor.kind === "psi" ? 11 : st.cursor.kind === "waypoint" ? 13 : st.cursor.kind === "throw" ? 15 : -1;
              if (extra >= 0 && cursor[extra + (st.animFrame >> 2)]) s.blit(cursor[extra + (st.animFrame >> 2)], px, py);
            } else if (cam.z > z) {
              s.blit(cursor[5], px, py);
            }
          }
        }
      }
    }

    // path preview: TU left markers
    if (st.path) {
      for (const p of st.path) {
        if (p.pos.z > endZ) continue;
        const sp = mapToScreen(p.pos);
        const t = b.idxP(p.pos);
        const px = sp.x + cam.x + 16, py = sp.y + cam.y + 22 + b.terrainLevel(t);
        drawTinyNumber(s, p.tu, px, py, p.ok ? 4 * 16 - 0 + 2 : 2 * 16 + 2);
      }
    }
    // exposure at the destination: open-ness (and kneeling), and how many enemies in view could shoot you
    if (st.path && st.pathInfo && st.pathInfo.pos.z <= endZ) {
      const info = st.pathInfo;
      const sp = mapToScreen(info.pos);
      const px = sp.x + cam.x + 16, py = sp.y + cam.y + b.terrainLevel(b.idxP(info.pos)) - 14;
      const tone = (v: number) => (v < 0.3 ? 4 * 16 + 2 : v < 0.6 ? 16 + 1 : 2 * 16 + 2);
      const lines: [string, number][] = [[`EXP ${Math.round(info.exposure * 100)}%`, tone(info.exposure)]];
      if (info.kneeling !== null) lines.push([`KNEEL ${Math.round(info.kneeling * 100)}%`, tone(info.kneeling)]);
      if (info.seenBy) lines.push([`SEEN BY ${info.seenBy}`, 2 * 16 + 2]);
      lines.forEach(([text, color], i) => drawTinyText(s, text, px - text.length * 2, py - (lines.length - 1 - i) * 7, color));
    }

    // team markers above units and the selected-unit arrow
    for (const u of b.units) {
      // (the Mysterious Stranger answers to no squad)
      if (isOut(u) || u.pos.z > endZ || u.id === STRANGER_ID) continue;
      const anim = st.anims.get(u.id);
      const p = anim ? (anim.phase / anim.end < 0.5 ? anim.from : anim.to) : u.pos;
      const sp = mapToScreen(p);
      let ox = 0, oy = 0;
      if (anim) {
        const a = mapToScreen(anim.from), c = mapToScreen(anim.to);
        const t = anim.phase / anim.end;
        ox = Math.round(a.x + (c.x - a.x) * t) - sp.x;
        oy = Math.round(a.y + (c.y - a.y) * t) - sp.y;
      }
      oy += levelOf(b, p, u.size) + (u.size > 1 ? 4 : 0) + 24 - (unitHeight(u) + floatHeight(u)) - (u.kneeled ? 2 : 0);
      const cx = sp.x + cam.x + ox + (u.size > 1 ? 0 : 16), cy = sp.y + cam.y + oy;
      if (u.id === st.selected && st.cursor.kind !== "none") {
        const bob = [0, 1, 2, 1, 0, 1, 2, 1][st.animFrame];
        s.blit(ARROW, cx - 4, cy - 9 + bob);
      } else {
        const color = st.teamColors[u.owner % st.teamColors.length] ?? 16;
        s.blit(this.marker(color), cx - 2, cy - 6);
      }
    }

    // blaster bomb waypoints: a dotted flight path from the launcher through numbered markers
    // (OpenXcom draws CURSOR.PCK frame 7 with the waypoint's number on each)
    if (st.waypoints?.points.length) {
      const centre = (p: Pos) => { const q = mapToScreen(p); return { x: q.x + cam.x + 16, y: q.y + cam.y + 12 }; };
      let prev = centre(st.waypoints.from);
      st.waypoints.points.forEach((p, i) => {
        const c = centre(p);
        const steps = Math.max(1, Math.ceil(Math.hypot(c.x - prev.x, c.y - prev.y) / 3));
        for (let k = 1; k < steps; k++) {
          if ((k + (st.animFrame & 3)) % 3) continue;
          s.fillRect(Math.round(prev.x + ((c.x - prev.x) * k) / steps), Math.round(prev.y + ((c.y - prev.y) * k) / steps), 2, 2, 16 + 1);
        }
        const q = mapToScreen(p);
        if (cursor[7]) s.blit(cursor[7], q.x + cam.x, q.y + cam.y);
        drawTinyText(s, String(i + 1), q.x + cam.x + 14, q.y + cam.y + 9, 16 * 3 + 1);
        prev = c;
      });
    }

    // incoming supply drops: the target box on the landing tile and the rounds left, nothing more
    for (const m of st.supplyMarkers) {
      const sp = mapToScreen(m.pos);
      const px = sp.x + cam.x, py = sp.y + cam.y;
      if (px < -64 || py < -64 || px > s.width + 32 || py > s.height + 32) continue;
      if (cursor[2]) s.blit(cursor[2], px, py);
      drawTinyText(s, m.label, px + 15, py + 2, 16 + 1);
    }

    // projectile
    if (st.projectile) this.drawProjectile(s, st, b);

    // explosions
    if (st.flash) {
      for (let i = 0; i < s.pixels.length; i++) s.pixels[i] = (s.pixels[i] >> 4) << 4;
    }
    const x1 = this.assets.pck("UFOGRAPH/X1.PCK", 128, 64);
    const hitp = this.assets.pck("UFOGRAPH/HIT.PCK");
    for (const e of st.explosions) {
      if (e.delay > 0) continue;
      const sp = voxelToScreen(e.at);
      const px = sp.x + cam.x, py = sp.y + cam.y;
      if (e.kind === "big") {
        const f = x1[e.frame];
        if (f) s.blit(f, px - 64, py - 32);
      } else if (e.kind === "hit") {
        const f = hitp[e.frame];
        if (f) s.blit(f, px - 15, py - 25);
      } else {
        const f = smoke[e.frame];
        if (f) s.blit(f, px - 15, py - 15);
      }
    }
  }

  private drawProjectile(s: Surface, st: MapViewState, b: Battle) {
    const p = st.projectile!;
    const cam = st.camera;
    if (p.item) {
      const it = itemRule(p.item);
      const fl = this.assets.unitSheet("FLOOROB.PCK")[it.floorSprite];
      const v = p.path[Math.min(p.pos, p.path.length - 1)];
      const sp = voxelToScreen(v);
      if (fl) s.blit(fl, sp.x + cam.x - 16, sp.y + cam.y - 26);
      return;
    }
    if (p.bullet < 0) return;
    const row = BULLETS[p.bullet];
    if (!row) return;
    // the bullet is a trail of up to 35 particles behind the head
    for (let i = 0; i < row.length; i++) {
      const k = p.pos - i;
      if (k < 0 || k >= p.path.length) continue;
      const v = p.path[k];
      if (Math.floor(v.z / 24) > cam.z && !st.showAllLayers) continue;
      const cell = row[i];
      const sp = voxelToScreen(v);
      for (let yy = 0; yy < 3; yy++)
        for (let xx = 0; xx < 3; xx++) {
          const c = cell[yy * 3 + xx];
          if (c) s.setPixel(sp.x + cam.x + xx - 1, sp.y + cam.y + yy - 1, c);
        }
    }
    void b;
  }

  cursorOn(st: MapViewState, x: number, y: number): boolean {
    const c = st.cursor;
    if (!c.visible) return false;
    return x > c.x - c.size && y > c.y - c.size && x < c.x + 1 && y < c.y + 1 && x >= c.x && y >= c.y;
  }

  visibleRange(w: number, h: number, b: Battle, cam: { x: number; y: number; z: number }) {
    // conservative: invert the four screen corners at the bottom and top levels
    const pts = [[0, 0], [w, 0], [0, h], [w, h]];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const z of [0, b.sz]) {
      for (const [sx, sy] of pts) {
        const m = screenToMap(sx, sy + 48, { x: cam.x, y: cam.y, z }, b);
        x0 = Math.min(x0, m.x);
        x1 = Math.max(x1, m.x);
        y0 = Math.min(y0, m.y);
        y1 = Math.max(y1, m.y);
      }
    }
    return {
      x0: Math.max(0, x0 - 2), x1: Math.min(b.sx - 1, x1 + 2),
      y0: Math.max(0, y0 - 2), y1: Math.min(b.sy - 1, y1 + 2),
    };
  }
}

function order(p: Pos): number {
  return p.z * 100000 + p.x + p.y;
}

export function levelOf(b: Battle, p: Pos, size: number): number {
  let lowest = 0;
  for (let x = 0; x < size; x++)
    for (let y = 0; y < size; y++) {
      const l = b.terrainLevel(b.idx(p.x + x, p.y + y, p.z));
      if (l < lowest) lowest = l;
    }
  return lowest;
}

export function topItemSprite(b: Battle, t: number): number {
  let best = -1, sprite = -1;
  for (const id of b.itemsOnTile(t)) {
    const it = b.item(id);
    if (!it) continue;
    const r = itemRule(it.type);
    if (r.weight > best) {
      best = r.weight;
      sprite = r.floorSprite;
    }
  }
  return sprite;
}

// 3x5 digits for TU markers and labels
const DIGITS: Record<string, number[]> = {
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7], "3": [7, 1, 7, 1, 7], "4": [5, 5, 7, 1, 1],
  "5": [7, 4, 7, 1, 7], "6": [7, 4, 7, 5, 7], "7": [7, 1, 1, 1, 1], "8": [7, 5, 7, 5, 7], "9": [7, 5, 7, 1, 7],
  "-": [0, 0, 7, 0, 0], "?": [7, 1, 3, 0, 2], "!": [2, 2, 2, 0, 2], " ": [0, 0, 0, 0, 0], "%": [5, 1, 2, 4, 5],
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [7, 4, 4, 4, 7], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4],
  G: [7, 4, 5, 5, 7], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 7], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [7, 5, 5, 5, 7], P: [7, 5, 7, 4, 4], Q: [7, 5, 5, 7, 1], R: [6, 5, 6, 5, 5],
  S: [7, 4, 7, 1, 7], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7],
};

export function drawTinyText(s: Surface, text: string, x: number, y: number, color: number) {
  for (const ch of text) {
    const g = DIGITS[ch.toUpperCase()];
    if (g) {
      for (let yy = -1; yy <= 5; yy++)
        for (let xx = -1; xx <= 3; xx++) {
          const on = yy >= 0 && yy < 5 && xx >= 0 && xx < 3 && g[yy] & (4 >> xx);
          if (on) s.setPixel(x + xx, y + yy, color);
          else {
            // outline for legibility
            let near = false;
            for (let dy = -1; dy <= 1 && !near; dy++)
              for (let dx = -1; dx <= 1 && !near; dx++) {
                const ny = yy + dy, nx = xx + dx;
                if (ny >= 0 && ny < 5 && nx >= 0 && nx < 3 && g[ny] & (4 >> nx)) near = true;
              }
            if (near) s.setPixel(x + xx, y + yy, 15);
          }
        }
    }
    x += 4;
  }
}

export function drawTinyNumber(s: Surface, n: number, cx: number, y: number, color: number) {
  const t = String(n);
  drawTinyText(s, t, cx - t.length * 2, y, color);
}

export { DX, DY };
