import { api, el, money } from "../api.ts";
import { boxArtScene } from "./boxart.ts";
import { BIOMES, UFO_CHOICES, PLACEMENTS, MAX_SQUAD_SIZE, defaultSettings, recommendedMapBlocks, recommendedScenarioBlocks, biomeName, type MatchSettings, type GameMode, type BotTuning } from "../../shared/protocol.ts";
import { enemyTypeChoices, weaponChoices } from "../../shared/rules/scenario.ts";
import { checkSettings, parseSettingsText, settingsDelta } from "../../shared/settings-docs.ts";
import { budgetGuide } from "../../shared/rules/catalog.ts";

export interface Me {
  user: { id: string; name: string; picture?: string } | null;
  /** signed in, but the server wants its passkey before this account can play */
  needsPasskey?: boolean;
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

/** Google's "G" mark, for the sign-in button. */
const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.7 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>`;

export function renderLogin(root: HTMLElement, me: Me, next = location.pathname) {
  root.innerHTML = "";
  const nameInput = el("input", { placeholder: "Commander name", maxlength: 40 }) as HTMLInputElement;
  const google = el("a", { class: "btn bx-google", href: `/auth/google?next=${encodeURIComponent(next)}` });
  google.innerHTML = `${GOOGLE_G}<span>Sign in with Google</span>`;
  const card = el("div", { class: "bx-card" },
    el("p", { class: "bx-lead" }, "Multiplayer battlescape: hire soldiers and aliens, kit them out, and fight to the last unit standing — or team up against an invasion."),
    me.google ? google : el("p", { class: "muted" }, "Google sign-in isn't configured on this server yet."),
    me.devLogin
      ? el("div", { style: { marginTop: "14px" } },
        el("div", { class: "hint" }, "Local development login:"),
        el("div", { class: "bx-row", style: { marginTop: "6px" } },
          nameInput,
          el("button", { onclick: () => {
            if (nameInput.value.trim()) location.href = `/auth/dev?name=${encodeURIComponent(nameInput.value.trim())}&next=${encodeURIComponent(next)}`;
          } }, "Enter")))
      : null,
  );
  root.append(boxArtScene(card));
  nameInput.addEventListener("keydown", (e) => e.key === "Enter" && (nameInput.nextSibling as HTMLButtonElement)?.click());
}

/** The passkey a signed-in account enters once before it can play on this server. */
export function renderPasskey(root: HTMLElement, me: Me, onUnlocked: () => void) {
  root.innerHTML = "";
  const input = el("input", { type: "password", placeholder: "Passkey", maxlength: 100, autocomplete: "off" }) as HTMLInputElement;
  const msg = el("div", { class: "err" });
  const submit = async () => {
    msg.textContent = "";
    try {
      await api("/api/passkey", { body: { passkey: input.value } });
      onUnlocked();
    } catch (e) {
      msg.textContent = (e as Error).message;
      input.select();
    }
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  const card = el("div", { class: "bx-card" },
    el("p", { class: "bx-lead" }, `Welcome, Commander ${me.user!.name}.`),
    el("p", {}, "This server is for invited players: enter the passkey you were given. You only need it once."),
    el("div", { class: "bx-row" }, input, el("button", { class: "primary", onclick: submit }, "Enter")),
    msg,
    el("p", { class: "hint", style: { margin: "12px 0 0" } }, "Not you? ", el("a", { href: "/auth/logout" }, "Sign out")),
  );
  root.append(boxArtScene(card));
  input.focus();
}

export async function renderHome(root: HTMLElement, me: Me, go: (path: string) => void) {
  root.innerHTML = "";
  root.append(topbar(me));
  // two columns: the new-match form on the left, your matches on the right (scrolling on their own, so a long
  // history never pushes the form down); stacked on narrow screens
  const wrap = el("div", { class: "wrap home" });
  root.append(wrap);
  const list = el("div", { class: "panel home-matches" }, el("h2", {}, "YOUR MATCHES"), el("div", { class: "muted" }, "Loading..."));
  const create = el("div", { class: "panel home-create" }, el("h2", {}, "NEW MATCH"));
  wrap.append(create, list);
  // the form, optionally pre-filled from an earlier match
  const startFrom = el("select", { class: "start-from" }, el("option", { value: "" }, "Default settings")) as HTMLSelectElement;
  const formSlot = el("div", {});
  let pastSettings = new Map<string, MatchSettings>();
  let form: ReturnType<typeof settingsForm> | null = null;
  const showForm = (given?: MatchSettings) => {
    const from = pastSettings.get(startFrom.value);
    // a "Random" environment that was rolled goes back to Random (sanitized again on the server)
    const initial = given ?? (from ? { ...structuredClone(from), biome: from.randomBiome ? ("RANDOM" as const) : from.biome, timeOfDay: from.randomTime ? ("random" as const) : from.timeOfDay, randomBiome: undefined, randomTime: undefined } : defaultSettings());
    form = settingsForm(initial, async (s) => {
      const { id } = await api<{ id: string }>("/api/matches", { body: { settings: s } });
      go(`/m/${id}`);
    }, "Create match");
    formSlot.replaceChildren(form);
  };
  startFrom.addEventListener("change", () => showForm());
  const ai = aiPanel(() => form!.current(), (settings) => {
    startFrom.value = "";
    showForm(settings);
  });
  create.append(
    el("div", { class: "row", style: { marginBottom: "10px" } }, el("span", {}, "Start from:"), startFrom,
      el("span", { class: "hint" }, "copy every setting from an earlier match, then change what you like")),
    ai.el,
    formSlot,
  );
  showForm();
  // a link from an AI assistant: /?settings=<json> opens the form filled in (then the address is tidied up)
  const linked = new URLSearchParams(location.search).get("settings");
  if (linked) {
    ai.load(linked, "the link");
    history.replaceState(null, "", "/");
  }
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
    list.replaceChildren(el("h2", {}, `YOUR MATCHES${matches.length ? ` (${matches.length})` : ""}`));
    if (!matches.length) list.append(el("div", { class: "muted" }, "No matches yet. Create one, then send the invite link to the people you want to play with."));
    else {
      // whatever needs you comes first: your turn, then open lobbies and running battles, then finished ones
      const rank = (m: any) => (m.yourTurn ? 0 : m.status === "lobby" ? 1 : m.status === "playing" ? 2 : 3);
      const sorted = [...matches].sort((x, y) => rank(x) - rank(y));
      const cards = el("div", { class: "match-cards" });
      for (const m of sorted) {
        const status = m.status === "lobby" ? el("span", { class: "badge dim" }, "Lobby")
          : m.status === "finished" ? el("span", { class: "badge dim" }, m.winner ? `${m.winner} won` : "Finished")
          : m.yourTurn ? el("span", { class: "badge" }, "Your turn") : el("span", { class: "badge dim" }, `Round ${m.round}`);
        const mode = m.settings?.mode === "coop" ? "co-op" : "free-for-all";
        const open = (e: Event) => {
          e.preventDefault();
          go(`/m/${m.id}`);
        };
        cards.append(el("div", { class: "match-card" + (m.yourTurn ? " yours" : "") },
          el("div", { class: "row" },
            el("a", { class: "grow match-name", href: `/m/${m.id}`, onclick: open }, m.name),
            status),
          el("div", { class: "muted" }, `${biomeName(m.biome)} · ${mode}${m.status === "playing" && !m.yourTurn && m.turnOf ? ` · ${m.turnOf}'s turn` : ""}`),
          el("div", { class: "muted" }, `${m.players.join(", ")} ${m.settings?.mode === "coop" ? "" : ` (${m.players.length} squad${m.players.length === 1 ? "" : "s"})`}`),
          el("div", { class: "row", style: { marginTop: "4px", gap: "6px" } },
            el("button", { class: "small", onclick: open }, "Open"),
            m.settings ? el("button", { class: "small", title: "Start a new match with these settings", onclick: () => reuse(m.id) }, "Reuse settings") : null),
        ));
      }
      list.append(cards);
    }
    // battles shared as challenges: the ones you set, and the ones you've had a go at
    const challenges = await api<{ id: string; title: string; yours: boolean; goes: number; wins: number; beaten: boolean }[]>("/api/challenges");
    if (challenges.length) {
      list.append(el("h2", { style: { marginTop: "16px" } }, "CHALLENGES"), el("div", { class: "match-cards" }, ...challenges.map((c) => {
        const open = (e: Event) => {
          e.preventDefault();
          go(`/c/${c.id}`);
        };
        return el("div", { class: "match-card" },
          el("div", { class: "row" },
            el("a", { class: "grow match-name", href: `/c/${c.id}`, onclick: open }, c.title),
            c.beaten ? el("span", { class: "badge" }, "Beaten") : c.yours ? el("span", { class: "badge dim" }, "Yours") : null),
          el("div", { class: "muted" }, `${c.goes} go${c.goes === 1 ? "" : "es"}, ${c.wins} win${c.wins === 1 ? "" : "s"}`));
      })));
    }
  } catch (e) {
    list.append(el("div", { class: "err" }, String((e as Error).message)));
  }
}

/** One line describing a match's main settings (for the "Start from" list). */
function settingsSummary(s: MatchSettings): string {
  const drops = s.supplyDrops.enabled ? `drops every ${s.supplyDrops.everyRounds} (${s.supplyDrops.kits ?? 3} ${s.supplyDrops.tier} kits)` : "no drops";
  const env = s.randomBiome ? "Random" : biomeName(s.biome);
  if (s.mode === "coop") {
    const foes = s.scenario.enemies.reduce((a, g) => a + g.count, 0);
    return `Co-op scenario: ${s.scenario.seatsPerPlayer} seats each vs ${foes} enemies, ${env}, ${s.randomTime || s.timeOfDay === "random" ? "random time" : s.timeOfDay}, ${money(s.budget)}, ${drops}`;
  }
  return `Free-for-all, ${env}, ${s.randomTime || s.timeOfDay === "random" ? "random time" : s.timeOfDay}, ${money(s.budget)}, ${s.techLevel} tech, ${drops}`;
}

/** The match settings form (create + edit). Budget guidance updates live. */
export function settingsForm(initial: MatchSettings, onSubmit: (s: MatchSettings) => Promise<void>, submitLabel: string, readOnly = false): HTMLElement & { current(): MatchSettings } {
  const s: MatchSettings = structuredClone(initial);
  // settings of matches from before co-op and scenarios
  const d = defaultSettings();
  s.coop = { ...d.coop, ...s.coop };
  s.mode ??= "ffa";
  s.scenario ??= d.scenario;
  const f = el("div", { class: "form" });
  const err = el("div", { class: "err full" });
  const guide = el("div", { class: "guide full" });
  const mapHint = el("span", { class: "hint" });
  /** rows shown in only one mode */
  const only: { mode: GameMode; els: HTMLElement[] }[] = [];
  const field = (label: string, input: HTMLElement, hint?: string | HTMLElement, mode?: GameMode) => {
    const els = [el("div", {}, label), el("div", { class: "row" }, input, hint ? (typeof hint === "string" ? el("span", { class: "hint" }, hint) : hint) : null)];
    f.append(...els);
    if (mode) only.push({ mode, els });
    return els;
  };
  const num = (get: () => number, set: (v: number) => void, min: number, max: number, step = 1, width = "130px") => {
    const i = el("input", { type: "number", min, max, step, value: get(), disabled: readOnly, style: { width } }) as HTMLInputElement;
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
  const text = (get: () => string, set: (v: string) => void, max = 30) => {
    const i = el("input", { value: get(), maxlength: max, disabled: readOnly, style: { width: "160px" } }) as HTMLInputElement;
    i.addEventListener("input", () => set(i.value));
    return i;
  };
  const nameInput = el("input", { value: s.name, maxlength: 40, disabled: readOnly }) as HTMLInputElement;
  nameInput.addEventListener("input", () => (s.name = nameInput.value));

  // the game mode is a pair of tabs over the rest of the form
  const MODES: { id: GameMode; name: string; blurb: string }[] = [
    { id: "ffa", name: "Free-for-all", blurb: "Squads fight it out; last squad standing wins. Anyone with the invite link can join, even once the battle is on: their squad lands at the edge of the map. Computer squads can join, and with “Co-op squads” set above 1, several people can share a squad." },
    { id: "coop", name: "Co-op scenario", blurb: "You're the game master: set up the mission and the enemy, and everyone who joins plays on one team against it (latecomers land with the team when they're ready)." },
  ];
  const tabButtons = MODES.map((m) => el("button", { type: "button", class: "tab", disabled: readOnly && m.id !== s.mode, onclick: () => {
    if (readOnly || s.mode === m.id) return;
    s.mode = m.id;
    if (m.id !== "coop" && s.coop.turnEnd === "daily") s.coop.turnEnd = "lockin";
    if (s.coop.turnEnd === "daily") s.coop.timeZone = browserTimeZone();
    refresh();
  } }, m.name));
  const tabBlurb = el("div", { class: "hint tab-blurb" });
  f.append(el("div", { class: "full" }, el("div", { class: "tabs" }, ...tabButtons), tabBlurb));
  field("Match name", nameInput);
  const notesInput = el("textarea", { rows: 3, maxlength: 1000, disabled: readOnly, placeholder: "Optional: house rules, when you'll play, what to expect... everyone who joins sees this", class: "notes-input" }) as HTMLTextAreaElement;
  notesInput.value = s.notes ?? "";
  notesInput.addEventListener("input", () => (s.notes = notesInput.value));
  field("Message for players", notesInput);

  // ---- free-for-all ----
  field("Co-op squads", el("div", { class: "row" },
    el("span", {}, "up to"), num(() => s.coop.squadSize, (v) => (s.coop.squadSize = v), 1, MAX_SQUAD_SIZE, 1, "60px"),
    el("span", {}, "people per squad; turn ends"),
    sel([{ id: "lockin", name: "when everyone locks in" }, { id: "timer", name: "on the turn timer" }] as const, () => (s.coop.turnEnd === "timer" ? "timer" : "lockin"), (v) => (s.coop.turnEnd = v)),
    check(() => s.coop.afkAI, (v) => (s.coop.afkAI = v), "AI plays for offline players")),
    "Several people can share a squad, each commanding some of its units, all moving at once on its turn", "ffa");

  // ---- co-op scenario: the team ----
  field("The team", el("div", { class: "row" },
    text(() => s.scenario.teamName, (v) => (s.scenario.teamName = v)),
    el("span", {}, "everyone with"), num(() => s.scenario.seatsPerPlayer, (v) => (s.scenario.seatsPerPlayer = v), 1, 30, 1, "60px"),
    el("span", {}, "Skyranger seats")),
    "Soldiers and small aliens take 1 seat, tanks and large aliens 4 (4 seats = 4 soldiers or a tank). Everyone who joins hires, equips and commands their own units", "coop");
  field("Landing", sel([
    { id: "together", name: "The whole team lands together" },
    { id: "apart", name: "Everyone lands apart (like squads in a normal battle)" },
  ] as const, () => s.scenario.teamStart, (v) => (s.scenario.teamStart = v)), "Apart: each person's units start in their own zone around the edge of the map", "coop");
  field("Game master", check(() => s.scenario.gmPlays, (v) => (s.scenario.gmPlays = v), "I play on the team too"),
    "If not, you hire nothing and watch the whole battle — every unit, both sides — as it happens", "coop");
  const dailyRow = el("span", { class: "row" });
  field("Turns end", el("div", { class: "row" },
    sel([
      { id: "lockin", name: "When everyone has locked in (players set the pace)" },
      { id: "daily", name: "At a set time every day (or when everyone locks in)" },
      { id: "timer", name: "On the turn timer" },
    ] as const, () => s.coop.turnEnd, (v) => {
      s.coop.turnEnd = v;
      if (v === "daily") s.coop.timeZone = browserTimeZone();
    }),
    dailyRow,
    check(() => s.coop.afkAI, (v) => (s.coop.afkAI = v), "AI plays for offline players")),
    "Offline players' units otherwise just stay where they are", "coop");
  const dailyInput = el("input", { type: "time", value: s.coop.dailyAt, disabled: readOnly }) as HTMLInputElement;
  dailyInput.addEventListener("input", () => {
    s.coop.dailyAt = dailyInput.value || "20:00";
    s.coop.timeZone = browserTimeZone();
  });
  dailyRow.append(el("span", {}, "at"), dailyInput, el("span", { class: "hint" }, `(${browserTimeZone()})`));

  // ---- co-op scenario: the enemy ----
  field("The enemy", el("div", { class: "row" }, text(() => s.scenario.enemyName, (v) => (s.scenario.enemyName = v)),
    el("span", { class: "hint" }, "played by the computer")), undefined, "coop");
  const groupsBox = el("div", { class: "full enemy-groups" });
  f.append(groupsBox);
  only.push({ mode: "coop", els: [groupsBox] });
  field("Enemy tactics", aiControls(s.scenario.ai, readOnly), "Bold and reckless enemies charge; cautious ones take aimed shots and fall back", "coop");

  // ---- the battlefield (both modes) ----
  field("Environment", sel([{ id: "RANDOM" as const, name: "Random (rolled when the battle starts)" }, ...BIOMES.map((b) => ({ id: b.id, name: b.name }))], () => s.biome, (v) => (s.biome = v)));
  field("Time of day", sel([{ id: "random", name: "Random (rolled when the battle starts)" }, { id: "day", name: "Day" }, { id: "dusk", name: "Dusk" }, { id: "night", name: "Night" }] as const, () => s.timeOfDay, (v) => (s.timeOfDay = v)), "At night humans see 9 tiles unless an area is lit; aliens see in the dark");
  field("Landed UFO", sel(UFO_CHOICES, () => s.ufo, (v) => (s.ufo = v)), "Placed in the middle of the map");
  const mapInput = sel([{ id: "0", name: "Auto" }, ...[4, 5, 6, 7, 8, 9, 10].map((n) => ({ id: String(n), name: `${n} (${n * 10}x${n * 10} tiles)` }))], () => String(s.mapBlocks), (v) => (s.mapBlocks = Number(v)));
  field("Map size (blocks)", mapInput, mapHint);
  const budgetInput = num(() => s.budget, (v) => (s.budget = v), 50_000, 5_000_000, 10_000);
  field("Budget per player", budgetInput);
  f.append(guide);
  field("Squad seats", num(() => s.squadLimit, (v) => (s.squadLimit = v), 1, 30), "A Skyranger holds 14; tanks and other large units take 4", "ffa");
  field("Recruit pool size", num(() => s.poolSize, (v) => (s.poolSize = v), 10, 80), "Everyone hires from an identical copy of this pool");
  field("Technology", sel([{ id: "conventional", name: "Conventional only" }, { id: "laser", name: "Up to lasers" }, { id: "alien", name: "Everything (plasma, blasters...)" }] as const, () => s.techLevel, (v) => (s.techLevel = v)),
    "What can be bought, and what \"standard\" enemy weapons are");
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
  field("Drop contents", el("div", { class: "row" },
    sel([{ id: "basic", name: "Basic (rifles, grenades, medikits)" }, { id: "advanced", name: "Advanced (cannons, lasers, scanners)" }, { id: "alien", name: "Alien tech (plasma, blasters, psi)" }, { id: "mixed", name: "Mixed (weighted random)" }] as const, () => s.supplyDrops.tier, (v) => (s.supplyDrops.tier = v)),
    num(() => s.supplyDrops.kits, (v) => (s.supplyDrops.kits = v), 1, 12, 1, "60px"),
    el("span", {}, "kits per drop")),
    "A kit is a weapon with its ammo, a pair of grenades, a medikit, a scanner...");
  field("Mysterious Stranger", sel([...new Set([0, 5, 10, 20, 35, 50, s.stranger])].sort((a, b) => a - b).map((n) => ({ id: String(n), name: n ? `${n}% chance` : "Off" })), () => String(s.stranger), (v) => (s.stranger = Number(v))),
    "As in Fallout: when an attack leaves a seen enemy standing, a stranger may appear beside the attacker, shoot it with a magnum and vanish (any side)");
  field("Turn timer", num(() => s.turnTimer, (v) => (s.turnTimer = v), 0, 3600, 30), "seconds per turn (0 = no limit; play asynchronously). Squads ending on the timer need one");
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

  const forceCount = el("b", {});
  /** The enemy groups: who, how many, armed with what, where, and when they arrive. */
  function renderGroups() {
    const types = enemyTypeChoices();
    const groups = [...new Set(types.map((t) => t.group))];
    const weapons = weaponChoices();
    const armors = [{ id: "STR_NONE_UC", name: "None" }, { id: "STR_PERSONAL_ARMOR_UC", name: "Personal" }, { id: "STR_POWER_SUIT_UC", name: "Power suit" }, { id: "STR_FLYING_SUIT_UC", name: "Flying suit" }];
    const t = el("table", { class: "compact" }, el("tr", {}, ...["Enemy", "Count", "Weapon", "Grenades", "Armor", "Starts", "Round", ""].map((h) => el("th", {}, h))));
    s.scenario.enemies.forEach((g, i) => {
      const typeSel = el("select", { disabled: readOnly }, ...groups.map((grp) => el("optgroup", { label: grp }, ...types.filter((x) => x.group === grp).map((x) => el("option", { value: x.id, selected: x.id === g.type }, x.name))))) as HTMLSelectElement;
      typeSel.addEventListener("change", () => {
        g.type = typeSel.value;
        renderGroups();
        refresh();
      });
      const soldier = g.type.startsWith("SOLDIER:");
      t.append(el("tr", {},
        el("td", {}, typeSel),
        el("td", {}, num(() => g.count, (v) => (g.count = v), 1, 40, 1, "60px")),
        el("td", {}, sel(weapons, () => g.weapon, (v) => (g.weapon = v))),
        el("td", {}, num(() => g.grenades, (v) => (g.grenades = v), 0, 6, 1, "50px")),
        el("td", {}, soldier ? sel(armors, () => g.armor, (v) => (g.armor = v)) : el("span", { class: "muted" }, "natural")),
        el("td", {}, sel(PLACEMENTS, () => g.placement, (v) => (g.placement = v))),
        el("td", {}, num(() => g.round, (v) => (g.round = v), 1, 99, 1, "60px")),
        el("td", {}, readOnly ? null : el("button", { class: "small danger", disabled: s.scenario.enemies.length < 2, onclick: () => {
          s.scenario.enemies.splice(i, 1);
          renderGroups();
          refresh();
        } }, "Remove")),
      ));
    });
    groupsBox.replaceChildren(
      el("div", { class: "title", style: { fontSize: "12px" } }, "ENEMY FORCE"),
      el("div", { class: "scroll" }, t),
      el("div", { class: "row", style: { marginTop: "6px" } },
        readOnly ? null : el("button", { class: "small", disabled: s.scenario.enemies.length >= 20, onclick: () => {
          s.scenario.enemies.push({ type: "STR_SECTOID_SOLDIER", count: 3, weapon: "standard", grenades: 0, armor: "STR_NONE_UC", placement: "edge", round: 1 });
          renderGroups();
          refresh();
        } }, "Add a group"),
        el("span", { class: "hint" }, forceCount, ` Groups arriving after round 1 are reinforcements. "Far side" is their own landing zone across the map; "At the UFO" needs a landed UFO (otherwise they start in the middle). The battle is won when every enemy is down and no more are coming.`)));
  }
  renderGroups();

  function refresh() {
    for (const o of only) for (const e of o.els) e.style.display = o.mode === s.mode ? "" : "none";
    MODES.forEach((m, i) => tabButtons[i].classList.toggle("active", m.id === s.mode));
    tabBlurb.textContent = MODES.find((m) => m.id === s.mode)!.blurb;
    const atStart = s.scenario.enemies.filter((g) => g.round <= 1).reduce((a, g) => a + g.count, 0);
    const later = s.scenario.enemies.filter((g) => g.round > 1).reduce((a, g) => a + g.count, 0);
    forceCount.textContent = `${atStart} on the map at the start${later ? `, ${later} more as reinforcements` : ""}.`;
    dailyRow.style.display = s.coop.turnEnd === "daily" ? "" : "none";
    dailyInput.value = s.coop.dailyAt;
    mapHint.textContent = s.mapBlocks ? "A size of your own: squads joining later still find room at the edge"
      : s.mode === "coop" ? `Auto: sized for the team at the start and the enemy force (2 people: ${recommendedScenarioBlocks(s, 2)}, 4: ${recommendedScenarioBlocks(s, 4)}, 8: ${recommendedScenarioBlocks(s, 8)})`
      : `Auto: sized for the squads ready at the start (2 squads: ${recommendedMapBlocks(2, s.budget)}, 3–4: ${recommendedMapBlocks(4, s.budget)}, 5–6: ${recommendedMapBlocks(6, s.budget)}, more: ${recommendedMapBlocks(8, s.budget)})`;
    const g = budgetGuide(s);
    guide.replaceChildren(
      el("div", { class: "title", style: { fontSize: "12px" } }, `WHAT ${money(s.budget)} BUYS`),
      el("ul", { style: { margin: "4px 0" } }, ...g.examples.map((x) => el("li", {}, x))),
      el("div", { class: "hint" }, g.prices.join(" ")),
    );
  }
  refresh();
  return Object.assign(f, { current: () => structuredClone(s) });
}

/**
 * "Set up a match with AI": a prompt to give an assistant (pointing it at /llms.txt), a box to paste its answer
 * (JSON, a code block or the link), what had to be adjusted, and the current form as JSON or a link to iterate on.
 */
function aiPanel(current: () => MatchSettings, apply: (s: MatchSettings) => void) {
  const origin = location.origin;
  const prompt = `Read ${origin}/llms.txt (it explains how matches on this X-COM server are set up), then set up this match for me and give me the settings link and JSON: `;
  const promptBox = el("textarea", { rows: 3, readonly: true }) as HTMLTextAreaElement;
  promptBox.value = prompt + "<describe the match you want>";
  const paste = el("textarea", { rows: 4, placeholder: "Paste what your assistant gave you: the JSON, or the link" }) as HTMLTextAreaElement;
  const out = el("div", {});
  const details = el("details", { class: "ai-panel" }) as HTMLDetailsElement;
  const copy = async (text: string, btn: HTMLButtonElement) => {
    try {
      await navigator.clipboard.writeText(text);
      const t = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = t), 1200);
    } catch {
      /* no clipboard access: the text is selectable */
    }
  };
  const load = (text: string, source: string) => {
    details.open = true;
    try {
      const raw = parseSettingsText(text.trim().startsWith("{") ? text : text.includes("settings=") ? text : `?settings=${encodeURIComponent(text)}`) as Record<string, unknown>;
      const { settings, warnings } = checkSettings(raw);
      // unless the assistant chose a time zone, use the browser's like the form would
      if ((raw.coop as { timeZone?: unknown } | undefined)?.timeZone === undefined) settings.coop.timeZone = browserTimeZone();
      apply(settings);
      out.replaceChildren(el("div", { class: "loaded" }, `Loaded "${settings.name}" from ${source}: check the form below, then Create match.`));
      if (warnings.length) out.append(el("div", { class: "warnings" }, el("div", {}, "Adjusted (tell your assistant if that's not what you wanted):"), el("ul", {}, ...warnings.map((w) => el("li", {}, w)))));
    } catch (e) {
      out.replaceChildren(el("div", { class: "err" }, `Couldn't read that: ${(e as Error).message}`));
    }
  };
  details.append(
    el("summary", {}, "Set up a match with AI"),
    el("div", { class: "hint", style: { margin: "6px 0" } }, "Describe the match you want to any AI assistant (Claude, ChatGPT...) and let it fill in the settings. Start it off with this:"),
    promptBox,
    el("div", { class: "row", style: { margin: "4px 0 10px" } },
      el("button", { class: "small", onclick: (e: Event) => copy(prompt, e.target as HTMLButtonElement) }, "Copy prompt"),
      el("a", { href: "/llms.txt", target: "_blank", class: "hint" }, "what the assistant reads")),
    el("div", { class: "hint" }, "It answers with a link (just open it) or JSON to paste here:"),
    paste,
    el("div", { class: "row", style: { marginTop: "4px" } },
      el("button", { class: "small primary", onclick: () => load(paste.value, "your assistant") }, "Load into the form"),
      el("span", { class: "hint" }, "Already set something up? Give it to your assistant to change:"),
      el("button", { class: "small", onclick: (e: Event) => copy(JSON.stringify(settingsDelta(current()), null, 2), e.target as HTMLButtonElement) }, "Copy settings JSON"),
      el("button", { class: "small", onclick: (e: Event) => copy(`${origin}/?settings=${encodeURIComponent(JSON.stringify(settingsDelta(current())))}`, e.target as HTMLButtonElement) }, "Copy settings link")),
    out,
  );
  return { el: details, load };
}

/** The enemy AI's temperament (co-op scenarios). */
function aiControls(t: BotTuning, readOnly: boolean): HTMLElement {
  const pick = (k: "aggression" | "difficulty", opts: string[]) => {
    const e = el("select", { disabled: readOnly }, ...opts.map((o, i) => el("option", { value: i, selected: i === t[k] }, o))) as HTMLSelectElement;
    e.addEventListener("change", () => (t[k] = Number(e.value)));
    return e;
  };
  const n = (k: "intelligence" | "cheatTurn", min: number, max: number) => {
    const i = el("input", { type: "number", min, max, value: t[k], disabled: readOnly, style: { width: "60px" } }) as HTMLInputElement;
    i.addEventListener("input", () => (t[k] = Number(i.value) || t[k]));
    return i;
  };
  const pers = el("input", { type: "checkbox", checked: t.personalities, disabled: readOnly }) as HTMLInputElement;
  pers.addEventListener("change", () => (t.personalities = pers.checked));
  return el("div", { class: "row" },
    el("label", {}, "aggression ", pick("aggression", ["Cautious", "Normal", "Bold", "Reckless"])),
    el("label", {}, "explosives ", pick("difficulty", ["Rarely", "Sometimes", "Often", "Very often", "Whenever it can"])),
    el("label", {}, "remembers you for ", n("intelligence", 1, 10), " rounds"),
    el("label", {}, "knows where you are after round ", n("cheatTurn", 1, 99)),
    el("label", {}, pers, " races play to type"));
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
