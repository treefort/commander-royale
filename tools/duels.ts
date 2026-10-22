// Price calibration: equal-budget duels between "mono squads" (copies of one hire with a standard
// kit) and a reference platoon of squaddies with mixed weapons. A fairly priced class wins about half the time.
//
//   bun tools/duels.ts [--size 16] [--games 12] [--only Sectoid,Rookie] [--kits] [--workers N] [--out file.json] [--calibrate]
//
// --kits compares weapons/armor instead: the same median soldier with each kit/armor option.
// --calibrate nudges shared/rules/calibration.json towards even (unit price multipliers for aliens and
// tanks; weapon and armor prices with --kits). Run it a few times; each pass is damped.
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { defaultSettings, type MatchSettings, type Recruit, type Loadout } from "../shared/protocol.ts";
import { generatePool, checkLoadout, seatsFor, itemPrice, armorPrice, ARMOR_PRICES, CATALOG } from "../shared/rules/catalog.ts";
import { equip, memberCost, kitsFor, type Kit } from "../shared/rules/squads.ts";
import { livingWeaponFor, unitRule } from "../shared/rules/index.ts";
import type { MatchSpec, MatchResult } from "./arena.ts";
import { recruitKey } from "./arena.ts";
import { playAll } from "./pool.ts";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? "1" : v;
}
const refSize = Number(arg("size", "16"));
const budget = 300000;
const games = Number(arg("games", "12"));
const workers = Number(arg("workers", String(Math.max(1, cpus().length - 2))));
const only = arg("only")?.split(",").map((x) => x.toLowerCase());
const kitMode = !!arg("kits");
const out = arg("out");

// plenty of seats so money, not the seat limit, decides squad size (and a platoon can face a hovertank)
const settings: MatchSettings = { ...defaultSettings(), budget, squadLimit: 60, poolSize: 80 };
const ref = generatePool(settings, 4242);
const kits = kitsFor(settings);
const kit = (n: string) => kits.find((k) => k.name === n)!;

interface Entry { name: string; recruit: Recruit; armor: string; kit: Kit | null; kits?: Kit[]; alt?: Recruit }
const median = <T,>(xs: T[], f: (x: T) => number) => [...xs].sort((a, b) => f(a) - f(b))[Math.floor(xs.length / 2)];

const entries: Entry[] = [];
const soldiers = ref.filter((r) => r.kind === "soldier" && r.stats.psiSkill === 0);
// soldiers are measured with a rifle; aliens with the plasma rifle they'll usually be handed (a good shot makes a
// good gun better, so aliens priced with rifles turn out cheap once they carry plasma)
const rifleOr = (r: Recruit) => (r.kind === "alien" && livingWeaponFor(unitRule(r.type)) ? null : r.kind === "alien" ? kits.find((k) => k.name === "plasma rifle") ?? kit("rifle") : kit("rifle"));
if (kitMode) {
  // half the duels on an average squaddie, half on a captain: good gear tends to go to good shots
  const base = median(soldiers.filter((r) => r.rank === "STR_SQUADDIE"), (r) => r.price);
  const alt = median(soldiers.filter((r) => r.rank === "STR_CAPTAIN"), (r) => r.price);
  for (const k of kits) if (k.weapon) entries.push({ name: k.name, recruit: base, alt, armor: "STR_NONE_UC", kit: k });
  for (const a of Object.keys(ARMOR_PRICES)) if (a !== "STR_NONE_UC") entries.push({ name: "rifle + " + recruitKey(base, a).replace(/^.*\(|\)$/g, ""), recruit: base, alt, armor: a, kit: kit("rifle") });
} else {
  for (const rank of ["STR_ROOKIE", "STR_SQUADDIE", "STR_SERGEANT", "STR_CAPTAIN", "STR_COLONEL", "STR_COMMANDER"]) {
    const rs = soldiers.filter((r) => r.rank === rank);
    if (rs.length) entries.push({ name: recruitKey(rs[0], "STR_NONE_UC"), recruit: median(rs, (r) => r.price), armor: "STR_NONE_UC", kit: kit("rifle") });
  }
  const psi = ref.filter((r) => r.kind === "soldier" && r.stats.psiSkill > 0);
  if (psi.length) entries.push({ name: "psi soldier + Psi-Amp", recruit: median(psi, (r) => r.price), armor: "STR_NONE_UC", kit: { ...kit("rifle"), extras: ["STR_PSI_AMP", "STR_RIFLE_CLIP"] } });
  const seen = new Set<string>();
  for (const r of ref) {
    if (r.kind === "soldier" || seen.has(r.type)) continue;
    seen.add(r.type);
    entries.push({ name: recruitKey(r, ""), recruit: r, armor: "STR_NONE_UC", kit: r.kind === "hwp" ? null : rifleOr(r) });
  }
}
const chosen = only ? entries.filter((e) => only.some((o) => e.name.toLowerCase().includes(o))) : entries;

/** Copies of the entry (each a separate recruit in the duel pool), as many as `budget` buys, at most `max`. */
function monoSquad(e: Entry, prefix: string, pool: Recruit[], budget: number, max = 40): Loadout {
  const squad: Loadout["squad"] = [];
  let cost = 0, seats = 0;
  for (let k = 0; k < max; k++) {
    const r = { ...e.recruit, id: `${prefix}${k}` };
    const m = equip(r, e.armor, e.kits ? e.kits[k % e.kits.length] : e.kit);
    const c = memberCost(r, m);
    if (cost + c > budget || seats + seatsFor(r) > settings.squadLimit) break;
    pool.push(r);
    squad.push(m);
    cost += c;
    seats += seatsFor(r);
  }
  return { squad, stash: [] };
}

// the reference: a mixed platoon of median squaddies, so armor isn't judged against rifles alone
const refEntry: Entry = {
  name: "reference platoon", recruit: median(soldiers.filter((r) => r.rank === "STR_SQUADDIE"), (r) => r.price), armor: "STR_NONE_UC", kit: kit("rifle"),
  kits: ["rifle", "heavy cannon", "rifle", "laser rifle", "rocket launcher", "plasma rifle"].map(kit),
};
const specs: (MatchSpec & { entry: string })[] = [];
for (const entry of chosen)
  for (let g = 0; g < games; g++) {
    const e = entry.alt && Math.floor(g / 2) % 2 ? { ...entry, recruit: entry.alt } : entry;
    const pool: Recruit[] = [];
    // the reference platoon has a fixed size (so its strength doesn't drift as prices are calibrated);
    // pick the size whose cost a whole number of the tested hire matches best, so neither side wastes money
    const one = memberCost(e.recruit, equip(e.recruit, e.armor, e.kits?.[0] ?? e.kit));
    const refCost = (n: number) => { const p: Recruit[] = []; const l = monoSquad(refEntry, "x", p, Infinity, n); return l.squad.reduce((a, m) => a + memberCost(p.find((x) => x.id === m.recruitId)!, m), 0); };
    let bestN = refSize, bestWaste = Infinity;
    for (let n = refSize; n <= settings.squadLimit; n++) {
      const c = refCost(n);
      const k = Math.floor((c * 1.03) / one);
      if (k < 1) continue;
      const waste = Math.abs(c - k * one) / c + (k < 2 ? 0.2 : 0) + (n - refSize) * 0.002;
      if (waste < bestWaste) {
        bestWaste = waste;
        bestN = n;
      }
    }
    const r = monoSquad(refEntry, "r", pool, Infinity, bestN);
    const b = Math.max(refCost(bestN), Math.floor((refCost(bestN) * 1.03) / one) * one);
    const a = monoSquad(e, "a", pool, b);
    if (!a.squad.length) continue;
    const s = { ...settings, budget: b, poolSize: pool.length };
    if (!checkLoadout(s, pool, a).ok || !checkLoadout(s, pool, r).ok) throw new Error("bad duel squad " + e.name);
    // alternate who moves first
    const flip = g % 2 === 1;
    specs.push({
      entry: e.name, seed: 7000 + g, strategies: ["random", "random"], randomMap: true, maxRounds: 50, settings: { budget: b, squadLimit: settings.squadLimit, timeOfDay: "day" },
      pool, loadouts: flip ? [r, a] : [a, r], names: flip ? ["reference", e.name] : [e.name, "reference"],
    });
  }

if (arg("trace")) {
  // play one duel per class in-process and summarise what the bots did
  const { runMatch } = await import("./arena.ts");
  for (const e of chosen) {
    const sp = specs.find((x) => x.entry === e.name)!;
    const counts: Record<string, number> = {};
    const r = runMatch({ ...sp, log: (l) => {
      const m = l.match(/^(rejected )?(?:r\d+ )?p(\d) \{"c":"(\w+)".*?(?:: (\w+))?$/);
      if (m) counts[`p${m[2]}:${m[3]}${m[1] ? "!" + (m[4] ?? "") : ""}`] = (counts[`p${m[2]}:${m[3]}${m[1] ? "!" + (m[4] ?? "") : ""}`] ?? 0) + 1;
    } });
    const me = sp.names![0] === "reference" ? 1 : 0;
    console.log(`${e.name} (p${me}): winner p${r.winner} in ${r.rounds} rounds; dmg ${r.units.filter((u) => u.player === me).reduce((a, u) => a + u.damage, 0)} vs ${r.units.filter((u) => u.player !== me).reduce((a, u) => a + u.damage, 0)}`);
    console.log("  " + Object.entries(counts).sort().map(([k, v]) => `${k}=${v}`).join(" "));
  }
  process.exit(0);
}
console.log(`${chosen.length} classes x ${games} duels vs a ${refSize}+ man ${refEntry.name} (${specs.length} matches, ${workers} workers)`);
const t0 = performance.now();
const results: (MatchResult & { entry: string; flip: boolean })[] = [];
await playAll(specs, workers, (sp, result, error) => {
  if (result) results.push({ ...result, entry: sp.entry, flip: sp.names![0] === "reference" });
  else console.error(`duel ${sp.entry} failed: ${error}`);
  process.stdout.write(`
${results.length}/${specs.length} (${((performance.now() - t0) / 1000).toFixed(0)}s)   `);
});
console.log();
if (out) writeFileSync(out, JSON.stringify(results));

const rows = chosen.map((e) => {
  const rs = results.filter((r) => r.entry === e.name);
  const side = (r: (typeof results)[number]) => (r.flip ? 1 : 0);
  const wins = rs.filter((r) => r.winner === side(r)).length;
  const draws = rs.filter((r) => r.winner < 0).length;
  // undecided matches count half, scored by the share of value left standing
  const score = rs.reduce((a, r) => a + (r.winner < 0 ? r.remaining[side(r)] / Math.max(1, r.remaining[0] + r.remaining[1]) : r.winner === side(r) ? 1 : 0), 0) / Math.max(1, rs.length);
  const unit = rs[0]?.units.find((u) => u.player === side(rs[0]));
  const n = rs[0] ? rs[0].units.filter((u) => u.player === side(rs[0])).length : 0;
  // rough price that would make it even, assuming strength grows with the square of numbers
  const p = Math.min(0.95, Math.max(0.05, score));
  const fair = unit ? unit.cost * Math.sqrt(p / (1 - p)) : 0;
  return { name: e.name, n: rs.length, wins, draws, score, price: unit?.price ?? 0, cost: unit?.cost ?? 0, count: n, fair };
}).sort((a, b) => b.score - a.score);
const w = Math.max(...rows.map((r) => r.name.length));
console.log(`${"class".padEnd(w)}  games  score  W/D      price  w/ gear  squad  ~even cost`);
for (const r of rows)
  console.log(`${r.name.padEnd(w)}  ${String(r.n).padStart(5)}  ${(100 * r.score).toFixed(0).padStart(4)}%  ${String(r.wins).padStart(2)}/${String(r.draws).padEnd(2)}  ${("$" + Math.round(r.price / 100) / 10 + "k").padStart(8)}  ${("$" + Math.round(r.cost / 100) / 10 + "k").padStart(7)}  ${String(r.count).padStart(5)}  ${("$" + Math.round(r.fair / 1000) + "k").padStart(10)}`);

if (arg("calibrate")) {
  const file = join(import.meta.dir, "..", "shared", "rules", "calibration.json");
  const cal = JSON.parse(readFileSync(file, "utf8")) as { units: Record<string, number>; items: Record<string, number>; armor: Record<string, number> };
  for (const r of rows) {
    if (r.n < 6) continue;
    const e = chosen.find((x) => x.name === r.name)!;
    const p = Math.min(0.92, Math.max(0.08, r.score));
    if (Math.abs(p - 0.5) < 0.1) continue; // within noise of even
    // results swing hard with a few % of money (an extra body snowballs), so take small steps
    const factor = Math.min(1.25, Math.max(0.8, Math.pow(p / (1 - p), 0.15)));
    if (!kitMode) {
      if (e.recruit.kind === "soldier") continue;
      // floor: bots are poor with melee monsters and psi, players won't be
      cal.units[e.recruit.type] = Math.max(0.2, Math.round((cal.units[e.recruit.type] ?? 1) * factor * 100) / 100);
      console.log(`calibrate ${e.recruit.type}: x${factor.toFixed(2)} -> ${cal.units[e.recruit.type]}`);
    } else {
      const delta = r.cost * (factor - 1);
      if (e.armor !== "STR_NONE_UC") {
        const old = armorPrice(e.armor);
        cal.armor[e.armor] = Math.max(1000, Math.round((old + delta) / 500) * 500);
        console.log(`calibrate ${e.armor}: $${old} -> $${cal.armor[e.armor]}`);
      } else if (e.kit?.weapon) {
        // guns move half as fast and stay within 0.4x-2.5x of their catalog price, so the shop still makes sense
        const old = itemPrice(e.kit.weapon);
        const base = CATALOG.find((c) => c.type === e.kit!.weapon)!.price;
        cal.items[e.kit.weapon] = Math.min(base * 2.5, Math.max(base * 0.4, Math.round((old + delta) / 100) * 100));
        console.log(`calibrate ${e.kit.weapon}: $${old} -> $${cal.items[e.kit.weapon]}`);
      }
    }
  }
  writeFileSync(file, JSON.stringify(cal, null, 2) + "\n");
}
process.exit(0);
