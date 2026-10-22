import { test, expect } from "bun:test";
import { files } from "../tools/gamefiles.ts";
import { runMatch } from "../tools/arena.ts";
import { defaultSettings, type TechLevel } from "../shared/protocol.ts";
import { generatePool, checkLoadout } from "../shared/rules/catalog.ts";
import { STRATEGIES, buildSquad } from "../shared/rules/squads.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { AIPlayer, DEFAULT_AI, STAND_IN_AI } from "../shared/engine/ai.ts";
import { GameRules } from "../shared/engine/actions.ts";
import { posEq } from "../shared/engine/defs.ts";
import { isUnitVisibleTo } from "../shared/engine/tileengine.ts";
import { isOut, Phase } from "../shared/engine/state.ts";
import { RNG } from "../shared/engine/rng.ts";

test("every squad strategy builds a legal loadout at any budget and tech level", () => {
  for (const budget of [60_000, 150_000, 400_000, 2_000_000])
    for (const techLevel of ["conventional", "laser", "alien"] as TechLevel[])
      for (const timeOfDay of ["day", "night"] as const) {
        const s = { ...defaultSettings(), budget, techLevel, timeOfDay };
        const pool = generatePool(s, budget + techLevel.length);
        for (const st of STRATEGIES) {
          const l = buildSquad(st, s, pool, new RNG(3));
          const chk = checkLoadout(s, pool, l);
          expect(chk.errors).toEqual([]);
          expect(l.squad.length).toBeGreaterThan(0);
          // strategies spend their money, unless the seat limit (or a cheap pool) stops them
          if (st !== "random" && budget <= 400_000 && chk.seats < s.squadLimit) expect(chk.cost).toBeGreaterThan(budget * 0.6);
        }
      }
});

test("a living-weapon alien can't be handed a gun in the hand its claws occupy", () => {
  const s = defaultSettings();
  const pool = generatePool(s, 5);
  const chry = pool.find((p) => p.type.startsWith("STR_CHRYSSALID"));
  const target = chry ?? pool.find((p) => p.kind === "alien" && p.notes.some((n) => n.startsWith("Built-in")))!;
  const l = { squad: [{ recruitId: target.id, armor: "", items: [{ type: "STR_PISTOL", slot: "STR_RIGHT_HAND", x: 0, y: 0, ammo: "STR_PISTOL_CLIP" }] }], stash: [] };
  expect(checkLoadout(s, pool, l).errors.join()).toContain("doesn't fit");
  // the left hand is fine
  l.squad[0].items[0].slot = "STR_LEFT_HAND";
  expect(checkLoadout(s, pool, l).errors).toEqual([]);
});

test("bots only know about enemies they have seen", () => {
  const s = { ...defaultSettings(), biome: "URBAN" as const, mapBlocks: 5 };
  const pool = generatePool(s, 11);
  const rng = new RNG(1);
  const players = [0, 1].map((i) => ({ userId: "u" + i, name: "P" + i, loadout: buildSquad("swarm", s, pool, rng) }));
  const b = createBattle(s, players, pool, 11, files);
  const bot = new AIPlayer(b, 0);
  bot.observe();
  for (const e of b.units.filter((u) => u.owner === 1 && !isOut(u))) expect(bot.knows(e, 4)).toBe(isUnitVisibleTo(b, e, 0));
});

test("the AI standing in for a person keeps moving instead of lying in wait", () => {
  // the host hands a player's turn to the AI: an alien-style ambush (waiting where it is for the enemy to come)
  // looks like the player standing there doing nothing, turn after turn
  const idleTurns = (opts: typeof STAND_IN_AI) => {
    let idle = 0;
    for (const seed of [1, 2, 3, 4]) {
      const s = { ...defaultSettings(), biome: "FOREST" as const, timeOfDay: "day" as const, ufo: "none", mapBlocks: 6 };
      const pool = generatePool(s, seed);
      const rng = new RNG(seed);
      const b = createBattle(s, [0, 1].map((i) => ({ userId: "u" + i, name: "P" + i, loadout: buildSquad("balanced", s, pool, rng) })), pool, seed, files);
      const rules = new GameRules(b);
      const ai = new AIPlayer(b, 0, opts, seed);
      for (let turn = 0; turn < 6 && b.phase === Phase.PLAYING; turn++) {
        if (b.current !== 0) rules.apply(b.current, { c: "endturn" });
        // the squad has heard where the enemy is (seen this round), but nobody is in sight right now
        for (const e of b.units.filter((u) => u.owner === 1 && !isOut(u))) (ai as unknown as { lastSeen: Map<number, number> }).lastSeen.set(e.id, b.round);
        const before = new Map(b.units.filter((u) => u.owner === 0 && !isOut(u)).map((u) => [u.id, { ...u.pos }]));
        const inSight = b.units.some((e) => e.owner === 1 && !isOut(e) && isUnitVisibleTo(b, e, 0));
        for (const _ of ai.turnSteps(rules, () => true));
        if (!inSight) for (const u of b.units) if (before.has(u.id) && !isOut(u) && posEq(u.pos, before.get(u.id)!)) idle++;
        if (b.current === 0 && b.phase === Phase.PLAYING) rules.apply(0, { c: "endturn" });
      }
    }
    return idle;
  };
  // the aliens' AI does lie in wait here; the stand-in never does
  expect(idleTurns(DEFAULT_AI as typeof STAND_IN_AI)).toBeGreaterThan(0);
  expect(idleTurns(STAND_IN_AI)).toBe(0);
}, 120_000);

test("bot-vs-bot battle plays out to a winner within the rules", () => {
  const r = runMatch({ seed: 1, strategies: ["swarm", "elite"], settings: { biome: "CULTA", timeOfDay: "day", ufo: "none" }, maxRounds: 40 });
  console.log(`winner ${r.winner} after ${r.rounds} rounds, ${r.actions} actions (${r.rejected} rejected), ${(r.ms / 1000).toFixed(1)}s`);
  expect(r.winner).toBeGreaterThanOrEqual(0);
  expect(r.rejected / r.actions).toBeLessThan(0.05);
  // somebody actually fought
  expect(r.units.reduce((a, u) => a + u.damage, 0)).toBeGreaterThan(100);
  expect(r.units.filter((u) => u.player !== r.winner).every((u) => !u.survived)).toBe(true);
}, 180_000);

test("bots use psionics, explosives and their built-in weapons", () => {
  const kinds = new Set<string>();
  for (const [strategies, seed] of [[["psi", "aliens"], 3], [["heavy", "swarm"], 4]] as const) {
    runMatch({
      seed, strategies: [...strategies], randomMap: true, maxRounds: 25,
      log: (l) => {
        const m = l.match(/"c":"(\w+)"/);
        if (m && !l.startsWith("rejected")) kinds.add(m[1]);
      },
    });
  }
  for (const c of ["move", "shoot", "psi", "launch", "turn"]) expect(kinds).toContain(c);
}, 240_000);
