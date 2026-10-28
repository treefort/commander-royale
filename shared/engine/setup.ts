// Turning a configured match (settings, players, loadouts) into a running battle.
import { type Battle, type FileSource, Phase } from "./state.ts";
import { generateMap } from "./mapgen.ts";
import { spawnGroundItem } from "./units.ts";
import { recalcAllLighting, recalculateAllFOV, calculateUnitLighting } from "./tileengine.ts";
import { GameRules } from "./actions.ts";
import { BattleEvents } from "./events.ts";
import { itemRule } from "../rules/index.ts";
import { resolveMapBlocks, type MatchSettings, type Recruit, type Loadout, type BotTuning, type SquadMember } from "../protocol.ts";
import { dealUnits } from "./coop.ts";
import { deployAll, newLandingZone } from "./deploy.ts";
import { RNG } from "./rng.ts";
import { newStats } from "./stats.ts";
import { customMap } from "../maps/build.ts";
import type { MapDoc } from "../maps/format.ts";

export interface SetupPlayer {
  userId: string;
  name: string;
  loadout: Loadout;
  /** the people playing this squad, leader first (co-op); omitted for computer squads */
  members?: { userId: string; name: string; observer?: boolean }[];
  ai?: BotTuning;
  /** co-op scenarios: units that join this squad later */
  waves?: { round: number; members: SquadMember[] }[];
  /**
   * a co-op team landing apart: how many landing zones it gets (members pick one with `zone`, 0-based), and the
   * spare equipment each zone's people brought
   */
  landings?: number;
  zoneStash?: string[][];
}

/** `custom`: the custom map (`settings.map`) to play on, instead of one generated from the settings. */
export function createBattle(settings: MatchSettings, players: SetupPlayer[], pool: Recruit[], seed: number, files: FileSource, custom?: MapDoc): Battle {
  // an auto map size fits whoever is here at the start (the server settles it first, so it's on record)
  if (!settings.mapBlocks && !custom) {
    const people = players[0]?.members?.filter((m) => !m.observer).length ?? 1;
    settings = { ...settings, mapBlocks: resolveMapBlocks(settings, players.length, people), autoMap: true };
  }
  // one landing zone per side, or several for a team landing apart; a side's zones are consecutive
  const first: number[] = [];
  let total = 0;
  for (const p of players) {
    first.push(total);
    total += Math.max(1, p.landings ?? 1);
  }
  const gen = custom ? customMap(custom, settings, total, seed, files) : generateMap(settings, total, seed, files);
  const { battle: b, ufo } = gen;
  // a custom map with fewer landing zones than it needs: the rest at the edge, as for a squad joining later
  const zones = [...gen.zones];
  b.landingZones = zones.map((z) => ({ ...z, seat: -1 }));
  while (zones.length < total) {
    const z = newLandingZone(b, -1);
    zones.push(z);
    b.landingZones.push({ ...z, seat: -1 });
  }
  b.zones = players.map((_, i) => zones[first[i]]);
  b.landingZones = zones.map((z, i) => ({ ...z, seat: first.filter((f) => f <= i).length - 1 }));
  b.ufoArea = ufo;
  b.players = players.map((p, i) => ({
    index: i, userId: p.userId, name: p.name, eliminated: false, surrendered: false, endedTurnCount: 0,
    ...(p.members ? { members: p.members.map((m) => ({ userId: m.userId, name: m.name, locked: false, afk: false, away: false, ...(m.observer ? { observer: true } : {}) })) } : {}),
    ...(p.ai ? { ai: p.ai } : {}),
  }));
  players.forEach((p, pi) => {
    const toZone = (m: SquadMember) => (p.landings && p.landings > 1 ? { ...m, zone: first[pi] + Math.min(p.landings - 1, Math.max(0, m.zone ?? 0)) } : m);
    const entries = p.loadout.squad.map((m) => ({ m: toZone(m), r: pool.find((x) => x.id === m.recruitId)! })).filter((e) => e.r);
    const created = deployAll(b, pi, entries);
    // co-op: everyone in the squad gets units of their own (in hiring order, so the deal is predictable)
    if (p.members) {
      const order = created.map((c) => ({ c, k: entries.findIndex((e) => e.m === c.m) })).sort((a, c) => a.k - c.k);
      dealUnits(order.map((o) => o.c.unit), p.members.filter((x) => !x.observer).map((x) => x.userId), order.map((o) => o.c.m.controller));
    }
    // spare equipment lies on the ground where the squad lands
    const lands = created.find((c) => !c.m.deploy || c.m.deploy === "edge");
    if (lands) {
      const t = b.idxP(lands.unit.pos);
      for (const type of p.loadout.stash) spawnGroundItem(b, type, t);
    }
    // a team landing apart: each person's spares land with them
    p.zoneStash?.forEach((items, k) => {
      const c = created.find((x) => x.m.zone === first[pi] + k) ?? lands;
      if (c) for (const type of items) spawnGroundItem(b, type, b.idxP(c.unit.pos));
    });
    for (const w of p.waves ?? []) {
      const ids = new Set(w.members.map((m) => m.recruitId));
      b.waves.push({ round: w.round, seat: pi, members: w.members, recruits: pool.filter((r) => ids.has(r.id)) });
    }
  });
  b.rebuildUnitIndex();
  recalcAllLighting(b);
  recalculateAllFOV(b);
  b.phase = Phase.PLAYING;
  const rules = new GameRules(b);
  const ev = new BattleEvents(b);
  rules.beginTurn(0, ev);
  return b;
}

/**
 * Someone joining the battle in progress. With `seat` they join that side (a co-op scenario's team, or a shared
 * squad in a free-for-all) and command the units they bring; without, their squad becomes a new side, last in the
 * turn order. Units land where they would have at the start: the side's landing zone, or (a new side, or a teammate
 * landing apart) a new zone on the map edge, as far from everyone else as the map allows. Returns the side.
 */
export function joinBattle(b: Battle, p: SetupPlayer, pool: Recruit[], ev: BattleEvents, seat = -1): number {
  const newSide = seat < 0;
  if (newSide) {
    seat = b.players.length;
    b.players.push({
      index: seat, userId: p.userId, name: p.name, eliminated: false, surrendered: false, endedTurnCount: 0, joinedRound: b.round,
      ...(p.members ? { members: p.members.map((m) => ({ userId: m.userId, name: m.name, locked: false, afk: false, away: false })) } : {}),
      ...(p.ai ? { ai: p.ai } : {}),
    });
    b.growSides(b.players.length);
  } else {
    const side = b.players[seat];
    // a squad from a save that predates co-op: its leader is its one member so far
    side.members ??= [{ userId: side.userId, name: side.name, locked: false, afk: false, away: false }];
    for (const m of p.members ?? []) if (!side.members.some((x) => x.userId === m.userId)) side.members.push({ userId: m.userId, name: m.name, locked: false, afk: false, away: false });
  }
  const entries = p.loadout.squad.map((m) => ({ m, r: pool.find((x) => x.id === m.recruitId)! })).filter((e) => e.r);
  if (entries.length && (newSide || (p.landings ?? 0) > 0)) {
    const z = newLandingZone(b, seat);
    b.landingZones.push({ ...z, seat });
    if (newSide) b.zones[seat] = z;
    const zone = b.landingZones.length - 1;
    for (const e of entries) e.m = { ...e.m, zone };
  }
  const created = deployAll(b, seat, entries);
  if (p.members) {
    const order = created.map((c) => ({ c, k: entries.findIndex((e) => e.m === c.m) })).sort((a, c) => a.k - c.k);
    dealUnits(order.map((o) => o.c.unit), p.members.filter((x) => !x.observer).map((x) => x.userId), order.map((o) => o.c.m.controller));
  }
  if (created.length) for (const type of p.loadout.stash) spawnGroundItem(b, type, b.idxP(created[0].unit.pos));
  b.rebuildUnitIndex();
  calculateUnitLighting(b);
  recalculateAllFOV(b);
  ev.msg("STR_JOINED_BATTLE", ev.all(), p.name);
  return seat;
}

/**
 * A battle's starting point (as `createBattle` left it), made ready to play again by one person: `player` takes over
 * the side in `seat` and commands all of its units, every other side is played by the AI (people's squads by the
 * computer squads' default AI), and the dice are new (`seed`). Same map, units, gear, positions and turn order.
 */
export function replayBattle(b: Battle, seat: number, player: { userId: string; name: string }, seed: number): Battle {
  const s = b.settings;
  // one person, nobody watching: no game master, and nobody's units handed to the AI while they're away
  b.settings = { ...s, coop: { ...s.coop, afkAI: false }, ...(s.mode === "coop" ? { scenario: { ...s.scenario, gmPlays: true } } : {}) };
  b.players.forEach((p, i) => {
    if (i === seat) {
      p.userId = player.userId;
      // a free-for-all squad goes by its commander's name; a co-op team keeps the scenario's
      if (s.mode !== "coop") p.name = player.name;
      p.members = [{ userId: player.userId, name: player.name, locked: false, afk: false, away: false }];
      delete p.ai;
    } else if (p.members) {
      p.userId = `bot:standin:${i}`;
      delete p.members;
    }
  });
  for (const u of b.units) delete u.controller;
  b.rng = new RNG(seed);
  b.stats = newStats();
  return b;
}

export { itemRule };
