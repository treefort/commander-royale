// Play links from an AI assistant (/play?setup=<json>): what the link will set up (the map, built from a recipe, a
// custom map or generated; the rules; the opponents) and buttons to create it, with the squad auto-configured or left
// for the player to hire and equip (the battle then starts when they're ready). Nothing is created before a click.
import { api, el, money } from "../api.ts";
import { topbar, type Me } from "./home.ts";
import { terrainName } from "./maps.ts";
import { biomeName, DEFAULT_BOT_TUNING, type BotTuning } from "../../shared/protocol.ts";
import { STRATEGY_NAMES } from "../../shared/rules/squads.ts";
import { enemyTypeChoices } from "../../shared/rules/scenario.ts";
import { checkSetup, parseSetupText, settingsDelta, type PlaySetup } from "../../shared/settings-docs.ts";

const AGGRESSION = ["cautious", "normal", "bold", "reckless"];

function opponentText(o: PlaySetup["opponents"][number]): string {
  const extras: string[] = [];
  if (o.ai.aggression !== DEFAULT_BOT_TUNING.aggression) extras.push(AGGRESSION[o.ai.aggression]);
  if (o.ai.strength !== 100) extras.push(`${o.ai.strength}% strength`);
  const changed = (Object.keys(o.ai) as (keyof BotTuning)[]).some((k) => k !== "aggression" && k !== "strength" && o.ai[k] !== DEFAULT_BOT_TUNING[k]);
  if (changed) extras.push("tuned AI");
  return `${o.strategy ? STRATEGY_NAMES[o.strategy] : "a random strategy"}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

function mapText(p: PlaySetup): string {
  const s = p.settings;
  if (p.recipe) {
    const r = p.recipe as { name?: unknown; terrain?: unknown; size?: unknown };
    const size = Array.isArray(r.size) ? `${r.size[0]}x${r.size[1]}` : `${Number(r.size) || 50}x${Number(r.size) || 50}`;
    return `"${String(r.name ?? "AI map")}", a new ${terrainName(String(r.terrain ?? "").toUpperCase())} map (${size} tiles) built for this match and saved to your maps`;
  }
  if (s.map) return "a custom map from the map editor";
  const size = s.mapBlocks ? `${s.mapBlocks * 10}x${s.mapBlocks * 10}` : "sized for the squads";
  const ufo = s.ufo === "none" ? "" : ", a landed UFO";
  return `generated: ${s.biome === "RANDOM" ? "a random environment" : biomeName(s.biome)}, ${size}${ufo}`;
}

export function renderPlay(root: HTMLElement, me: Me, go: (path: string) => void) {
  root.innerHTML = "";
  root.append(topbar(me));
  const panel = el("div", { class: "panel" });
  root.append(el("div", { class: "wrap", style: { maxWidth: "900px" } }, panel));
  let raw: unknown;
  try {
    raw = parseSetupText(new URLSearchParams(location.search).get("setup") ?? "");
  } catch (e) {
    panel.append(el("h2", {}, "PLAY LINK"), el("div", { class: "err" }, `This link doesn't hold a match setup (${(e as Error).message}). Ask your assistant for the link again.`));
    return;
  }
  const { setup, warnings } = checkSetup(raw);
  const s = setup.settings;
  const coop = s.mode === "coop";
  const line = (label: string, text: string) => el("div", { class: "row", style: { alignItems: "baseline", gap: "8px", margin: "4px 0" } }, el("b", { style: { minWidth: "110px" } }, label), el("span", { class: "grow" }, text));
  const units = [s.allowAliens ? "alien recruits" : "", s.allowHWP ? "tanks" : "", s.allowArmor ? "armor" : "", s.psionics ? "psionics" : ""].filter(Boolean);
  const names = new Map(enemyTypeChoices().map((t) => [t.id, t.name]));
  const force = s.scenario.enemies.map((g) => `${g.count} × ${names.get(g.type) ?? g.type}${g.round > 1 ? ` (from round ${g.round})` : ""}`).join(", ");
  const status = el("div", { class: "hint", style: { marginTop: "8px" } });
  const err = el("div", { class: "err" });
  const buttons: HTMLButtonElement[] = [];
  const play = async (squad: PlaySetup["squad"]) => {
    for (const b of buttons) b.disabled = true;
    err.textContent = "";
    status.textContent = setup.recipe ? "Building the map and setting up the match..." : "Setting up the match...";
    try {
      const r = await api<{ id: string; started: boolean }>("/api/play", { body: { setup: { ...(raw as object), squad } } });
      go(`/m/${r.id}`);
    } catch (e) {
      status.textContent = "";
      err.textContent = (e as Error).message;
      for (const b of buttons) b.disabled = false;
    }
  };
  const auto = el("button", { class: setup.squad === "auto" ? "primary" : "", onclick: () => play("auto") }, "Play now") as HTMLButtonElement;
  const equip = el("button", { class: setup.squad === "equip" ? "primary" : "", onclick: () => play("equip") }, "Set up my squad first") as HTMLButtonElement;
  buttons.push(auto, equip);
  const waitsForFriends = !coop && !setup.opponents.length;
  panel.append(...([
    el("h2", {}, s.name.toUpperCase()),
    s.notes ? el("p", { class: "muted", style: { whiteSpace: "pre-wrap" } }, s.notes) : null,
    line("Mode", coop ? `Co-op: you${s.scenario.teamName ? ` (${s.scenario.teamName})` : ""} against ${s.scenario.enemyName}: ${force}` : "Free-for-all: last squad standing wins"),
    coop ? null : line("Opponents", setup.opponents.length ? setup.opponents.map(opponentText).join("; ") : "none yet: friends join with the invite link (the battle starts once one is ready)"),
    line("Map", mapText(setup)),
    line("Time", s.timeOfDay === "random" ? "random time of day" : s.timeOfDay),
    line("Your squad", `${money(s.budget)}, ${coop ? s.scenario.seatsPerPlayer : s.squadLimit} seats, ${s.techLevel === "alien" ? "all technology" : s.techLevel === "laser" ? "up to lasers" : "conventional weapons"}${units.length ? `, ${units.join(", ")}` : ""}`),
    line("Extras", [s.supplyDrops.enabled ? `supply drops every ${s.supplyDrops.everyRounds} rounds` : "no supply drops", s.stranger ? `Mysterious Stranger ${s.stranger}%` : "", s.turnTimer ? `${s.turnTimer}s turn timer` : "no turn timer"].filter(Boolean).join(", ")),
    warnings.length ? el("div", { class: "hint", style: { color: "var(--orange)", marginTop: "8px" } }, "Adjusted from what your assistant asked (tell it if that's not what you wanted):", el("ul", { style: { margin: "4px 0" } }, ...warnings.map((w) => el("li", {}, w)))) : null,
    el("div", { class: "row", style: { marginTop: "14px" } }, auto, el("span", { class: "hint" }, waitsForFriends ? "a squad is hired and equipped for you, ready for when friends join" : "a squad is hired and equipped for you, and the battle starts")),
    el("div", { class: "row", style: { marginTop: "8px" } }, equip, el("span", { class: "hint" }, waitsForFriends ? "hire and equip your squad, then press Ready" : "hire and equip your squad; the battle starts when you press Ready")),
    status,
    err,
    el("div", { class: "hint", style: { marginTop: "12px" } },
      setup.recipe
        ? el("a", { href: `/maps/new?recipe=${encodeURIComponent(JSON.stringify(setup.recipe))}`, target: "_blank" }, "Look at the map in the editor first")
        : el("span", {}, el("a", { href: `/?settings=${encodeURIComponent(JSON.stringify(settingsDelta(s)))}` }, "Change the settings in the New Match form instead"), coop ? "" : " (add computer squads in the lobby)")),
  ] as (HTMLElement | null)[]).filter((x): x is HTMLElement => !!x));
}
