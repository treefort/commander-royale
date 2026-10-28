// The custom maps page: everyone's maps (open, play on, copy, delete your own), a new map (flat, generated, or from
// an AI assistant's recipe), and how to get an assistant to make one.
import { api, el } from "../api.ts";
import { topbar, type Me } from "./home.ts";
import { BIOMES, UFO_CHOICES } from "../../shared/protocol.ts";
import { mapTerrains, MAP_LIMITS, type MapDoc } from "../../shared/maps/format.ts";
import type { Recipe } from "../../shared/maps/recipe.ts";

export interface MapSummary { id: string; name: string; terrain: string; size: string; zones: number; author: string; mine: boolean; updated: number; description: string }

/** What the editor opens next when it's given no id: a recipe to build, or a map document to start from. */
export let pendingMap: { recipe?: unknown; doc?: MapDoc; source?: string } | null = null;
export function setPendingMap(p: typeof pendingMap) {
  pendingMap = p;
}

export function terrainName(t: string): string {
  return BIOMES.find((b) => b.id === t)?.name ?? (t === "XBASE" ? "X-COM Base" : t);
}

/** A recipe (or a map document) from what someone pasted: JSON, a ```json block, or a /maps/new?recipe= link. */
export function parseMapText(text: string): { recipe?: unknown; doc?: MapDoc } {
  let t = text.trim();
  const link = /[?&]recipe=([^&\s]+)/.exec(t);
  if (link) t = decodeURIComponent(link[1]);
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("there's no JSON in that");
  const o = JSON.parse(t.slice(start, end + 1));
  if (o && o.v === 1 && typeof o.parts === "string") return { doc: o as MapDoc };
  return { recipe: o };
}

/** Is this server somewhere an assistant on the web can't reach (then the reference goes along with the prompt)? */
export function unreachableHost(): boolean {
  const host = location.hostname;
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1|\[?f[cd])/.test(host) || /\.(local|lan|home|internal|ts\.net)$/.test(host) || !host.includes(".");
}

export async function copyText(text: string, btn: HTMLButtonElement) {
  try {
    await navigator.clipboard.writeText(text);
    const t = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = t), 1200);
  } catch {
    /* no clipboard access */
  }
}

/** The prompt that starts an assistant off (with the reference itself when it can't fetch it). */
export async function assistantPrompt(ask: string): Promise<string> {
  const origin = location.origin;
  if (!unreachableHost()) return `Read ${origin}/maps.txt (how custom battle maps are made on this Commander Royale server), then ${ask}`;
  let ref = "";
  try {
    ref = await (await fetch("/maps.txt")).text();
  } catch {
    /* it can still try */
  }
  return `The reference below explains how custom battle maps are made on my Commander Royale server (${origin}). Use it to ${ask}\n\n${ref}`;
}

export async function renderMaps(root: HTMLElement, me: Me, go: (path: string) => void) {
  root.innerHTML = "";
  root.append(topbar(me));
  const wrap = el("div", { class: "wrap home" });
  root.append(wrap);
  const list = el("div", { class: "panel home-matches" }, el("h2", {}, "MAPS"), el("div", { class: "muted" }, "Loading..."));
  const create = el("div", { class: "panel home-create" }, el("h2", {}, "NEW MAP"));
  wrap.append(create, list);

  // ---- a new map: a recipe without ops (flat ground or the terrain's generator) ----
  const terrains = mapTerrains();
  const name = el("input", { value: "", placeholder: "Untitled map", maxlength: 40 }) as HTMLInputElement;
  const terrain = el("select", {}, ...terrains.map((t) => el("option", { value: t, selected: t === "URBAN" }, terrainName(t)))) as HTMLSelectElement;
  const num = (v: number, min: number, max: number) => el("input", { type: "number", value: v, min, max, style: { width: "80px" } }) as HTMLInputElement;
  const width = num(50, MAP_LIMITS.minSide, MAP_LIMITS.maxSide), length = num(50, MAP_LIMITS.minSide, MAP_LIMITS.maxSide), levels = num(4, 1, MAP_LIMITS.maxLevels);
  const base = el("select", {},
    el("option", { value: "flat" }, "Flat ground"),
    el("option", { value: "generated" }, "A generated map, like a normal match's")) as HTMLSelectElement;
  const ufo = el("select", {}, ...UFO_CHOICES.filter((u) => u.id !== "STR_BATTLESHIP").map((u) => el("option", { value: u.id }, u.name))) as HTMLSelectElement;
  const ufoRow = el("div", { class: "row" }, el("span", {}, "with a landed UFO:"), ufo);
  const sync = () => {
    ufoRow.style.display = base.value === "generated" ? "" : "none";
    const gen = BIOMES.some((b) => b.id === terrain.value);
    (base.options[1] as HTMLOptionElement).disabled = !gen;
    if (!gen) base.value = "flat";
  };
  base.addEventListener("change", sync);
  terrain.addEventListener("change", sync);
  sync();
  const form = el("div", { class: "form" },
    el("div", {}, "Name"), name,
    el("div", {}, "Terrain"), el("div", { class: "row" }, terrain, el("span", { class: "hint" }, "its ground, walls and furniture, and its original map blocks (any terrain's parts can be added later)")),
    el("div", {}, "Size"), el("div", { class: "row" }, width, el("span", {}, "x"), length, el("span", {}, "tiles,"), levels, el("span", {}, "levels"),
      el("span", { class: "hint" }, "10x10 tiles is one original map block; 50x50 suits 2-4 squads")),
    el("div", {}, "Start from"), el("div", { class: "row" }, base, ufoRow),
    el("div", { class: "full" }, el("button", { class: "primary", onclick: () => {
      const r: Recipe = {
        name: name.value.trim() || "Untitled map", terrain: terrain.value, size: [Number(width.value), Number(length.value)], levels: Number(levels.value),
        base: base.value as "flat" | "generated", seed: Math.floor(Math.random() * 1e9), ...(base.value === "generated" && ufo.value !== "none" ? { ufo: ufo.value } : {}),
      };
      setPendingMap({ recipe: r });
      go("/maps/new");
    } }, "Create map")),
  );

  // ---- an AI assistant makes it ----
  const ask = el("textarea", { rows: 3, placeholder: "Describe the map: where it is, what's on it, how many squads, where they start... e.g. \"a ruined Mars outpost round a crashed supply ship, for 4 squads\"" }) as HTMLTextAreaElement;
  const paste = el("textarea", { rows: 4, placeholder: "Paste what your assistant gave you: the recipe JSON, or its link" }) as HTMLTextAreaElement;
  const out = el("div", {});
  const file = el("input", { type: "file", accept: ".json,application/json", style: { display: "none" } }) as HTMLInputElement;
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      setPendingMap({ ...parseMapText(await f.text()), source: f.name });
      go("/maps/new");
    } catch (e) {
      out.replaceChildren(el("div", { class: "err" }, `Couldn't read ${f.name}: ${(e as Error).message}`));
    }
  });
  const ai = el("details", { class: "ai-panel", open: true },
    el("summary", {}, "Make a map with AI"),
    el("div", { class: "hint", style: { margin: "6px 0" } }, unreachableHost()
      ? "Any AI assistant (Claude, ChatGPT...) can design a map for you. This server isn't on the public internet, so the prompt carries the map reference with it: describe the map, copy the prompt into the chat, and paste back what it answers."
      : "Any AI assistant (Claude, ChatGPT...) can design a map for you: describe it, copy the prompt into the chat, and paste back what it answers (or just open the link it gives you)."),
    ask,
    el("div", { class: "row", style: { margin: "4px 0 10px" } },
      el("button", { class: "small", onclick: async (e: Event) => copyText(await assistantPrompt(`make me a map recipe and give me its link and JSON: ${ask.value.trim() || "<describe the map>"}`), e.target as HTMLButtonElement) }, "Copy prompt"),
      el("a", { href: "/maps.txt", target: "_blank", class: "hint" }, "what the assistant reads")),
    paste,
    el("div", { class: "row", style: { marginTop: "4px" } },
      el("button", { class: "small primary", onclick: () => {
        try {
          setPendingMap({ ...parseMapText(paste.value), source: "your assistant" });
          go("/maps/new");
        } catch (e) {
          out.replaceChildren(el("div", { class: "err" }, `Couldn't read that: ${(e as Error).message}`));
        }
      } }, "Open in the editor"),
      el("button", { class: "small", onclick: () => file.click() }, "Import a file"), file,
      el("span", { class: "hint" }, "a recipe, or a map exported from the editor")),
    out,
  );
  create.append(ai, form);

  try {
    const maps = await api<MapSummary[]>("/api/maps");
    list.replaceChildren(el("h2", {}, `MAPS${maps.length ? ` (${maps.length})` : ""}`));
    if (!maps.length) list.append(el("div", { class: "muted" }, "No custom maps yet. Make one, then choose it under \"Map\" when you create a match."));
    const cards = el("div", { class: "match-cards" });
    for (const m of maps) {
      const open = (e: Event) => {
        e.preventDefault();
        go(`/maps/${m.id}`);
      };
      const [w, l, z] = m.size.split("x");
      cards.append(el("div", { class: "match-card" + (m.mine ? " yours" : "") },
        el("div", { class: "row" }, el("a", { class: "grow match-name", href: `/maps/${m.id}`, onclick: open }, m.name), m.mine ? el("span", { class: "badge dim" }, "Yours") : null),
        el("div", { class: "muted" }, `${terrainName(m.terrain)} · ${w}x${l}, ${z} levels · ${m.zones} landing zones${m.mine ? "" : ` · by ${m.author}`}`),
        m.description ? el("div", { class: "muted" }, m.description.slice(0, 160)) : null,
        el("div", { class: "row", style: { marginTop: "4px", gap: "6px" } },
          el("button", { class: "small", onclick: open }, m.mine ? "Edit" : "Open"),
          el("button", { class: "small primary", title: "Create a match on this map", onclick: () => go(`/?settings=${encodeURIComponent(JSON.stringify({ map: m.id, name: m.name }))}`) }, "Play"),
          el("button", { class: "small", title: "A copy of your own to change", onclick: async () => {
            const st = await api<{ doc: MapDoc }>(`/api/maps/${m.id}`);
            setPendingMap({ doc: { ...st.doc, name: `${st.doc.name} (copy)`.slice(0, 40) }, source: m.name });
            go("/maps/new");
          } }, "Copy"),
          m.mine ? el("button", { class: "small danger", onclick: async () => {
            if (!confirm(`Delete "${m.name}"? Matches already played on it keep their map.`)) return;
            await api(`/api/maps/${m.id}`, { method: "DELETE" });
            renderMaps(root, me, go);
          } }, "Delete") : null),
      ));
    }
    list.append(cards);
  } catch (e) {
    list.append(el("div", { class: "err" }, (e as Error).message));
  }
}
