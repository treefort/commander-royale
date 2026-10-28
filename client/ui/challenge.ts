// A challenge's page (/c/<id>): the briefing for a battle's start someone shared, a button to take it on, and
// everyone's goes at it so far.
import { api, el } from "../api.ts";
import { topbar, type Me } from "./home.ts";
import { biomeName } from "../../shared/protocol.ts";
import { tr } from "../../shared/rules/index.ts";

interface Attempt { name: string; you: boolean; matchId?: string; started: number; finished: number | null; won: boolean; rounds: number | null; lost: number | null; kills: number | null }
interface Challenge {
  id: string;
  title: string;
  by: string;
  yours: boolean;
  created: number;
  summary: {
    biome: string; timeOfDay: string; mapBlocks: number; mode: string; turnTimer: number; mapName?: string;
    sides: { name: string; units: number; yours: boolean; reinforcements: number }[];
    squad: { name: string; type: string; armor: string; items: string[] }[];
  };
  attempts: Attempt[];
}

/** Best first: wins (quickest, then fewest lost), then losses (most enemies down), then goes still being played. */
function ranked(attempts: Attempt[]): Attempt[] {
  const k = (a: Attempt) => (!a.finished ? 2 : a.won ? 0 : 1);
  return [...attempts].sort((a, b) => k(a) - k(b) || (a.won
    ? (a.rounds ?? 0) - (b.rounds ?? 0) || (a.lost ?? 0) - (b.lost ?? 0)
    : (b.kills ?? 0) - (a.kills ?? 0) || (a.rounds ?? 0) - (b.rounds ?? 0)) || a.started - b.started);
}

/** "Rifle, Rifle Clip x2" */
function gear(items: string[]): string {
  const n = new Map<string, number>();
  for (const i of items) n.set(i, (n.get(i) ?? 0) + 1);
  return [...n].map(([t, c]) => tr(t) + (c > 1 ? ` x${c}` : "")).join(", ") || "-";
}

export async function renderChallenge(root: HTMLElement, me: Me, id: string, go: (path: string) => void) {
  root.innerHTML = "";
  root.append(topbar(me));
  const wrap = el("div", { class: "wrap challenge" });
  root.append(wrap);
  let c: Challenge;
  try {
    c = await api<Challenge>(`/api/challenges/${id}`);
  } catch (e) {
    wrap.append(el("div", { class: "panel err" }, `Can't open this challenge: ${(e as Error).message}`));
    return;
  }
  const s = c.summary;
  const error = el("div", { class: "err" });
  const play = async () => {
    error.textContent = "";
    try {
      const r = await api<{ id: string }>(`/api/challenges/${id}/play`, { body: {} });
      go(`/m/${r.id}`);
    } catch (e) {
      error.textContent = (e as Error).message;
    }
  };
  const mine = c.attempts.filter((a) => a.you);
  const ongoing = mine.find((a) => !a.finished && a.matchId);
  const wins = c.attempts.filter((a) => a.won).length;
  const url = `${location.origin}/c/${id}`;

  const sides = s.sides.map((p, i) => el("li", { class: p.yours ? "good" : "" },
    `${p.yours ? "Your squad" : p.name}: ${p.units} unit${p.units === 1 ? "" : "s"}${p.reinforcements ? ` + ${p.reinforcements} arriving later` : ""}${i === 0 ? " (moves first)" : ""}`));
  const briefing = el("div", { class: "panel" },
    el("h1", {}, c.title.toUpperCase()),
    el("div", { class: "muted" }, `Challenge set by ${c.by}${c.yours ? " (you)" : ""} · ${new Date(c.created).toLocaleDateString()}`),
    el("p", {}, `${s.mapName ? `${s.mapName} (${biomeName(s.biome)})` : biomeName(s.biome)}, ${s.timeOfDay} · ${s.mapBlocks}x${s.mapBlocks} map${s.turnTimer ? ` · ${Math.round(s.turnTimer / 60) || 1} min turns` : ""}`),
    el("h3", {}, "TURN ORDER"),
    el("ol", { class: "challenge-sides" }, ...sides),
    el("p", { class: "muted" }, "You command the squad below from the very start of the battle; everyone else is the AI. Same map, same soldiers and gear, same starting positions; the dice are your own."),
    el("div", { class: "row" },
      el("button", { class: "primary", onclick: play }, mine.length ? "Have another go" : "Accept the challenge"),
      ongoing ? el("button", { onclick: () => go(`/m/${ongoing.matchId}`) }, "Carry on with your go") : null),
    error,
  );

  const squad = el("div", { class: "panel" },
    el("h2", {}, `YOUR SQUAD (${s.squad.length})`),
    el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", {}, "Unit"), el("th", {}, "Armor"), el("th", {}, "Carrying"))),
      el("tbody", {}, ...s.squad.map((u) => el("tr", {},
        el("td", {}, u.name), el("td", {}, u.type === "SOLDIER" ? "Soldier" : tr(u.type)), el("td", {}, u.armor === "STR_NONE_UC" ? "-" : tr(u.armor)), el("td", {}, gear(u.items)))))));

  const rows = ranked(c.attempts).map((a, i) => el("tr", { class: a.you ? "hired" : "" },
    el("td", {}, a.finished ? String(i + 1) : ""),
    el("td", {}, a.name + (a.you ? " (you)" : "")),
    el("td", { class: !a.finished ? "muted" : a.won ? "good" : "bad" }, !a.finished ? "Playing" : a.won ? "Won" : "Lost"),
    el("td", {}, String(a.rounds ?? "-")),
    el("td", {}, String(a.lost ?? "-")),
    el("td", {}, String(a.kills ?? "-")),
    el("td", { class: "muted" }, new Date(a.finished ?? a.started).toLocaleDateString())));
  const board = el("div", { class: "panel" },
    el("h2", {}, "WHO HAS BEATEN IT"),
    el("div", { class: "muted" }, c.attempts.length ? `${c.attempts.length} go${c.attempts.length === 1 ? "" : "es"}, ${wins} win${wins === 1 ? "" : "s"}` : "Nobody has had a go yet."),
    c.attempts.length ? el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, "Commander"), el("th", {}, "Result"), el("th", {}, "Rounds"), el("th", {}, "Units lost"), el("th", {}, "Enemies down"), el("th", {}, "When"))),
      el("tbody", {}, ...rows)) : null,
    el("h3", { style: { marginTop: "14px" } }, "PASS IT ON"),
    el("div", { class: "row" }, el("span", { class: "invite grow" }, url),
      el("button", { class: "small", onclick: (e: Event) => navigator.clipboard.writeText(url).then(() => ((e.target as HTMLElement).textContent = "Copied"), () => {}) }, "Copy link")),
  );
  wrap.append(briefing, board, squad);
}
