// Headless bot-vs-bot matches for balance testing: each player hires from the shared pool with a
// squad-building strategy, then OpenXcom-style AI plays the battle out to the last squad standing.
import { files } from "./gamefiles.ts";
import { defaultSettings, recommendedMapBlocks, sanitizeSettings, BIOMES, type MatchSettings, type Recruit, type Loadout } from "../shared/protocol.ts";
import { generatePool, checkLoadout } from "../shared/rules/catalog.ts";
import { buildSquad, type Strategy } from "../shared/rules/squads.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { GameRules } from "../shared/engine/actions.ts";
import { AIPlayer, DEFAULT_AI, type AIOptions } from "../shared/engine/ai.ts";
import { Phase } from "../shared/engine/state.ts";
import { buildRecord, recruitKey, kitName, type MatchRecord, type UnitRecord } from "../shared/engine/record.ts";
import { RNG } from "../shared/engine/rng.ts";

export interface MatchSpec {
  seed: number;
  strategies: Strategy[];
  settings?: Partial<MatchSettings>;
  /** randomize biome / time of day / UFO from the seed (fields given in `settings` win) */
  randomMap?: boolean;
  maxRounds?: number;
  /** wall-clock cap; the match is called undecided after this (default 4 minutes) */
  maxMs?: number;
  ai?: Partial<AIOptions>;
  log?: (line: string) => void;
  /** play these exact squads from this pool instead of generating them (duels) */
  pool?: Recruit[];
  loadouts?: Loadout[];
  names?: string[];
}

export type UnitStat = UnitRecord;

/** A bot match: the same record the server keeps for real games, plus harness details. */
export interface MatchResult extends MatchRecord {
  seed: number;
  biome: string;
  time: string;
  ufo: string;
  budget: number;
  mapBlocks: number;
  strategies: Strategy[];
  spent: number[];
  actions: number;
  rejected: number;
  ms: number;
}

export { recruitKey, kitName };

export function matchSettings(spec: MatchSpec): MatchSettings {
  const rng = new RNG(spec.seed ^ 0x51ab);
  const base = defaultSettings();
  const s: Partial<MatchSettings> = { ...base, maxPlayers: spec.strategies.length };
  if (spec.randomMap) {
    s.biome = rng.pick(BIOMES).id;
    s.timeOfDay = rng.pick(["day", "day", "dusk", "night"] as const);
    s.ufo = rng.percent(50) ? "random" : "none";
  }
  Object.assign(s, spec.settings ?? {});
  if (!spec.settings?.mapBlocks) s.mapBlocks = recommendedMapBlocks(spec.loadouts?.length ?? spec.strategies.length, s.budget ?? base.budget);
  return sanitizeSettings(s);
}

export function runMatch(spec: MatchSpec): MatchResult {
  const t0 = performance.now();
  const settings = matchSettings(spec);
  const pool = spec.pool ?? generatePool(settings, spec.seed);
  const rng = new RNG(spec.seed * 31 + 7);
  const loadouts = spec.loadouts ?? spec.strategies.map((st) => buildSquad(st, settings, pool, rng));
  const spent = loadouts.map((l) => checkLoadout(settings, pool, l).cost);
  const players = loadouts.map((l, i) => ({ userId: "bot" + i, name: spec.names?.[i] ?? `${spec.strategies[i]} #${i + 1}`, loadout: l }));
  const b = createBattle(settings, players, pool, spec.seed, files);
  const ai = { ...DEFAULT_AI, ...(spec.ai ?? {}) };
  const bots = players.map((_, i) => new AIPlayer(b, i, ai, spec.seed + i));

  const rules = new GameRules(b);
  let actions = 0, rejected = 0;
  const apply = rules.apply.bind(rules);
  rules.apply = (p, cmd) => {
    const r = apply(p, cmd);
    actions++;
    if (!r.ok) {
      rejected++;
      if (spec.log) spec.log(`rejected p${p} ${JSON.stringify(cmd)}: ${r.error}`);
    } else if (spec.log && cmd.c !== "endturn") spec.log(`r${b.round} p${p} ${JSON.stringify(cmd)}`);
    // everyone notices what they see, on anyone's turn
    for (const bot of bots) bot.observe();
    return r;
  };
  const maxRounds = spec.maxRounds ?? 60;
  const deadline = t0 + (spec.maxMs ?? 240_000);
  for (let guard = 0; b.phase === Phase.PLAYING && b.round <= maxRounds && guard < maxRounds * players.length + 10 && performance.now() < deadline; guard++) {
    const cur = b.current;
    const round = b.round;
    bots[cur].playTurn(rules);
    // a bot that somehow didn't end its turn still loses it
    if (b.phase === Phase.PLAYING && b.current === cur && b.round === round) rules.apply(cur, { c: "endturn" });
  }

  const rec = buildRecord(b, pool, loadouts, `bot-${spec.seed}`, "bot");
  if (b.phase !== Phase.FINISHED) rec.winner = -1;
  return {
    ...rec, seed: spec.seed, biome: settings.biome, time: settings.timeOfDay, ufo: settings.ufo, budget: settings.budget,
    mapBlocks: settings.mapBlocks, strategies: spec.strategies, spent, actions, rejected, ms: performance.now() - t0,
  };
}

