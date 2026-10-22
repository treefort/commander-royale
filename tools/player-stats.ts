// Balance report from real games: reads the statistics the server records for every finished match.
//
//   bun tools/player-stats.ts [--db data/xcom.sqlite | --json match-records.json] [--since 2026-11-01]
//                             [--min 5] [--csv units.csv] [--include-bots]
//
// On the droplet: `bun tools/player-stats.ts --db /var/lib/xcom/xcom.sqlite`. Or, signed in as one of
// ADMIN_EMAILS, download /api/admin/match-records and pass it with --json.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { armorName, type MatchRecord } from "../shared/engine/record.ts";
import { biomeName } from "../shared/protocol.ts";
import { pct, money, ci, table, valueTable, weaponTable } from "./report.ts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "1" : v;
}

const since = Date.parse(arg("since") ?? "") || 0;
const minN = Number(arg("min", "5"));
let records: MatchRecord[];
if (arg("json")) records = JSON.parse(readFileSync(arg("json")!, "utf8"));
else {
  const path = arg("db", process.env.DB_PATH ?? "./data/xcom.sqlite")!;
  if (!existsSync(path)) throw new Error(`no database at ${path}`);
  const db = new Database(path, { readonly: true });
  records = (db.query("SELECT record FROM match_records WHERE finished >= ? ORDER BY finished").all(since) as { record: string }[]).map((r) => JSON.parse(r.record));
}
records = records.filter((r) => r.finishedAt >= since && (arg("include-bots") || r.source === "human"));
if (!records.length) {
  console.log("No finished matches recorded yet.");
  process.exit(0);
}

const n = records.length;
const avg = (f: (r: MatchRecord) => number) => records.reduce((a, r) => a + f(r), 0) / n;
const users = new Set(records.flatMap((r) => r.players.map((p) => p.userId)));
console.log(`${n} finished matches, ${users.size} players, ${new Date(records[0].finishedAt).toISOString().slice(0, 10)} to ${new Date(records[n - 1].finishedAt).toISOString().slice(0, 10)}`);
console.log(`avg ${avg((r) => r.rounds).toFixed(1)} rounds, ${avg((r) => (r.finishedAt - r.startedAt) / 3600000).toFixed(1)} hours from start to finish, ` +
  `${avg((r) => r.players.length).toFixed(1)} squads; ${pct(avg((r) => (r.players.some((p) => p.surrendered) ? 1 : 0)))} ended with a surrender`);
const firstWins = records.filter((r) => r.winner === 0).length;
console.log(`first to move wins ${pct(firstWins / n)} ${ci(firstWins / n, n)} (fair share ${pct(avg((r) => 1 / r.players.length))})`);
const spend = records.flatMap((r) => r.players.map((p) => ({ share: p.spent / r.settings.budget, won: p.won })));
console.log(`players spend ${pct(spend.reduce((a, s) => a + s.share, 0) / spend.length)} of the budget on average`);

console.log("\n=== Matches by setting ===");
const groups = new Map<string, { n: number; rounds: number }>();
for (const r of records) {
  for (const k of [`map: ${biomeName(r.settings.biome)}`, `time: ${r.settings.timeOfDay}`, `budget: ${money(r.settings.budget)}`, `squads: ${r.players.length}`]) {
    const g = groups.get(k) ?? { n: 0, rounds: 0 };
    g.n++;
    g.rounds += r.rounds;
    groups.set(k, g);
  }
}
table(["setting", "matches", "avg rounds"], [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([k, g]) => [k, g.n, (g.rounds / g.n).toFixed(1)]), ["l", "r", "r"]);

// spending: does a bigger share of the budget, or more bodies, win?
console.log("\n=== Squad shape vs winning ===");
const shape = new Map<string, { n: number; w: number }>();
for (const r of records)
  for (const p of r.players) {
    const units = r.units.filter((u) => u.player === p.seat);
    const avgCost = units.reduce((a, u) => a + u.cost, 0) / Math.max(1, units.length);
    const aliens = units.filter((u) => u.kind !== "soldier").length / Math.max(1, units.length);
    for (const k of [
      `squad size ${units.length <= 4 ? "1-4" : units.length <= 8 ? "5-8" : units.length <= 12 ? "9-12" : "13+"}`,
      `avg unit cost ${avgCost < 25000 ? "<$25k" : avgCost < 50000 ? "$25-50k" : avgCost < 100000 ? "$50-100k" : "$100k+"}`,
      `non-humans ${aliens === 0 ? "none" : aliens < 0.5 ? "some" : aliens < 1 ? "mostly" : "all"}`,
    ]) {
      const x = shape.get(k) ?? { n: 0, w: 0 };
      x.n++;
      if (p.won) x.w++;
      shape.set(k, x);
    }
  }
table(["squad", "squads", "win rate"], [...shape].sort((a, b) => a[0].localeCompare(b[0])).map(([k, x]) => [k, x.n, pct(x.w / x.n) + " " + ci(x.w / x.n, x.n)]), ["l", "r", "r"]);

valueTable(records, "Value by hire (unit type, rank, armor)", (u) => u.key, minN);
valueTable(records, "Value by armor (soldiers)", (u) => (u.kind === "soldier" ? armorName(u.armor) : "(non-human)"), minN);
valueTable(records, "Value by weapon (soldiers)", (u) => (u.kind === "soldier" ? u.kit : "(non-human)"), minN);
weaponTable(records, minN);

console.log("\n=== Tactics ===");
const all = records.flatMap((r) => r.units);
const sum = (f: (u: (typeof all)[number]) => number) => all.reduce((a, u) => a + (u.stats ? f(u) : 0), 0);
const psiA = sum((u) => u.stats.psiAttempts), psiS = sum((u) => u.stats.psiSuccesses);
const shots = sum((u) => Object.values(u.stats.shots).reduce((a, x) => a + x, 0));
console.log(`per unit: ${(sum((u) => u.stats.tilesMoved) / all.length).toFixed(0)} tiles moved, ${(shots / all.length).toFixed(1)} shots (${pct(sum((u) => u.stats.reactionShots) / Math.max(1, shots))} reaction fire), ` +
  `${(sum((u) => u.stats.throws) / all.length).toFixed(2)} throws, ${(sum((u) => u.stats.actions.medikit ?? 0) / all.length).toFixed(2)} medikit uses`);
console.log(`mind control: ${psiA} attempts, ${pct(psiS / Math.max(1, psiA))} succeeded; friendly fire ${pct(sum((u) => u.stats.friendlyDamage) / Math.max(1, sum((u) => u.damage + u.stats.friendlyDamage)))} of all damage`);
const outcomes = new Map<string, number>();
for (const u of all) outcomes.set(u.outcome, (outcomes.get(u.outcome) ?? 0) + 1);
console.log(`unit fates: ${[...outcomes].map(([k, v]) => `${k} ${pct(v / all.length)}`).join(", ")}`);
const drops = records.flatMap((r) => r.supplyDrops);
if (drops.length) console.log(`supply drops: ${drops.length}, ${pct(drops.reduce((a, d) => a + d.looted / Math.max(1, d.items.length), 0) / drops.length)} of their contents looted`);

console.log("\n=== Players ===");
const ps = new Map<string, { name: string; n: number; w: number; spent: number }>();
for (const r of records)
  for (const p of r.players) {
    const x = ps.get(p.userId) ?? { name: p.name, n: 0, w: 0, spent: 0 };
    x.name = p.name;
    x.n++;
    if (p.won) x.w++;
    x.spent += p.spent / r.settings.budget;
    ps.set(p.userId, x);
  }
table(["player", "matches", "wins", "win rate", "budget spent"], [...ps.values()].sort((a, b) => b.w / b.n - a.w / a.n).map((x) => [x.name, x.n, x.w, pct(x.w / x.n), pct(x.spent / x.n)]), ["l", "r", "r", "r", "r"]);

if (arg("csv")) {
  // one row per unit, for spreadsheets
  const head = ["match", "finished", "biome", "time", "budget", "seat", "won", "key", "kind", "type", "armor", "kit", "price", "cost", "damage", "taken", "kills", "killValue", "outcome", "downRound", "tilesMoved", "tuSpent", "shots", "hits", "reactionShots", "throws", "psiAttempts", "psiSuccesses"];
  const rows = records.flatMap((r) => r.units.map((u) => [
    r.id, new Date(r.finishedAt).toISOString(), r.settings.biome, r.settings.timeOfDay, r.settings.budget, u.player, r.winner === u.player ? 1 : 0, u.key, u.kind, u.type, u.armor, u.kit,
    u.price, u.cost, u.damage, u.stats.damageTaken, u.kills, u.killValue, u.outcome, u.stats.downRound, u.stats.tilesMoved, u.stats.tuSpent,
    Object.values(u.stats.shots).reduce((a, x) => a + x, 0), Object.values(u.stats.hits).reduce((a, x) => a + x, 0), u.stats.reactionShots, u.stats.throws, u.stats.psiAttempts, u.stats.psiSuccesses,
  ]));
  const esc = (v: unknown) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  writeFileSync(arg("csv")!, [head, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n");
  console.log(`\nwrote ${rows.length} unit rows to ${arg("csv")}`);
}
process.exit(0);
