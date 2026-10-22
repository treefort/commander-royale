import { test, expect } from "bun:test";
import { files } from "../tools/render-map.ts";
import { defaultSettings, type Loadout } from "../shared/protocol.ts";
import { generatePool, checkLoadout } from "../shared/rules/catalog.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { GameRules, type Command } from "../shared/engine/actions.ts";
import { isOut, Phase } from "../shared/engine/state.ts";
import { serializeBattle, deserializeBattle } from "../shared/engine/serialize.ts";
import { extractView, newSentState, applyView } from "../shared/engine/view.ts";
import { RNG } from "../shared/engine/rng.ts";

function squad(pool: ReturnType<typeof generatePool>, ids: string[]): Loadout {
  return {
    squad: ids.map((id) => {
      const r = pool.find((p) => p.id === id)!;
      const items = r.kind === "hwp" ? [] : [
        { type: "STR_RIFLE", slot: "STR_RIGHT_HAND", x: 0, y: 0, ammo: "STR_RIFLE_CLIP" },
        { type: "STR_GRENADE", slot: "STR_BELT", x: 0, y: 0 },
        { type: "STR_RIFLE_CLIP", slot: "STR_BELT", x: 1, y: 0 },
      ];
      return { recruitId: id, armor: "STR_NONE_UC", items };
    }),
    stash: ["STR_MEDI_KIT"],
  };
}

for (const biome of ["URBAN", "CULTA", "UBASE"] as const) {
  test(`random battle in ${biome} runs to completion without errors`, () => {
    const settings = { ...defaultSettings(), biome, mapBlocks: 4, budget: 5_000_000, timeOfDay: biome === "CULTA" ? "night" as const : "day" as const };
    const pool = generatePool(settings, 123);
    const soldiers = pool.filter((p) => p.kind === "soldier").map((p) => p.id);
    const aliens = pool.filter((p) => p.kind !== "soldier").map((p) => p.id);
    const l0 = squad(pool, soldiers.slice(0, 5));
    const l1 = squad(pool, [...soldiers.slice(5, 8), ...aliens.slice(0, 3)]);
    expect(checkLoadout(settings, pool, l0).errors).toEqual([]);
    const t0 = performance.now();
    const b = createBattle(settings, [{ userId: "a", name: "A", loadout: l0 }, { userId: "b", name: "B", loadout: l1 }], pool, 99, files);
    console.log(biome, "setup ms", (performance.now() - t0).toFixed(0), "units", b.units.length);
    const rules = new GameRules(b);
    const rng = new RNG(7);
    let actions = 0, errors = 0; const reasons: Record<string, number> = {};
    const timings: number[] = [];
    for (let turn = 0; turn < 40 && b.phase === Phase.PLAYING; turn++) {
      const p = b.current;
      for (const u of b.units.filter((x) => x.owner === p && !isOut(x))) {
        for (let k = 0; k < 3; k++) {
          if (isOut(u)) break;
          const enemies = b.units.filter((e) => e.owner !== p && !isOut(e) && u.visibleUnits.includes(e.id));
          let cmd: Command;
          if (enemies.length && rng.percent(70)) {
            const e = rng.pick(enemies);
            const hand = b.itemInSlot(u, "STR_RIGHT_HAND");
            cmd = hand && hand.type === "STR_RIFLE" ? { c: "shoot", unit: u.id, hand: "STR_RIGHT_HAND", mode: rng.pick(["snap", "auto", "aimed"] as const), target: e.pos }
              : { c: "melee", unit: u.id, hand: "STR_RIGHT_HAND", target: e.pos };
          } else {
            // wander towards the centre
            const to = { x: Math.max(0, Math.min(b.sx - 1, Math.floor(b.sx / 2) + rng.int(-8, 8))), y: Math.max(0, Math.min(b.sy - 1, Math.floor(b.sy / 2) + rng.int(-8, 8))), z: 0 };
            cmd = { c: "move", unit: u.id, to };
          }
          const t = performance.now();
          const r = rules.apply(p, cmd);
          timings.push(performance.now() - t);
          actions++;
          if (!r.ok) { errors++; reasons[cmd.c + ":" + r.error] = (reasons[cmd.c + ":" + r.error] ?? 0) + 1; }
        }
      }
      rules.apply(p, { c: "endturn" });
      // views and persistence keep working throughout
      if (turn % 10 === 0) {
        const json = serializeBattle(b);
        const b2 = deserializeBattle(json, files);
        expect(b2.units.length).toBe(b.units.length);
        const v = extractView(b, 0, newSentState(), true);
        const cb = applyView(null, v, files);
        expect(cb.units.filter((u) => u.owner === 0).length).toBe(b.units.filter((u) => u.owner === 0).length);
      }
      for (const u of b.units) {
        expect(u.tu).toBeGreaterThanOrEqual(0);
        expect(u.health).toBeGreaterThanOrEqual(0);
      }
    }
    timings.sort((a, c) => a - c);
    console.log(biome, "actions", actions, "rejected", errors, "rounds", b.round, "phase", b.phase, "winner", b.winner,
      "median ms", timings[timings.length >> 1]?.toFixed(1), "p95", timings[Math.floor(timings.length * 0.95)]?.toFixed(1),
      "alive", b.units.filter((u) => !isOut(u)).length, JSON.stringify(reasons));
  }, 120000);
}
