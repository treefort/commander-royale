// Match lobby: invite link, players, settings, and the loadout builder (hire, buy, equip).
import { api, el, money } from "../api.ts";
import { topbar, settingsForm, type Me } from "./home.ts";
import { biomeName, DEFAULT_BOT_TUNING, type MatchSettings, type Recruit, type Loadout, type BotTuning } from "../../shared/protocol.ts";
import { checkLoadout, budgetGuide, type CatalogEntry } from "../../shared/rules/catalog.ts";
import { forceSummary } from "../../shared/rules/scenario.ts";
import { itemRule, unitRule, tr, livingWeaponFor, INVENTORY_SLOTS, type SlotId } from "../../shared/rules/index.ts";
import { InventoryScreen, type InvAdapter, type InvItem } from "./inventory.ts";
import { Assets, battleFileList } from "../render/assets.ts";
import { preload, getFile, hasFile } from "../files.ts";
import { lutFor } from "../render/surface.ts";

interface LobbyState {
  id: string;
  status: string;
  isOwner: boolean;
  /** co-op scenario: you run it without playing */
  gameMaster?: boolean;
  settings: MatchSettings;
  players: {
    name: string; seat: number; ready: boolean; hasLoadout: boolean; you: boolean; owner: boolean; userId: string;
    /** co-op: the leader whose squad this player plays in */
    squadOf: string | null;
    /** a co-op scenario's game master who only watches */
    gm?: boolean;
    bot?: boolean; botId?: string; ai?: BotTuning;
  }[];
  strategies: string[];
  /** co-op members get their leader's loadout (read-only) */
  you: { seat: number; loadout: Loadout | null; ready: boolean; squadOf: string | null; leaderName: string | null } | null;
  pool: Recruit[];
  catalog: CatalogEntry[];
  armors: { type: string; price: number }[];
}

export class LobbyPage {
  state: LobbyState | null = null;
  loadout: Loadout = { squad: [], stash: [] };
  dirty = false;
  saveTimer: ReturnType<typeof setTimeout> | null = null;
  ws: WebSocket | null = null;
  editingSettings = false;
  filter: "all" | "soldier" | "alien" | "hwp" = "all";
  sort: "price" | "tu" | "health" | "firing" | "reactions" | "psi" = "price";
  modal: HTMLElement | null = null;
  assets: Assets | null = null;
  error = "";
  /** incremented on every local loadout edit, so a slow save can't mark newer edits as saved */
  edits = 0;
  modalRaf = 0;
  settingsEl: HTMLElement | null = null;
  renderDeferred = false;
  botStrategy = "any";
  /** the computer squad whose AI settings are open */
  tuning: string | null = null;

  constructor(private root: HTMLElement, private matchId: string, private me: Me, private go: (p: string) => void, private onStart: () => void) {
    this.connect();
  }

  destroy() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    cancelAnimationFrame(this.modalRaf);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.modal?.remove();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws?match=${this.matchId}`);
    this.ws = ws;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "lobby") this.onLobby(m.lobby);
      else if (m.t === "deleted") {
        alert("This match was deleted by its creator.");
        this.go("/");
      } else if (m.t === "view") this.onStart();
    };
    ws.onclose = (e) => {
      if (e.code === 4003) return; // not a member: don't retry
      if (this.ws === ws) setTimeout(() => this.ws === ws && this.connect(), 2000);
    };
  }

  private onLobby(s: LobbyState) {
    if (!s) return;
    if (s.status !== "lobby") {
      this.onStart();
      return;
    }
    const poolChanged = this.state && JSON.stringify(this.state.pool.map((p) => p.id + p.price)) !== JSON.stringify(s.pool.map((p) => p.id + p.price));
    this.state = s;
    // never replace local edits that haven't reached the server yet
    if (poolChanged || (!this.dirty && !this.saveTimer)) {
      this.loadout = s.you?.loadout ? structuredClone(s.you.loadout) : poolChanged ? { squad: [], stash: [] } : this.loadout;
      this.dirty = false;
    }
    // don't yank a dropdown or text field out from under the user; re-render when they're done
    const active = document.activeElement as HTMLElement | null;
    if (active && this.root.contains(active) && (active.tagName === "SELECT" || active.tagName === "INPUT")) {
      if (!this.renderDeferred) {
        this.renderDeferred = true;
        active.addEventListener("blur", () => {
          this.renderDeferred = false;
          this.render();
        }, { once: true });
      }
      return;
    }
    this.render();
  }

  private scheduleSave() {
    this.dirty = true;
    this.edits++;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 600);
    this.render();
  }

  private async save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const version = this.edits;
    try {
      await api(`/api/matches/${this.matchId}/loadout`, { body: { loadout: this.loadout } });
      if (version === this.edits && !this.saveTimer) this.dirty = false;
    } catch (e) {
      this.error = (e as Error).message;
      this.render();
    }
  }

  private async act(action: string, body: unknown = {}) {
    try {
      this.error = "";
      // flush pending edits first, so a late autosave can't un-ready us afterwards
      if (this.dirty || this.saveTimer) await this.save();
      await api(`/api/matches/${this.matchId}/${action}`, { body });
    } catch (e) {
      this.error = (e as Error).message;
      this.render();
    }
  }

  // ------------------------------------------------------------------------------------------

  render() {
    const s = this.state;
    if (!s) return;
    const scrollY = window.scrollY;
    const root = this.root;
    const inner = [...root.querySelectorAll<HTMLElement>(".scroll")].map((e) => e.scrollTop);
    root.innerHTML = "";
    root.append(topbar(this.me));
    const wrap = el("div", { class: "wrap" });
    root.append(wrap);
    const url = `${location.origin}/m/${s.id}`;
    const biome = biomeName(s.settings.biome);
    wrap.append(
      el("div", { class: "panel" },
        el("div", { class: "row" },
          el("h2", { class: "grow" }, s.settings.name.toUpperCase()),
          s.isOwner ? el("button", { onclick: () => { this.editingSettings = !this.editingSettings; this.settingsEl = null; this.render(); } }, this.editingSettings ? "Close settings" : "Edit settings") : null,
          s.isOwner ? el("button", { class: "danger small", onclick: async () => { if (confirm("Delete this match?")) { await api(`/api/matches/${s.id}`, { method: "DELETE" }); this.go("/"); } } }, "Delete") : null,
          !s.isOwner && s.you ? el("button", { class: "small", onclick: async () => { await this.act("leave"); this.go("/"); } }, "Leave") : null,
        ),
        el("div", { class: "row" }, el("span", {}, "Invite link:"), el("span", { class: "invite" }, url),
          el("button", { class: "small", onclick: () => navigator.clipboard?.writeText(url) }, "Copy")),
        el("div", { class: "muted", style: { marginTop: "6px" } },
          `${biome} · ${s.settings.timeOfDay === "random" ? "random time of day" : s.settings.timeOfDay} · ${s.settings.mapBlocks * 10}x${s.settings.mapBlocks * 10} map · ${s.settings.ufo === "none" ? "no UFO" : "UFO: " + (s.settings.ufo === "random" ? "random" : tr(s.settings.ufo))} · budget ${money(s.settings.budget)}${s.settings.mode === "coop" ? " each" : ""} · ${s.settings.mode === "coop" ? `${s.settings.scenario.seatsPerPlayer} seats each${s.settings.scenario.teamStart === "apart" ? ", landing apart" : ""}` : `${s.settings.squadLimit} seats`} · tech: ${s.settings.techLevel}` +
          `${s.settings.psionics ? " · psionics" : ""}${s.settings.allowAliens ? " · alien recruits" : ""}${s.settings.allowHWP ? " · tanks" : ""}` +
          `${s.settings.supplyDrops.enabled ? ` · supply drops every ${s.settings.supplyDrops.everyRounds} rounds (${s.settings.supplyDrops.tier})` : ""}${s.settings.turnTimer ? ` · ${s.settings.turnTimer}s turns` : " · no turn timer"}`),
        // the creator's message to everyone joining
        s.settings.notes?.trim() ? el("div", { class: "match-notes" }, el("div", { class: "title", style: { fontSize: "12px" } }, "MESSAGE FROM THE HOST"), el("div", { class: "notes-text" }, s.settings.notes)) : null,
        this.editingSettings && s.isOwner ? this.settingsPanel(s) : null,
      ),
    );
    if (s.settings.mode === "coop") {
      wrap.append(this.renderScenario(s));
      if (s.you && !s.gameMaster) wrap.append(this.renderLoadout(s));
      root.querySelectorAll<HTMLElement>(".scroll").forEach((e, i) => (e.scrollTop = inner[i] ?? 0));
      window.scrollTo(0, scrollY);
      return;
    }
    // squads (in co-op, each with the people sharing it)
    const leaders = s.players.filter((p) => !p.squadOf);
    const allReady = leaders.length >= 2 && leaders.every((p) => p.ready);
    const coop = s.settings.coop.squadSize > 1;
    const room = (l: LobbyState["players"][number]) => !l.bot && s.players.filter((p) => p.squadOf === l.userId).length + 1 < s.settings.coop.squadSize;
    const meRow = s.players.find((p) => p.you);
    const iLead = !!meRow && !meRow.squadOf && s.players.some((p) => p.squadOf === meRow.userId);
    const rows: HTMLElement[] = [];
    for (const p of leaders) {
      const team = s.players.filter((x) => x.squadOf === p.userId);
      const canJoin = coop && !p.you && room(p) && (!s.you ? true : !iLead && meRow?.squadOf !== p.userId);
      rows.push(el("tr", {},
        el("td", {}, p.name, p.owner ? el("span", { class: "muted" }, " (host)") : null, p.you ? el("span", { class: "muted" }, " (you)") : null, p.bot ? el("span", { class: "muted" }, " (computer)") : null,
          team.length ? el("div", { class: "muted" }, "with ", ...team.flatMap((t, i) => [i ? ", " : "", t.name + (t.you ? " (you)" : "") + (t.owner ? " (host)" : "")])) : null,
          p.bot && p.ai ? el("div", { class: "muted" }, botSummary(p.ai)) : null),
        el("td", {}, p.ready ? el("span", { class: "badge" }, "Ready") : p.hasLoadout ? el("span", { class: "badge dim" }, "Equipping") : el("span", { class: "badge red" }, "Not ready")),
        el("td", {},
          canJoin ? el("button", { class: "small", onclick: () => this.act("join", { squad: p.userId }) }, s.you ? "Join this squad" : "Join as teammate") : null, " ",
          p.bot && s.isOwner ? el("button", { class: "small", onclick: () => { this.tuning = this.tuning === p.botId ? null : p.botId!; this.render(); } }, this.tuning === p.botId ? "Close AI settings" : "AI settings") : null, " ",
          p.bot && s.isOwner ? el("button", { class: "small danger", onclick: () => this.act("removebot", { botId: p.botId }) }, "Remove") : null),
      ));
      if (p.bot && s.isOwner && this.tuning === p.botId) rows.push(el("tr", {}, el("td", { colspan: 3 }, this.tuningForm(p.ai ?? DEFAULT_BOT_TUNING, (ai) => this.act("tunebot", { botId: p.botId, ai })))));
    }
    wrap.append(el("div", { class: "panel" },
      el("div", { class: "row" }, el("h2", { class: "grow" }, `SQUADS (${leaders.length}/${s.settings.maxPlayers})${coop ? ` · UP TO ${s.settings.coop.squadSize} PEOPLE EACH` : ""}`),
        !s.you && (leaders.length < s.settings.maxPlayers || (coop && leaders.some(room))) ? el("button", { class: "primary", onclick: () => this.act("join") }, leaders.length < s.settings.maxPlayers ? "Join this match" : "Join as a teammate") : null,
        s.you?.squadOf ? el("button", { class: "small", disabled: leaders.length >= s.settings.maxPlayers, title: "Leave this squad and hire one of your own", onclick: () => this.act("squad", { leader: "" }) }, "Field my own squad") : null,
        s.isOwner ? el("button", { class: "primary", disabled: !allReady, onclick: () => this.act("start") }, "Start battle") : null),
      el("table", {}, ...rows),
      s.isOwner ? this.addBotRow(s) : null,
      coop ? el("div", { class: "hint" }, `Co-op: people who join a squad play it together — its leader hires and equips it, the units are dealt out between everyone (the leader can pick who gets which), and everyone moves at once on the squad's turn. ${s.settings.coop.turnEnd === "timer" ? "The turn ends when the timer runs out." : "The turn ends once everyone has locked in (End Turn)."}${s.settings.coop.afkAI ? " The AI plays for anyone offline for more than half a minute." : ""}`) : null,
      s.isOwner && !allReady ? el("div", { class: "hint" }, "The battle can start once at least two squads are ready.") : null,
      this.error ? el("div", { class: "err" }, this.error) : null,
    ));
    if (s.you?.squadOf) wrap.append(this.renderTeammateView(s));
    else if (s.you) wrap.append(this.renderLoadout(s));
    root.querySelectorAll<HTMLElement>(".scroll").forEach((e, i) => (e.scrollTop = inner[i] ?? 0));
    window.scrollTo(0, scrollY);
  }

  /** Co-op scenario: the team, the mission briefing (the enemy the game master set up) and how turns work. */
  private renderScenario(s: LobbyState): HTMLElement {
    const sc = s.settings.scenario;
    const team = s.players.filter((p) => !p.gm);
    const allReady = team.length >= 1 && team.every((p) => p.ready);
    const co = s.settings.coop;
    const turns = co.turnEnd === "daily" ? `The team's turn ends at ${co.dailyAt} (${co.timeZone}) every day, or as soon as everyone has locked in (End Turn).`
      : co.turnEnd === "timer" && s.settings.turnTimer ? `The team's turn ends when the ${s.settings.turnTimer}s timer runs out.`
      : "The team's turn ends once everyone has locked in (End Turn) — you set the pace.";
    const offline = co.afkAI ? "The AI plays for anyone offline for more than half a minute." : "Offline players' units stay where they are.";
    return el("div", {},
      el("div", { class: "panel" },
        el("div", { class: "row" },
          el("h2", { class: "grow" }, `THE TEAM: ${sc.teamName.toUpperCase()} (${team.length}/${s.settings.maxPlayers})`),
          !s.you && team.length < s.settings.maxPlayers ? el("button", { class: "primary", onclick: () => this.act("join") }, "Join the team") : null,
          s.isOwner ? el("button", { class: "primary", disabled: !allReady, onclick: () => this.act("start") }, "Start battle") : null),
        el("table", {}, ...s.players.map((p) => el("tr", {},
          el("td", {}, p.name, p.owner ? el("span", { class: "muted" }, " (game master)") : null, p.you ? el("span", { class: "muted" }, " (you)") : null),
          el("td", {}, p.gm ? el("span", { class: "badge dim" }, "Watching") : p.ready ? el("span", { class: "badge" }, "Ready") : p.hasLoadout ? el("span", { class: "badge dim" }, "Equipping") : el("span", { class: "badge red" }, "Not ready")),
        ))),
        el("div", { class: "hint" }, `Everyone fills up to ${sc.seatsPerPlayer} Skyranger seat${sc.seatsPerPlayer > 1 ? "s" : ""} (tanks and large aliens take 4) with ${money(s.settings.budget)}, and commands those units in battle${sc.teamStart === "apart" ? ", landing in their own zone" : ""}. The whole team moves at once, and you see every move a teammate (or any enemy in sight) makes as it happens. ${turns} ${offline}`),
        s.isOwner && !allReady ? el("div", { class: "hint" }, team.length ? "The battle can start once everyone on the team is ready." : "Send the invite link: the battle can start once someone has joined the team and is ready.") : null,
        this.error ? el("div", { class: "err" }, this.error) : null,
      ),
      el("div", { class: "panel" },
        el("h2", {}, `MISSION BRIEFING: ${sc.enemyName.toUpperCase()}`),
        el("ul", {}, ...forceSummary(s.settings).map((x) => el("li", {}, x))),
        el("div", { class: "muted" }, `Tactics: ${botSummary({ ...sc.ai, strength: 100 })}. Victory when every enemy is down and no more are coming.`),
        s.gameMaster ? el("div", { class: "hint", style: { marginTop: "6px" } }, `You're the game master: change the scenario with Edit settings, start the battle when the team is ready, and watch the whole battlefield — both sides — as it plays out. You can call off the mission from the battlescape (Surrender).`) : null,
      ));
  }

  /** A co-op member's view: the leader's squad (read-only) and who gets which unit. */
  private renderTeammateView(s: LobbyState): HTMLElement {
    const l = s.you!.loadout;
    const names = new Map(s.players.map((p) => [p.userId, p.name]));
    const me = s.players.find((p) => p.you)!;
    const t = el("table", {}, el("tr", {}, el("th", {}, "Unit"), el("th", {}, "Equipment"), el("th", {}, "Played by")));
    for (const m of l?.squad ?? []) {
      const r = s.pool.find((p) => p.id === m.recruitId);
      if (!r) continue;
      t.append(el("tr", {},
        el("td", {}, el("b", {}, r.name), el("div", { class: "muted" }, unitLabel(r))),
        el("td", {}, m.items.length ? m.items.map((i) => tr(i.type)).join(", ") : el("span", { class: "muted" }, r.kind === "hwp" ? "built-in weapon" : "nothing")),
        el("td", {}, m.controller ? (m.controller === me.userId ? el("b", {}, "you") : names.get(m.controller) ?? "?") : el("span", { class: "muted" }, "dealt out at the start"))));
    }
    return el("div", { class: "panel" },
      el("h2", {}, `${(s.you!.leaderName ?? "").toUpperCase()}'S SQUAD`),
      el("div", { class: "hint" }, `${s.you!.leaderName} hires and equips this squad and says when it's ready. In battle you command the units dealt to you; press G to hand the selected unit to a teammate, and End Turn to lock in.`),
      l?.squad.length ? el("div", { class: "scroll", style: { maxHeight: "360px", marginTop: "8px" } }, t) : el("div", { class: "muted", style: { marginTop: "8px" } }, "Nobody hired yet."));
  }

  /** A computer squad's AI settings (creator only). */
  private tuningForm(initial: BotTuning, save: (t: BotTuning) => void): HTMLElement {
    const t = { ...initial };
    const num = (k: "intelligence" | "cheatTurn" | "strength", min: number, max: number, step = 1) => {
      const i = el("input", { type: "number", min, max, step, value: t[k], style: { width: "70px" } }) as HTMLInputElement;
      i.addEventListener("input", () => (t[k] = Number(i.value)));
      return i;
    };
    const pick = (k: "aggression" | "difficulty", opts: string[]) => {
      const e = el("select", {}, ...opts.map((o, i) => el("option", { value: i, selected: i === t[k] }, o))) as HTMLSelectElement;
      e.addEventListener("change", () => (t[k] = Number(e.value)));
      return e;
    };
    const pers = el("input", { type: "checkbox", checked: t.personalities }) as HTMLInputElement;
    pers.addEventListener("change", () => (t.personalities = pers.checked));
    return el("div", { class: "tuning" },
      el("div", { class: "row" },
        el("label", {}, "Aggression ", pick("aggression", ["Cautious", "Normal", "Bold", "Reckless"])),
        el("label", {}, "Explosives ", pick("difficulty", ["Rarely", "Sometimes", "Often", "Very often", "Whenever it can"])),
        el("label", {}, "Remembers enemies for ", num("intelligence", 1, 10), " rounds"),
      ),
      el("div", { class: "row" },
        el("label", {}, "Knows where everyone is after round ", num("cheatTurn", 1, 99)),
        el("label", {}, pers, " Each race plays to type (Sectoids cautious, Chryssalids reckless...)"),
      ),
      el("div", { class: "row" },
        el("label", {}, "Strength ", num("strength", 25, 400, 25), "% of the budget and seats"),
        el("button", { class: "small primary", onclick: () => { this.tuning = null; save(sanitizeLocal(t)); } }, "Save AI settings"),
      ),
      el("div", { class: "hint" }, "A stronger enemy squad (more budget and seats) evens out a co-op team ganging up on it. Changing the strength rehires the squad."));
  }

  /** Creator only: add a computer-controlled squad that hires with the chosen strategy. */
  private addBotRow(s: LobbyState): HTMLElement {
    const full = s.players.filter((p) => !p.squadOf).length >= s.settings.maxPlayers;
    const labels: Record<string, string> = {
      random: "Wildcard (random hires)", swarm: "Swarm (lots of cheap soldiers)", elite: "Elite (few veterans, best gear)", balanced: "Balanced",
      heavy: "Heavy weapons", monster: "Monster (one big alien + troops)", aliens: "Alien legion", tanks: "Armored (tanks)", psi: "Psionic",
    };
    const sel = el("select", {}, el("option", { value: "any" }, "Any strategy"), ...s.strategies.map((k) => el("option", { value: k }, labels[k] ?? k))) as HTMLSelectElement;
    sel.value = this.botStrategy;
    sel.addEventListener("change", () => (this.botStrategy = sel.value));
    return el("div", { class: "row", style: { marginTop: "8px" } },
      el("span", {}, "Add a computer squad:"), sel,
      el("button", { class: "small", disabled: full, onclick: () => this.act("addbot", { strategy: sel.value }) }, "Add AI squad"),
      full ? el("span", { class: "hint" }, "The match is full; raise the number of squads in the settings to add more.") : null);
  }

  /** The settings form keeps its (unsaved) state across lobby updates. */
  private settingsPanel(s: LobbyState): HTMLElement {
    if (!this.settingsEl) {
      this.settingsEl = el("div", { class: "panel" }, settingsForm(s.settings, async (ns) => {
        await api(`/api/matches/${s.id}/settings`, { body: { settings: ns } });
        this.editingSettings = false;
        this.settingsEl = null;
        this.render();
      }, "Save settings (players must re-ready)"));
    }
    return this.settingsEl;
  }

  private renderLoadout(s: LobbyState): HTMLElement {
    const check = checkLoadout(s.settings, s.pool, this.loadout);
    const hiredIds = new Set(this.loadout.squad.map((m) => m.recruitId));
    const box = el("div", {});
    const pct = Math.min(100, (check.cost / s.settings.budget) * 100);
    const guide = budgetGuide(s.settings);
    box.append(el("div", { class: "panel" },
      el("div", { class: "row" },
        el("h2", { class: "grow" }, "YOUR SQUAD"),
        el("span", {}, `Spent ${money(check.cost)} of ${money(s.settings.budget)}`),
        el("div", { class: "meter" + (check.cost > s.settings.budget ? " over" : "") }, el("div", { style: { width: pct + "%" } })),
        s.settings.mode === "coop"
          ? el("span", { class: check.seats > s.settings.scenario.seatsPerPlayer ? "bad" : "" }, `Seats ${check.seats}/${s.settings.scenario.seatsPerPlayer}`)
          : el("span", { class: check.seats > s.settings.squadLimit ? "bad" : "" }, `Seats ${check.seats}/${s.settings.squadLimit}`),
        el("span", { class: "muted" }, this.dirty ? "saving..." : "saved"),
        el("button", { class: s.you!.ready ? "" : "primary", disabled: !check.ok && !s.you!.ready, onclick: () => this.act("ready", { ready: !s.you!.ready }) }, s.you!.ready ? "Not ready" : "Ready"),
      ),
      check.errors.length ? el("div", { class: "warn" }, check.errors.join(" · ")) : null,
      el("details", { class: "guide" }, el("summary", {}, "Budget rules of thumb"), el("ul", {}, ...guide.examples.map((x) => el("li", {}, x))), el("div", { class: "hint" }, guide.prices.join(" "))),
      this.squadTable(s),
    ));
    box.append(this.poolPanel(s, hiredIds));
    return box;
  }

  private squadTable(s: LobbyState): HTMLElement {
    if (!this.loadout.squad.length) return el("div", { class: "muted", style: { marginTop: "8px" } }, "Nobody hired yet — pick recruits from the pool below.");
    // co-op: the leader picks who plays which unit (unpicked ones are dealt out evenly at the start)
    const meRow = s.players.find((p) => p.you);
    const team = meRow ? [meRow, ...s.players.filter((p) => p.squadOf === meRow.userId)] : [];
    const coop = team.length > 1;
    const t = el("table", {}, el("tr", {}, el("th", {}, "Unit"), el("th", {}, "Armor"), el("th", {}, "Equipment"), coop ? el("th", {}, "Played by") : null, el("th", {}, "Cost"), el("th", {}, "")));
    this.loadout.squad.forEach((m, idx) => {
      const r = s.pool.find((p) => p.id === m.recruitId);
      if (!r) return;
      let armorSel: HTMLElement = el("span", { class: "muted" }, r.kind === "soldier" ? "—" : "natural");
      if (r.kind === "soldier" && s.armors.length > 1) {
        const sel = el("select", {}) as HTMLSelectElement;
        for (const a of s.armors) sel.append(el("option", { value: a.type, selected: a.type === m.armor }, `${tr(a.type)}${a.price ? " " + money(a.price) : ""}`));
        sel.addEventListener("change", () => {
          m.armor = sel.value;
          this.scheduleSave();
        });
        armorSel = sel;
      }
      const cost = r.price + (s.armors.find((a) => a.type === m.armor)?.price ?? 0) + m.items.reduce((a, it) => a + (s.catalog.find((c) => c.type === it.type)?.price ?? 0) + (it.ammo ? s.catalog.find((c) => c.type === it.ammo)?.price ?? 0 : 0), 0);
      t.append(el("tr", {},
        el("td", {}, el("b", {}, r.name), el("div", { class: "muted" }, unitLabel(r))),
        el("td", {}, armorSel),
        el("td", {}, r.kind === "hwp" ? el("span", { class: "muted" }, "built-in weapon") : m.items.length ? m.items.map((i) => tr(i.type) + (i.ammo ? ` (${tr(i.ammo)})` : "")).join(", ") : el("span", { class: "muted" }, "nothing")),
        coop ? el("td", {}, this.controllerSelect(m, team)) : null,
        el("td", { class: "price" }, money(cost)),
        el("td", {}, r.kind !== "hwp" ? el("button", { class: "small primary", onclick: () => this.openEquip(idx) }, "Equip") : null, " ",
          el("button", { class: "small danger", onclick: () => {
            for (const it of m.items) {
              this.loadout.stash.push(it.type);
              if (it.ammo) this.loadout.stash.push(it.ammo);
            }
            this.loadout.squad.splice(idx, 1);
            this.scheduleSave();
          } }, "Dismiss")),
      ));
    });
    return el("div", {},
      el("div", { class: "scroll", style: { maxHeight: "360px", marginTop: "8px" } }, t),
      el("div", { class: "hint", style: { marginTop: "6px" } }, "Buy and fit gear from each unit's Equip screen: drag items onto the soldier, right-click to sell them back. Unequipped stores are dropped at your deployment zone."));
  }

  private controllerSelect(m: Loadout["squad"][number], team: LobbyState["players"]): HTMLElement {
    const sel = el("select", {}, el("option", { value: "" }, "Anyone (dealt out)"), ...team.map((p) => el("option", { value: p.userId, selected: p.userId === m.controller }, p.you ? `${p.name} (you)` : p.name))) as HTMLSelectElement;
    sel.addEventListener("change", () => {
      if (sel.value) m.controller = sel.value;
      else delete m.controller;
      this.scheduleSave();
    });
    return sel;
  }

  private poolPanel(s: LobbyState, hired: Set<string>): HTMLElement {
    const psi = s.settings.psionics;
    let list = s.pool.filter((r) => this.filter === "all" || r.kind === this.filter);
    const key = (r: Recruit) => this.sort === "price" ? r.price : this.sort === "psi" ? r.stats.psiSkill * 1000 + r.stats.psiStrength : (r.stats as any)[this.sort];
    list = [...list].sort((a, b) => key(b) - key(a));
    const filters = el("div", { class: "row" }, ...(["all", "soldier", "alien", "hwp"] as const).map((f) =>
      el("button", { class: "small" + (this.filter === f ? " primary" : ""), onclick: () => { this.filter = f; this.render(); } }, f === "all" ? "All" : f === "soldier" ? "Soldiers" : f === "alien" ? "Aliens" : "Tanks")),
      el("span", { class: "muted" }, "sort:"),
      ...(["price", "tu", "health", "firing", "reactions", ...(psi ? ["psi"] : [])] as const).map((k) =>
        el("button", { class: "small" + (this.sort === k ? " primary" : ""), onclick: () => { this.sort = k as never; this.render(); } }, k)));
    const head = el("tr", {}, ...["Recruit", "TU", "Sta", "HP", "Rea", "Fir", "Thr", "Str", "Mel", ...(psi ? ["PSt", "PSk"] : []), "Price", ""].map((h) => el("th", {}, h)));
    const t = el("table", {}, head);
    for (const r of list) {
      const st = r.stats;
      const isHired = hired.has(r.id);
      t.append(el("tr", { class: isHired ? "hired" : "" },
        el("td", { class: "recruit" }, el("b", {}, r.name), el("div", { class: "muted" }, unitLabel(r)), r.notes.length ? el("div", {}, ...r.notes.map((n) => el("span", { class: "tag" }, n))) : null),
        ...[st.tu, st.stamina, st.health, st.reactions, st.firing, st.throwing, st.strength, st.melee, ...(psi ? [st.psiStrength, st.psiSkill] : [])].map((v) => el("td", {}, el("span", { class: "stat" }, String(v)))),
        el("td", { class: "price" }, money(r.price)),
        el("td", {}, isHired ? el("span", { class: "good" }, "hired") : el("button", { class: "small primary", onclick: () => {
          this.loadout.squad.push({ recruitId: r.id, armor: "STR_NONE_UC", items: [] });
          this.scheduleSave();
        } }, "Hire")),
      ));
    }
    return el("div", { class: "panel" }, el("h2", {}, "RECRUIT POOL"), el("div", { class: "hint" }, "Every squad hires from its own copy of this pool. Seats: soldiers and small aliens 1, large units 4."), filters, el("div", { class: "scroll pool" }, t));
  }

  // ------------------------------------------------------------------------------------------
  // equip modal: the original inventory screen over the local loadout
  // ------------------------------------------------------------------------------------------

  private async ensureAssets() {
    if (this.assets) return this.assets;
    await preload(battleFileList([]));
    this.assets = new Assets(getFile, hasFile);
    return this.assets;
  }

  private async openEquip(index: number) {
    const s = this.state!;
    const A = await this.ensureAssets();
    let cur = index;
    const page = this;
    const members = () => this.loadout.squad.filter((m) => s.pool.find((p) => p.id === m.recruitId)?.kind !== "hwp");
    const member = () => this.loadout.squad[cur];
    const recruit = () => s.pool.find((p) => p.id === member().recruitId)!;
    const toInv = (): InvItem[] => {
      const out: InvItem[] = member().items.map((it, i) => ({ id: i, type: it.type, slot: it.slot as SlotId, x: it.x, y: it.y, ammoType: it.ammo, ammoQty: it.ammo ? itemRule(it.ammo).clipSize : undefined, selfPowered: isSelfPowered(it.type) }));
      this.loadout.stash.forEach((t, i) => out.push({ id: 10000 + i, type: t, slot: "STR_GROUND", x: 0, y: 0, ammoQty: itemRule(t).battleType === 2 ? itemRule(t).clipSize : undefined, selfPowered: isSelfPowered(t) }));
      return out;
    };
    const fits = (type: string, slot: SlotId, x: number, y: number, ignore: number) => {
      const def = INVENTORY_SLOTS[slot];
      if (def.type === 2) return true;
      const items = member().items;
      if (def.type === 1) {
        // a living weapon (Chryssalid claws...) already fills the right hand
        const r = recruit();
        if (slot === "STR_RIGHT_HAND" && r.kind === "alien" && livingWeaponFor(unitRule(r.type))) return false;
        return !items.some((it, i) => i !== ignore && it.slot === slot);
      }
      const r = itemRule(type);
      for (let i = 0; i < r.invWidth; i++) for (let j = 0; j < r.invHeight; j++) if (!def.cells.some(([cx, cy]) => cx === x + i && cy === y + j)) return false;
      return !items.some((it, k) => {
        if (k === ignore || it.slot !== slot) return false;
        const o = itemRule(it.type);
        return x < it.x + o.invWidth && it.x < x + r.invWidth && y < it.y + o.invHeight && it.y < y + r.invHeight;
      });
    };
    const price = (type: string) => s.catalog.find((c) => c.type === type)?.price ?? 0;
    const left = () => s.settings.budget - checkLoadout(s.settings, s.pool, this.loadout).cost;
    const takeFromAnywhere = (item: InvItem): { type: string; ammo?: string } => {
      if (item.id >= 10000) {
        const t = this.loadout.stash.splice(item.id - 10000, 1)[0];
        return { type: t };
      }
      const it = member().items.splice(item.id, 1)[0];
      return { type: it.type, ammo: it.ammo };
    };
    const adapter: InvAdapter = {
      unit() {
        const r = recruit();
        const m = member();
        const weight = m.items.reduce((a, it) => a + (itemRule(it.type).fixedWeapon ? 0 : itemRule(it.type).weight) + (it.ammo ? itemRule(it.ammo).weight : 0), 0);
        const armor = r.kind === "soldier" ? m.armor || "STR_NONE_UC" : unitRule(r.type).armor;
        return { name: r.name, rank: r.rank, armor, gender: r.gender, look: r.look, standHeight: r.kind === "soldier" ? 22 : 18, tu: null, weight, strength: r.stats.strength, firing: r.stats.firing, reactions: r.stats.reactions, psiSkill: r.stats.psiSkill, psiStrength: r.stats.psiStrength, hasInventory: r.kind !== "hwp" };
      },
      items: toInv,
      move(item, slot, x, y) {
        if (slot === "STR_GROUND") {
          if (item.id >= 10000) return null;
          const it = member().items.splice(item.id, 1)[0];
          page.loadout.stash.push(it.type);
          if (it.ammo) page.loadout.stash.push(it.ammo);
          page.scheduleSave();
          return null;
        }
        if (!fits(item.type, slot, x, y, item.id < 10000 ? item.id : -1)) return "STR_NOT_ENOUGH_SPACE";
        if (item.id < 10000) {
          const it = member().items[item.id];
          it.slot = slot;
          it.x = x;
          it.y = y;
        } else {
          const t = takeFromAnywhere(item);
          member().items.push({ type: t.type, slot, x, y });
        }
        page.scheduleSave();
        return null;
      },
      load(weapon, ammo) {
        const w = weapon.id < 10000 ? member().items[weapon.id] : null;
        if (!w) {
          // loading a weapon lying in the stores: take both, put the loaded weapon in a free hand
          const hand = (["STR_RIGHT_HAND", "STR_LEFT_HAND"] as const).find((h) => fits(weapon.type, h, 0, 0, -1));
          if (!hand) return "STR_NOT_ENOUGH_SPACE";
          const aIdx = ammo.id;
          const wIdx = weapon.id;
          // remove the higher index first so indices stay valid
          for (const id of [Math.max(aIdx, wIdx), Math.min(aIdx, wIdx)]) {
            if (id >= 10000) page.loadout.stash.splice(id - 10000, 1);
            else member().items.splice(id, 1);
          }
          member().items.push({ type: weapon.type, slot: hand, x: 0, y: 0, ammo: ammo.type });
        } else {
          takeFromAnywhere(ammo);
          // indices may have shifted if the ammo came from the same unit
          const wNow = member().items.find((x) => x === w)!;
          wNow.ammo = ammo.type;
        }
        page.scheduleSave();
        return null;
      },
      unload(weapon) {
        if (weapon.id >= 10000) return null;
        const w = member().items[weapon.id];
        if (!w.ammo) return "STR_NO_AMMUNITION_LOADED";
        page.loadout.stash.push(w.ammo);
        w.ammo = undefined;
        page.scheduleSave();
        return null;
      },
      prev() {
        const ms = members();
        const i = ms.indexOf(member());
        cur = page.loadout.squad.indexOf(ms[(i - 1 + ms.length) % ms.length]);
        renderShop();
      },
      next() {
        const ms = members();
        const i = ms.indexOf(member());
        cur = page.loadout.squad.indexOf(ms[(i + 1) % ms.length]);
        renderShop();
      },
      close() {
        bg.remove();
        page.modal = null;
        cancelAnimationFrame(page.modalRaf);
        page.render();
      },
      groundLabel: () => "STORES (UNEQUIPPED)",
      buy(type, slot, x, y) {
        if (price(type) > left()) return "STR_NOT_ENOUGH_MONEY";
        if (slot === "STR_GROUND") page.loadout.stash.push(type);
        else {
          if (!fits(type, slot, x, y, -1)) return "STR_NOT_ENOUGH_SPACE";
          member().items.push({ type, slot, x, y });
        }
        page.scheduleSave();
        return null;
      },
      buyLoad(weapon, ammoType) {
        if (price(ammoType) > left()) return "STR_NOT_ENOUGH_MONEY";
        if (weapon.id >= 10000) {
          // a weapon in the stores: load it and carry it in a free hand
          const hand = (["STR_RIGHT_HAND", "STR_LEFT_HAND"] as const).find((h) => fits(weapon.type, h, 0, 0, -1));
          if (!hand) return "STR_NOT_ENOUGH_SPACE";
          page.loadout.stash.splice(weapon.id - 10000, 1);
          member().items.push({ type: weapon.type, slot: hand, x: 0, y: 0, ammo: ammoType });
        } else member().items[weapon.id].ammo = ammoType;
        page.scheduleSave();
        return null;
      },
      remove(item) {
        // selling refunds the full price (a loaded clip goes with its weapon)
        if (item.id >= 10000) page.loadout.stash.splice(item.id - 10000, 1);
        else member().items.splice(item.id, 1);
        page.scheduleSave();
        return null;
      },
    };
    const screen = new InventoryScreen(A, adapter);
    const scale = Math.max(2, Math.min(4, Math.floor(Math.min((innerWidth - 520) / 320, (innerHeight - 90) / 200))));
    const canvas = el("canvas", { width: 320, height: 200, style: { width: 320 * scale + "px", height: 200 * scale + "px" } }) as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(320, 200);
    const lut = lutFor(A.pal);
    const bigobs = A.unitSheet("BIGOBS.PCK");

    // budget bar above the inventory
    const budgetBar = el("div", { class: "equip-budget" });
    const renderBudget = () => {
      const check = checkLoadout(s.settings, s.pool, this.loadout);
      const r = recruit();
      const m = member();
      const unitCost = r.price + (s.armors.find((a) => a.type === m.armor)?.price ?? 0) + m.items.reduce((a, it) => a + price(it.type) + (it.ammo ? price(it.ammo) : 0), 0);
      const rest = s.settings.budget - check.cost;
      budgetBar.replaceChildren(
        el("span", { class: rest < 0 ? "bad" : "good" }, `${short(rest)} left`),
        el("span", { class: "muted" }, ` of ${short(s.settings.budget)}`),
        el("div", { class: "meter" + (rest < 0 ? " over" : "") }, el("div", { style: { width: Math.min(100, (check.cost / s.settings.budget) * 100) + "%" } })),
        el("span", {}, `${r.name}: ${short(unitCost)}`),
        s.settings.mode === "coop"
          ? el("span", { class: check.seats > s.settings.scenario.seatsPerPlayer ? "bad" : "muted" }, `seats ${check.seats}/${s.settings.scenario.seatsPerPlayer}`)
          : el("span", { class: check.seats > s.settings.squadLimit ? "bad" : "muted" }, `seats ${check.seats}/${s.settings.squadLimit}`),
        el("span", { class: "muted" }, this.loadout.stash.length ? `stores ${short(this.loadout.stash.reduce((a, t) => a + price(t), 0))}` : ""),
      );
    };

    // the shop: tabbed icon grid
    const tabs: [string, string][] = [["weapon", "Weapons"], ["ammo", "Ammo"], ["explosive", "Explosives"], ["equipment", "Equipment"], ["armor", "Armor"]];
    let tab = tabs.find(([k]) => s.catalog.some((c) => c.category === k))?.[0] ?? "weapon";
    const shop = el("div", { class: "panel shop" });
    const info = el("div", { class: "shop-info" });
    const iconCache = new Map<string, string>();
    const icon = (type: string): string => {
      let url = iconCache.get(type);
      if (url !== undefined) return url;
      const spr = bigobs[itemRule(type).bigSprite];
      url = "";
      if (spr) {
        const c = document.createElement("canvas");
        c.width = spr.width;
        c.height = spr.height;
        const cx = c.getContext("2d")!;
        const d = cx.createImageData(spr.width, spr.height);
        const o32 = new Uint32Array(d.data.buffer);
        for (let i = 0; i < spr.pixels.length; i++) o32[i] = spr.pixels[i] ? lut[spr.pixels[i]] : 0;
        cx.putImageData(d, 0, 0);
        url = c.toDataURL();
      }
      iconCache.set(type, url);
      return url;
    };
    const showInfo = (title: string, lines: string[]) => info.replaceChildren(el("div", { class: "title-line" }, title), ...lines.map((l) => el("div", { class: "muted" }, l)));
    const defaultInfo = () => showInfo("Drag gear onto the soldier", [
      "Drop it on a slot to buy and carry it, on a weapon to load it, or in the stores bar to keep it spare.",
      "Right-click anything carried or in the stores to sell it back.",
    ]);
    const renderShop = () => {
      renderBudget();
      const rest = left();
      const tabBar = el("div", { class: "shop-tabs" }, ...tabs.filter(([k]) => (k === "armor" ? s.armors.length > 1 : s.catalog.some((c) => c.category === k))).map(([k, label]) =>
        el("button", { class: "small" + (tab === k ? " primary" : ""), onclick: () => { tab = k; renderShop(); } }, label)));
      const grid = el("div", { class: "shop-grid" });
      if (tab === "armor") {
        const r = recruit();
        const m = member();
        for (const a of s.armors) {
          const current = (m.armor || "STR_NONE_UC") === a.type;
          const delta = a.price - (s.armors.find((x) => x.type === (m.armor || "STR_NONE_UC"))?.price ?? 0);
          const ok = r.kind === "soldier" && (current || delta <= rest);
          const t = el("div", { class: "shop-tile armor" + (current ? " current" : "") + (ok ? "" : " disabled"), title: tr(a.type) },
            el("div", { class: "tile-price" }, a.price ? short(a.price) : "free"),
            el("div", { class: "tile-name" }, armorShortName(a.type)));
          t.addEventListener("mouseenter", () => showInfo(tr(a.type), [
            a.price ? `${money(a.price)} per soldier` : "Free",
            r.kind !== "soldier" ? "Only human soldiers wear armor" : current ? "Worn by this soldier" : ok ? "Click to wear it" : "More than you have left",
          ]));
          t.addEventListener("mouseleave", defaultInfo);
          if (ok && !current) t.addEventListener("click", () => {
            m.armor = a.type;
            this.scheduleSave();
            renderShop();
          });
          grid.append(t);
        }
      } else {
        for (const c of s.catalog.filter((c) => c.category === tab)) {
          const ok = c.price <= rest;
          const src = icon(c.type);
          const ir = itemRule(c.type);
          const t = el("div", { class: "shop-tile" + (ok ? "" : " disabled"), title: tr(c.type) },
            // icons scaled to fit under the price tag (at most 2x)
            src ? el("img", { src, draggable: false, style: { width: ir.invWidth * 16 * Math.min(2, 66 / (ir.invWidth * 16), 70 / (ir.invHeight * 16)) + "px", marginTop: "16px" } }) : el("div", { class: "tile-name" }, tr(c.type)),
            el("div", { class: "tile-price" }, short(c.price)));
          t.addEventListener("mouseenter", () => showInfo(tr(c.type), [
            `${money(c.price)}${ok ? "" : " (more than you have left)"}`,
            itemDesc(c.type).replace(/^ — /, ""),
            `weight ${ir.weight}, ${ir.invWidth}x${ir.invHeight} slots`,
          ].filter(Boolean)));
          t.addEventListener("mouseleave", defaultInfo);
          if (ok) t.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            startDrag(c.type, e);
          });
          grid.append(t);
        }
      }
      shop.replaceChildren(tabBar, grid, info, el("button", { style: { marginTop: "10px" }, onclick: () => adapter.close() }, "Done"));
      if (!info.childElementCount) defaultInfo();
    };

    // dragging a shop item: a ghost follows the cursor outside the canvas; the inventory draws it inside
    const ghost = el("img", { class: "drag-ghost", draggable: false }) as HTMLImageElement;
    let drag: { type: string; x0: number; y0: number; moved: boolean } | null = null;
    const pos = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: Math.floor(((e.clientX - r.left) / r.width) * 320), y: Math.floor(((e.clientY - r.top) / r.height) * 200) };
    };
    const overCanvas = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
    };
    const moveGhost = (e: MouseEvent) => {
      const show = !!screen.held && !overCanvas(e) && !!ghost.getAttribute("src");
      ghost.style.display = show ? "block" : "none";
      ghost.style.left = e.clientX + "px";
      ghost.style.top = e.clientY + "px";
    };
    const startDrag = (type: string, e: MouseEvent) => {
      screen.selected = null;
      screen.held = type;
      drag = { type, x0: e.clientX, y0: e.clientY, moved: false };
      const src = icon(type);
      if (src) ghost.setAttribute("src", src);
      else ghost.removeAttribute("src");
      ghost.style.width = itemRule(type).invWidth * 16 * scale + "px";
      moveGhost(e);
    };
    const onMove = (e: MouseEvent) => {
      if (drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 5) drag.moved = true;
      if (overCanvas(e)) screen.mouse = pos(e);
      moveGhost(e);
    };
    const onUp = async (e: MouseEvent) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (overCanvas(e)) {
        const p = pos(e);
        await screen.click(p.x, p.y, false);
      } else if (d.moved) screen.held = null; // dropped somewhere else: cancel
      // (a plain click on a tile keeps the item in hand until the next click on the inventory)
      moveGhost(e);
      renderShop();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    // dropping a carried item on the shop sells it
    shop.addEventListener("mousedown", async () => {
      if (screen.selected && adapter.remove) {
        await adapter.remove(screen.selected);
        screen.selected = null;
        renderShop();
      }
    });
    const keys = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (screen.held || screen.selected) {
        screen.held = null;
        screen.selected = null;
        ghost.style.display = "none";
      } else adapter.close();
    };
    window.addEventListener("keydown", keys);
    const origClose = adapter.close;
    adapter.close = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("keydown", keys);
      origClose();
    };
    // switching soldiers updates the shop (armor tab, budget line)
    const origPrev = adapter.prev, origNext = adapter.next;
    adapter.prev = () => { origPrev(); renderShop(); };
    adapter.next = () => { origNext(); renderShop(); };

    renderShop();
    const bg = el("div", { class: "modal-bg" }, el("div", { class: "modal" }, el("div", { class: "equip-left" }, budgetBar, canvas), shop), ghost);
    this.modal = bg;
    document.body.append(bg);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("mousedown", async (e) => {
      if (drag) return;
      const p = pos(e);
      await screen.click(p.x, p.y, e.button === 2);
      renderShop();
    });
    const loop = () => {
      page.modalRaf = requestAnimationFrame(loop);
      const surf = screen.draw();
      const o32 = new Uint32Array(img.data.buffer);
      for (let i = 0; i < surf.pixels.length; i++) o32[i] = lut[surf.pixels[i]];
      ctx.putImageData(img, 0, 0);
    };
    loop();
  }
}

/** "$950", "$2.2k", "$15k", "$1.2M" */
/** One line describing a computer squad's AI settings. */
function botSummary(t: BotTuning): string {
  const d = DEFAULT_BOT_TUNING;
  if (JSON.stringify(t) === JSON.stringify(d)) return "standard AI";
  const parts = [["cautious", "normal", "bold", "reckless"][t.aggression] ?? "normal"];
  if (t.difficulty !== d.difficulty) parts.push(`explosives ${t.difficulty}/4`);
  if (t.intelligence !== d.intelligence) parts.push(`memory ${t.intelligence}`);
  if (t.cheatTurn !== d.cheatTurn) parts.push(`omniscient from round ${t.cheatTurn}`);
  if (t.personalities) parts.push("races play to type");
  if (t.strength !== 100) parts.push(`${t.strength}% strength`);
  return parts.join(" · ");
}

function sanitizeLocal(t: BotTuning): BotTuning {
  // the server clamps too; this just keeps empty inputs from saving as 0
  const out = { ...t };
  for (const k of ["intelligence", "cheatTurn", "strength"] as const) if (!Number.isFinite(out[k]) || !out[k]) out[k] = DEFAULT_BOT_TUNING[k];
  return out;
}

function short(n: number): string {
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  const trim = (x: string) => x.replace(/\.0$/, "");
  if (n >= 1e6) return `${sign}$${trim((n / 1e6).toFixed(n >= 1e7 ? 0 : 1))}M`;
  if (n >= 1000) return `${sign}$${trim((n / 1000).toFixed(n >= 10000 ? 0 : 1))}k`;
  return `${sign}$${Math.round(n)}`;
}

function armorShortName(type: string): string {
  return ({ STR_NONE_UC: "NONE", STR_PERSONAL_ARMOR_UC: "PERSONAL", STR_POWER_SUIT_UC: "POWER SUIT", STR_FLYING_SUIT_UC: "FLYING SUIT" } as Record<string, string>)[type] ?? tr(type);
}

function unitLabel(r: Recruit): string {
  if (r.kind === "soldier") return `${tr(r.rank)} · ${r.gender ? "female" : "male"}`;
  return r.rank ? `${r.rank}` : r.kind === "hwp" ? "Heavy weapons platform" : "";
}

function itemDesc(type: string): string {
  const r = itemRule(type);
  const bits: string[] = [];
  if (r.power) bits.push(`dmg ${r.power}`);
  if (r.clipSize > 0) bits.push(`${r.clipSize} rds`);
  if (r.clipSize === -1 && r.battleType === 1) bits.push("no ammo needed");
  if (r.compatibleAmmo.length) bits.push(`uses ${r.compatibleAmmo.map((a) => tr(a)).join("/")}`);
  return bits.length ? ` — ${bits.join(", ")}` : "";
}

function isSelfPowered(type: string): boolean {
  const r = itemRule(type);
  return r.clipSize === -1 || (r.battleType !== 1 && r.battleType !== 2 && !r.compatibleAmmo.length);
}

