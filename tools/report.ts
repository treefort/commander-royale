// Text tables shared by the balance reports (bot tournaments and real-game statistics).
import type { MatchRecord, UnitRecord } from "../shared/engine/record.ts";
import { tr } from "../shared/rules/index.ts";

export const pct = (x: number) => (100 * x).toFixed(0).padStart(3) + "%";
export const money = (n: number) => "$" + Math.round(n / 1000) + "k";
export const ci = (p: number, n: number) => (n ? "±" + (196 * Math.sqrt((p * (1 - p)) / n)).toFixed(0).padStart(2) : "");

export function table(head: string[], rows: (string | number)[][], align: ("l" | "r")[]) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r: (string | number)[]) => r.map((c, i) => (align[i] === "l" ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join("  ");
  console.log(line(head));
  console.log(w.map((n) => "-".repeat(n)).join("  "));
  for (const r of rows) console.log(line(r));
}

/** What each kind of hire did for its money. */
export function valueTable(records: MatchRecord[], title: string, keyOf: (u: UnitRecord) => string, minN: number) {
  const m = new Map<string, { n: number; cost: number; dmg: number; taken: number; kills: number; kv: number; alive: number; wins: number }>();
  for (const r of records)
    for (const u of r.units) {
      const k = keyOf(u);
      const x = m.get(k) ?? { n: 0, cost: 0, dmg: 0, taken: 0, kills: 0, kv: 0, alive: 0, wins: 0 };
      x.n++;
      x.cost += u.cost;
      x.dmg += u.damage;
      x.taken += u.stats?.damageTaken ?? 0;
      x.kills += u.kills;
      x.kv += u.killValue;
      x.alive += u.survived ? 1 : 0;
      x.wins += r.winner === u.player ? 1 : 0;
      m.set(k, x);
    }
  console.log(`\n=== ${title} ===`);
  console.log("exchange = enemy value it finished off / what it cost (1.0 pays for itself); dmg/$1k = damage dealt per $1000 spent");
  const rows = [...m].filter(([, x]) => x.n >= minN).sort((a, c) => c[1].kv / c[1].cost - a[1].kv / a[1].cost)
    .map(([k, x]) => [k, x.n, money(x.cost / x.n), (x.kv / x.cost).toFixed(2), ((x.dmg / x.cost) * 1000).toFixed(1), (x.taken / x.n).toFixed(0), (x.kills / x.n).toFixed(2), pct(x.alive / x.n), pct(x.wins / x.n)]);
  table(["hired", "n", "avg cost", "exchange", "dmg/$1k", "dmg taken", "kills", "survived", "on winner"], rows, ["l", "r", "r", "r", "r", "r", "r", "r", "r"]);
}

/** Shots, hits and damage by weapon, from the per-unit statistics. */
export function weaponTable(records: MatchRecord[], minShots: number) {
  const m = new Map<string, { shots: number; hits: number; dmg: number; users: Set<string> }>();
  for (const r of records)
    for (const u of r.units) {
      if (!u.stats) continue;
      const weapons = new Set([...Object.keys(u.stats.shots), ...Object.keys(u.stats.hits)]);
      for (const w of weapons) {
        const x = m.get(w) ?? { shots: 0, hits: 0, dmg: 0, users: new Set() };
        x.shots += u.stats.shots[w] ?? 0;
        x.hits += u.stats.hits[w] ?? 0;
        x.dmg += u.stats.damage[w] ?? 0;
        x.users.add(r.id + ":" + u.player + ":" + u.recruitId);
        m.set(w, x);
      }
    }
  console.log("\n=== Weapons in use ===");
  console.log("hits include ones armor stopped; a blast counts every unit it catches; thrown and melee weapons have no shots");
  const rows = [...m].filter(([, x]) => x.shots >= minShots || x.hits >= minShots).sort((a, c) => c[1].dmg - a[1].dmg)
    .map(([w, x]) => [w === "other" ? "fire / other" : tr(w), x.users.size, x.shots, x.hits, x.shots ? (x.hits / x.shots).toFixed(2) : "-", x.hits ? (x.dmg / x.hits).toFixed(0) : "-", x.dmg]);
  table(["weapon", "carriers", "shots", "hits", "hits/shot", "dmg/hit", "total dmg"], rows, ["l", "r", "r", "r", "r", "r", "r"]);
}
