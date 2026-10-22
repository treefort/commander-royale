// Manual perf check: bun tests/stress.ts
import { files } from "../tools/render-map.ts";
import { defaultSettings } from "../shared/protocol.ts";
import { generatePool } from "../shared/rules/catalog.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { GameRules } from "../shared/engine/actions.ts";
import { isOut } from "../shared/engine/state.ts";
import { serializeBattle } from "../shared/engine/serialize.ts";
import { extractView, newSentState } from "../shared/engine/view.ts";
const s = { ...defaultSettings(), maxPlayers: 8, mapBlocks: 8, poolSize: 80, biome: "URBAN" as const };
const pool = generatePool(s, 1);
const players = Array.from({ length: 8 }, (_, i) => ({ userId: "u" + i, name: "P" + i, loadout: { squad: pool.filter((p) => p.kind !== "hwp").slice(i * 9, i * 9 + 9).map((r) => ({ recruitId: r.id, armor: "STR_NONE_UC", items: [{ type: "STR_RIFLE", slot: "STR_RIGHT_HAND", x: 0, y: 0, ammo: "STR_RIFLE_CLIP" }] })), stash: [] } }));
let t = performance.now();
const b = createBattle(s, players, pool, 3, files);
console.log("setup", (performance.now() - t).toFixed(0), "ms", b.units.length, "units", b.sx, "x", b.sy);
const rules = new GameRules(b);
const times: number[] = [];
for (let turn = 0; turn < 16; turn++) {
  const p = b.current;
  for (const u of b.units.filter((x) => x.owner === p && !isOut(x)).slice(0, 4)) {
    t = performance.now();
    rules.apply(p, { c: "move", unit: u.id, to: { x: b.sx >> 1, y: b.sy >> 1, z: 0 } });
    times.push(performance.now() - t);
  }
  t = performance.now();
  rules.apply(p, { c: "endturn" });
  times.push(performance.now() - t);
}
t = performance.now();
const json = serializeBattle(b);
const ser = performance.now() - t;
t = performance.now();
for (let i = 0; i < 8; i++) extractView(b, i, newSentState(), true);
console.log("serialize", ser.toFixed(0), "ms", (json.length / 1024).toFixed(0), "KB; 8 full views", (performance.now() - t).toFixed(0), "ms");
times.sort((a, c) => a - c);
console.log("action median", times[times.length >> 1].toFixed(1), "p95", times[Math.floor(times.length * 0.95)].toFixed(1), "max", times[times.length - 1].toFixed(1));
