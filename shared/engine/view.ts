// What each player is allowed to know, and incremental updates of it.
// Server: extractView/diff. Client: applyView onto its own Battle copy.
import { Battle, TerrainLib, type Unit, type Item, type FileSource, isOut, type Phase, type PlayerState } from "./state.ts";
import { isUnitVisibleTo, recalcAllLighting, canSeeTile } from "./tileengine.ts";
import type { MatchSettings } from "../protocol.ts";
import type { Pos } from "./defs.ts";

export interface ItemView {
  id: number;
  type: string;
  slot: string | null;
  sx: number;
  sy: number;
  tile: number;
  ammoType?: string;
  ammoQty?: number;
  selfPowered?: boolean;
  fuse?: number;
  unitId?: number;
  uses?: number[];
}

export interface UnitView extends Partial<Unit> {
  id: number;
  mine: boolean;
  items?: ItemView[];
}

export interface SupplyView {
  id: number;
  pos: Pos;
  dropRound: number;
  dropped: boolean;
  /** a landed drop that still has something in it (public, like the drop itself), and where it lies */
  stocked?: boolean;
  at?: Pos;
}

export interface PlayerView {
  full: boolean;
  you: number;
  round: number;
  current: number;
  phase: Phase;
  winner: number;
  players: PlayerState[];
  settings?: MatchSettings;
  globalShade: number;
  terrainName?: string;
  datasets?: string[];
  size?: [number, number, number];
  /** [tile, p0, p1, p2, p3, fire, smoke, doorOpen, discovered] */
  tiles: number[][];
  units: UnitView[];
  /** [tile, items] for discovered tiles whose ground items changed */
  ground: [number, ItemView[]][];
  supply: SupplyView[];
}

/** Server-side memory of what was last sent to a player, for diffing. */
export interface SentState {
  tiles: Map<number, string>;
  ground: Map<number, string>;
}

export function newSentState(): SentState {
  return { tiles: new Map(), ground: new Map() };
}

function itemView(b: Battle, it: Item, own: boolean): ItemView {
  const v: ItemView = { id: it.id, type: it.type, slot: it.slot, sx: it.sx, sy: it.sy, tile: it.tile };
  if (it.ammo === it.id) v.selfPowered = true;
  else if (it.ammo >= 0) {
    const a = b.item(it.ammo);
    if (a) {
      v.ammoType = a.type;
      v.ammoQty = a.ammoQty;
    }
  }
  if (it.ammoQty && !v.ammoType) v.ammoQty = it.ammoQty;
  if (own && it.fuse >= 0) v.fuse = it.fuse;
  if (!own && it.fuse >= 0) v.fuse = -2; // "primed" is visible, the timer isn't
  if (it.unitId >= 0) v.unitId = it.unitId;
  if (it.uses) v.uses = it.uses;
  return v;
}

const ENEMY_FIELDS: (keyof Unit)[] = [
  "id", "owner", "originalOwner", "type", "race", "name", "rank", "armor", "pos", "dir", "turretDir", "turretType", "kneeled", "floating",
  "status", "size", "baseHeights", "movementType", "gender", "look", "fire", "loftemps", "activeHand", "hwp", "deathSound", "moveSound",
];

const ALL_SEEN = new WeakMap<Battle, Uint8Array>();
/** A game master's "discovered" map: everything. */
function allSeen(b: Battle): Uint8Array {
  let a = ALL_SEEN.get(b);
  if (!a || a.length !== b.size) ALL_SEEN.set(b, (a = new Uint8Array(b.size).fill(7)));
  return a;
}

/** A tile as a player is sent it: [tile, p0, p1, p2, p3, fire, smoke, doorOpen, discovered]. */
function tileRow(b: Battle, i: number, d: number): number[] {
  return [i, b.parts[i * 4], b.parts[i * 4 + 1], b.parts[i * 4 + 2], b.parts[i * 4 + 3], b.fire[i], b.smoke[i], b.doorOpen[i], d];
}
function groundList(b: Battle, t: number): ItemView[] {
  return b.itemsOnTile(t).map((id) => itemView(b, b.item(id)!, false));
}

/**
 * The part of a player's memory (what they were last sent) that differs from the battle as it is: the ground and
 * terrain they last saw where it has changed out of their sight. Kept with the saved battle, it survives a server
 * restart (`restoreMemory`); without it a player reloading afterwards would lose what they'd seen.
 */
export interface SavedMemory {
  tiles: [number, string][];
  /** "" for ground last seen empty */
  ground: [number, string][];
}

export function saveMemory(b: Battle, player: number, sent: SentState): SavedMemory {
  const disc = b.discovered[player];
  const tiles: [number, string][] = [];
  for (const [i, key] of sent.tiles) if (disc[i] && key !== tileRow(b, i, disc[i]).join(",")) tiles.push([i, key]);
  const ground: [number, string][] = [];
  const groundTiles = new Set(sent.ground.keys());
  for (const it of b.items) if (it.tile >= 0) groundTiles.add(it.tile);
  for (const t of groundTiles) {
    if (!(disc[t] & 4)) continue;
    const list = groundList(b, t);
    const now = list.length ? JSON.stringify(list) : "";
    const seen = sent.ground.get(t) ?? "";
    if (seen !== now) ground.push([t, seen]);
  }
  return { tiles, ground };
}

/** A player's memory after a restart: what they've discovered as it is now, except where `saved` says otherwise. */
export function restoreMemory(b: Battle, player: number, saved: SavedMemory): SentState {
  const disc = b.discovered[player];
  const sent = newSentState();
  for (let i = 0; i < b.size; i++) if (disc[i]) sent.tiles.set(i, tileRow(b, i, disc[i]).join(","));
  for (const it of b.items) {
    if (it.tile < 0 || !(disc[it.tile] & 4) || sent.ground.has(it.tile)) continue;
    sent.ground.set(it.tile, JSON.stringify(groundList(b, it.tile)));
  }
  for (const [i, key] of saved.tiles) sent.tiles.set(i, key);
  for (const [t, key] of saved.ground) {
    if (key) sent.ground.set(t, key);
    else sent.ground.delete(t);
  }
  return sent;
}

/**
 * What `player` may know. `omniscient` is a co-op scenario's game master watching from that side: the whole
 * map and every unit (only ever sent to them).
 */
export function extractView(b: Battle, player: number, sent: SentState, full: boolean, omniscient = false): PlayerView {
  const disc = omniscient ? allSeen(b) : b.discovered[player];
  const sees = (t: number) => omniscient || canSeeTile(b, player, t);
  const tiles: number[][] = [];
  for (let i = 0; i < b.size; i++) {
    const d = disc[i];
    if (!d) continue;
    // the game master's whole map: open air needn't be sent (unless something there changed)
    if (omniscient && b.isVoid(i) && !b.fire[i] && !sent.tiles.has(i)) continue;
    const row = tileRow(b, i, d);
    const key = row.join(",");
    const prev = sent.tiles.get(i);
    if (prev !== undefined && prev !== key && !sees(i)) {
      // changed while out of sight: the player keeps the state they last saw
      if (full) tiles.push(prev.split(",").map(Number));
      continue;
    }
    if (full || prev !== key) {
      tiles.push(row);
      sent.tiles.set(i, key);
    }
  }
  const units: UnitView[] = [];
  for (const u of b.units) {
    if (u.status === 8) continue;
    const mine = u.owner === player;
    if (mine) {
      const items = b.items.filter((it) => it.owner === u.id).map((it) => itemView(b, it, true));
      units.push({ ...u, mine: true, items });
    } else if (!isOut(u) && (omniscient || isUnitVisibleTo(b, u, player))) {
      const v: UnitView = { id: u.id, mine: false };
      for (const f of ENEMY_FIELDS) (v as unknown as Record<string, unknown>)[f] = (u as unknown as Record<string, unknown>)[f];
      v.items = b.items.filter((it) => it.owner === u.id && (it.slot === "STR_RIGHT_HAND" || it.slot === "STR_LEFT_HAND")).map((it) => itemView(b, it, false));
      units.push(v);
    } else if (u.originalOwner === player && isOut(u)) {
      // your fallen are still listed (for the casualty roster)
      units.push({ id: u.id, mine: false, owner: u.owner, originalOwner: u.originalOwner, name: u.name, status: u.status, type: u.type, armor: u.armor, pos: { x: -1, y: -1, z: -1 }, size: u.size });
    }
  }
  const ground: [number, ItemView[]][] = [];
  const groundTiles = new Set<number>();
  for (const it of b.items) if (it.tile >= 0) groundTiles.add(it.tile);
  for (const t of sent.ground.keys()) groundTiles.add(t);
  for (const t of groundTiles) {
    if (!(disc[t] & 4)) continue;
    const list = groundList(b, t);
    const key = JSON.stringify(list);
    const prev = sent.ground.get(t);
    if (prev !== key && !sees(t)) {
      // items came or went out of sight: keep showing what was last seen
      if (full && prev !== undefined) ground.push([t, JSON.parse(prev)]);
      continue;
    }
    if (full || prev !== key) {
      ground.push([t, list]);
      if (list.length) sent.ground.set(t, key);
      else sent.ground.delete(t);
    }
  }
  const v: PlayerView = {
    full, you: player, round: b.round, current: b.current, phase: b.phase, winner: b.winner,
    players: b.players, globalShade: b.globalShade, tiles, units, ground,
    supply: b.supply.map((s) => ({ id: s.id, pos: s.pos, dropRound: s.dropRound, dropped: s.dropped, ...(s.dropped ? crateAt(b, s.pos) : {}) })),
  };
  if (full) {
    v.settings = b.settings;
    v.terrainName = b.terrainName;
    v.datasets = b.lib.datasetNames;
    v.size = [b.sx, b.sy, b.sz];
  }
  return v;
}

const UNIT_DEFAULTS: Partial<Unit> = {
  stats: { tu: 0, stamina: 0, health: 0, bravery: 0, reactions: 0, firing: 0, throwing: 0, strength: 0, psiStrength: 0, psiSkill: 0, melee: 0 },
  tu: 0, energy: 0, health: 1, stun: 0, morale: 100, armorNow: [0, 0, 0, 0, 0], armorMax: [0, 0, 0, 0, 0], wounds: [0, 0, 0, 0, 0, 0],
  specab: 0, spawnUnit: "", spawnOwner: -1, respawn: false, deathSound: [], moveSound: -1, energyRecovery: 0, woundable: false,
  nightVision: false, hasInventory: false, visibleUnits: [], spottedThisTurn: [], mindControllerId: -1, kills: 0, psiWeapon: false,
  hitByFire: false, motionPoints: 0, killedBy: -1, value: 0, recruitId: "", rankInt: 0, loftemps: [3], fire: 0, turretType: -1,
};

/** Client: builds (or updates) the local battle copy from a view. */
export function applyView(prev: Battle | null, v: PlayerView, files: FileSource): Battle {
  let b = prev;
  if (v.full || !b) {
    const lib = new TerrainLib(v.datasets!, files);
    b = new Battle(lib, v.settings!, 1);
    b.initMap(v.size![0], v.size![1], v.size![2], v.players.length);
    b.terrainName = v.terrainName ?? "";
  }
  b.round = v.round;
  b.current = v.current;
  b.phase = v.phase;
  b.winner = v.winner;
  b.players = v.players;
  // squads can join the battle in progress
  b.growSides(v.players.length);
  b.globalShade = v.globalShade;
  const disc = b.discovered[v.you];
  for (const row of v.tiles) {
    const i = row[0];
    b.parts[i * 4] = row[1];
    b.parts[i * 4 + 1] = row[2];
    b.parts[i * 4 + 2] = row[3];
    b.parts[i * 4 + 3] = row[4];
    b.fire[i] = row[5];
    b.smoke[i] = row[6];
    b.doorOpen[i] = row[7];
    disc[i] = row[8];
  }
  // items: own inventories come with units, ground items per tile
  const keep = new Map<number, Item>();
  for (const it of b.items) if (it.tile >= 0) keep.set(it.id, it);
  const groundUpdated = new Set(v.ground.map(([t]) => t));
  const items: Item[] = [];
  for (const it of keep.values()) {
    if (groundUpdated.has(it.tile)) continue;
    items.push(it);
    // a loaded weapon lying on an unchanged tile keeps its (client-side) clip
    if (it.ammo >= 0 && it.ammo !== it.id) {
      const clip = b.item(it.ammo);
      if (clip) items.push(clip);
    }
  }
  const toItem = (iv: ItemView, owner: number): Item[] => {
    const it: Item = { id: iv.id, type: iv.type, owner, slot: iv.slot as never, sx: iv.sx, sy: iv.sy, tile: iv.tile, ammo: -1, ammoQty: iv.ammoQty ?? 0, fuse: iv.fuse ?? -1, unitId: iv.unitId ?? -1, previousOwner: -1, uses: iv.uses };
    const out = [it];
    if (iv.selfPowered) it.ammo = it.id;
    else if (iv.ammoType) {
      const clipId = 1_000_000_000 + iv.id; // synthetic (client-only) id for the loaded clip
      it.ammo = clipId;
      it.ammoQty = 0;
      out.push({ id: clipId, type: iv.ammoType, owner: -2, slot: null, sx: 0, sy: 0, tile: -1, ammo: -1, ammoQty: iv.ammoQty ?? 0, fuse: -1, unitId: -1, previousOwner: -1 });
    }
    return out;
  };
  for (const [, list] of v.ground) for (const iv of list) items.push(...toItem(iv, -1));
  const units: Unit[] = [];
  for (const uv of v.units) {
    const u = { ...UNIT_DEFAULTS, ...uv } as unknown as Unit & { mine?: boolean; items?: ItemView[] };
    for (const iv of uv.items ?? []) items.push(...toItem(iv, u.id));
    delete u.items;
    units.push(u);
  }
  b.units = units;
  b.items = items;
  b.supply = v.supply.map((s) => ({ ...s, announcedRound: 0, items: [] }));
  b.rebuildUnitIndex();
  b.rebuildItemIndex();
  recalcAllLighting(b);
  return b;
}

/** The tile a landed drop's items ended up on (they fall through floorless tiles), if anything is left. */
function crateAt(b: Battle, pos: Pos): { stocked: boolean; at?: Pos } {
  for (let z = pos.z; z >= 0; z--) {
    const t = b.idx(pos.x, pos.y, z);
    if (t < 0) break;
    if (b.itemsOnTile(t).some((id) => (b.item(id)?.unitId ?? -1) < 0)) return { stocked: true, at: { x: pos.x, y: pos.y, z } };
    if (!b.noFloorAt(t)) break;
  }
  return { stocked: false };
}
