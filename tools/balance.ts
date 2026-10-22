// Balance harness: bot-vs-bot tournaments between squad-building strategies, played in parallel.
//
//   bun tools/balance.ts [--games 300] [--budget 400000[,1000000]] [--strategies swarm,elite,...]
//                        [--players 2] [--biome URBAN] [--time day] [--tech alien] [--rounds 60]
//                        [--workers N] [--seed 1] [--out results.json] [--personalities]
//
// Prints win rates per strategy, a head-to-head table, and value-for-money per hire type and weapon kit.
import { writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { STRATEGIES, type Strategy } from "../shared/rules/squads.ts";
import type { MatchSpec, MatchResult } from "./arena.ts";
import { playAll } from "./pool.ts";
import { pct, money, ci, table, valueTable, weaponTable } from "./report.ts";
import type { Biome, TimeOfDay, TechLevel } from "../shared/protocol.ts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "1" : v;
}

const games = Number(arg("games", "200"));
const budgets = arg("budget", "400000")!.split(",").map(Number);
const strategies = (arg("strategies") ?? STRATEGIES.join(",")).split(",") as Strategy[];
for (const s of strategies) if (!STRATEGIES.includes(s)) throw new Error(`unknown strategy ${s} (have ${STRATEGIES.join(", ")})`);
const nPlayers = Number(arg("players", "2"));
const workers = Number(arg("workers", String(Math.max(1, cpus().length - 2))));
const seed0 = Number(arg("seed", "1"));
const rounds = Number(arg("rounds", "60"));
const out = arg("out");
const fixed: MatchSpec["settings"] = {};
if (arg("biome")) fixed.biome = arg("biome") as Biome;
if (arg("time")) fixed.timeOfDay = arg("time") as TimeOfDay;
if (arg("tech")) fixed.techLevel = arg("tech") as TechLevel;
if (arg("ufo")) fixed.ufo = arg("ufo")!;
if (arg("drops") === "off") fixed.supplyDrops = { enabled: false, everyRounds: 4, warningRounds: 2, tier: "mixed", kits: 3 };

// every strategy meets every other equally often, in both seat orders (player 1 moves first)
const lineups: Strategy[][] = [];
if (nPlayers === 2) {
  for (let i = 0; i < strategies.length; i++)
    for (let j = i + 1; j < strategies.length; j++) lineups.push([strategies[i], strategies[j]], [strategies[j], strategies[i]]);
  if (strategies.length === 1) lineups.push([strategies[0], strategies[0]]);
}
const specs: MatchSpec[] = [];
for (let g = 0; g < games; g++) {
  const seed = seed0 + g;
  const lineup = nPlayers === 2 ? lineups[g % lineups.length] : Array.from({ length: nPlayers }, (_, k) => strategies[(g + k * 7) % strategies.length]);
  specs.push({
    seed, strategies: lineup, randomMap: true, maxRounds: rounds,
    settings: { ...fixed, budget: budgets[g % budgets.length] },
    ai: arg("personalities") ? { personalities: true } : undefined,
  });
}

console.log(`${specs.length} matches, ${workers} workers, budgets ${budgets.join("/")}, strategies ${strategies.join(", ")}`);
const t0 = performance.now();
const results: MatchResult[] = [];
let failed = 0;
await playAll(specs, workers, (spec, result, error) => {
  if (result) results.push(result);
  else {
    failed++;
    console.error(`match ${spec.seed} failed: ${error}`);
  }
  const done = results.length + failed;
  if (done % 20 === 0 || done === specs.length) {
    const el = (performance.now() - t0) / 1000;
    process.stdout.write(`
${done}/${specs.length} played, ${el.toFixed(0)}s elapsed, ~${((el / done) * (specs.length - done)).toFixed(0)}s left   `);
  }
});
console.log();
if (out) writeFileSync(out, JSON.stringify(results));

// ------------------------------------------------------------------------------------------
// report
// ------------------------------------------------------------------------------------------

const decided = results.filter((r) => r.winner >= 0);
console.log(`\n${results.length} matches (${failed} failed), ${results.length - decided.length} undecided after ${rounds} rounds; ` +
  `avg ${(results.reduce((a, r) => a + r.rounds, 0) / Math.max(1, results.length)).toFixed(1)} rounds, ${(results.reduce((a, r) => a + r.ms, 0) / Math.max(1, results.length) / 1000).toFixed(1)}s each`);
if (nPlayers === 2) {
  const first = decided.filter((r) => r.winner === 0).length;
  console.log(`seat 1 (moves first) wins ${pct(first / Math.max(1, decided.length))} of decided matches`);
}

for (const budget of budgets) {
  const rs = results.filter((r) => r.budget === budget);
  if (!rs.length) continue;
  console.log(`\n=== Strategies at ${money(budget)} (${rs.length} matches) ===`);
  const stat = new Map<string, { n: number; w: number; d: number; spent: number; left: number }>();
  for (const r of rs)
    r.strategies.forEach((s, i) => {
      const x = stat.get(s) ?? { n: 0, w: 0, d: 0, spent: 0, left: 0 };
      x.n++;
      if (r.winner === i) x.w++;
      if (r.winner < 0) x.d++;
      x.spent += r.spent[i];
      x.left += r.remaining[i] / Math.max(1, r.spent[i]);
      stat.set(s, x);
    });
  const rows = [...stat].sort((a, c) => c[1].w / c[1].n - a[1].w / a[1].n)
    .map(([s, x]) => [s, x.n, pct(x.w / x.n) + " " + ci(x.w / x.n, x.n), pct(x.d / x.n), money(x.spent / x.n), pct(x.left / x.n)]);
  table(["strategy", "games", "win", "undecided", "avg spent", "value left"], rows, ["l", "r", "r", "r", "r", "r"]);

  if (nPlayers === 2 && strategies.length > 2) {
    console.log(`\nhead to head (row's win rate against column):`);
    const names = [...stat.keys()];
    const rows2 = names.map((a) => [a, ...names.map((c) => {
      if (a === c) return "-";
      const g = rs.filter((r) => r.strategies.includes(a as Strategy) && r.strategies.includes(c as Strategy));
      const w = g.filter((r) => r.strategies[r.winner] === a).length;
      return g.length ? pct(w / g.length) : "";
    })]);
    table(["", ...names.map((n) => n.slice(0, 8))], rows2, ["l", ...names.map(() => "r" as const)]);
  }
}

valueTable(results, "Value by hire (unit type, rank, armor)", (u) => u.key, 8);
valueTable(results, "Value by weapon (soldiers)", (u) => (u.kind === "soldier" ? u.kit : "(non-human)"), 8);
weaponTable(results, 20);
process.exit(0);
