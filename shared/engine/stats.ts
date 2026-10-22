// Per-unit battle statistics, recorded by the engine for every match (people and bots alike) and saved
// with the battle. When a match ends they become a MatchRecord (see record.ts) for balance analysis.
import type { Battle, Unit } from "./state.ts";
import type { BattleEvents } from "./events.ts";

export interface UnitStats {
  /** successful commands by type (move, shoot, throw, psi, medikit, inv, ...) */
  actions: Record<string, number>;
  tuSpent: number;
  tilesMoved: number;
  /** rounds fired (an auto burst counts each round), by weapon type */
  shots: Record<string, number>;
  reactionShots: number;
  /** hits on enemies (including ones armor stopped) and the damage they did, by weapon type ("other": fire etc.) */
  hits: Record<string, number>;
  damage: Record<string, number>;
  damageTaken: number;
  friendlyDamage: number; // to its own side (not counting mind-controlled targets)
  throws: number;
  melee: number;
  meleeHits: number;
  psiAttempts: number;
  psiSuccesses: number;
  timesMindControlled: number;
  /** round the unit went down (-1 still up), and whether it died or was knocked out */
  downRound: number;
  died: boolean;
}

export interface BattleStats {
  v: 1;
  units: Record<number, UnitStats>;
  /** victim unit id -> last enemy unit that hurt it (kill credit) */
  lastHit: Record<number, number>;
  startedAt: number;
}

export function newStats(): BattleStats {
  return { v: 1, units: {}, lastHit: {}, startedAt: Date.now() };
}

export function unitStats(b: Battle, id: number): UnitStats {
  let s = b.stats.units[id];
  if (!s) {
    b.stats.units[id] = s = {
      actions: {}, tuSpent: 0, tilesMoved: 0, shots: {}, reactionShots: 0, hits: {}, damage: {}, damageTaken: 0, friendlyDamage: 0,
      throws: 0, melee: 0, meleeHits: 0, psiAttempts: 0, psiSuccesses: 0, timesMindControlled: 0, downRound: -1, died: false,
    };
  }
  return s;
}

/** Whoever really did it: a mind-controlled unit's work is credited to the controller. */
function responsible(b: Battle, attacker: Unit): Unit {
  if (attacker.owner !== attacker.originalOwner && attacker.mindControllerId >= 0) return b.unit(attacker.mindControllerId) ?? attacker;
  return attacker;
}

export function recordDamage(b: Battle, victim: Unit, amount: number, attacker: Unit | null) {
  amount = Math.max(0, amount);
  unitStats(b, victim.id).damageTaken += amount;
  if (!attacker) return;
  const who = responsible(b, attacker);
  const s = unitStats(b, who.id);
  if (who.originalOwner === victim.originalOwner) {
    if (victim.owner === victim.originalOwner) s.friendlyDamage += amount;
    return;
  }
  // hits count even when armor stops all the damage
  const w = b.actingWeapon || "other";
  s.hits[w] = (s.hits[w] ?? 0) + 1;
  s.damage[w] = (s.damage[w] ?? 0) + amount;
  if (amount > 0) b.stats.lastHit[victim.id] = who.id;
}

/** Tallies what an action's events show: shots, throws, melee, psi, movement, units going down. */
export function recordEvents(b: Battle, ev: BattleEvents) {
  for (const { e } of ev.list) {
    switch (e.t) {
      case "shot": {
        const s = unitStats(b, e.unit);
        s.shots[e.weapon] = (s.shots[e.weapon] ?? 0) + 1;
        break;
      }
      case "reaction": unitStats(b, e.unit).reactionShots++; break;
      case "throw": unitStats(b, e.unit).throws++; break;
      case "melee": {
        const s = unitStats(b, e.unit);
        s.melee++;
        if (e.hit) s.meleeHits++;
        break;
      }
      case "psi": {
        const s = unitStats(b, e.unit);
        s.psiAttempts++;
        if (e.success) {
          s.psiSuccesses++;
          unitStats(b, e.target).timesMindControlled++;
        }
        break;
      }
      case "move": unitStats(b, e.unit).tilesMoved++; break;
      case "collapse": {
        const s = unitStats(b, e.unit);
        if (s.downRound < 0) s.downRound = b.round;
        s.died ||= e.dead;
        break;
      }
      case "spawn": break;
    }
  }
}

export function recordCommand(b: Battle, u: Unit, command: string, tuBefore: number) {
  const s = unitStats(b, u.id);
  s.actions[command] = (s.actions[command] ?? 0) + 1;
  s.tuSpent += Math.max(0, tuBefore - u.tu);
}
