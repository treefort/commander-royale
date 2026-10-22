// Putting units on the map: a squad's landing zone, or (co-op scenario enemies) the UFO, the middle of the
// map or anywhere, at the start or as reinforcements later on.
import { type Battle, type Unit, type Rect, isOut } from "./state.ts";
import { canStand, openSkyTiles } from "./mapgen.ts";
import { createUnit, giveItem } from "./units.ts";
import { directionTo, VoxelType, MAX_VIEW_DISTANCE, type Pos } from "./defs.ts";
import { calculateLine } from "./tileengine.ts";
import { armorRule, unitRule, itemRule, fitsSlot, livingWeaponFor, type PlacedItem } from "../rules/index.ts";
import type { Recruit, SquadMember, Placement } from "../protocol.ts";
import { trainedRecruit } from "../rules/catalog.ts";

function standZ(b: Battle, x: number, y: number, size: number): number {
  for (let z = 0; z < b.sz; z++) if (canStand(b, { x, y, z }, size)) return z;
  return -1;
}

/** Tiles in rings around a point, nearest first. */
function around(b: Battle, cx: number, cy: number, maxR: number): Pos[] {
  const spots: Pos[] = [];
  for (let r = 0; r < maxR; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = Math.floor(cx + dx), y = Math.floor(cy + dy);
        if (x < 0 || y < 0 || x >= b.sx || y >= b.sy) continue;
        spots.push({ x, y, z: 0 });
      }
  return spots;
}

/** Eye-level voxels the other sides watch from: their landing zones (centre and corners) and their units. */
function watchers(b: Battle, seat: number, zones: Rect[]): Pos[] {
  const eye = (x: number, y: number, z: number): Pos => ({ x: x * 16 + 8, y: y * 16 + 8, z: z * 24 + 20 });
  const out: Pos[] = [];
  for (const zn of zones)
    for (const [x, y] of [[zn.x + zn.w / 2, zn.y + zn.h / 2], [zn.x + 1, zn.y + 1], [zn.x + zn.w - 2, zn.y + 1], [zn.x + 1, zn.y + zn.h - 2], [zn.x + zn.w - 2, zn.y + zn.h - 2]]) {
      const tx = Math.floor(x), ty = Math.floor(y);
      out.push(eye(tx, ty, Math.max(0, standZ(b, tx, ty, 1))));
    }
  for (const u of b.units) if (u.owner !== seat && !isOut(u)) out.push(eye(u.pos.x, u.pos.y, u.pos.z));
  return out;
}

/** A clear line from `eye` to a unit standing at `p`, within the furthest anyone can see (20 tiles). */
function inSight(b: Battle, eye: Pos, p: Pos): boolean {
  const dx = (eye.x >> 4) - p.x, dy = (eye.y >> 4) - p.y;
  if (dx * dx + dy * dy > MAX_VIEW_DISTANCE * MAX_VIEW_DISTANCE) return false;
  const z = standZ(b, p.x, p.y, 1);
  if (z < 0) return false;
  const target = { x: p.x * 16 + 8, y: p.y * 16 + 8, z: z * 24 + 16 };
  return calculateLine(b, eye, target, false, null, { excludeAllUnits: true }) === VoxelType.EMPTY;
}

/** Where `seat`'s units may land, best first (`zone`: one of the side's landing zones, by its map-wide index). */
export function deploySpots(b: Battle, seat: number, how: Placement | undefined, zone?: number): Pos[] {
  if (how === "ufo" && b.ufoArea) {
    const a = b.ufoArea;
    return around(b, a.x + a.w / 2, a.y + a.h / 2, Math.max(a.w, a.h) / 2 + 14);
  }
  if (how === "ufo" || how === "center") return around(b, b.sx / 2, b.sy / 2, 22);
  if (how === "spread") {
    // anywhere, but well away from everyone else's landing zone (further on bigger maps), and out of sight of it
    // and of their units: nobody should start the battle (or see reinforcements land) already in someone's sights
    const zones = b.landingZones.filter((z) => z.seat !== seat);
    const others = zones.map((z) => ({ x: z.x + z.w / 2, y: z.y + z.h / 2 }));
    const minDist = Math.max(14, Math.round(Math.max(b.sx, b.sy) / 3));
    const all: Pos[] = [];
    for (let x = 1; x < b.sx - 1; x++)
      for (let y = 1; y < b.sy - 1; y++) if (others.every((o) => Math.max(Math.abs(o.x - x), Math.abs(o.y - y)) >= minDist)) all.push({ x, y, z: 0 });
    const eyes = watchers(b, seat, zones);
    const hidden = new Set(all.filter((p) => !eyes.some((e) => inSight(b, e, p))));
    // a map too small or open to hide in: out of sight where possible, then the rest
    const seen = all.filter((p) => !hidden.has(p));
    return [...b.rng.shuffle([...hidden]), ...b.rng.shuffle(seen)];
  }
  const z = (zone !== undefined ? b.landingZones[zone] : undefined) ?? b.zones[seat] ?? { x: b.sx / 2 - 5, y: b.sy / 2 - 5, w: 10, h: 10 };
  return around(b, z.x + z.w / 2, z.y + z.h / 2, 18);
}

/**
 * A landing zone for a squad joining the battle in progress (or a co-op teammate landing apart): the 10x10 block on
 * the map edge farthest from every other landing zone and from the other sides' units, open ground preferred.
 */
export function newLandingZone(b: Battle, seat: number): Rect {
  const cols = Math.max(1, Math.floor(b.sx / 10)), rows = Math.max(1, Math.floor(b.sy / 10));
  const open = new Map<number, number>();
  for (const p of openSkyTiles(b, 0)) {
    const k = Math.floor(p.x / 10) * rows + Math.floor(p.y / 10);
    open.set(k, (open.get(k) ?? 0) + 1);
  }
  const others = [
    ...b.landingZones.map((z) => ({ x: z.x + z.w / 2, y: z.y + z.h / 2 })),
    ...b.units.filter((u) => u.owner !== seat && !isOut(u)).map((u) => ({ x: u.pos.x, y: u.pos.y })),
  ];
  let best: Rect | null = null, bestScore = -1;
  for (let cx = 0; cx < cols; cx++)
    for (let cy = 0; cy < rows; cy++) {
      if (cx > 0 && cy > 0 && cx < cols - 1 && cy < rows - 1) continue;
      const x = cx * 10 + 5, y = cy * 10 + 5;
      const far = others.length ? Math.min(...others.map((o) => Math.hypot(o.x - x, o.y - y))) : 1;
      // a block that's mostly buildings or rough ground counts as half as far away
      const score = far * ((open.get(cx * rows + cy) ?? 0) >= 30 ? 1 : 0.5);
      if (score > bestScore) {
        bestScore = score;
        best = { x: cx * 10, y: cy * 10, w: 10, h: 10 };
      }
    }
  return best!;
}

export function sizeOf(r: Recruit): number {
  if (r.kind === "soldier") return 1;
  return armorRule(unitRule(r.type).armor).size;
}

/** Creates a squad member's unit on the first free spot, carrying its kit. Null if there's no room. */
export function deployMember(b: Battle, r: Recruit, m: SquadMember, seat: number, spots: Pos[]): Unit | null {
  const size = sizeOf(r);
  let at: Pos | null = null;
  for (const s of spots) {
    const z = standZ(b, s.x, s.y, size);
    if (z < 0) continue;
    at = { x: s.x, y: s.y, z };
    break;
  }
  if (!at) return null;
  // trained soldiers fight with their trained stats
  const u = createUnit(b, trainedRecruit(r, m), m.armor, seat, at, directionTo(at, { x: b.sx / 2, y: b.sy / 2, z: 0 }));
  if (u.hasInventory) {
    const innate = r.kind === "alien" ? livingWeaponFor(unitRule(r.type)) : null;
    const placed: PlacedItem[] = innate ? [{ type: innate, slot: "STR_RIGHT_HAND", x: 0, y: 0 }] : [];
    for (const it of m.items) {
      // only items that really fit are carried (the loadout check already rejects the rest)
      if (it.slot === "STR_GROUND" || !fitsSlot(placed, it.type, it.slot, it.x, it.y)) continue;
      if (it.ammo && !itemRule(it.type).compatibleAmmo.includes(it.ammo)) continue;
      placed.push(it);
      giveItem(b, u, it.type, it.slot, it.x, it.y, it.ammo);
    }
  }
  return u;
}

/** Deploys members grouped by where they go (big units first, so they find room). */
export function deployAll(b: Battle, seat: number, entries: { r: Recruit; m: SquadMember }[]): { unit: Unit; m: SquadMember }[] {
  const out: { unit: Unit; m: SquadMember }[] = [];
  const spotsBy = new Map<string, Pos[]>();
  const sorted = [...entries].sort((a, c) => sizeOf(c.r) - sizeOf(a.r));
  for (const { r, m } of sorted) {
    const key = `${m.deploy ?? "edge"}:${m.zone ?? ""}`;
    let spots = spotsBy.get(key);
    if (!spots) spotsBy.set(key, (spots = deploySpots(b, seat, m.deploy, m.zone)));
    // scattered units each take the next random spot rather than crowding the first one
    const u = deployMember(b, r, m, seat, spots);
    if (m.deploy === "spread" && u) spotsBy.set(key, spots.filter((p) => Math.max(Math.abs(p.x - u.pos.x), Math.abs(p.y - u.pos.y)) >= 4));
    if (u) out.push({ unit: u, m });
  }
  return out;
}
