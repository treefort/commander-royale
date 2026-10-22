// Co-op squads: several people share one squad, each commanding the units dealt to them, all acting at
// once during the squad's turn. The turn ends when everyone has locked in (or on the timer); the AI
// plays the units of anyone who is AFK. The engine itself only knows squads; these rules sit on top.
import { type Battle, type Unit, type PlayerState, type SquadMemberState, isOut } from "./state.ts";
import { UnitStatus } from "./defs.ts";

export function membersOf(p: PlayerState | undefined): SquadMemberState[] {
  return p?.members ?? [];
}

/** The squad a person plays in (as its leader or a member), -1 if none. */
export function seatOfUser(b: Battle, userId: string): number {
  return b.players.findIndex((p) => p.userId === userId || membersOf(p).some((m) => m.userId === userId));
}

export function memberOf(b: Battle, seat: number, userId: string): SquadMemberState | undefined {
  return membersOf(b.players[seat]).find((m) => m.userId === userId);
}

/** The AI plays this person's units (they went AFK, or have been offline too long). */
export function isAfk(m: SquadMemberState): boolean {
  return m.afk || m.away;
}

/**
 * Who commands a unit: its assigned member, or "" if anyone in the squad may (unassigned units, members who
 * left, mind-controlled enemies take after the unit that controls them... unless that's someone else's).
 */
export function controllerOf(b: Battle, u: Unit): string {
  let c = u.controller ?? "";
  if (u.owner !== u.originalOwner) {
    // a mind-controlled unit answers to whoever controls the psionic who took it
    const psi = b.unit(u.mindControllerId);
    c = psi && psi.owner === u.owner ? psi.controller ?? "" : "";
  }
  return c && memberOf(b, u.owner, c) ? c : "";
}

/** Whether `userId` may give orders to `u` right now (it's still the squad's turn check that decides when). */
export function mayCommand(b: Battle, userId: string, u: Unit): string | null {
  const me = memberOf(b, u.owner, userId);
  if (me === undefined && b.players[u.owner]?.userId !== userId) return "STR_INVALID_UNIT";
  if (me?.observer) return "STR_GAME_MASTER_WATCHES";
  const c = controllerOf(b, u);
  if (!c || c === userId) return null;
  const m = memberOf(b, u.owner, c)!;
  return isAfk(m) ? "STR_UNIT_PLAYED_BY_AI" : "STR_TEAMMATES_UNIT";
}

/** Members who still have to lock in before the squad's turn can end (AFK members never hold it up). */
export function waitingFor(b: Battle, seat: number): SquadMemberState[] {
  const p = b.players[seat];
  const members = membersOf(p);
  const active = new Set<string>();
  let shared = false;
  for (const u of b.units) {
    if (u.owner !== seat || isOut(u) || u.status === UnitStatus.IGNORE_ME) continue;
    const c = controllerOf(b, u);
    if (c) active.add(c);
    else shared = true;
  }
  // anyone may move the shared units, so everyone present has a say; otherwise only people with units do
  return members.filter((m) => !m.locked && !isAfk(m) && !m.observer && (shared || active.has(m.userId)));
}

/** A squad played by more than one person (lock-ins and the "timer" turn end apply). */
export function isShared(p: PlayerState | undefined): boolean {
  return membersOf(p).filter((m) => !m.observer).length > 1;
}

/** Whether `userId` watches `seat`'s side as a game master (everything is visible to them). */
export function isObserver(b: Battle, seat: number, userId: string): boolean {
  return !!memberOf(b, seat, userId)?.observer;
}

/** Deals a squad's units out to its members: explicit picks first, then the rest in turn (fewest first). */
export function dealUnits(units: Unit[], members: string[], picks: (string | undefined)[]) {
  if (!members.length) return;
  const count = new Map(members.map((m) => [m, 0]));
  units.forEach((u, i) => {
    const pick = picks[i];
    if (pick && count.has(pick)) {
      u.controller = pick;
      count.set(pick, count.get(pick)! + 1);
    }
  });
  for (const u of units) {
    if (u.controller && count.has(u.controller)) continue;
    let best = members[0];
    for (const m of members) if (count.get(m)! < count.get(best)!) best = m;
    u.controller = best;
    count.set(best, count.get(best)! + 1);
  }
}

/** The AI plays this unit for its AFK controller (or, with the whole squad AFK, the units nobody owns). */
export function playedByAI(b: Battle, u: Unit): boolean {
  if (isOut(u) || u.status === UnitStatus.IGNORE_ME) return false;
  const members = membersOf(b.players[u.owner]);
  if (!members.length) return false;
  const c = controllerOf(b, u);
  if (c) return isAfk(memberOf(b, u.owner, c)!);
  return members.every((m) => m.observer || isAfk(m));
}
