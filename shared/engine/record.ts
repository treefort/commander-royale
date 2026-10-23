// The statistics record of a finished (or abandoned) match: what everyone hired and how each unit did.
// Written by the server for real games and by the bot arena, so both feed the same balance reports.
import { type Battle, isOut } from "./state.ts";
import { unitStats, type UnitStats } from "./stats.ts";
import { UnitStatus } from "./defs.ts";
import { itemRule, tr, livingWeaponFor, unitRule } from "../rules/index.ts";
import { checkLoadout, trainingCost, trainedRecruit } from "../rules/catalog.ts";
import { memberCost } from "../rules/squads.ts";
import type { MatchSettings, Recruit, Loadout, SquadMember } from "../protocol.ts";

export interface UnitRecord {
  player: number; // seat
  recruitId: string;
  key: string; // "Rookie", "Captain psi (Power Suit)", "Chryssalid Terrorist", "Tank/Cannon"
  kind: Recruit["kind"];
  type: string;
  rank: string;
  armor: string;
  kit: string; // what it held in its hands at deployment
  items: string[]; // everything it carried, loaded ammo included
  recruitStats: Recruit["stats"]; // as it fought (training included)
  price: number; // hire price
  cost: number; // price + armor + gear + training
  /** training courses bought for it (sessions each) */
  training?: SquadMember["training"];
  damage: number; // to enemies
  kills: number; // enemies it finished off
  killValue: number; // their hire price
  survived: boolean;
  outcome: "alive" | "dead" | "unconscious" | "evacuated";
  stats: UnitStats;
}

export interface PlayerRecord {
  seat: number;
  userId: string;
  name: string;
  spent: number;
  hired: number;
  surrendered: boolean;
  /** joined the battle in progress, in this round */
  joinedRound?: number;
  won: boolean;
  bot: boolean; // a computer player
}

export interface MatchRecord {
  v: 1;
  id: string;
  source: "human" | "bot";
  startedAt: number;
  finishedAt: number;
  settings: MatchSettings;
  rounds: number;
  winner: number; // seat, -1 if nobody won (bot matches that hit the round limit)
  players: PlayerRecord[];
  remaining: number[]; // gear-inclusive value of each seat's surviving units
  supplyDrops: { round: number; items: string[]; looted: number }[];
  units: UnitRecord[];
}

const RANK_NAMES: Record<string, string> = {
  STR_ROOKIE: "Rookie", STR_SQUADDIE: "Squaddie", STR_SERGEANT: "Sergeant", STR_CAPTAIN: "Captain", STR_COLONEL: "Colonel", STR_COMMANDER: "Commander",
};
const ARMOR_NAMES: Record<string, string> = { STR_PERSONAL_ARMOR_UC: "Personal Armor", STR_POWER_SUIT_UC: "Power Suit", STR_FLYING_SUIT_UC: "Flying Suit" };

export function armorName(type: string): string {
  return ARMOR_NAMES[type] ?? "No armor";
}

export function recruitKey(r: Recruit, armor: string): string {
  if (r.kind !== "soldier") return tr(r.type);
  const rank = RANK_NAMES[r.rank] ?? r.rank;
  const psi = r.stats.psiSkill > 0 ? " psi" : "";
  return ARMOR_NAMES[armor] ? `${rank}${psi} (${ARMOR_NAMES[armor]})` : rank + psi;
}

export function kitName(r: Recruit, items: Loadout["squad"][number]["items"]): string {
  const inHand = items.filter((it) => it.slot === "STR_RIGHT_HAND" || it.slot === "STR_LEFT_HAND").map((it) => tr(itemRule(it.type).name));
  if (r.kind !== "soldier") {
    const innate = r.kind === "hwp" ? "turret" : livingWeaponFor(unitRule(r.type)) ? "built-in" : "";
    return [innate, ...inHand].filter(Boolean).join(" + ") || "unarmed";
  }
  return inHand.join(" + ") || (items.length ? "grenades" : "unarmed");
}

export function buildRecord(b: Battle, pool: Recruit[], loadouts: Loadout[], id: string, source: MatchRecord["source"]): MatchRecord {
  const killValue = new Map<number, number>();
  const kills = new Map<number, number>();
  for (const v of b.units) {
    if (!isOut(v) || v.status === UnitStatus.IGNORE_ME) continue;
    const k = b.stats.lastHit[v.id];
    if (k === undefined) continue;
    if (v.recruitId !== "spawn") killValue.set(k, (killValue.get(k) ?? 0) + v.value);
    kills.set(k, (kills.get(k) ?? 0) + 1);
  }
  const units: UnitRecord[] = [];
  const remaining = b.players.map(() => 0);
  for (const u of b.units) {
    if (u.recruitId === "spawn") continue; // zombies etc. aren't hires; their damage is still on record in b.stats
    const m = loadouts[u.originalOwner]?.squad.find((x) => x.recruitId === u.recruitId);
    const r = pool.find((x) => x.id === u.recruitId);
    if (!m || !r) continue;
    const alive = !isOut(u) && u.health > 0;
    const cost = memberCost(r, m) + trainingCost(b.settings, r, m.training);
    if (alive) remaining[u.originalOwner] += cost;
    const s = unitStats(b, u.id);
    units.push({
      player: u.originalOwner, recruitId: r.id, key: recruitKey(r, m.armor), kind: r.kind, type: r.type, rank: r.rank, armor: m.armor || "STR_NONE_UC",
      kit: kitName(r, m.items), items: m.items.flatMap((it) => (it.ammo ? [it.type, it.ammo] : [it.type])), recruitStats: trainedRecruit(r, m).stats,
      price: r.price, cost, ...(m.training && trainingCost(b.settings, r, m.training) ? { training: m.training } : {}), damage: Object.values(s.damage).reduce((a, x) => a + x, 0), kills: kills.get(u.id) ?? 0, killValue: killValue.get(u.id) ?? 0,
      survived: alive,
      outcome: u.status === UnitStatus.IGNORE_ME ? "evacuated" : u.status === UnitStatus.DEAD ? "dead" : isOut(u) ? "unconscious" : "alive",
      stats: s,
    });
  }
  const settings = b.settings;
  return {
    v: 1, id, source, startedAt: b.stats.startedAt, finishedAt: Date.now(), settings, rounds: b.round, winner: b.winner,
    players: b.players.map((p, i) => ({
      seat: i, userId: p.userId, name: p.name, spent: loadouts[i] ? checkLoadout(settings, pool, loadouts[i]).cost : 0,
      hired: loadouts[i]?.squad.length ?? 0, surrendered: p.surrendered, won: b.winner === i, bot: p.userId.startsWith("bot"),
      ...(p.joinedRound ? { joinedRound: p.joinedRound } : {}),
    })),
    remaining,
    supplyDrops: b.supply.filter((d) => d.dropped).map((d) => ({
      round: d.dropRound, items: d.items, looted: d.items.length - b.itemsOnTile(b.idxP(d.pos)).filter((id) => d.items.includes(b.item(id)?.type ?? "")).length,
    })),
    units,
  };
}
