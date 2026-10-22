// Turning a configured match (settings, players, loadouts) into a running battle.
import { type Battle, type FileSource, Phase } from "./state.ts";
import { generateMap } from "./mapgen.ts";
import { spawnGroundItem } from "./units.ts";
import { recalcAllLighting, recalculateAllFOV } from "./tileengine.ts";
import { GameRules } from "./actions.ts";
import { BattleEvents } from "./events.ts";
import { itemRule } from "../rules/index.ts";
import type { MatchSettings, Recruit, Loadout, BotTuning, SquadMember } from "../protocol.ts";
import { dealUnits } from "./coop.ts";
import { deployAll } from "./deploy.ts";

export interface SetupPlayer {
  userId: string;
  name: string;
  loadout: Loadout;
  /** the people playing this squad, leader first (co-op); omitted for computer squads */
  members?: { userId: string; name: string; observer?: boolean }[];
  ai?: BotTuning;
  /** co-op scenarios: units that join this squad later */
  waves?: { round: number; members: SquadMember[] }[];
}

export function createBattle(settings: MatchSettings, players: SetupPlayer[], pool: Recruit[], seed: number, files: FileSource): Battle {
  const { battle: b, zones, ufo } = generateMap(settings, players.length, seed, files);
  b.zones = zones;
  b.ufoArea = ufo;
  b.players = players.map((p, i) => ({
    index: i, userId: p.userId, name: p.name, eliminated: false, surrendered: false, endedTurnCount: 0,
    ...(p.members ? { members: p.members.map((m) => ({ userId: m.userId, name: m.name, locked: false, afk: false, away: false, ...(m.observer ? { observer: true } : {}) })) } : {}),
    ...(p.ai ? { ai: p.ai } : {}),
  }));
  players.forEach((p, pi) => {
    const entries = p.loadout.squad.map((m) => ({ m, r: pool.find((x) => x.id === m.recruitId)! })).filter((e) => e.r);
    const created = deployAll(b, pi, entries);
    // co-op: everyone in the squad gets units of their own (in hiring order, so the deal is predictable)
    if (p.members) {
      const order = created.map((c) => ({ c, k: p.loadout.squad.indexOf(c.m) })).sort((a, c) => a.k - c.k);
      dealUnits(order.map((o) => o.c.unit), p.members.filter((x) => !x.observer).map((x) => x.userId), order.map((o) => o.c.m.controller));
    }
    // spare equipment lies on the ground where the squad lands
    const first = created.find((c) => !c.m.deploy || c.m.deploy === "edge");
    if (first) {
      const t = b.idxP(first.unit.pos);
      for (const type of p.loadout.stash) spawnGroundItem(b, type, t);
    }
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

export { itemRule };
