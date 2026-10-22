// Event recording: the server resolves an action completely and records what happened,
// tagging each event with the set of players allowed to see it (fog of war).
import type { Pos } from "./defs.ts";
import type { Battle, Unit } from "./state.ts";
import { isUnitVisibleTo, canSeeTile } from "./tileengine.ts";
import { recordDamage } from "./stats.ts";

export type BattleEvent =
  | { t: "move"; unit: number; from: Pos; to: Pos; dir: number; fly: boolean; app: UnitAppearance }
  | { t: "fall"; unit: number; from: Pos; to: Pos }
  | { t: "turn"; unit: number; dir: number; turret?: number }
  | { t: "kneel"; unit: number; kneeled: boolean }
  | { t: "door"; tile: number; ufo: boolean }
  | { t: "aim"; unit: number; aiming: boolean }
  | { t: "shot"; unit: number; weapon: string; bullet: number; sound: number; path: Pos[]; impact: number }
  | { t: "throw"; unit: number; item: string; path: Pos[] }
  | { t: "hit"; at: Pos; anim: number; sound: number }
  | { t: "explosion"; at: Pos; power: number; frame: number; small: boolean }
  | { t: "damage"; unit: number; amount: number; type: number }
  | { t: "collapse"; unit: number; dead: boolean }
  | { t: "melee"; unit: number; at: Pos; sound: number; hit: boolean }
  | { t: "psi"; unit: number; target: number; success: boolean; sound: number }
  | { t: "spawn"; unit: number }
  | { t: "msg"; text: string; arg?: string }
  | { t: "reaction"; unit: number; target: number }
  | { t: "supply"; pos: Pos; dropped: boolean; round: number }
  | { t: "terrain" };

/** Enough about a unit to draw it, for units that come into view mid-action. */
export interface UnitAppearance {
  owner: number; originalOwner: number; type: string; race: string; name: string; rank: string; armor: string; size: number;
  baseHeights: { stand: number; kneel: number; float: number }; movementType: number; gender: number; look: number;
  turretType: number; turretDir: number; kneeled: boolean; loftemps: number[]; hands: [string, string][];
}

export function appearance(b: Battle, u: Unit): UnitAppearance {
  return {
    owner: u.owner, originalOwner: u.originalOwner, type: u.type, race: u.race, name: u.name, rank: u.rank, armor: u.armor, size: u.size,
    baseHeights: u.baseHeights, movementType: u.movementType, gender: u.gender, look: u.look, turretType: u.turretType, turretDir: u.turretDir,
    kneeled: u.kneeled, loftemps: u.loftemps,
    hands: b.items.filter((it) => it.owner === u.id && (it.slot === "STR_RIGHT_HAND" || it.slot === "STR_LEFT_HAND")).map((it) => [it.slot!, it.type]),
  };
}

export interface Recorded {
  e: BattleEvent;
  vis: number; // bitmask of players that may see it
}

export class BattleEvents {
  list: Recorded[] = [];
  changedTiles = new Set<number>();
  terrainChanged = false;
  itemsChanged = false;
  pendingDeathExplosions: number[] = [];
  /** where the last terrain-changing impact happened (limits FOV recalculation) */
  focus: Pos | null = null;
  /** units that fell this action (positions already applied) */
  fallen: { unit: number; to: Pos }[] = [];

  constructor(public b: Battle) {}

  all(): number {
    return (1 << this.b.players.length) - 1;
  }

  /** Players that currently see unit `u` (owners always do). */
  seers(u: Unit | undefined): number {
    if (!u) return 0;
    let m = 0;
    for (const p of this.b.players) if (isUnitVisibleTo(this.b, u, p.index)) m |= 1 << p.index;
    return m;
  }

  /** Players with a line of sight to the tile right now (they see explosions, hits, doors there). */
  tileSeers(tile: number): number {
    let m = 0;
    for (const p of this.b.players) if (canSeeTile(this.b, p.index, tile)) m |= 1 << p.index;
    return m;
  }

  push(e: BattleEvent, vis: number) {
    this.list.push({ e, vis });
  }

  damage(u: Unit, amount: number, type: number, attacker: Unit | null) {
    recordDamage(this.b, u, amount, attacker);
    this.push({ t: "damage", unit: u.id, amount, type }, this.seers(u));
  }
  tileChanged(t: number) {
    this.changedTiles.add(t);
  }
  door(tile: number, ufo: boolean) {
    this.push({ t: "door", tile, ufo }, this.tileSeers(tile));
  }
  unitFell(u: Unit, to: Pos) {
    this.push({ t: "fall", unit: u.id, from: { ...u.pos }, to: { ...to } }, this.seers(u));
    this.fallen.push({ unit: u.id, to });
  }
  msg(text: string, vis: number, arg?: string) {
    this.push({ t: "msg", text, arg }, vis);
  }
}
