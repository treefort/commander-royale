// Computer players: a port of OpenXcom's AIModule (patrol / ambush / combat / escape modes, psi,
// grenade and blaster-bomb logic) adapted to free-for-all. Bots act only through GameRules.apply,
// so they are held to exactly the same rules and fog of war checks as human players.
//
// Differences from OpenXcom, because our maps and rules differ:
// - Our generated maps carry no route nodes, so patrols head for random (preferably unexplored)
//   spots or a supply drop, ambush/grenade candidates come from the 11x11 search grid around the
//   unit, and "cover" means a see-through wall (window, fence) next to the tile, like faceWindow().
// - Morale is out, so psi is mind control only (no panic) and grenade "desperation" is injury only.
// - Bots reload, ready a weapon from the backpack and pick weapons up off the ground; the original
//   AI only does the last of these.
// - By default every unit gets the same "player" personality instead of its race's
//   intelligence/aggression, so a Sectoid isn't played worse than a Muton (see AIOptions).
import { type Battle, type Unit, type Item, isOut, unitHeight, floatHeight, Phase } from "./state.ts";
import { type Pos, VoxelType, DX, DY, DZ, DIR_UP, directionTo, tileDistance, posEq } from "./defs.ts";
import { TilePart } from "../formats/terrain.ts";
import { Pathfinder } from "./pathfinding.ts";
import {
  canTargetUnit, canTargetTile, calculateLine, originVoxel, sightOriginVoxel, validMeleeRange, validThrowRange, validateThrow,
  isUnitVisibleTo,
} from "./tileengine.ts";
import { actionTUs, mainHandWeapon, meleeWeapon, ammoOf, roundsLeft, unitCanAct, checkViewSector } from "./unitops.ts";
import { BattleType, DamageType, itemRule, armorRule, explosionRadius, UNITS, INVENTORY_COSTS, type SlotId } from "../rules/index.ts";
import { canStand } from "./mapgen.ts";
import { type GameRules, type Command, type Hand } from "./actions.ts";
import { RNG } from "./rng.ts";
import type { BotTuning } from "../protocol.ts";

export interface AIOptions {
  /** after this round every bot knows where all enemies are (OpenXcom's "cheat turn", default 20) */
  cheatTurn: number;
  /** OpenXcom difficulty coefficient, 0 (beginner) .. 4 (superhuman): makes explosives more attractive */
  difficulty: number;
  /** first round grenades / blaster bombs may be used */
  grenadeTurn: number;
  blasterTurn: number;
  /** use each race's own intelligence/aggression instead of a uniform player personality */
  personalities: boolean;
  intelligence: number;
  aggression: number;
  /**
   * playing for a person (AFK, offline, or the host's "AI plays this turn"): never ambushes or digs in while
   * nothing is in sight (the aliens' waiting game looks like the player just standing there), keeps moving on
   */
  standIn?: boolean;
}

export const DEFAULT_AI: AIOptions = {
  cheatTurn: 20, difficulty: 4, grenadeTurn: 3, blasterTurn: 3, personalities: false, intelligence: 4, aggression: 1,
};

/**
 * The AI standing in for a person's units: bold, always on the move, and no cheat turn (it plays with what the
 * squad has actually seen, like the person would).
 */
export const STAND_IN_AI: AIOptions = { ...DEFAULT_AI, aggression: 2, cheatTurn: 1_000_000, standIn: true };

/** A computer squad's lobby settings as AI options. */
export function aiOptionsFor(t: BotTuning | undefined): AIOptions {
  if (!t) return DEFAULT_AI;
  return { ...DEFAULT_AI, aggression: t.aggression, intelligence: t.intelligence, difficulty: t.difficulty, cheatTurn: t.cheatTurn, personalities: t.personalities };
}

const enum Mode { PATROL = 0, AMBUSH = 1, COMBAT = 2, ESCAPE = 3 }

type Act =
  | { type: "rethink" }
  | { type: "none" }
  | { type: "walk"; target: Pos; facing?: number; final?: boolean; hide?: boolean; reserve?: number }
  | { type: "snap" | "aimed" | "auto"; target: Pos }
  | { type: "hit"; target: Pos }
  | { type: "throw"; target: Pos; item: Item }
  | { type: "launch"; waypoints: Pos[] }
  | { type: "psi"; target: Pos; hand: Hand | "innate" }
  | { type: "load"; weapon: Item; ammo: Item }
  | { type: "ready"; item: Item; hand: Hand }
  | { type: "drop"; item: Item };

interface Brain {
  mode: Mode;
  patrol: Pos | null;
  charging: number; // unit id we're charging at with a melee weapon, -1 none
  didPsi: boolean;
  escapeTUs: number;
  ambushTUs: number;
}

/** OpenXcom's 11x11 tile search grid around a unit. */
const TILE_SEARCH: Pos[] = Array.from({ length: 121 }, (_, i) => ({ x: (i % 11) - 5, y: Math.floor(i / 11) - 5, z: 0 }));

const HANDS: Hand[] = ["STR_RIGHT_HAND", "STR_LEFT_HAND"];

export class AIPlayer {
  private brains = new Map<number, Brain>();
  /** enemy unit id -> round it was last seen by any of our units */
  private lastSeen = new Map<number, number>();
  rng: RNG;
  flaresThisTurn = 0;
  /** where each enemy could walk within a few turns, by "id:tile" (cleared every turn) */
  enemyReach = new Map<string, Reach>();

  /** Tiles `e` can walk to within about three turns of movement. */
  reachOf(e: Unit): Reach {
    const key = `${e.id}:${this.b.idxP(e.pos)}`;
    let r = this.enemyReach.get(key);
    if (!r) this.enemyReach.set(key, (r = reachFrom(this.b, e, e.stats.tu * 3, false)));
    return r;
  }

  constructor(public b: Battle, public player: number, public opts: AIOptions = DEFAULT_AI, seed = 1) {
    this.rng = new RNG(seed * 7919 + player);
  }

  /** Notes which enemies are in sight right now; call after every action, by anyone. */
  observe() {
    const b = this.b;
    for (const u of b.units) if (u.owner !== this.player && !isOut(u) && isUnitVisibleTo(b, u, this.player)) this.lastSeen.set(u.id, b.round);
  }

  /** Late in the game (or nearly beaten) the AI knows where everyone is, so matches end. */
  cheating(): boolean {
    const b = this.b;
    if (b.round > this.opts.cheatTurn) return true;
    const mine = b.units.filter((u) => u.owner === this.player && !isOut(u)).length;
    return b.round > this.opts.cheatTurn / 2 && mine <= 2;
  }

  knows(e: Unit, intelligence: number): boolean {
    if (this.cheating()) return true;
    const r = this.lastSeen.get(e.id);
    return r !== undefined && this.b.round - r <= intelligence;
  }

  brain(u: Unit): Brain {
    let br = this.brains.get(u.id);
    if (!br) this.brains.set(u.id, (br = { mode: Mode.PATROL, patrol: null, charging: -1, didPsi: false, escapeTUs: 0, ambushTUs: 0 }));
    return br;
  }

  intelligence(u: Unit): number {
    if (!this.opts.personalities) return this.opts.intelligence;
    return u.type === "SOLDIER" ? 2 : UNITS.get(u.type)?.intelligence ?? 2;
  }
  aggression(u: Unit): number {
    if (!this.opts.personalities) return this.opts.aggression;
    return u.type === "SOLDIER" ? 1 : UNITS.get(u.type)?.aggression ?? 1;
  }

  /** Plays the whole turn (every unit, two passes like OpenXcom) and ends it. */
  playTurn(rules: GameRules) {
    for (const _ of this.turnSteps(rules));
  }

  /**
   * The same turn, one action at a time (the server paces bot turns so people can watch). With `only`, just
   * those units are played and the turn is left running (the AI standing in for AFK co-op players).
   */
  *turnSteps(rules: Pick<GameRules, "apply">, only?: (u: Unit) => boolean): Generator<void> {
    const b = this.b;
    if (b.phase !== Phase.PLAYING || b.current !== this.player) return;
    this.observe();
    this.flaresThisTurn = 0;
    this.enemyReach.clear();
    for (const br of this.brains.values()) {
      br.escapeTUs = 0;
      br.ambushTUs = 0;
    }
    const done = new Set<number>();
    const stillOurs = () => b.phase === Phase.PLAYING && b.current === this.player;
    for (let pass = 0; pass < 2 && stillOurs(); pass++) {
      const units = b.units.filter((u) => u.owner === this.player && !isOut(u) && (!only || only(u))).sort((a, c) => a.id - c.id);
      for (const u of units) {
        let counter = 0;
        for (let guard = 0; guard < 10 && counter < 2 && !done.has(u.id); guard++) {
          if (!stillOurs() || isOut(u) || u.owner !== this.player || !unitCanAct(u) || (only && !only(u))) break;
          if (u.tu <= 5) {
            done.add(u.id);
            break;
          }
          let t = new Thinker(this, u, counter + 1);
          let act = t.think();
          if (act.type === "rethink") {
            t = new Thinker(this, u, t.number);
            act = t.think();
          }
          if (act.type === "rethink" || act.type === "none") break;
          const ok = this.execute(rules, u, act);
          this.observe();
          yield;
          if (!ok) {
            done.add(u.id);
            break;
          }
          counter = t.number;
          if (act.type === "walk" && act.final) done.add(u.id);
        }
      }
    }
    if (stillOurs() && !only) rules.apply(this.player, { c: "endturn" });
  }

  private apply(rules: Pick<GameRules, "apply">, cmd: Command): boolean {
    return rules.apply(this.player, cmd).ok;
  }

  private execute(rules: Pick<GameRules, "apply">, u: Unit, act: Act): boolean {
    const b = this.b;
    switch (act.type) {
      case "walk": {
        if (posEq(u.pos, act.target)) {
          // already in place: just face the right way
          if (act.facing === undefined || act.facing === u.dir) return false;
          return this.apply(rules, { c: "turn", unit: u.id, to: { x: u.pos.x + DX[act.facing], y: u.pos.y + DY[act.facing], z: u.pos.z } });
        }
        const to = walkTarget(b, u, act.target, act.reserve ?? 0);
        if (!to) return false;
        const from = { ...u.pos };
        const tu = u.tu;
        rules.apply(this.player, { c: "move", unit: u.id, to });
        if (isOut(u) || u.owner !== this.player) return true;
        let facing = act.facing;
        if (act.hide) {
          // spin round at the end of the retreat to face the danger
          const e = new Thinker(this, u, 1).closestKnownEnemy();
          if (e) facing = directionTo(u.pos, e.pos);
        }
        if (facing !== undefined && facing !== u.dir && u.tu > 0) {
          this.apply(rules, { c: "turn", unit: u.id, to: { x: u.pos.x + DX[facing], y: u.pos.y + DY[facing], z: u.pos.z } });
        }
        return !posEq(from, u.pos) || u.tu !== tu;
      }
      case "snap": case "aimed": case "auto": {
        const w = mainHandWeapon(b, u, false);
        if (!w) return false;
        return this.apply(rules, { c: "shoot", unit: u.id, hand: w.slot as Hand, mode: act.type, target: act.target });
      }
      case "hit": {
        const w = meleeWeapon(b, u);
        return this.apply(rules, { c: "melee", unit: u.id, hand: (w?.slot as Hand) ?? "STR_RIGHT_HAND", target: act.target });
      }
      case "launch": {
        const w = mainHandWeapon(b, u, false);
        if (!w) return false;
        return this.apply(rules, { c: "launch", unit: u.id, hand: w.slot as Hand, waypoints: act.waypoints });
      }
      case "psi":
        return this.apply(rules, { c: "psi", unit: u.id, hand: act.hand, target: act.target });
      case "throw": {
        const it = act.item;
        let hand = HANDS.find((h) => it.slot === h);
        if (!hand) {
          hand = HANDS.find((h) => !b.itemInSlot(u, h));
          if (!hand || !this.apply(rules, { c: "inv", unit: u.id, item: it.id, slot: hand, x: 0, y: 0 })) return false;
        }
        const bt = itemRule(it.type).battleType;
        if ((bt === BattleType.GRENADE || bt === BattleType.PROXIMITYGRENADE) && it.fuse < 0 && !this.apply(rules, { c: "prime", unit: u.id, hand, fuse: 0 })) return false;
        return this.apply(rules, { c: "throw", unit: u.id, hand, target: act.target });
      }
      case "load":
        return this.apply(rules, { c: "load", unit: u.id, weapon: act.weapon.id, ammo: act.ammo.id });
      case "ready":
        return this.apply(rules, { c: "inv", unit: u.id, item: act.item.id, slot: act.hand, x: 0, y: 0 });
      case "drop":
        return this.apply(rules, { c: "inv", unit: u.id, item: act.item.id, slot: "STR_GROUND", x: 0, y: 0 });
    }
    return false;
  }
}

/** How far along the path to `target` we get keeping `reserve` TUs (and the energy) for later; null if not a step. */
function walkTarget(b: Battle, u: Unit, target: Pos, reserve: number): Pos | null {
  if (posEq(u.pos, target)) return null;
  const pf = new Pathfinder(b, u);
  const path = pf.calculate(target);
  if (!path || !path.length) return null;
  const budget = u.tu - Math.max(0, reserve);
  let p = { ...u.pos };
  let tu = 0, energy = 0;
  let last: Pos | null = null;
  for (const d of path) {
    const { cost, dest } = pf.tuCost(p, d);
    if (cost >= 255) break;
    tu += cost;
    if (d < DIR_UP) energy += Math.floor(cost / 2);
    if (tu > budget || energy > u.energy) break;
    p = dest;
    last = dest;
  }
  return last;
}

interface Reach {
  cost: Map<number, number>;
  prev: Map<number, number>;
}

/** Cheapest TU cost to every tile the unit can reach with `maxTU` (Pathfinding::findReachable). */
function findReachable(b: Battle, u: Unit, maxTU: number): Map<number, number> {
  return reachFrom(b, u, maxTU, true).cost;
}

function reachFrom(b: Battle, u: Unit, maxTU: number, useEnergy: boolean): Reach {
  const pf = new Pathfinder(b, u);
  const cost = new Map<number, number>();
  const prev = new Map<number, number>();
  const energy = new Map<number, number>();
  const start = b.idxP(u.pos);
  cost.set(start, 0);
  energy.set(start, 0);
  const heap: [number, number][] = [[0, start]];
  const done = new Set<number>();
  while (heap.length) {
    const [c, t] = heapPop(heap);
    if (done.has(t)) continue;
    done.add(t);
    const p = b.posOf(t);
    for (let d = 0; d < 10; d++) {
      const { cost: step, dest } = pf.tuCost(p, d);
      if (step >= 255) continue;
      const nt = b.idxP(dest);
      if (nt < 0 || done.has(nt)) continue;
      const total = c + step;
      const en = energy.get(t)! + (d < DIR_UP ? Math.floor(step / 2) : 0);
      if (total > maxTU || (useEnergy && en > u.energy)) continue;
      if (total < (cost.get(nt) ?? Infinity)) {
        cost.set(nt, total);
        prev.set(nt, t);
        energy.set(nt, en);
        heapPush(heap, [total, nt]);
      }
    }
  }
  return { cost, prev };
}

function heapPush(h: [number, number][], v: [number, number]) {
  h.push(v);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] <= h[i][0]) break;
    [h[p], h[i]] = [h[i], h[p]];
    i = p;
  }
}
function heapPop(h: [number, number][]): [number, number] {
  const top = h[0];
  const last = h.pop()!;
  if (h.length) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < h.length && h[l][0] < h[m][0]) m = l;
      if (r < h.length && h[r][0] < h[m][0]) m = r;
      if (m === i) break;
      [h[m], h[i]] = [h[i], h[m]];
      i = m;
    }
  }
  return top;
}

/** One decision for one unit (AIModule::think and friends). */
export class Thinker {
  b: Battle;
  br: Brain;
  rng: RNG;
  intelligence: number;
  aggression: number;
  weapon: Item | null = null;
  aggro: Unit | null = null;
  knownEnemies = 0;
  visibleEnemies = 0;
  spottingEnemies = 0;
  closestDist = 100;
  melee = false;
  rifle = false;
  blaster = false;
  reachable = new Map<number, number>();
  reachableWithAttack = new Map<number, number>();
  dangerous = new Set<number>();

  attack: Act = { type: "rethink" };
  attackTarget: Pos | null = null;
  attackFacing: number | undefined;
  escape: Act = { type: "rethink" };
  ambush: Act = { type: "rethink" };
  patrolAct: Act = { type: "rethink" };
  psiAct: Act | null = null;

  constructor(public ai: AIPlayer, public u: Unit, public number: number) {
    this.b = ai.b;
    this.br = ai.brain(u);
    this.rng = ai.rng;
    this.intelligence = ai.intelligence(u);
    this.aggression = ai.aggression(u);
  }

  private tile(p: Pos) {
    return this.b.idxP(p);
  }

  /** Tiles a primed grenade lying on the ground is about to blow up (Tile::getDangerous). */
  private computeDanger() {
    const b = this.b;
    for (const it of b.items) {
      if (it.tile < 0 || it.fuse < 0) continue;
      const r = itemRule(it.type);
      if (r.battleType !== BattleType.GRENADE && r.battleType !== BattleType.PROXIMITYGRENADE) continue;
      const rad = explosionRadius(r);
      const c = b.posOf(it.tile);
      for (let x = -rad; x <= rad; x++)
        for (let y = -rad; y <= rad; y++) {
          const t = b.idx(c.x + x, c.y + y, c.z);
          if (t >= 0 && x * x + y * y <= rad * rad) this.dangerous.add(t);
        }
    }
  }

  private isDangerous(p: Pos) {
    return this.dangerous.has(this.tile(p));
  }

  // ------------------------------------------------------------------------------------------
  // the main loop
  // ------------------------------------------------------------------------------------------

  think(): Act {
    const b = this.b, u = this.u, br = this.br;
    this.computeDanger();
    const upkeep = this.upkeep();
    if (upkeep) return upkeep;
    this.weapon = mainHandWeapon(b, u, false);
    this.knownEnemies = this.countKnownTargets();
    this.visibleEnemies = this.selectNearestTarget();
    this.spottingEnemies = this.getSpottingUnits(u.pos);
    this.melee = meleeWeapon(b, u) !== null;
    this.rifle = false;
    this.blaster = false;
    this.reachable = findReachable(b, u, u.tu);
    this.reachableWithAttack = this.reachable;
    if (br.charging >= 0) {
      const c = b.unit(br.charging);
      if (!c || isOut(c)) br.charging = -1;
    }
    const w = this.weapon;
    if (w) {
      const r = itemRule(w.type);
      if (r.battleType === BattleType.FIREARM) {
        if (r.waypoints) {
          this.blaster = true;
          this.reachableWithAttack = this.within(u.tu - actionTUs(u, "aimed", r));
        } else {
          this.rifle = true;
          this.reachableWithAttack = this.within(u.tu - actionTUs(u, "snap", r));
        }
      } else if (r.battleType === BattleType.MELEE) {
        this.melee = true;
        this.reachableWithAttack = this.within(u.tu - actionTUs(u, "hit", r));
      }
    }

    if (this.spottingEnemies && !br.escapeTUs) this.setupEscape();
    if (this.knownEnemies && !this.melee && !br.ambushTUs) this.setupAmbush();
    this.setupAttack();
    this.setupPatrol();

    if (this.psiAct && !br.didPsi) {
      br.didPsi = true;
      this.number -= 1;
      return this.psiAct;
    }
    br.didPsi = false;

    let evaluate = false;
    switch (br.mode) {
      case Mode.PATROL: evaluate = !!(this.spottingEnemies || this.visibleEnemies || this.knownEnemies || this.rng.percent(10)); break;
      case Mode.AMBUSH: evaluate = !this.rifle || !br.ambushTUs || !!this.visibleEnemies; break;
      case Mode.COMBAT: evaluate = this.attack.type === "rethink"; break;
      case Mode.ESCAPE: evaluate = !this.spottingEnemies || !this.knownEnemies; break;
    }
    if (this.spottingEnemies > 2 || u.health < (2 * u.stats.health) / 3) evaluate = true;
    if (this.ai.cheating() && br.mode !== Mode.COMBAT) evaluate = true;
    if (evaluate) this.evaluateAIMode();

    let act: Act = { type: "rethink" };
    switch (br.mode) {
      case Mode.ESCAPE:
        br.charging = -1;
        act = this.escape.type === "walk" ? { ...this.escape, final: true, hide: true } : this.escape;
        break;
      case Mode.PATROL: {
        br.charging = -1;
        act = this.patrolAct;
        if (act.type === "walk" && w && itemRule(w.type).battleType === BattleType.FIREARM) {
          // keep enough time for a shot at whatever turns up
          const mode = this.aggression === 0 ? "aimed" : this.aggression === 1 ? "auto" : this.aggression === 2 ? "snap" : null;
          if (mode) act = { ...act, reserve: actionTUs(u, mode, itemRule(w.type)) };
        }
        break;
      }
      case Mode.COMBAT:
        act = this.attack;
        if (act.type === "walk") {
          act = { ...act, facing: this.attackFacing };
          if (this.rifle && w && u.tu > actionTUs(u, "snap", itemRule(w.type))) this.number -= 1;
        }
        break;
      case Mode.AMBUSH:
        br.charging = -1;
        act = this.ambush.type === "walk" ? { ...this.ambush, final: true } : this.ambush;
        break;
    }
    if (act.type === "walk") {
      if (!posEq(act.target, u.pos)) {
        br.escapeTUs = 0;
        br.ambushTUs = 0;
      } else if (act.facing !== undefined && act.facing !== u.dir) {
        // already in place: just face the right way
        return act;
      } else return this.idle();
    }
    if (act.type === "none" || act.type === "rethink") return this.idle(act);
    return act;
  }

  /**
   * Nothing to do where it is. An alien waits (ambush, hiding); standing in for a person, with nobody in sight,
   * it moves on instead: towards the enemy it knows about, or into unexplored ground.
   */
  private idle(otherwise: Act = { type: "none" }): Act {
    const p = this.patrolAct;
    if (!this.ai.opts.standIn || this.visibleEnemies || p.type !== "walk" || posEq(p.target, this.u.pos)) return otherwise;
    this.br.mode = Mode.PATROL;
    return p;
  }

  private within(tu: number): Map<number, number> {
    const m = new Map<number, number>();
    for (const [t, c] of this.reachable) if (c <= tu) m.set(t, c);
    return m;
  }

  // ------------------------------------------------------------------------------------------
  // weapon upkeep (not in OpenXcom, whose aliens never run dry or carry backpacks)
  // ------------------------------------------------------------------------------------------

  private upkeep(): Act | null {
    const b = this.b, u = this.u;
    if (!u.hasInventory) return null;
    const items = b.unitItems(u);
    const here = b.idxP(u.pos);
    const ground = b.itemsOnTile(here).map((id) => b.item(id)!).filter((it) => it && it.unitId < 0);
    const usable = (it: Item) => {
      const r = itemRule(it.type);
      if (r.battleType === BattleType.MELEE) return true;
      return r.battleType === BattleType.FIREARM && roundsLeft(b, it) > 0;
    };
    const clipFor = (w: Item, pool: Item[]) => {
      const r = itemRule(w.type);
      return pool.find((a) => a !== w && r.compatibleAmmo.includes(a.type) && a.ammoQty > 0 && itemRule(a.type).battleType === BattleType.AMMO);
    };
    const inHands = HANDS.map((h) => b.itemInSlot(u, h)).filter((x): x is Item => !!x);
    // reload an empty gun
    for (const w of inHands) {
      if (itemRule(w.type).battleType !== BattleType.FIREARM || w.ammo >= 0) continue;
      const a = clipFor(w, [...items, ...ground]);
      if (a && u.tu >= 15 + 8) return { type: "load", weapon: w, ammo: a };
    }
    const flare = this.flareAction(items);
    if (flare) return flare;
    if (inHands.some(usable)) return null;
    // ready a weapon from the backpack/belt, or one lying here
    const freeHand = HANDS.find((h) => !b.itemInSlot(u, h));
    const candidates = [...items.filter((it) => !HANDS.includes(it.slot as Hand)), ...ground].filter((it) => {
      const r = itemRule(it.type);
      if (r.fixedWeapon) return false;
      if (usable(it)) return true;
      return r.battleType === BattleType.FIREARM && !!clipFor(it, [...items, ...ground]);
    });
    if (candidates.length) {
      const best = candidates.sort((a, c) => itemRule(c.type).power - itemRule(a.type).power)[0];
      if (freeHand) {
        const from: SlotId = best.tile >= 0 ? "STR_GROUND" : (best.slot as SlotId);
        const cost = INVENTORY_COSTS[from]?.[freeHand] ?? 8;
        if (u.tu >= cost + 15) return { type: "ready", item: best, hand: freeHand };
        return null;
      }
      // both hands full of useless things: drop the empty gun
      const junk = inHands.find((it) => !usable(it) && !itemRule(it.type).fixedWeapon);
      if (junk && u.tu >= 2) return { type: "drop", item: junk };
      return null;
    }
    // unarmed: look for something on the ground nearby (BattlescapeGame::findItem)
    if (u.visibleUnits.some((id) => b.unit(id)?.owner !== u.owner)) return null;
    const reach = findReachable(b, u, u.tu);
    let best: Pos | null = null, bestCost = Infinity;
    for (const [t, c] of reach) {
      if (t === here || c >= bestCost) continue;
      const pile = b.itemsOnTile(t).map((id) => b.item(id)!).filter(Boolean);
      const want = pile.some((it) => {
        const r = itemRule(it.type);
        if (r.battleType === BattleType.MELEE && !r.fixedWeapon) return true;
        if (r.battleType !== BattleType.FIREARM) return false;
        return roundsLeft(b, it) > 0 || !!clipFor(it, [...items, ...pile]);
      });
      if (want && !this.isDangerous(b.posOf(t))) {
        best = b.posOf(t);
        bestCost = c;
      }
    }
    return best ? { type: "walk", target: best } : null;
  }

  /**
   * After dark, light the way: throw a flare into the gloom ahead when nothing is in sight yet.
   * (OpenXcom's aliens see in the dark and never need to; a human squad without flares is blind.)
   */
  private flareAction(items: Item[]): Act | null {
    const b = this.b, u = this.u;
    if (u.nightVision || b.globalShade < 5 || this.ai.flaresThisTurn >= 2) return null;
    const flare = items.find((it) => itemRule(it.type).battleType === BattleType.FLARE);
    if (!flare) return null;
    if (u.visibleUnits.some((id) => b.unit(id)?.owner !== u.owner)) return null;
    const hand = HANDS.find((h) => flare.slot === h) ?? HANDS.find((h) => !b.itemInSlot(u, h));
    if (!hand) return null;
    const cost = (flare.slot === hand ? 0 : INVENTORY_COSTS[flare.slot as SlotId]?.[hand] ?? 8) + actionTUs(u, "throw", itemRule(flare.type));
    // keep most of the turn for moving and shooting
    if (u.tu < cost + u.stats.tu / 2) return null;
    const goal = this.closestKnownEnemy()?.pos ?? this.br.patrol;
    const dir = goal && !posEq(goal, u.pos) ? directionTo(u.pos, goal) : u.dir;
    const r = itemRule(flare.type);
    for (const dist of [9, 7, 5]) {
      const p = { x: u.pos.x + DX[dir] * dist, y: u.pos.y + DY[dir] * dist, z: u.pos.z };
      const t = b.idxP(p);
      if (t < 0 || b.shade(t, this.ai.player) <= 9) continue;
      const origin = originVoxel(b, u, p, true);
      const tv = { x: p.x * 16 + 8, y: p.y * 16 + 8, z: p.z * 24 + 2 - b.terrainLevel(t) };
      if (!validThrowRange(b, u, r.weight, origin, p) || !validateThrow(b, u, r.weight, true, origin, tv, p)) continue;
      this.ai.flaresThisTurn++;
      return { type: "throw", target: p, item: flare };
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------
  // targets
  // ------------------------------------------------------------------------------------------

  /** AIModule::validTarget: alive, known to us, not about to be blown up, not ours. */
  validTarget(e: Unit, assessDanger: boolean): boolean {
    if (isOut(e) || e.owner === this.ai.player) return false;
    if (!this.ai.knows(e, this.intelligence)) return false;
    if (assessDanger && this.isDangerous(e.pos)) return false;
    return true;
  }

  private countKnownTargets(): number {
    let n = 0;
    for (const e of this.b.units) if (this.validTarget(e, true)) n++;
    return n;
  }

  /** Tile-level line of sight (what FOV uses); a cheap filter before the voxel traces. */
  private tileLOS(from: Pos, to: Pos): boolean {
    if (tileDistance(from, to) > 20) return false;
    return calculateLine(this.b, from, to, false, null, {}, false) <= 127;
  }

  private spotCache = new Map<number, number>();

  /** Enemies that could shoot at us if we stood at `pos`. */
  getSpottingUnits(pos: Pos): number {
    const b = this.b, u = this.u;
    const checking = !posEq(pos, u.pos);
    const t = b.idxP(pos);
    if (t < 0) return 0;
    const cached = this.spotCache.get(t);
    if (cached !== undefined) return cached;
    let tally = 0;
    const scan = { x: 0, y: 0, z: 0 };
    for (const e of b.units) {
      if (!this.validTarget(e, false)) continue;
      if (!this.tileLOS(e.pos, pos)) continue;
      const origin = sightOriginVoxel(b, e);
      origin.z -= 2;
      if (checking ? canTargetUnit(b, origin, t, scan, e, u) : canTargetUnit(b, origin, t, scan, e)) tally++;
    }
    this.spotCache.set(t, tally);
    return tally;
  }

  /** The nearest visible enemy we can actually attack; returns how many enemies we see. */
  private selectNearestTarget(): number {
    const b = this.b, u = this.u;
    let tally = 0;
    this.closestDist = 100;
    this.aggro = null;
    const scan = { x: 0, y: 0, z: 0 };
    for (const e of b.units) {
      if (!this.validTarget(e, true) || !u.visibleUnits.includes(e.id)) continue;
      tally++;
      const dist = tileDistance(u.pos, e.pos);
      if (dist >= this.closestDist) continue;
      let valid = false;
      if (this.rifle || !this.melee) {
        const origin = originVoxel(b, u, e.pos, false);
        valid = canTargetUnit(b, origin, b.idxP(e.pos), scan, u);
      } else if (this.selectPointNearTarget(e, u.tu)) {
        valid = !!validMeleeRange(b, u, this.attackTarget!, directionTo(this.attackTarget!, e.pos), e);
      }
      if (valid) {
        this.closestDist = dist;
        this.aggro = e;
      }
    }
    return this.aggro ? tally : 0;
  }

  closestKnownEnemy(): Unit | null {
    let best: Unit | null = null, min = 255;
    for (const e of this.b.units) {
      if (!this.validTarget(e, true)) continue;
      const d = tileDistance(e.pos, this.u.pos);
      if (d < min) {
        min = d;
        best = e;
      }
    }
    return best;
  }

  private selectClosestKnownEnemy(): boolean {
    this.aggro = this.closestKnownEnemy();
    return !!this.aggro;
  }

  private selectRandomTarget(): boolean {
    let farthest = -100;
    this.aggro = null;
    for (const e of this.b.units) {
      if (!this.validTarget(e, true)) continue;
      const d = this.rng.int(0, 20) - tileDistance(this.u.pos, e.pos);
      if (d > farthest) {
        farthest = d;
        this.aggro = e;
      }
    }
    return !!this.aggro;
  }

  /** Whether the unit would fit at `p` (SavedBattleGame::setUnitPosition test mode). */
  private fits(p: Pos): boolean {
    const b = this.b, u = this.u;
    for (let x = 0; x < u.size; x++)
      for (let y = 0; y < u.size; y++) {
        const t = b.idx(p.x + x, p.y + y, p.z);
        if (t < 0) return false;
        const o = b.unitOnTile(t);
        if (o && o !== u) return false;
      }
    return true;
  }

  /** A reachable tile next to `target` from which we can hit it in melee. */
  private selectPointNearTarget(target: Unit, maxTUs: number): boolean {
    const b = this.b, u = this.u;
    let found = false, best = Infinity;
    for (let z = -1; z <= 1; z++)
      for (let x = -u.size; x <= target.size; x++)
        for (let y = -u.size; y <= target.size; y++) {
          if (!x && !y) continue;
          const p = { x: target.pos.x + x, y: target.pos.y + y, z: target.pos.z + z };
          const t = b.idxP(p);
          const cost = t >= 0 ? this.reachable.get(t) : undefined;
          if (cost === undefined || cost > maxTUs) continue;
          if (!this.fits(p) || this.isDangerous(p)) continue;
          if (!validMeleeRange(b, u, p, directionTo(p, target.pos), target)) continue;
          if (cost < best) {
            best = cost;
            this.attackTarget = p;
            found = true;
          }
        }
    return found;
  }

  // ------------------------------------------------------------------------------------------
  // mode setup
  // ------------------------------------------------------------------------------------------

  /** Heads somewhere new: a supply drop, unexplored ground, or anywhere (scouting). */
  private setupPatrol() {
    const b = this.b, u = this.u, br = this.br;
    this.patrolAct = { type: "rethink" };
    if (br.patrol && posEq(u.pos, br.patrol)) br.patrol = null;
    if (br.patrol && this.isDangerous(br.patrol)) br.patrol = null;
    // a hunt goes stale once the prey has moved on
    const prey = this.closestKnownEnemy();
    if (br.patrol && prey && tileDistance(br.patrol, prey.pos) > 6 && this.rng.percent(50)) br.patrol = null;
    for (let tries = 5; !br.patrol && tries > 0; tries--) {
      const cand = this.patrolCandidate();
      if (!cand) continue;
      if (new Pathfinder(b, u).calculate(cand)) br.patrol = cand;
    }
    if (br.patrol) this.patrolAct = { type: "walk", target: br.patrol };
  }

  private patrolCandidate(): Pos | null {
    const b = this.b, u = this.u;
    const disc = b.discovered[this.ai.player];
    // hunt: close in on an enemy we know about (OpenXcom's aliens rely on wandering between route
    // nodes on small maps; without this, two careful squads can circle each other forever)
    const prey = this.closestKnownEnemy();
    if (prey && (this.ai.cheating() || this.rng.percent(60))) {
      for (let k = 0; k < 8; k++) {
        const x = prey.pos.x + this.rng.int(-3, 3), y = prey.pos.y + this.rng.int(-3, 3);
        if (x < 0 || y < 0 || x >= b.sx || y >= b.sy) continue;
        const z = this.standZ(x, y);
        if (z >= 0) return { x, y, z };
      }
    }
    // loot: a landed drop that still has something on it, or one about to land
    for (const d of b.supply) {
      if (this.rng.percent(35)) continue;
      const t = b.idxP(d.pos);
      if ((d.dropped && b.itemsOnTile(t).length) || (!d.dropped && d.dropRound - b.round <= 1)) {
        for (let k = 0; k < 8; k++) {
          const p = { x: d.pos.x + this.rng.int(-1, 1), y: d.pos.y + this.rng.int(-1, 1), z: 0 };
          const z = this.standZ(p.x, p.y);
          if (z >= 0) return { ...p, z };
        }
      }
    }
    let best: Pos | null = null, bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const x = this.rng.int(0, b.sx - u.size), y = this.rng.int(0, b.sy - u.size);
      const z = this.standZ(x, y);
      if (z < 0) continue;
      const p = { x, y, z };
      if (this.isDangerous(p) || b.fire[b.idxP(p)]) continue;
      // like a scout: push into ground we haven't seen yet, not too far in one go
      const score = (disc[b.idxP(p)] & 4 ? 0 : 25) - tileDistance(u.pos, p) * 0.5 + this.rng.int(0, 20);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  private standZ(x: number, y: number): number {
    const b = this.b, u = this.u;
    const zs: number[] = [];
    for (let z = 0; z < b.sz; z++) {
      const p = { x, y, z };
      if (posEq(p, u.pos) || canStand(b, p, u.size)) zs.push(z);
    }
    if (!zs.length) return -1;
    return zs.includes(u.pos.z) ? u.pos.z : this.rng.pick(zs);
  }

  /** The 11x11 grid around the unit, cheapest to reach first (random among equals). */
  private searchByCost(reach: Map<number, number>): { pos: Pos; t: number; tus: number }[] {
    const b = this.b, u = this.u;
    const out: { pos: Pos; t: number; tus: number }[] = [];
    for (const off of this.rng.shuffle([...TILE_SEARCH])) {
      const pos = { x: u.pos.x + off.x, y: u.pos.y + off.y, z: u.pos.z };
      const t = b.idxP(pos);
      const tus = t >= 0 ? reach.get(t) : undefined;
      if (tus !== undefined) out.push({ pos, t, tus });
    }
    return out.sort((a, c) => a.tus - c.tus);
  }

  /** A see-through wall next to the tile (window, fence): AIModule's ambush "cover". */
  private faceWindow(p: Pos): number {
    const b = this.b;
    const see = (t: number, part: TilePart) => {
      const md = b.part(t, part);
      return !!md && !md.stopLOS && md.tuWalk === 255;
    };
    if (see(b.idxP(p), TilePart.NORTHWALL)) return 0;
    if (see(b.idx(p.x + 1, p.y, p.z), TilePart.WESTWALL)) return 2;
    if (see(b.idx(p.x, p.y + 1, p.z), TilePart.NORTHWALL)) return 4;
    if (see(b.idxP(p), TilePart.WESTWALL)) return 6;
    return -1;
  }

  /** A nearby tile the enemy can't see but will walk into view of (AIModule::setupAmbush). */
  private setupAmbush() {
    const b = this.b, u = this.u, br = this.br;
    this.ambush = { type: "rethink" };
    br.ambushTUs = 0;
    if (!this.selectClosestKnownEnemy()) return;
    const target = this.aggro!;
    const BASE = 100, COVER_BONUS = 25, FAST_PASS = 80;
    const origin = sightOriginVoxel(b, target);
    let bestScore = 0;
    let bestPath: Pos[] = [];
    const scan = { x: 0, y: 0, z: 0 };
    for (const { pos, t, tus } of this.searchByCost(this.reachableWithAttack)) {
      if (this.isDangerous(pos)) continue;
      let score = BASE - tus;
      const cover = this.faceWindow(pos) !== -1;
      if (score + (cover ? COVER_BONUS : 0) <= bestScore) continue;
      // make sure we can't be seen here
      if ((this.tileLOS(target.pos, pos) && canTargetUnit(b, origin, t, scan, target, u)) || this.getSpottingUnits(pos)) continue;
      // and that the enemy can get here too (so they'll come into our sights); our own tile counts
      // as reachable when the enemy can get next to it
      const reach = this.ai.reachOf(target);
      let end = t;
      if (!reach.cost.has(t)) {
        if (!posEq(pos, u.pos)) continue;
        end = -1;
        for (let d = 0; d < 8 && end < 0; d++) {
          const n = b.idx(pos.x + DX[d], pos.y + DY[d], pos.z);
          if (n >= 0 && reach.cost.has(n)) end = n;
        }
        if (end < 0) continue;
      }
      if (cover) score += COVER_BONUS;
      if (score > bestScore) {
        bestScore = score;
        br.ambushTUs = posEq(pos, u.pos) ? 1 : tus;
        this.ambush = { type: "walk", target: pos };
        bestPath = [];
        for (let k = end; k !== undefined && k !== b.idxP(target.pos); k = reach.prev.get(k)!) bestPath.push(b.posOf(k));
        bestPath.reverse();
        if (bestScore > FAST_PASS) break;
      }
    }
    if (bestScore <= 0 || this.ambush.type !== "walk") return;
    // walk the enemy along its route and face where it first comes into our line of fire
    const at = this.ambush.target;
    const ov = { x: at.x * 16 + 8, y: at.y * 16 + 8, z: at.z * 24 + unitHeight(u) + floatHeight(u) - b.terrainLevel(b.idxP(at)) - 4 };
    let facing = directionTo(at, target.pos);
    for (const p of bestPath) {
      if (canTargetUnit(b, ov, b.idxP(p), scan, u, target)) {
        facing = directionTo(at, p);
        break;
      }
    }
    this.ambush = { ...this.ambush, facing };
  }

  /** Psi, blaster bomb, grenade, melee or gunfire — or moving to where we could shoot. */
  private setupAttack() {
    this.attack = { type: "rethink" };
    this.psiAct = null;
    if (this.knownEnemies) {
      if (this.psiAction()) return;
      if (this.blaster) this.wayPointAction();
    }
    if (this.selectNearestTarget()) {
      if (this.melee && this.rifle) this.selectMeleeOrRanged();
      if (this.grenadeFromInventory()) this.grenadeAction();
      if (this.melee) this.meleeAction();
      if (this.rifle) this.projectileAction();
    }
    if (this.attack.type !== "rethink") return;
    if (this.spottingEnemies || this.aggression < this.rng.int(0, 3)) this.findFirePoint();
  }

  /** Cover nearby, away from the enemy and out of their sight (AIModule::setupEscape). */
  private setupEscape() {
    const b = this.b, u = this.u, br = this.br;
    const unitsSpottingMe = this.spottingEnemies;
    const CURRENT_TILE_PREFERENCE = 15;
    const EXPOSURE_PENALTY = 10, FIRE_PENALTY = 40, BASE_SYSTEMATIC = 100, BASE_DESPERATE = 110, FAST_PASS = 100;
    const keep = this.aggro;
    this.selectNearestTarget();
    const threat = this.aggro;
    this.aggro = keep ?? threat;
    br.escapeTUs = 0;
    const dist = threat ? tileDistance(u.pos, threat.pos) : 0;
    let bestScore = -100000;
    let bestTile = { ...u.pos };
    const search = this.rng.shuffle([...TILE_SEARCH]);
    let found = false;
    for (let tries = -1; tries < 150 && !found; tries++) {
      let target = { ...u.pos };
      let score = 0;
      if (tries === -1) {
        // maybe just stay put rather than risk reaction fire
      } else if (tries < 121) {
        target.x += search[tries].x;
        target.y += search[tries].y;
        score = BASE_SYSTEMATIC;
        if (posEq(target, u.pos)) {
          if (unitsSpottingMe > 0) {
            target.x += this.rng.int(-20, 20);
            target.y += this.rng.int(-20, 20);
          } else score += CURRENT_TILE_PREFERENCE;
        }
      } else {
        score = BASE_DESPERATE; // ruuuuuuun
        target.x += this.rng.int(-10, 10);
        target.y += this.rng.int(-10, 10);
        target.z = Math.max(0, Math.min(b.sz - 1, u.pos.z + this.rng.int(-1, 1)));
      }
      const t = b.idxP(target);
      const fromThreat = threat ? tileDistance(threat.pos, target) : 0;
      score += (fromThreat - dist) * 10;
      if (t < 0) continue;
      const tus = posEq(target, u.pos) ? 1 : this.reachable.get(t);
      if (tus === undefined) continue;
      const spotters = this.getSpottingUnits(target);
      if (this.spottingEnemies || spotters) {
        if (this.spottingEnemies <= spotters) score -= (1 + spotters - this.spottingEnemies) * EXPOSURE_PENALTY;
        else score += (this.spottingEnemies - spotters) * EXPOSURE_PENALTY;
      }
      if (b.fire[t]) score -= FIRE_PENALTY;
      if (this.dangerous.has(t)) score -= BASE_SYSTEMATIC;
      if (score > bestScore) {
        bestScore = score;
        bestTile = target;
        br.escapeTUs = tus;
        if (bestScore > FAST_PASS) found = true;
      }
    }
    if (bestScore <= -100000) {
      this.escape = { type: "rethink" };
      return;
    }
    this.escape = { type: "walk", target: bestTile };
  }

  // ------------------------------------------------------------------------------------------
  // mode choice
  // ------------------------------------------------------------------------------------------

  private evaluateAIMode() {
    const u = this.u, br = this.br;
    if (br.charging >= 0 && this.attack.type !== "rethink") {
      br.mode = Mode.COMBAT;
      return;
    }
    let escapeOdds = this.melee ? 12 : 15;
    if (u.tu > u.stats.tu / 2 || br.charging >= 0) escapeOdds = 5;
    let ambushOdds = 12;
    let combatOdds = 20;
    let patrolOdds = this.visibleEnemies ? 15 : 30;
    if (this.spottingEnemies) {
      patrolOdds = 0;
      if (br.escapeTUs === 0) this.setupEscape();
    }
    if (!this.rifle || br.ambushTUs === 0) {
      ambushOdds = 0;
      if (this.melee) combatOdds *= 1.3;
    }
    if (this.knownEnemies) {
      if (this.knownEnemies === 1) combatOdds *= 1.2;
      if (br.escapeTUs === 0) {
        if (this.selectClosestKnownEnemy()) this.setupEscape();
        else escapeOdds = 0;
      }
    } else {
      combatOdds = 0;
      escapeOdds = 0;
    }
    switch (br.mode) {
      case Mode.PATROL: patrolOdds *= 1.1; break;
      case Mode.AMBUSH: ambushOdds *= 1.1; break;
      case Mode.COMBAT: combatOdds *= 1.1; break;
      case Mode.ESCAPE: escapeOdds *= 1.1; break;
    }
    if (u.health < u.stats.health / 3) {
      escapeOdds *= 1.7;
      combatOdds *= 0.6;
      ambushOdds *= 0.75;
    } else if (u.health < 2 * Math.floor(u.stats.health / 3)) {
      escapeOdds *= 1.4;
      combatOdds *= 0.8;
      ambushOdds *= 0.8;
    } else if (u.health < u.stats.health) {
      escapeOdds *= 1.1;
    }
    switch (this.aggression) {
      case 0: escapeOdds *= 1.4; combatOdds *= 0.7; break;
      case 1: ambushOdds *= 1.1; break;
      case 2: combatOdds *= 1.4; escapeOdds *= 0.7; break;
      default:
        combatOdds *= Math.max(0.1, Math.min(2, 1.2 + this.aggression / 10));
        escapeOdds *= Math.max(0.1, Math.min(2, 0.9 - this.aggression / 10));
    }
    if (br.mode === Mode.COMBAT) ambushOdds *= 1.5;
    if (this.spottingEnemies) {
      escapeOdds = (10 * escapeOdds * (this.spottingEnemies + 10)) / 100;
      combatOdds = (5 * combatOdds * (this.spottingEnemies + 20)) / 100;
    } else escapeOdds /= 2;
    if (this.visibleEnemies) {
      combatOdds = (10 * combatOdds * (this.visibleEnemies + 10)) / 100;
      if (this.closestDist < 5) ambushOdds = 0;
    }
    if (br.ambushTUs) ambushOdds *= 1.7;
    else ambushOdds = 0;
    // standing in for a person: no lying in wait while nobody is in sight
    if (this.ai.opts.standIn && !this.visibleEnemies) ambushOdds = 0;
    const canFight = this.melee || this.rifle || this.blaster || !!this.grenadeFromInventory() || this.psiCapable();
    if (!canFight) {
      combatOdds = 0;
      ambushOdds = 0;
    }
    escapeOdds = Math.floor(escapeOdds);
    ambushOdds = Math.floor(ambushOdds);
    combatOdds = Math.floor(combatOdds);
    patrolOdds = Math.floor(patrolOdds);
    const decision = this.rng.int(1, Math.max(1, patrolOdds + ambushOdds + escapeOdds + combatOdds));
    if (decision > escapeOdds) {
      if (decision > escapeOdds + ambushOdds) br.mode = decision > escapeOdds + ambushOdds + combatOdds ? Mode.PATROL : Mode.COMBAT;
      else br.mode = Mode.AMBUSH;
    } else br.mode = Mode.ESCAPE;
    if ((this.ai.cheating() && canFight) || br.charging >= 0) br.mode = Mode.COMBAT;

    // enforce the decision, falling back by priority
    if (br.mode === Mode.COMBAT) {
      const tgt = this.attackPos();
      if (tgt && this.b.unitOnTile(this.b.idxP(tgt))) {
        if (this.attack.type !== "rethink") return;
        if (this.findFirePoint()) return;
      } else if (this.selectRandomTarget() && this.findFirePoint()) return;
      br.mode = Mode.PATROL;
    }
    if (br.mode === Mode.PATROL) {
      if (br.patrol) return;
      br.mode = Mode.AMBUSH;
    }
    if (br.mode === Mode.AMBUSH) {
      if (br.ambushTUs) return;
      br.mode = Mode.ESCAPE;
    }
  }

  private attackPos(): Pos | null {
    const a = this.attack;
    if ("target" in a) return a.target;
    if (a.type === "launch") return a.waypoints[a.waypoints.length - 1];
    return null;
  }

  /** A tile in reach from which we'd have a line of fire on the nearest known enemy. */
  private findFirePoint(): boolean {
    const b = this.b, u = this.u;
    if (!this.selectClosestKnownEnemy()) return false;
    const target = this.aggro!;
    const BASE = 100, FAST_PASS = 125;
    let bestScore = 0;
    let best: Pos | null = null, facing = 0;
    const scan = { x: 0, y: 0, z: 0 };
    const tt = b.idxP(target.pos);
    for (const { pos, t, tus } of this.searchByCost(this.reachableWithAttack)) {
      const upper = BASE + u.tu - tus + 10;
      if (upper <= bestScore) break;
      if (!this.tileLOS(pos, target.pos)) continue;
      const origin = { x: pos.x * 16 + 8, y: pos.y * 16 + 8, z: pos.z * 24 + unitHeight(u) + floatHeight(u) - b.terrainLevel(t) - 4 };
      // pretend we stand there (our own body mustn't block the line)
      if (!canTargetUnit(b, origin, tt, scan, u)) continue;
      let score = BASE - this.getSpottingUnits(pos) * 10;
      score += u.tu - tus;
      if (!checkViewSector(target, pos)) score += 10;
      if (score > bestScore) {
        bestScore = score;
        best = pos;
        facing = directionTo(pos, target.pos);
        if (score > FAST_PASS) break;
      }
    }
    if (bestScore > 70 && best) {
      this.attack = { type: "walk", target: best };
      this.attackFacing = facing;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------------------------------
  // attacks
  // ------------------------------------------------------------------------------------------

  /** Whether an explosion at `targetPos` would hurt enough enemies and few enough friends. */
  private explosiveEfficacy(targetPos: Pos, radius: number, grenade: boolean): boolean {
    const b = this.b, u = this.u, opts = this.ai.opts;
    if (b.round < (grenade ? opts.grenadeTurn : opts.blasterTurn)) return false;
    const tt = b.idxP(targetPos);
    if (tt < 0) return false;
    // don't throw grenades at flying enemies
    if (grenade && targetPos.z > 0 && b.hasNoFloor(tt, b.idx(targetPos.x, targetPos.y, targetPos.z - 1))) return false;
    const distance = tileDistance(u.pos, targetPos);
    const injury = u.stats.health - u.health;
    let desperation = 0; // (100 - morale) / 10 in OpenXcom; there is no morale here
    if (injury > Math.floor(u.stats.health / 3) * 2) desperation += 3;
    let efficacy = desperation;
    // don't go kamikaze unless we're already doomed
    if (u.pos.z === targetPos.z && distance <= radius) efficacy -= 4;
    efficacy += Math.floor(opts.difficulty / 2);
    let affected = 0;
    const target = b.unitOnTile(tt);
    if (target && !this.dangerous.has(tt)) {
      affected++;
      efficacy++;
    }
    const a = { x: targetPos.x * 16 + 8, y: targetPos.y * 16 + 8, z: targetPos.z * 24 + 12 };
    for (const o of b.units) {
      if (isOut(o) || o === u || o === target || o.pos.z !== targetPos.z || tileDistance(o.pos, targetPos) > radius) continue;
      const enemy = o.owner !== this.ai.player;
      if (this.isDangerous(o.pos) || (enemy && !this.ai.knows(o, this.intelligence))) continue;
      const bv = { x: o.pos.x * 16 + 8, y: o.pos.y * 16 + 8, z: o.pos.z * 24 + 12 };
      const traj: Pos[] = [];
      const hit = calculateLine(b, a, bv, false, traj, { excludeUnit: target ?? null, excludeAllBut: o });
      if (hit === VoxelType.UNIT && traj.length && posEq({ x: traj[0].x >> 4, y: traj[0].y >> 4, z: Math.floor(traj[0].z / 24) }, o.pos)) {
        if (enemy) {
          affected++;
          efficacy++;
        } else efficacy -= 2; // friendlies count double
      }
    }
    // don't throw grenades at single targets unless things are dire
    if (grenade && desperation < 6 && affected < 2) return false;
    return efficacy > 0 || affected >= 10;
  }

  private meleeAction() {
    const b = this.b, u = this.u, br = this.br;
    const mw = meleeWeapon(b, u);
    if (!mw) return;
    const attackCost = actionTUs(u, "hit", itemRule(mw.type));
    if (u.tu < attackCost) return;
    if (this.aggro && !isOut(this.aggro) && validMeleeRange(b, u, u.pos, directionTo(u.pos, this.aggro.pos), this.aggro)) {
      this.meleeAttack();
      return;
    }
    const chargeReserve = u.tu - attackCost;
    let distance = Math.floor(chargeReserve / 4) + 1;
    this.aggro = null;
    for (const e of b.units) {
      const d = tileDistance(u.pos, e.pos);
      if (d > 20 || !this.validTarget(e, true)) continue;
      if (d < distance || d === 1) {
        if (d === 1 || this.selectPointNearTarget(e, chargeReserve)) {
          this.aggro = e;
          if (this.attackTarget) this.attack = { type: "walk", target: this.attackTarget };
          br.charging = e.id;
          distance = d;
        }
      }
    }
    if (this.aggro && validMeleeRange(b, u, u.pos, directionTo(u.pos, this.aggro.pos), this.aggro)) this.meleeAttack();
  }

  private meleeAttack() {
    this.attack = { type: "hit", target: { ...this.aggro!.pos } };
  }

  /** Blaster bomb: route it along a path to any known enemy (AIModule::wayPointAction). */
  private wayPointAction() {
    const b = this.b, u = this.u;
    const w = this.weapon;
    if (!w) return;
    const wr = itemRule(w.type);
    if (u.tu < actionTUs(u, "launch", wr)) return;
    const ammo = ammoOf(b, w);
    if (!ammo) return;
    const radius = Math.floor(itemRule(ammo.type).power / 20) + 1;
    let target: Unit | null = null;
    let path: number[] | null = null;
    for (const e of b.units) {
      if (!this.validTarget(e, true)) continue;
      const p = new Pathfinder(b, u, e).calculate(e.pos);
      if (p && p.length && this.explosiveEfficacy(e.pos, radius, false)) {
        target = e;
        path = p;
        break;
      }
    }
    if (!target || !path) return;
    const waypoints: Pos[] = [];
    let lastWaypoint = { ...u.pos }, last = { ...u.pos }, cur = { ...u.pos };
    for (const d of path) {
      if (waypoints.length >= wr.waypoints) break;
      last = cur;
      cur = { x: cur.x + DX[d], y: cur.y + DY[d], z: cur.z + DZ[d] };
      const a = { x: cur.x * 16 + 8, y: cur.y * 16 + 8, z: cur.z * 24 + 16 };
      const bv = { x: lastWaypoint.x * 16 + 8, y: lastWaypoint.y * 16 + 8, z: lastWaypoint.z * 24 + 16 };
      const hit = calculateLine(b, a, bv, false, null, { excludeUnit: u });
      if (hit > VoxelType.EMPTY && hit < VoxelType.UNIT) {
        waypoints.push(last);
        lastWaypoint = last;
      } else if (hit === VoxelType.UNIT && b.unitOnTile(b.idxP(cur)) === target) {
        waypoints.push(cur);
        lastWaypoint = cur;
      }
    }
    if (!waypoints.length || !posEq(lastWaypoint, target.pos)) return;
    this.aggro = target;
    this.attack = { type: "launch", waypoints };
  }

  private projectileAction() {
    const b = this.b;
    const w = this.weapon!;
    const ammo = ammoOf(b, w);
    if (!ammo) return;
    const ar = itemRule(ammo.type);
    const radius = ammo.id === w.id ? explosionRadius(itemRule(w.type)) : explosionRadius(ar);
    const explosive = ar.damageType === DamageType.HE || ar.damageType === DamageType.IN || ar.damageType === DamageType.STUN ? radius : 0;
    if (!explosive || this.explosiveEfficacy(this.aggro!.pos, explosive, false)) this.selectFireMethod();
  }

  /** Auto close up, aimed far away, snap otherwise (AIModule::selectFireMethod). */
  private selectFireMethod() {
    const u = this.u;
    const target = { ...this.aggro!.pos };
    const distance = tileDistance(u.pos, target);
    const r = itemRule(this.weapon!.type);
    const can = (m: "snap" | "aimed" | "auto") => {
      const has = m === "snap" ? r.tuSnap : m === "aimed" ? r.tuAimed : r.tuAuto;
      return !!has && u.tu >= actionTUs(u, m, r);
    };
    const pick = (m: "snap" | "aimed" | "auto") => (this.attack = { type: m, target });
    this.attack = { type: "rethink" };
    if (distance < 4) {
      if (can("auto")) return pick("auto");
      if (!can("snap")) {
        if (can("aimed")) pick("aimed");
        return;
      }
      return pick("snap");
    }
    if (distance > 12) {
      if (can("aimed")) return pick("aimed");
      if (distance < 20 && can("snap")) return pick("snap");
    }
    if (can("snap")) return pick("snap");
    if (can("aimed")) return pick("aimed");
    if (can("auto")) pick("auto");
  }

  /** A grenade anywhere on the unit (not smoke), and whether a hand is free to throw it. */
  private grenadeFromInventory(): Item | null {
    const b = this.b, u = this.u;
    if (!u.hasInventory) return null;
    const freeHand = HANDS.some((h) => !b.itemInSlot(u, h));
    for (const it of b.unitItems(u)) {
      const r = itemRule(it.type);
      if (r.battleType !== BattleType.GRENADE || r.damageType === DamageType.SMOKE) continue;
      if (HANDS.includes(it.slot as Hand) || freeHand) return it;
    }
    return null;
  }

  private grenadeAction() {
    const b = this.b, u = this.u;
    const g = this.grenadeFromInventory()!;
    const r = itemRule(g.type);
    const hand = HANDS.includes(g.slot as Hand) ? (g.slot as Hand) : HANDS.find((h) => !b.itemInSlot(u, h))!;
    const moveCost = g.slot === hand ? 0 : INVENTORY_COSTS[g.slot as SlotId]?.[hand] ?? 4;
    const tu = moveCost + (g.fuse >= 0 ? 0 : actionTUs(u, "prime", r)) + actionTUs(u, "throw", r);
    if (tu > u.tu) return;
    const radius = explosionRadius(r);
    let target: Pos | null = null;
    if (this.explosiveEfficacy(this.aggro!.pos, radius, true)) target = { ...this.aggro!.pos };
    else target = this.tileOfBestEfficacy(radius);
    if (!target) return;
    const tt = b.idxP(target);
    const origin = originVoxel(b, u, target, true);
    const tv = { x: target.x * 16 + 8, y: target.y * 16 + 8, z: target.z * 24 + 2 - b.terrainLevel(tt) };
    if (!validThrowRange(b, u, r.weight, origin, target) || !validateThrow(b, u, r.weight, true, origin, tv, target)) return;
    this.attack = { type: "throw", target, item: g };
    this.rifle = false;
    this.melee = false;
  }

  /** Best spot near known enemies to drop a grenade on (getNodeOfBestEfficacy, without nodes). */
  private tileOfBestEfficacy(radius: number): Pos | null {
    const b = this.b, u = this.u;
    if (b.round < this.ai.opts.grenadeTurn) return null;
    let bestScore = 2;
    let best: Pos | null = null;
    const origin = sightOriginVoxel(b, u);
    const scan = { x: 0, y: 0, z: 0 };
    const seen = new Set<number>();
    for (const e of b.units) {
      if (!this.validTarget(e, true)) continue;
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const p = { x: e.pos.x + dx, y: e.pos.y + dy, z: e.pos.z };
          const t = b.idxP(p);
          if (t < 0 || seen.has(t)) continue;
          seen.add(t);
          const dist = tileDistance(p, u.pos);
          if (dist > 20 || dist <= radius || !canTargetTile(b, origin, t, TilePart.FLOOR, scan, u)) continue;
          let points = 0;
          for (const o of b.units) {
            if (isOut(o) || tileDistance(p, o.pos) >= radius) continue;
            if (!canTargetTile(b, sightOriginVoxel(b, o), t, TilePart.FLOOR, scan, o)) continue;
            if (o.owner !== this.ai.player) {
              if (this.ai.knows(o, this.intelligence)) points++;
            } else points -= 2;
          }
          if (points > bestScore) {
            bestScore = points;
            best = p;
          }
        }
    }
    return best;
  }

  /** Our psi attack source: innate alien psionics, or a Psi-Amp in hand with psi skill. */
  private psiSource(): { hand: Hand | "innate"; cost: number } | null {
    const b = this.b, u = this.u;
    if (!b.settings.psionics) return null;
    if (u.psiWeapon) return { hand: "innate", cost: 25 };
    if (u.stats.psiSkill <= 0) return null;
    for (const h of HANDS) {
      const it = b.itemInSlot(u, h);
      if (it && itemRule(it.type).battleType === BattleType.PSIAMP) return { hand: h, cost: actionTUs(u, "mindcontrol", itemRule(it.type)) };
    }
    return null;
  }

  private psiCapable(): boolean {
    return !!this.psiSource();
  }

  /** Mind control the most promising enemy in view (AIModule::psiAction; there's no panic here). */
  private psiAction(): boolean {
    const b = this.b, u = this.u, br = this.br;
    const src = this.psiSource();
    if (!src) return false;
    this.aggro = null;
    if (u.originalOwner !== u.owner || u.tu <= br.escapeTUs + src.cost || br.didPsi) return false;
    const strength = Math.floor((u.stats.psiSkill * u.stats.psiStrength) / 50);
    let chance = 0;
    for (const e of b.units) {
      if (e.size !== 1 || !this.validTarget(e, true) || !isUnitVisibleTo(b, e, this.ai.player)) continue;
      const c = strength + (e.stats.psiSkill > 0 ? e.stats.psiSkill * -0.4 : 0) - tileDistance(e.pos, u.pos) - e.stats.psiStrength + this.rng.int(55, 105);
      if (c > chance) {
        chance = c;
        this.aggro = e;
      }
    }
    if (!this.aggro || !chance) return false;
    const w = this.weapon;
    const ammo = w ? ammoOf(b, w) : null;
    if (this.visibleEnemies && w && ammo) {
      if (itemRule(ammo.type).power >= chance) return false;
    } else if (this.rng.int(35, 155) >= chance) return false;
    if (chance < 30) return false; // too weak for mind control, and there's no panic attack to fall back on
    this.psiAct = { type: "psi", target: { ...this.aggro.pos }, hand: src.hand };
    return true;
  }

  /** Melee or gun this turn, when we have both (AIModule::selectMeleeOrRanged). */
  private selectMeleeOrRanged() {
    const b = this.b, u = this.u;
    const mw = meleeWeapon(b, u);
    if (!mw) {
      this.melee = false;
      return;
    }
    if (!this.weapon || !ammoOf(b, this.weapon)) {
      this.rifle = false;
      return;
    }
    const mr = itemRule(mw.type);
    let meleeOdds = 10;
    let dmg = mr.power;
    if (mr.strengthApplied) dmg += u.stats.strength;
    const ammo = ammoOf(b, mw);
    const type = ammo ? itemRule(ammo.type).damageType : mr.damageType;
    dmg *= armorRule(this.aggro!.armor).damageModifier[type] ?? 1;
    if (dmg > 50) meleeOdds += (dmg - 50) / 2;
    if (this.visibleEnemies > 1) meleeOdds -= 20 * (this.visibleEnemies - 1);
    if (meleeOdds > 0 && u.health >= (2 * u.stats.health) / 3) {
      if (this.aggression === 0) meleeOdds -= 20;
      else if (this.aggression > 1) meleeOdds += 10 * this.aggression;
      if (this.rng.percent(meleeOdds)) {
        this.rifle = false;
        this.reachableWithAttack = this.within(u.tu - actionTUs(u, "hit", mr));
        return;
      }
    }
    this.melee = false;
  }
}

