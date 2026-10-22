// Battle state: the map, units and items. Plain data so it can be serialized and diffed.
import { type MapData, TilePart, parseMcd, parseLoftemps } from "../formats/terrain.ts";
import { type Pos, UnitStatus, DIR_UP } from "./defs.ts";
import { RNG } from "./rng.ts";
import type { Stats, SlotId } from "../rules/index.ts";
import type { MatchSettings, BotTuning } from "../protocol.ts";
import { newStats, type BattleStats } from "./stats.ts";

/** Supplies raw game files (server: from disk, client: from the asset cache). */
export type FileSource = (path: string) => Uint8Array;

export class TerrainLib {
  mapData: MapData[] = [];
  datasetNames: string[] = [];
  datasetStart: number[] = [];
  voxels: Uint16Array;

  constructor(datasetNames: string[], files: FileSource) {
    this.voxels = parseLoftemps(files("GEODATA/LOFTEMPS.DAT"));
    for (const name of datasetNames) this.addDataset(name, files);
  }

  addDataset(name: string, files: FileSource): number {
    const set = this.datasetNames.length;
    const start = this.mapData.length;
    const defs = parseMcd(files(`TERRAIN/${name}.MCD`), set);
    for (const d of defs) {
      // die/alt references are local to the dataset; 0 means "none" for die, "self" (unused) for alt
      d.dieMCD = d.dieMCD ? start + d.dieMCD : 0;
      d.altMCD = d.altMCD ? start + d.altMCD : 0;
    }
    this.datasetNames.push(name);
    this.datasetStart.push(start);
    this.mapData.push(...defs);
    return start;
  }

  get(id: number): MapData | null {
    return id >= 0 ? this.mapData[id] : null;
  }
}

export interface Unit {
  id: number;
  owner: number; // controlling player index
  originalOwner: number;
  type: string; // UnitRule type, or "SOLDIER"
  race: string;
  name: string;
  rank: string;
  rankInt: number;
  gender: number; // 0 male 1 female
  look: number;
  armor: string;
  stats: Stats;
  baseHeights: { stand: number; kneel: number; float: number };
  pos: Pos;
  dir: number;
  turretDir: number;
  turretType: number;
  tu: number;
  energy: number;
  health: number;
  stun: number;
  morale: number;
  kneeled: boolean;
  floating: boolean;
  status: UnitStatus;
  armorNow: number[]; // front, left, right, rear, under
  armorMax: number[];
  wounds: number[]; // head, torso, rarm, larm, rleg, lleg
  fire: number;
  loftemps: number[];
  movementType: number;
  size: number;
  specab: number;
  spawnUnit: string;
  spawnOwner: number; // who a zombie/spawned unit fights for (the infecting chryssalid's owner)
  respawn: boolean;
  deathSound: number[];
  moveSound: number;
  energyRecovery: number;
  woundable: boolean;
  nightVision: boolean;
  hasInventory: boolean;
  visibleUnits: number[];
  spottedThisTurn: number[];
  mindControllerId: number;
  kills: number;
  activeHand: "STR_RIGHT_HAND" | "STR_LEFT_HAND";
  psiWeapon: boolean; // innate alien psionics
  hitByFire: boolean;
  motionPoints: number;
  killedBy: number;
  value: number; // hire price, for scoring
  recruitId: string; // pool entry the unit was hired from ("spawn" for zombies etc.)
  hwp: boolean;
  /** co-op: user id of the squad member who commands this unit ("" or missing: anyone in the squad) */
  controller?: string;
}

export interface Item {
  id: number;
  type: string;
  owner: number; // unit id or -1
  slot: SlotId | null;
  sx: number;
  sy: number;
  tile: number; // tile index when on the ground, else -1
  ammo: number; // loaded clip item id (self id for built-in power), -1 none
  ammoQty: number; // rounds left for ammo items
  fuse: number; // -1 not primed
  unitId: number; // body item for an unconscious/dead unit
  previousOwner: number;
  uses?: number[]; // medikit charges: painkiller, heal, stimulant
}

export interface PlayerState {
  index: number;
  userId: string;
  name: string;
  eliminated: boolean;
  surrendered: boolean;
  endedTurnCount: number;
  /** the people sharing this squad, its leader (userId) first; missing for computer squads and old saves */
  members?: SquadMemberState[];
  /** a computer squad's AI settings */
  ai?: BotTuning;
}

export interface SquadMemberState {
  userId: string;
  name: string;
  /** done for this turn (cleared when the squad's next turn begins) */
  locked: boolean;
  /** asked the AI to play their units */
  afk: boolean;
  /** offline long enough that the AI plays their units (only with the co-op "afkAI" setting) */
  away: boolean;
}

export interface SupplyDrop {
  id: number;
  pos: Pos;
  dropRound: number;
  announcedRound: number;
  dropped: boolean;
  items: string[];
  /** client only (from the view): the landed crate still holds something, and where it lies */
  stocked?: boolean;
  at?: Pos;
}

export const enum Phase { DEPLOY = 0, PLAYING = 1, FINISHED = 2 }

export class Battle {
  lib: TerrainLib;
  sx = 0;
  sy = 0;
  sz = 0;
  parts!: Int16Array;
  fire!: Uint8Array;
  smoke!: Uint8Array;
  overlaps!: Uint8Array;
  explosive!: Uint8Array;
  explosiveType!: Uint8Array;
  doorOpen!: Uint8Array; // bit per part (ufo doors)
  light!: Uint8Array; // 3 layers per tile: ambient, static (terrain/fire/flares), units on fire
  personal: Uint8Array[] = []; // per player: light carried by that player's own units (only they benefit)
  discovered: Uint8Array[] = []; // per player, bits 0 west wall,1 north wall,2 tile
  unitAt!: Int32Array; // unit id + 1
  units: Unit[] = [];
  items: Item[] = [];
  players: PlayerState[] = [];
  nextItemId = 1;
  nextUnitId = 1;
  rng: RNG;
  round = 1;
  current = 0; // index into players
  phase: Phase = Phase.PLAYING;
  globalShade = 0;
  settings: MatchSettings;
  supply: SupplyDrop[] = [];
  winner = -1;
  terrainName = "";
  /** unit ids that are hit this turn (they may turn to face their attacker for reactions) */
  hitBy = new Map<number, Set<number>>();
  /** per-unit statistics for balance analysis (saved with the battle) */
  stats: BattleStats = newStats();
  /** the item doing the damage right now, for statistics (not saved) */
  actingWeapon = "";

  private itemsByTile = new Map<number, number[]>();
  private itemIndex = new Map<number, Item>();
  private unitIndex = new Map<number, Unit>();

  constructor(lib: TerrainLib, settings: MatchSettings, seed: number) {
    this.lib = lib;
    this.settings = settings;
    this.rng = new RNG(seed);
  }

  initMap(sx: number, sy: number, sz: number, playerCount: number) {
    this.sx = sx;
    this.sy = sy;
    this.sz = sz;
    const n = sx * sy * sz;
    this.parts = new Int16Array(n * 4).fill(-1);
    this.fire = new Uint8Array(n);
    this.smoke = new Uint8Array(n);
    this.overlaps = new Uint8Array(n);
    this.explosive = new Uint8Array(n);
    this.explosiveType = new Uint8Array(n);
    this.doorOpen = new Uint8Array(n);
    this.light = new Uint8Array(n * 3);
    this.unitAt = new Int32Array(n);
    this.discovered = Array.from({ length: playerCount }, () => new Uint8Array(n));
    this.personal = Array.from({ length: playerCount }, () => new Uint8Array(n));
  }

  get size(): number {
    return this.sx * this.sy * this.sz;
  }

  idx(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return -1;
    return (z * this.sy + y) * this.sx + x;
  }
  idxP(p: Pos): number {
    return this.idx(p.x, p.y, p.z);
  }
  posOf(i: number): Pos {
    const x = i % this.sx;
    const y = Math.floor(i / this.sx) % this.sy;
    const z = Math.floor(i / (this.sx * this.sy));
    return { x, y, z };
  }

  part(i: number, p: TilePart): MapData | null {
    if (i < 0) return null;
    const id = this.parts[i * 4 + p];
    return id >= 0 ? this.lib.mapData[id] : null;
  }
  setPart(i: number, p: TilePart, id: number) {
    this.parts[i * 4 + p] = id;
    if (p === TilePart.WESTWALL || p === TilePart.NORTHWALL) this.doorOpen[i] &= ~(1 << p);
  }

  isUfoDoorOpen(i: number, p: TilePart): boolean {
    if (i < 0) return false;
    const md = this.part(i, p);
    return !!md && md.ufoDoor && (this.doorOpen[i] & (1 << p)) !== 0;
  }

  /** Terrain level is 0..-24 (negative = raised floor). */
  terrainLevel(i: number): number {
    if (i < 0) return 0;
    let level = 0;
    const f = this.part(i, TilePart.FLOOR);
    if (f) level = f.terrainLevel;
    const o = this.part(i, TilePart.OBJECT);
    if (o) level = Math.min(o.terrainLevel, level);
    return level;
  }

  hasNoFloor(i: number, below: number): boolean {
    if (below >= 0 && this.terrainLevel(below) === -24) return false;
    const f = this.part(i, TilePart.FLOOR);
    return f ? f.noFloor : true;
  }
  /** Convenience: tile below looked up automatically. */
  noFloorAt(i: number): boolean {
    if (i < 0) return true;
    const below = i - this.sx * this.sy;
    return this.hasNoFloor(i, below >= 0 ? below : -1);
  }

  isVoid(i: number): boolean {
    const b = i * 4;
    return this.parts[b] < 0 && this.parts[b + 1] < 0 && this.parts[b + 2] < 0 && this.parts[b + 3] < 0 && this.smoke[i] === 0 && !this.itemsOnTile(i).length;
  }

  isBigWall(i: number): boolean {
    const o = this.part(i, TilePart.OBJECT);
    return !!o && o.bigWall !== 0;
  }

  tuCost(i: number, p: TilePart, movementType: number): number {
    const md = this.part(i, p);
    if (!md) return 0;
    if (md.ufoDoor && this.isUfoDoorOpen(i, p)) return 0;
    if (p === TilePart.OBJECT && md.bigWall >= 4) return 0;
    return movementType === 1 ? md.tuFly : movementType === 2 ? md.tuSlide : md.tuWalk;
  }

  /** 0 (bright) .. 15 (dark) as seen by `player` (whose own units carry light). */
  shade(i: number, player = -1): number {
    const b = i * 3;
    let l = Math.max(this.light[b], this.light[b + 1], this.light[b + 2]);
    const pl = player >= 0 ? this.personal[player] : undefined;
    if (pl && pl[i] > l) l = pl[i];
    return Math.max(0, 15 - l);
  }

  // ---- units ----
  addUnit(u: Unit) {
    this.units.push(u);
    this.unitIndex.set(u.id, u);
  }
  unit(id: number): Unit | undefined {
    return this.unitIndex.get(id);
  }
  unitOnTile(i: number): Unit | undefined {
    if (i < 0) return undefined;
    const v = this.unitAt[i];
    return v ? this.unitIndex.get(v - 1) : undefined;
  }
  placeUnit(u: Unit, p: Pos) {
    this.clearUnitTiles(u);
    u.pos = { ...p };
    if (u.status === UnitStatus.DEAD || u.status === UnitStatus.UNCONSCIOUS || u.status === UnitStatus.IGNORE_ME) return;
    for (let x = 0; x < u.size; x++)
      for (let y = 0; y < u.size; y++) {
        const i = this.idx(p.x + x, p.y + y, p.z);
        if (i >= 0) this.unitAt[i] = u.id + 1;
      }
  }
  clearUnitTiles(u: Unit) {
    for (let x = 0; x < u.size; x++)
      for (let y = 0; y < u.size; y++) {
        const i = this.idx(u.pos.x + x, u.pos.y + y, u.pos.z);
        if (i >= 0 && this.unitAt[i] === u.id + 1) this.unitAt[i] = 0;
      }
  }
  rebuildUnitIndex() {
    this.unitIndex.clear();
    this.unitAt.fill(0);
    for (const u of this.units) {
      this.unitIndex.set(u.id, u);
      if (!isOut(u)) this.placeUnit(u, u.pos);
    }
  }

  // ---- items ----
  item(id: number): Item | undefined {
    return this.itemIndex.get(id);
  }
  createItem(type: string, extra: Partial<Item> = {}): Item {
    const it: Item = { id: this.nextItemId++, type, owner: -1, slot: null, sx: 0, sy: 0, tile: -1, ammo: -1, ammoQty: 0, fuse: -1, unitId: -1, previousOwner: -1, ...extra };
    this.items.push(it);
    this.itemIndex.set(it.id, it);
    if (it.tile >= 0) this.tileAdd(it.tile, it.id);
    return it;
  }
  removeItem(it: Item) {
    if (it.tile >= 0) this.tileRemove(it.tile, it.id);
    const k = this.items.indexOf(it);
    if (k >= 0) this.items.splice(k, 1);
    this.itemIndex.delete(it.id);
    for (const o of this.items) if (o.ammo === it.id) o.ammo = -1;
    // a clip loaded into the weapon goes with it
    if (it.ammo >= 0 && it.ammo !== it.id) {
      const clip = this.itemIndex.get(it.ammo);
      if (clip && clip.owner === -2) this.removeItem(clip);
    }
  }
  itemsOnTile(i: number): number[] {
    return this.itemsByTile.get(i) ?? EMPTY;
  }
  unitItems(u: Unit): Item[] {
    return this.items.filter((it) => it.owner === u.id);
  }
  itemInSlot(u: Unit, slot: SlotId): Item | undefined {
    return this.items.find((it) => it.owner === u.id && it.slot === slot);
  }
  moveItemToTile(it: Item, tile: number) {
    if (it.tile >= 0) this.tileRemove(it.tile, it.id);
    it.owner = -1;
    it.slot = "STR_GROUND";
    it.tile = tile;
    if (tile >= 0) this.tileAdd(tile, it.id);
    this.syncBody(it);
  }
  /** An unconscious unit lies wherever its body item is. */
  syncBody(it: Item) {
    if (it.unitId < 0) return;
    const u = this.unit(it.unitId);
    if (!u || u.status === UnitStatus.STANDING) return;
    if (it.tile >= 0) u.pos = this.posOf(it.tile);
    else if (it.owner >= 0) {
      const carrier = this.unit(it.owner);
      if (carrier) u.pos = { ...carrier.pos };
    }
  }
  moveItemToUnit(it: Item, u: Unit, slot: SlotId, sx: number, sy: number) {
    if (it.tile >= 0) this.tileRemove(it.tile, it.id);
    it.tile = -1;
    it.owner = u.id;
    it.previousOwner = u.id;
    it.slot = slot;
    it.sx = sx;
    it.sy = sy;
    this.syncBody(it);
  }
  /** Detaches an item from everything (e.g. while in flight). */
  detachItem(it: Item) {
    if (it.tile >= 0) this.tileRemove(it.tile, it.id);
    it.tile = -1;
    if (it.owner >= 0) it.previousOwner = it.owner;
    it.owner = -1;
    it.slot = null;
  }
  private tileAdd(tile: number, id: number) {
    let l = this.itemsByTile.get(tile);
    if (!l) this.itemsByTile.set(tile, (l = []));
    l.push(id);
  }
  private tileRemove(tile: number, id: number) {
    const l = this.itemsByTile.get(tile);
    if (!l) return;
    const k = l.indexOf(id);
    if (k >= 0) l.splice(k, 1);
    if (!l.length) this.itemsByTile.delete(tile);
  }
  rebuildItemIndex() {
    this.itemIndex.clear();
    this.itemsByTile.clear();
    for (const it of this.items) {
      this.itemIndex.set(it.id, it);
      if (it.tile >= 0) this.tileAdd(it.tile, it.id);
    }
  }

  isEnemy(a: number, b: number): boolean {
    return a !== b;
  }
}

const EMPTY: number[] = [];

export function isOut(u: Unit): boolean {
  return u.status === UnitStatus.DEAD || u.status === UnitStatus.UNCONSCIOUS || u.status === UnitStatus.IGNORE_ME;
}
export function unitHeight(u: Unit): number {
  return u.kneeled ? u.baseHeights.kneel : u.baseHeights.stand;
}
export function floatHeight(u: Unit): number {
  return u.baseHeights.float;
}
export function isUpDown(dir: number) {
  return dir >= DIR_UP;
}
