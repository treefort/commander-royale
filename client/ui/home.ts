import { api, el, money } from "../api.ts";
import { BIOMES, UFO_CHOICES, defaultSettings, recommendedMapBlocks, biomeName, type MatchSettings } from "../../shared/protocol.ts";
import { budgetGuide } from "../../shared/rules/catalog.ts";

export interface Me {
  user: { id: string; name: string; picture?: string } | null;
  devLogin: boolean;
  google: boolean;
}

export function topbar(me: Me): HTMLElement {
  return el("div", { class: "topbar" },
    el("a", { class: "logo", href: "/" }, "X-COM: BATTLESCAPE"),
    me.user
      ? el("div", { class: "row" },
        el("span", {}, "Commander ", el("b", {}, me.user.name)),
        el("button", { class: "small", onclick: async () => {
          const n = prompt("Your commander name", me.user!.name);
          if (n) {
            await api("/api/me", { body: { name: n } });
            location.reload();
          }
        } }, "Rename"),
        el("a", { class: "btn small", href: "/auth/logout" }, "Sign out"))
      : el("span", {}),
  );
}

export function renderLogin(root: HTMLElement, me: Me, next = location.pathname) {
  root.innerHTML = "";
  const nameInput = el("input", { placeholder: "Commander name", maxlength: 40 }) as HTMLInputElement;
  root.append(
    el("div", { class: "wrap landing" },
      el("h1", {}, "X-COM"),
      el("div", { class: "title", style: { fontSize: "20px", marginBottom: "6px" } }, "UFO DEFENSE — BATTLESCAPE"),
      el("div", { class: "sub" }, "Multiplayer squad combat. Hire soldiers and aliens, kit them out, and fight to the last unit standing."),
      el("div", { class: "panel", style: { maxWidth: "480px", margin: "0 auto" } },
        me.google
          ? el("a", { class: "btn primary", href: `/auth/google?next=${encodeURIComponent(next)}` }, "Sign in with Google")
          : el("div", { class: "muted" }, "Google sign-in isn't configured on this server yet."),
        me.devLogin
          ? el("div", { style: { marginTop: "16px" } },
            el("div", { class: "hint" }, "Local development login:"),
            el("div", { class: "row", style: { justifyContent: "center", marginTop: "6px" } },
              nameInput,
              el("button", { onclick: () => {
                if (nameInput.value.trim()) location.href = `/auth/dev?name=${encodeURIComponent(nameInput.value.trim())}&next=${encodeURIComponent(next)}`;
              } }, "Enter")))
          : null,
      ),
    ),
  );
  nameInput.addEventListener("keydown", (e) => e.key === "Enter" && (nameInput.nextSibling as HTMLButtonElement)?.click());
}

export async function renderHome(root: HTMLElement, me: Me, go: (path: string) => void) {
  root.innerHTML = "";
  root.append(topbar(me));
  const wrap = el("div", { class: "wrap" });
  root.append(wrap);
  const list = el("div", { class: "panel" }, el("h2", {}, "YOUR MATCHES"), el("div", { class: "muted" }, "Loading..."));
  const create = el("div", { class: "panel" }, el("h2", {}, "NEW MATCH"));
  wrap.append(list, create);
  // the form, optionally pre-filled from an earlier match
  const startFrom = el("select", {}, el("option", { value: "" }, "Default settings")) as HTMLSelectElement;
  const formSlot = el("div", {});
  let pastSettings = new Map<string, MatchSettings>();
  const showForm = () => {
    const from = pastSettings.get(startFrom.value);
    // a "Random" environment that was rolled goes back to Random (sanitized again on the server)
    const initial = from ? { ...structuredClone(from), biome: from.randomBiome ? ("RANDOM" as const) : from.biome, timeOfDay: from.randomTime ? ("random" as const) : from.timeOfDay, randomBiome: undefined, randomTime: undefined } : defaultSettings();
    formSlot.replaceChildren(settingsForm(initial, async (s) => {
      const { id } = await api<{ id: string }>("/api/matches", { body: { settings: s } });
      go(`/m/${id}`);
    }, "Create match"));
  };
  startFrom.addEventListener("change", showForm);
  create.append(
    el("div", { class: "row", style: { marginBottom: "10px" } }, el("span", {}, "Start from:"), startFrom,
      el("span", { class: "hint" }, "copy every setting from one of your earlier matches, then change what you like")),
    formSlot,
  );
  showForm();
  try {
    const matches = await api<any[]>("/api/matches");
    pastSettings = new Map(matches.filter((m) => m.settings).map((m) => [m.id, m.settings as MatchSettings]));
    for (const m of matches) {
      if (!m.settings) continue;
      startFrom.append(el("option", { value: m.id }, `${m.name} (${new Date(m.created).toLocaleDateString()}) - ${settingsSummary(m.settings)}`));
    }
    const reuse = (id: string) => {
      startFrom.value = id;
      showForm();
      create.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    list.replaceChildren(el("h2", {}, "YOUR MATCHES"));
    if (!matches.length) list.append(el("div", { class: "muted" }, "No matches yet. Create one below, then send the invite link to your opponents."));
    else {
      const t = el("table", {}, el("tr", {}, el("th", {}, "Match"), el("th", {}, "Biome"), el("th", {}, "Players"), el("th", {}, "Status"), el("th", {}, "")));
      for (const m of matches) {
        const status = m.status === "lobby" ? el("span", { class: "badge dim" }, "Lobby")
          : m.status === "finished" ? el("span", {}, el("span", { class: "badge dim" }, "Finished"), " ", m.winner ? `${m.winner} won` : "")
          : m.yourTurn ? el("span", { class: "badge" }, "Your turn") : el("span", { class: "muted" }, `Round ${m.round}: ${m.turnOf}'s turn`);
        t.append(el("tr", {},
          el("td", {}, el("a", { href: `/m/${m.id}`, onclick: (e: Event) => { e.preventDefault(); go(`/m/${m.id}`); } }, m.name)),
          el("td", {}, biomeName(m.biome)),
          el("td", {}, `${m.players.join(", ")} (${m.players.length}/${m.maxPlayers})`),
          el("td", {}, status),
          el("td", {}, el("button", { class: "small", onclick: () => go(`/m/${m.id}`) }, "Open"), " ",
            m.settings ? el("button", { class: "small", title: "Start a new match with these settings", onclick: () => reuse(m.id) }, "Reuse settings") : null),
        ));
      }
      list.append(el("div", { class: "scroll" }, t));
    }
  } catch (e) {
    list.append(el("div", { class: "err" }, String((e as Error).message)));
  }
}

/** One line describing a match's main settings (for the "Start from" list). */
function settingsSummary(s: MatchSettings): string {
  const drops = s.supplyDrops.enabled ? `drops every ${s.supplyDrops.everyRounds} (${s.supplyDrops.tier})` : "no drops";
  const env = s.randomBiome ? "Random" : biomeName(s.biome);
  return `${s.maxPlayers} squads, ${env}, ${s.randomTime || s.timeOfDay === "random" ? "random time" : s.timeOfDay}, ${money(s.budget)}, ${s.techLevel} tech, ${drops}`;
}

/** The match settings form (create + edit). Budget guidance updates live. */
export function settingsForm(initial: MatchSettings, onSubmit: (s: MatchSettings) => Promise<void>, submitLabel: string, readOnly = false): HTMLElement {
  const s: MatchSettings = structuredClone(initial);
  let mapTouched = s.mapBlocks !== recommendedMapBlocks(s.maxPlayers, s.budget);
  const f = el("div", { class: "form" });
  const err = el("div", { class: "err full" });
  const guide = el("div", { class: "guide full" });
  const mapHint = el("span", { class: "hint" });
  const field = (label: string, input: HTMLElement, hint?: string | HTMLElement) => {
    f.append(el("div", {}, label), el("div", { class: "row" }, input, hint ? (typeof hint === "string" ? el("span", { class: "hint" }, hint) : hint) : null));
  };
  const num = (get: () => number, set: (v: number) => void, min: number, max: number, step = 1) => {
    const i = el("input", { type: "number", min, max, step, value: get(), disabled: readOnly, style: { width: "130px" } }) as HTMLInputElement;
    i.addEventListener("input", () => {
      set(Number(i.value));
      refresh();
    });
    return i;
  };
  const sel = <T extends string>(opts: { id: T; name: string }[], get: () => T, set: (v: T) => void) => {
    const e = el("select", { disabled: readOnly }) as HTMLSelectElement;
    for (const o of opts) e.append(el("option", { value: o.id, selected: o.id === get() }, o.name));
    e.addEventListener("change", () => {
      set(e.value as T);
      refresh();
    });
    return e;
  };
  const check = (get: () => boolean, set: (v: boolean) => void, text: string) => {
    const c = el("input", { type: "checkbox", checked: get(), disabled: readOnly }) as HTMLInputElement;
    c.addEventListener("change", () => {
      set(c.checked);
      refresh();
    });
    return el("label", {}, c, text);
  };
  const mapInput = num(() => s.mapBlocks, (v) => { s.mapBlocks = v; mapTouched = true; }, 4, 10);
  const nameInput = el("input", { value: s.name, maxlength: 40, disabled: readOnly }) as HTMLInputElement;
  nameInput.addEventListener("input", () => (s.name = nameInput.value));

  field("Match name", nameInput);
  const notesInput = el("textarea", { rows: 3, maxlength: 1000, disabled: readOnly, placeholder: "Optional: house rules, when you'll play, what to expect... everyone who joins sees this", class: "notes-input" }) as HTMLTextAreaElement;
  notesInput.value = s.notes ?? "";
  notesInput.addEventListener("input", () => (s.notes = notesInput.value));
  field("Message for players", notesInput);
  field("Players", num(() => s.maxPlayers, (v) => (s.maxPlayers = v), 2, 8), "2–8 squads, free-for-all");
  field("Environment", sel([{ id: "RANDOM" as const, name: "Random (rolled when the battle starts)" }, ...BIOMES.map((b) => ({ id: b.id, name: b.name }))], () => s.biome, (v) => (s.biome = v)));
  field("Time of day", sel([{ id: "random", name: "Random (rolled when the battle starts)" }, { id: "day", name: "Day" }, { id: "dusk", name: "Dusk" }, { id: "night", name: "Night" }] as const, () => s.timeOfDay, (v) => (s.timeOfDay = v)), "At night humans see 9 tiles unless an area is lit; aliens see in the dark");
  field("Landed UFO", sel(UFO_CHOICES, () => s.ufo, (v) => (s.ufo = v)), "Placed in the middle of the map");
  field("Map size (blocks)", mapInput, mapHint);
  const budgetInput = num(() => s.budget, (v) => (s.budget = v), 50_000, 5_000_000, 10_000);
  field("Budget per player", budgetInput);
  f.append(guide);
  field("Squad seats", num(() => s.squadLimit, (v) => (s.squadLimit = v), 1, 30), "A Skyranger holds 14; tanks and other large units take 4");
  field("Recruit pool size", num(() => s.poolSize, (v) => (s.poolSize = v), 10, 80), "Everyone hires from an identical copy of this pool");
  field("Technology", sel([{ id: "conventional", name: "Conventional only" }, { id: "laser", name: "Up to lasers" }, { id: "alien", name: "Everything (plasma, blasters...)" }] as const, () => s.techLevel, (v) => (s.techLevel = v)));
  field("Units", el("div", { class: "row" },
    check(() => s.allowAliens, (v) => (s.allowAliens = v), "Alien recruits"),
    check(() => s.allowHWP, (v) => (s.allowHWP = v), "Tanks (HWPs)"),
    check(() => s.allowArmor, (v) => (s.allowArmor = v), "Armor"),
    check(() => s.psionics, (v) => (s.psionics = v), "Psionics & mind control")));
  field("Supply drops", el("div", { class: "row" },
    check(() => s.supplyDrops.enabled, (v) => (s.supplyDrops.enabled = v), "Enabled"),
    el("span", {}, "every"), num(() => s.supplyDrops.everyRounds, (v) => (s.supplyDrops.everyRounds = v), 1, 20),
    el("span", {}, "rounds, announced"), num(() => s.supplyDrops.warningRounds, (v) => (s.supplyDrops.warningRounds = v), 0, 10),
    el("span", {}, "rounds ahead")));
  field("Drop contents", sel([{ id: "basic", name: "Basic (rifles, grenades, medikits)" }, { id: "advanced", name: "Advanced (cannons, lasers, scanners)" }, { id: "alien", name: "Alien tech (plasma, blasters, psi)" }, { id: "mixed", name: "Mixed (weighted random)" }] as const, () => s.supplyDrops.tier, (v) => (s.supplyDrops.tier = v)));
  field("Turn timer", num(() => s.turnTimer, (v) => (s.turnTimer = v), 0, 3600, 30), "seconds per turn (0 = no limit; play asynchronously)");
  f.append(err);
  if (!readOnly) {
    f.append(el("div", { class: "full" }, el("button", { class: "primary", onclick: async (e: Event) => {
      const btn = e.target as HTMLButtonElement;
      btn.disabled = true;
      err.textContent = "";
      try {
        await onSubmit(s);
      } catch (x) {
        err.textContent = (x as Error).message;
      } finally {
        btn.disabled = false;
      }
    } }, submitLabel)));
  }

  function refresh() {
    const rec = recommendedMapBlocks(s.maxPlayers, s.budget);
    if (!mapTouched) {
      s.mapBlocks = rec;
      mapInput.value = String(rec);
    }
    mapHint.textContent = `${s.mapBlocks * 10}x${s.mapBlocks * 10} tiles. Recommended for ${s.maxPlayers} players: ${rec} (${rec * 10}x${rec * 10})${mapTouched && s.mapBlocks !== rec ? " — overridden" : ""}`;
    const g = budgetGuide(s);
    guide.replaceChildren(
      el("div", { class: "title", style: { fontSize: "12px" } }, `WHAT ${money(s.budget)} BUYS`),
      el("ul", { style: { margin: "4px 0" } }, ...g.examples.map((x) => el("li", {}, x))),
      el("div", { class: "hint" }, g.prices.join(" ")),
    );
  }
  refresh();
  return f;
}
