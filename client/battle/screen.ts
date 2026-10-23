// The battlescape: renders the map + icon panel at the original 320x200-style resolution (scaled up),
// animates events received from the server and turns clicks into commands.
import { Surface } from "../render/surface.ts";
import { Assets, battleFileList } from "../render/assets.ts";
import { MapRenderer, type MapViewState, mapToScreen, screenToMap, voxelToScreen, drawTinyText, type Explosion } from "../render/mapview.ts";
import { drawText, drawFrame, textWidth, wrapText } from "../render/text.ts";
import { exposureAt } from "./exposure.ts";
import { drawHud, hudHit, ICONS_W, ICONS_H, TOOLTIPS, type HudButton, type HudState } from "./hud.ts";
import { InventoryScreen, type InvAdapter, type InvItem } from "../ui/inventory.ts";
import { preload, getFile, hasFile } from "../files.ts";
import { initAudio, playSound, playTurnChime, playMusic, stopMusic, applyMusicSettings, unlockAudio, SND, audioSettings, saveAudioSettings } from "../audio.ts";
import { applyView, type PlayerView } from "../../shared/engine/view.ts";
import { type Battle, type Unit, type Item, isOut, Phase } from "../../shared/engine/state.ts";
import type { BattleEvent } from "../../shared/engine/events.ts";
import type { Command, Hand } from "../../shared/engine/actions.ts";
import { Pathfinder } from "../../shared/engine/pathfinding.ts";
import { type Pos, UnitStatus, DIR_UP, DIR_DOWN, directionTo, posEq } from "../../shared/engine/defs.ts";
import { itemRule, tr, BattleType, explosionRadius, armorRule, type SlotId } from "../../shared/rules/index.ts";
import { actionTUs, firingAccuracy, carriedWeight, roundsLeft } from "../../shared/engine/unitops.ts";
import { calculateUnitLighting } from "../../shared/engine/tileengine.ts";
import { memberOf, membersOf, mayCommand, controllerOf, isAfk, isShared, waitingFor } from "../../shared/engine/coop.ts";
import { api } from "../api.ts";
import { shareDialog } from "./share.ts";

type ActionKind = "snap" | "aimed" | "auto" | "throw" | "melee" | "psi" | "probe" | "launch";

interface MenuItem {
  label: string;
  acc?: number;
  tu: number;
  run: () => void;
}

type Dialog =
  | { kind: "menu"; items: MenuItem[] }
  | { kind: "prime"; hand: Hand; proximity: boolean }
  | { kind: "medikit"; hand: Hand; target: number; part: number }
  | { kind: "scanner"; blips: { x: number; y: number; size: number }[]; dir: number }
  | { kind: "unitinfo"; unit: Unit | null; stats?: any }
  | { kind: "minimap" }
  | { kind: "options" }
  | { kind: "abort" }
  | { kind: "restart" }
  | { kind: "nextturn"; title: string; sub: string }
  | { kind: "gameover" };

const TEAM_COLORS = [16 * 4, 16 * 2, 16 * 8, 16 * 3, 16 * 12, 16 * 9, 16 * 5, 16 * 14];
/** Squads past the eighth (people can keep joining) reuse the colours. */
const teamColor = (side: number) => TEAM_COLORS[side % TEAM_COLORS.length];

const MESSAGES: Record<string, string> = {
  STR_TURN_BEGINS: "{0}'s turn",
  STR_HAS_BEEN_KILLED: "{0} has been killed",
  STR_HAS_BECOME_UNCONSCIOUS: "{0} has become unconscious",
  STR_MIND_CONTROL_SUCCESSFUL: "Mind control successful",
  STR_MIND_CONTROL_FAILED: "Mind control failed",
  STR_IS_UNDER_ALIEN_CONTROL: "{0} is under enemy control!",
  STR_PLAYER_ELIMINATED: "{0}'s squad has been wiped out",
  STR_PLAYER_SURRENDERED: "{0} has surrendered",
  STR_GAME_OVER: "Battle over",
  STR_SUPPLY_DROP_INBOUND: "Supply drop inbound in {0} rounds",
  STR_SUPPLY_DROP_LANDED: "Supply drop has landed",
  STR_TURN_TIMER_EXPIRED: "Turn timer expired",
  STR_TEAMMATES_UNIT: "That unit is a teammate's (G gives yours away)",
  STR_UNIT_PLAYED_BY_AI: "The AI is playing that unit for an AFK teammate",
  STR_ONLY_LEADER_SURRENDERS: "Only the squad leader can surrender",
  STR_GAME_MASTER_WATCHES: "The game master watches: the team gives the orders",
  STR_REINFORCEMENTS_ARRIVED: "{0}: reinforcements have arrived!",
  STR_JOINED_BATTLE: "{0} has joined the battle",
  STR_HOST_HANDED_TO_AI: "The host had the AI play this turn for {0}",
  STR_HOST_ONLY: "Only the host can do that",
  STR_NOBODY_TO_WAIT_FOR: "Nobody is holding up this turn",
};
function msgText(key: string, arg?: string) {
  return (MESSAGES[key] ?? tr(key)).replace("{0}", arg ?? "");
}

/** How far in from the viewport edge (in game pixels) the mouse starts scrolling the map. */
const EDGE_ZONE = 24;

export class BattleScreen {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  assets!: Assets;
  renderer!: MapRenderer;
  surf!: Surface;
  image!: ImageData;
  scale = 2;
  vw = 320;
  vh = 200;
  private endingTurn = false;
  private scrollRest = { x: 0, y: 0 };
  private exposureKey = "";
  b: Battle | null = null;
  you = 0;
  ws: WebSocket | null = null;
  st: MapViewState;
  hud: HudState = { reserve: "none", reserveKneel: false, pressed: null, showLayers: false, warning: "", warningTime: 0, tooltip: "" };
  queue: { events: BattleEvent[]; view: PlayerView; deadline: number | null; by: string }[] = [];
  processing = false;
  /** the update being animated is someone else's (a co-op teammate's): it doesn't hold up your own orders */
  processingOthers = false;
  /** the match creator: may have the AI play for whoever holds up a turn */
  isHost = false;
  /** the battle can be played again from its start (a retry, or shared as a challenge), and the challenge it's a go at */
  replayable = false;
  challengeId: string | null = null;
  /** where the host's "AI: play for ..." button was drawn this frame (null: not shown) */
  private hostAiRect: { x: number; y: number; w: number; h: number } | null = null;
  busy = false;
  seq = 0;
  pending = new Map<number, (r: { ok: boolean; error?: string; private?: any }) => void>();
  waitingUpdate: (() => void) | null = null;
  action: { kind: ActionKind; hand: Hand | "innate"; waypoints: Pos[] } | null = null;
  pathTarget: Pos | null = null;
  dialog: Dialog | null = null;
  inventory: InventoryScreen | null = null;
  mouse = { x: 0, y: 0, inside: false };
  drag: { x: number; y: number; cx: number; cy: number } | null = null;
  messages: { text: string; time: number }[] = [];
  deadline: number | null = null;
  online = new Set<string>();
  keys = new Set<string>();
  lastAnimTick = 0;
  ready = false;
  pathPreview = true;
  private loadingText = "CONNECTING...";
  private incoming: PlayerView | null = null;

  constructor(private root: HTMLElement, private matchId: string, private me: { id: string; name: string }, private onExit: () => void, private go: (path: string) => void) {
    root.innerHTML = "";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "battle-canvas";
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this.st = {
      player: 0, camera: { x: 0, y: 0, z: 0 }, showAllLayers: false, cursor: { x: 0, y: 0, z: 0, kind: "normal", size: 1, visible: false },
      selected: -1, anims: new Map(), poses: new Map(), projectile: null, explosions: [], flash: false, animFrame: 0,
      teamColors: TEAM_COLORS, supplyMarkers: [], crates: new Set(), path: null, doorAnim: new Map(),
    };
    try {
      this.pathPreview = localStorage.getItem("xcom.pathPreview") !== "0";
    } catch {
      /* ignore */
    }
    this.bindInput();
    (window as any).__xcom = this;
    this.resize();
    window.addEventListener("resize", this.resize);
    this.connect();
    this.raf = requestAnimationFrame(this.frame);
  }

  private raf = 0;
  private destroyed = false;
  /** bumped whenever a full view replaces the battle copy; stale queued updates are dropped */
  private generation = 0;

  destroy() {
    this.destroyed = true;
    stopMusic();
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mouseup", this.onMouseUp);
    window.removeEventListener("blur", this.onBlur);
    this.chatInput?.remove();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    if ((window as any).__xcom === this) (window as any).__xcom = null;
    this.root.innerHTML = "";
  }

  // ------------------------------------------------------------------------------------------
  // networking
  // ------------------------------------------------------------------------------------------

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    if (this.destroyed) return;
    const ws = new WebSocket(`${proto}://${location.host}/ws?match=${this.matchId}`);
    this.ws = ws;
    ws.onmessage = (e) => this.onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      if (this.ws !== ws || e.code === 4003) return;
      this.loadingText = "RECONNECTING...";
      setTimeout(() => this.ws === ws && this.connect(), 2000);
    };
  }

  private async onMessage(m: any) {
    switch (m.t) {
      case "view":
        this.isHost = !!m.host;
        this.replayable = !!m.replayable;
        this.challengeId = m.challenge ?? null;
        await this.onFullView(m.view as PlayerView);
        this.deadline = m.deadline;
        break;
      case "update":
        this.queue.push({ events: m.events, view: m.view, deadline: m.deadline, by: m.by ?? "" });
        if (this.b) this.processQueue();
        break;
      case "result": {
        const cb = this.pending.get(m.seq);
        this.pending.delete(m.seq);
        cb?.(m);
        break;
      }
      case "presence":
        this.online = new Set(m.online);
        break;
      case "chat":
        this.messages.push({ text: `${m.from}: ${m.text}`, time: performance.now() });
        break;
      case "lobby":
        // the match hasn't started (or was reset): go back to the lobby
        if (m.lobby?.status === "lobby") this.onExit();
        break;
      case "deleted":
        this.onExit();
        break;
      case "error":
        this.loadingText = String(m.error).toUpperCase();
        break;
    }
  }

  private async onFullView(v: PlayerView) {
    // updates queued so far are already included in this snapshot; ones that arrive while it loads are not
    const stale = this.queue.length;
    if (!this.assets) {
      this.loadingText = "LOADING GAME DATA...";
      await preload(battleFileList(v.datasets!), (d, t) => (this.loadingText = `LOADING GAME DATA ${Math.floor((d / t) * 100)}%`));
      this.assets = new Assets(getFile, hasFile);
      this.renderer = new MapRenderer(this.assets);
      initAudio();
    }
    const first = !this.b;
    this.generation++;
    this.queue.splice(0, stale);
    this.pending.clear();
    this.waitingUpdate = null;
    this.busy = false;
    this.st.anims.clear();
    this.st.poses.clear();
    this.st.projectile = null;
    this.st.explosions = [];
    this.b = applyView(null, v, getFile);
    this.you = v.you;
    this.st.player = v.you;
    this.syncSupply();
    this.ready = true;
    this.updateMusic();
    if (first) {
      const mine = this.myUnits();
      if (mine.length) {
        this.select(mine[0]);
        this.centerOn(mine[0].pos);
      } else this.centerOn({ x: this.b.sx >> 1, y: this.b.sy >> 1, z: 0 });
      if (this.myTurn()) this.showNextTurn();
    }
    if (this.queue.length) this.processQueue();
  }

  private send(cmd: Command): Promise<{ ok: boolean; error?: string; private?: any }> {
    return this.sendMsg({ t: "cmd", cmd });
  }

  /** Sends a message that gets a result (and, normally, an update of ours) back. */
  private sendMsg(msg: Record<string, unknown>): Promise<{ ok: boolean; error?: string; private?: any }> {
    // one command at a time: the server resolves each action fully before the next
    if (this.busy) return Promise.resolve({ ok: false, error: "STR_BUSY" });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.warn("STR_NOT_CONNECTED");
      return Promise.resolve({ ok: false, error: "STR_NOT_CONNECTED" });
    }
    return new Promise((resolve) => {
      const seq = ++this.seq;
      this.busy = true;
      let gotResult: { ok: boolean; error?: string; private?: any } | null = null;
      let gotUpdate = false;
      const finish = () => {
        if (gotResult && gotUpdate) {
          this.busy = false;
          resolve(gotResult);
        }
      };
      this.pending.set(seq, (r) => {
        gotResult = r;
        // turned away before anything happened: no update follows
        if ((r as { noUpdate?: boolean }).noUpdate) gotUpdate = true;
        if (!r.ok && r.error) this.warn(r.error);
        finish();
      });
      this.waitingUpdate = () => {
        gotUpdate = true;
        finish();
      };
      // never lock the UI forever if something goes missing
      const timer = setTimeout(() => {
        if (!gotResult || !gotUpdate) {
          this.pending.delete(seq);
          this.waitingUpdate = null;
          this.busy = false;
          resolve(gotResult ?? { ok: false, error: "STR_TIMEOUT" });
        }
      }, 15000);
      try {
        this.ws!.send(JSON.stringify({ ...msg, seq }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(seq);
        this.waitingUpdate = null;
        this.busy = false;
        resolve({ ok: false, error: "STR_NOT_CONNECTED" });
      }
    });
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length && this.b && !this.destroyed) {
        const u = this.queue.shift()!;
        const gen = this.generation;
        const wasMyTurn = this.myTurn();
        const ours = u.by === this.me.id;
        this.incoming = u.view;
        this.processingOthers = !ours;
        // something happens where we can see it (shots at us, a move into view...): never play it behind the
        // "waiting for..." screen
        if (!ours && this.dialog?.kind === "nextturn" && this.dialog.title === "TURN OVER" && u.events.some((e) => e.t !== "msg")) this.dialog = null;
        await this.animate(u.events);
        this.processingOthers = false;
        this.incoming = null;
        if (gen !== this.generation) continue; // a full view arrived meanwhile
        const prevSel = this.st.selected;
        this.b = applyView(this.b, u.view, getFile);
        this.st.anims.clear();
        this.st.poses.clear();
        this.st.doorAnim.clear();
        this.deadline = u.deadline;
        this.syncSupply();
        const sel = this.b.unit(prevSel);
        if (!sel || sel.owner !== this.you || isOut(sel) || (!this.mayCommand(sel) && this.myUnits().length)) {
          const next = this.myUnits().find((x) => x.tu > 0) ?? this.myUnits()[0];
          if (next) this.select(next);
          else this.st.selected = -1;
        }
        this.refreshPath();
        // only the update our own order caused completes it (teammates act at the same time)
        if (ours) {
          const w = this.waitingUpdate;
          this.waitingUpdate = null;
          w?.();
        }
        if (!wasMyTurn && this.myTurn()) {
          // the turn came back round: a quiet chime, in case you're looking at another tab
          playTurnChime();
          this.showNextTurn();
        }
        if (this.b.phase === Phase.FINISHED) this.dialog = { kind: "gameover" };
        this.updateMusic();
      }
    } finally {
      this.processing = false;
    }
  }

  /** The battle track for this environment (as OpenXcom picks them), and a win/lose piece at the end. */
  private updateMusic() {
    const b = this.b;
    if (!b || this.destroyed) return;
    if (b.phase === Phase.FINISHED) playMusic(b.winner === this.you ? "GMWIN" : "GMLOSE", false);
    else playMusic(b.settings.biome === "UBASE" ? "GMENBASE" : b.settings.biome === "MARS" ? "GMMARS" : "GMTACTIC");
  }

  private syncSupply() {
    if (!this.b) return;
    // drops on their way get a countdown beacon; landed ones are just a crate on the ground until emptied
    this.st.supplyMarkers = this.b.supply.filter((s) => !s.dropped).map((s) => ({
      pos: s.pos,
      dropped: false,
      label: String(Math.max(0, s.dropRound - this.b!.round)),
    }));
    this.st.crates = new Set(this.b.supply.filter((s) => s.dropped && s.stocked && s.at).map((s) => this.b!.idxP(s.at!)));
  }

  // ------------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------------

  myTurn() {
    return !!this.b && this.b.current === this.you && this.b.phase === Phase.PLAYING;
  }
  /** Input waits for our own orders to play out, but not for a co-op teammate's. */
  inputLocked() {
    return this.busy || (this.processing && !this.processingOthers);
  }
  /** Units you give orders to (in a co-op squad, the ones dealt to you, plus any shared ones). */
  myUnits(): Unit[] {
    return this.b ? this.b.units.filter((u) => u.owner === this.you && !isOut(u) && u.status !== UnitStatus.IGNORE_ME && u.stats.tu > 0 && this.mayCommand(u)) : [];
  }
  mayCommand(u: Unit): boolean {
    return !!this.b && mayCommand(this.b, this.me.id, u) === null;
  }
  /** Your place in a co-op squad (undefined in battles from before co-op). */
  member() {
    return this.b ? memberOf(this.b, this.you, this.me.id) : undefined;
  }
  selectedUnit(): Unit | null {
    const u = this.b?.unit(this.st.selected);
    return u && u.owner === this.you && !isOut(u) ? u : null;
  }
  select(u: Unit) {
    this.st.selected = u.id;
    this.cancelAction();
    this.st.camera.z = u.pos.z;
  }
  warn(msg: string) {
    this.hud.warning = msgText(msg).toUpperCase();
    this.hud.warningTime = performance.now();
  }
  private mapH() {
    return this.vh - ICONS_H;
  }
  centerOn(p: Pos) {
    const s = mapToScreen(p);
    this.st.camera.x = Math.round(this.vw / 2 - (s.x + 16));
    this.st.camera.y = Math.round(this.mapH() / 2 - (s.y + 20));
    this.st.camera.z = Math.max(0, Math.min((this.b?.sz ?? 4) - 1, p.z));
  }
  private onScreen(p: Pos): boolean {
    const s = mapToScreen(p);
    const x = s.x + this.st.camera.x, y = s.y + this.st.camera.y;
    return x > 8 && x < this.vw - 40 && y > 8 && y < this.mapH() - 40;
  }
  private isVisibleToMe(id: number) {
    const u = this.b?.unit(id);
    return !!u;
  }
  private wait(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  // ------------------------------------------------------------------------------------------
  // animation of server events
  // ------------------------------------------------------------------------------------------

  private async animate(events: BattleEvent[]) {
    const b = this.b!;
    for (const e of events) {
      try {
        await this.playEvent(b, e);
      } catch (err) {
        console.warn("animation error", e, err);
      }
    }
  }

  private ensureUnit(b: Battle, e: Extract<BattleEvent, { t: "move" }>): Unit {
    let u = b.unit(e.unit);
    if (!u) {
      const a = e.app;
      u = {
        id: e.unit, owner: a.owner, originalOwner: a.originalOwner, type: a.type, race: a.race, name: a.name, rank: a.rank, rankInt: 0,
        gender: a.gender, look: a.look, armor: a.armor, stats: { tu: 0, stamina: 0, health: 1, bravery: 0, reactions: 0, firing: 0, throwing: 0, strength: 0, psiStrength: 0, psiSkill: 0, melee: 0 },
        baseHeights: a.baseHeights, pos: { ...e.from }, dir: e.dir, turretDir: a.turretDir, turretType: a.turretType, tu: 0, energy: 0, health: 1, stun: 0, morale: 100,
        kneeled: a.kneeled, floating: false, status: UnitStatus.STANDING, armorNow: [0, 0, 0, 0, 0], armorMax: [0, 0, 0, 0, 0], wounds: [0, 0, 0, 0, 0, 0], fire: 0,
        loftemps: a.loftemps, movementType: a.movementType, size: a.size, specab: 0, spawnUnit: "", spawnOwner: -1, respawn: false, deathSound: [], moveSound: -1,
        energyRecovery: 0, woundable: false, nightVision: false, hasInventory: false, visibleUnits: [], spottedThisTurn: [], mindControllerId: -1, kills: 0, recruitId: "",
        activeHand: "STR_RIGHT_HAND", psiWeapon: false, hitByFire: false, motionPoints: 0, killedBy: -1, value: 0, hwp: false,
      };
      b.addUnit(u);
      b.placeUnit(u, e.from);
      for (const [slot, type] of a.hands) b.createItem(type, { owner: u.id, slot: slot as SlotId });
    }
    return u;
  }

  private async playEvent(b: Battle, e: BattleEvent) {
    // teammates acting at once can queue up moves faster than they play out: catch up rather than lag behind
    const fast = this.keys.has("Shift") || this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") || this.queue.length > 1;
    switch (e.t) {
      case "move": {
        const u = this.ensureUnit(b, e);
        if (u.status !== UnitStatus.STANDING) u.status = UnitStatus.STANDING;
        const vertical = e.from.x === e.to.x && e.from.y === e.to.y;
        const end = vertical ? 8 : e.dir % 2 ? 16 : 8;
        u.dir = e.dir;
        if (!this.onScreen(e.to) && (u.owner !== this.you || u.id === this.st.selected)) this.centerOn(e.to);
        this.st.camera.z = Math.max(this.st.camera.z, Math.min(e.to.z, b.sz - 1));
        if ((u.owner === this.you && this.mayCommand(u)) || u.id === this.st.selected) this.st.camera.z = e.to.z;
        const anim = { from: e.from, to: e.to, phase: 0, end };
        this.st.anims.set(u.id, anim);
        const stepMs = fast ? 8 : 28;
        for (let p = 0; p < end; p++) {
          anim.phase = p;
          // like UnitWalkBState::playMovementSound: footsteps at phases 3 and 7 (from the tile the unit is on
          // at that moment), a whoosh at phase 1 when airborne, or the unit's own movement sound once
          if (u.moveSound >= 0) {
            if (p === 0) playSound(u.moveSound, this.pan(e.to));
          } else if (e.fly) {
            if (p === 1) playSound(SND.FLY, this.pan(e.to));
          } else if (p % 8 === 3 || p % 8 === 7) this.footstep(b, p < end / 2 ? e.from : e.to, p % 8 === 7);
          await this.wait(stepMs);
        }
        this.st.anims.delete(u.id);
        b.placeUnit(u, e.to);
        u.floating = e.fly;
        calculateUnitLighting(b);
        break;
      }
      case "fall": {
        const u = b.unit(e.unit);
        if (!u) break;
        const anim = { from: e.from, to: e.to, phase: 0, end: 8 };
        this.st.anims.set(u.id, anim);
        for (let p = 0; p < 8; p++) {
          anim.phase = p;
          await this.wait(20);
        }
        this.st.anims.delete(u.id);
        b.placeUnit(u, e.to);
        break;
      }
      case "turn": {
        const u = b.unit(e.unit);
        if (!u) break;
        u.dir = e.dir;
        if (e.turret !== undefined) u.turretDir = e.turret;
        await this.wait(fast ? 5 : 30);
        break;
      }
      case "kneel": {
        const u = b.unit(e.unit);
        if (u) u.kneeled = e.kneeled;
        break;
      }
      case "door": {
        playSound(e.ufo ? SND.UFO_DOOR : SND.DOOR, this.pan(b.posOf(e.tile)));
        // show the new door tile right away (the rest of the terrain updates after the action)
        const row = this.incoming?.tiles.find((r) => r[0] === e.tile);
        if (e.ufo) {
          for (let f = 1; f <= 7; f++) {
            this.st.doorAnim.set(e.tile * 4 + 1, f);
            this.st.doorAnim.set(e.tile * 4 + 2, f);
            await this.wait(fast ? 5 : 40);
          }
        }
        if (row) {
          for (let k = 0; k < 4; k++) b.parts[e.tile * 4 + k] = row[1 + k];
          b.doorOpen[e.tile] = row[7];
        }
        this.st.doorAnim.delete(e.tile * 4 + 1);
        this.st.doorAnim.delete(e.tile * 4 + 2);
        break;
      }
      case "aim": {
        if (e.aiming) this.st.poses.set(e.unit, { status: UnitStatus.AIMING });
        else this.st.poses.delete(e.unit);
        break;
      }
      case "shot": {
        const shooter = b.unit(e.unit);
        const path = e.path.length === 2 ? voxelLine(e.path[0], e.path[1]) : densify(e.path);
        const end = path[path.length - 1];
        const endTile = { x: end.x >> 4, y: end.y >> 4, z: Math.floor(end.z / 24) };
        if (shooter && !this.onScreen(shooter.pos)) this.centerOn(shooter.pos);
        // a shot at us from someone we can't see (in the dark, say): watch it come in where it lands
        else if (!shooter && !this.onScreen(endTile)) this.centerOn(endTile);
        playSound(e.sound, this.pan(shooter ? shooter.pos : endTile));
        this.st.projectile = { path, pos: 0, bullet: e.bullet };
        const speed = 8;
        for (let i = 0; i < path.length + 35; i += speed) {
          this.st.projectile.pos = Math.min(i, path.length - 1);
          if (i >= path.length) break;
          await this.wait(fast ? 4 : 16);
        }
        this.st.projectile = null;
        if (!this.onScreen(endTile)) this.centerOn(endTile);
        break;
      }
      case "throw": {
        playSound(SND.ITEM_THROW);
        const path = densify(e.path);
        this.st.projectile = { path, pos: 0, bullet: -1, item: e.item };
        const shooter = b.unit(e.unit);
        // the item leaves the thrower's hand
        if (shooter) for (const it of b.unitItems(shooter)) if (it.type === e.item && (it.slot === "STR_RIGHT_HAND" || it.slot === "STR_LEFT_HAND")) { b.removeItem(it); break; }
        for (let i = 0; i < path.length; i += 4) {
          this.st.projectile.pos = i;
          await this.wait(fast ? 4 : 16);
        }
        this.st.projectile = null;
        playSound(SND.ITEM_DROP);
        break;
      }
      case "hit": {
        playSound(e.sound, this.pan({ x: e.at.x >> 4, y: e.at.y >> 4, z: 0 }));
        if (e.anim >= 0) await this.runExplosions([{ at: e.at, frame: e.anim, delay: 0, kind: "smoke", first: e.anim, last: e.anim + 10 }], 40);
        break;
      }
      case "melee": {
        playSound(e.sound);
        await this.runExplosions([{ at: e.at, frame: 0, delay: 0, kind: "hit", first: 0, last: 4 }], 60);
        break;
      }
      case "explosion": {
        const tile = { x: e.at.x >> 4, y: e.at.y >> 4, z: Math.floor(e.at.z / 24) };
        if (!this.onScreen(tile)) this.centerOn(tile);
        playSound(e.small ? SND.SMALL_EXPLOSION : SND.LARGE_EXPLOSION, this.pan(tile));
        const list: Explosion[] = [];
        const n = Math.max(1, Math.floor(e.power / 5));
        const counter = Math.max(1, Math.floor(e.power / 5 / 5));
        let delay = 0;
        for (let i = 0; i < n; i++) {
          const at = { x: e.at.x + rnd(-e.power / 2, e.power / 2), y: e.at.y + rnd(-e.power / 2, e.power / 2), z: e.at.z };
          list.push({ at, frame: e.frame, delay, kind: "big", first: e.frame, last: e.frame + 8 });
          if (i > 0 && i % counter === 0) delay++;
        }
        this.st.flash = true;
        await this.wait(40);
        this.st.flash = false;
        await this.runExplosions(list, fast ? 20 : 50);
        break;
      }
      case "collapse": {
        const u = b.unit(e.unit);
        if (!u) break;
        if (!this.onScreen(u.pos)) this.centerOn(u.pos);
        if (e.dead && u.deathSound?.length) playSound(u.deathSound[Math.floor(Math.random() * u.deathSound.length)], this.pan(u.pos));
        const frames = armorRule(u.armor).deathFrames;
        for (let f = 0; f < frames; f++) {
          this.st.poses.set(u.id, { status: UnitStatus.COLLAPSING, fallPhase: f });
          await this.wait(fast ? 20 : 90);
        }
        this.st.poses.delete(u.id);
        b.clearUnitTiles(u);
        u.status = e.dead ? UnitStatus.DEAD : UnitStatus.UNCONSCIOUS;
        break;
      }
      case "psi":
        playSound(e.sound);
        await this.wait(200);
        break;
      case "msg":
        if (e.text === "STR_TURN_BEGINS") break;
        this.messages.push({ text: msgText(e.text, e.arg), time: performance.now() });
        break;
      case "supply":
        if (!e.dropped) {
          if (!b.supply.some((s) => posEq(s.pos, e.pos) && !s.dropped)) b.supply.push({ id: b.supply.length + 1, pos: e.pos, dropRound: e.round, announcedRound: b.round, dropped: false, items: [] });
        }
        this.syncSupply();
        break;
      default:
        break;
    }
  }

  /** Tile::getFootstepSound: the floor's, overridden by a walkable object's, or the stairs below. */
  private footstep(b: Battle, at: Pos, second: boolean) {
    const t = b.idxP(at);
    if (t < 0) return;
    const floor = b.part(t, 0), obj = b.part(t, 3);
    let f = floor ? floor.footstep : -1;
    if (obj && obj.bigWall <= 1 && obj.footstep > -1) f = obj.footstep;
    if (!floor && !obj) {
      const below = b.idx(at.x, at.y, at.z - 1);
      if (below >= 0 && b.terrainLevel(below) === -24) f = b.part(below, 3)?.footstep ?? -1;
    }
    if (f > -1) playSound(SND.WALK + f * 2 + (second ? 1 : 0), this.pan(at));
  }

  private pan(p: Pos) {
    const s = mapToScreen(p);
    return ((s.x + this.st.camera.x) / this.vw) * 2 - 1;
  }

  private async runExplosions(list: Explosion[], ms: number) {
    this.st.explosions.push(...list);
    while (list.some((x) => x.frame < x.last)) {
      await this.wait(ms);
      for (const x of list) {
        if (x.delay > 0) x.delay--;
        else if (x.frame < x.last) x.frame++;
      }
    }
    this.st.explosions = this.st.explosions.filter((x) => !list.includes(x));
  }

  // ------------------------------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------------------------------

  private resize = () => {
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    // integer scale so pixels stay crisp; keep at least 320x200 visible
    // integer scale with a bit more map than the original 320x200 on typical screens
    const scale = Math.max(1, Math.min(Math.floor(W / 320), Math.floor(H / 270) || 1));
    this.scale = scale;
    this.vw = Math.floor(W / scale);
    this.vh = Math.floor(H / scale);
    this.canvas.width = this.vw;
    this.canvas.height = this.vh;
    this.canvas.style.width = `${this.vw * scale}px`;
    this.canvas.style.height = `${this.vh * scale}px`;
    this.surf = new Surface(this.vw, this.vh);
    this.image = this.ctx.createImageData(this.vw, this.vh);
    void dpr;
  };

  private frame = (t: number) => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (t - this.lastAnimTick > 100) {
      this.lastAnimTick = t;
      this.st.animFrame = (this.st.animFrame + 1) % 8;
    }
    this.scrollStep();
    this.render();
  };

  private render() {
    const s = this.surf;
    s.clear(0);
    if (!this.ready || !this.b) {
      this.ctx.fillStyle = "#000";
      this.ctx.fillRect(0, 0, this.vw, this.vh);
      this.ctx.fillStyle = "#6c6";
      this.ctx.font = "8px monospace";
      this.ctx.fillText(this.loadingText, 8, 16);
      return;
    }
    const A = this.assets;
    if (this.inventory && !this.selectedUnit()) this.inventory = null;
    if (this.inventory) {
      const inv = this.inventory.draw();
      const ox = Math.floor((this.vw - 320) / 2), oy = Math.floor((this.vh - 200) / 2);
      s.blit(inv.asImage(), ox, oy);
      this.present();
      return;
    }
    this.st.showAllLayers = this.hud.showLayers;
    const sel0 = this.selectedUnit();
    this.st.waypoints = this.action?.kind === "launch" && sel0 ? { from: sel0.pos, points: this.action.waypoints } : undefined;
    this.renderer.draw(s, this.b, this.st, this.vh);
    const ix = Math.floor((this.vw - ICONS_W) / 2), iy = this.vh - ICONS_H;
    drawHud(s, ix, iy, A, this.b, this.selectedUnit(), this.hud, this.st.camera.z, this.myTurn());
    this.drawVisibleEnemies(ix, iy);
    this.drawOverlay(ix, iy);
    if (this.dialog) this.drawDialog();
    this.present();
  }

  private present() {
    this.surf.toRGBA(this.assets.pal, this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** The red numbered boxes above the panel listing visible enemies (click to center). */
  private visibleEnemies(): Unit[] {
    const b = this.b!;
    return b.units.filter((u) => u.owner !== this.you && !isOut(u) && u.status !== UnitStatus.IGNORE_ME).slice(0, 10);
  }
  private drawVisibleEnemies(ix: number, iy: number) {
    const list = this.visibleEnemies();
    list.forEach((u, i) => {
      const x = ix + 300, y = iy - 16 - i * 13;
      const color = teamColor(u.owner);
      this.surf.fillRect(x, y, 15, 12, color + 8);
      this.surf.rect(x, y, 15, 12, color + 2);
      drawText(this.surf, this.assets.small, String(i + 1), x + 4, y + 2, 15 - 5 > 0 ? 0 : 0);
    });
  }

  private drawOverlay(ix: number, iy: number) {
    const s = this.surf, A = this.assets, b = this.b!;
    // turn banner
    const cur = b.players[b.current];
    let banner = b.phase === Phase.FINISHED ? "BATTLE OVER" : `ROUND ${b.round}: ${(cur?.name ?? "").toUpperCase()}${this.myTurn() ? (this.member()?.observer ? " (GM VIEW)" : " (YOU)") : ""}`;
    if (this.deadline && b.phase === Phase.PLAYING) {
      const secs = Math.max(0, Math.ceil((this.deadline - Date.now()) / 1000));
      // daily turn ends can be hours away
      const hms = secs >= 3600 ? `${Math.floor(secs / 3600)}:${String(Math.floor(secs / 60) % 60).padStart(2, "0")}` : `${Math.floor(secs / 60)}`;
      banner += `  ${hms}:${String(secs % 60).padStart(2, "0")}`;
    }
    drawText(s, A.small, banner, 4, 4, this.myTurn() ? 16 * 4 - 1 : 16 - 1, { contrast: true });
    // whose turn it is, front and centre, whenever it isn't yours (or you're done with it, in a co-op squad)
    const coop = this.coopBanner();
    if (b.phase === Phase.PLAYING && (this.endingTurn || !this.myTurn() || coop)) {
      const text = this.endingTurn ? "ENDING TURN..." : coop || `${(cur?.name ?? "").toUpperCase()}'S TURN - WAITING`;
      const w = Math.min(this.vw - 8, textWidth(A.big, text) + 16);
      const x = Math.floor((this.vw - w) / 2);
      // below the round/squad list if the screen is too narrow for both side by side
      const y = x < textWidth(A.small, banner) + 12 ? 18 + b.players.length * 9 + 12 : 3;
      drawFrame(s, x, y, w, 20, 16 * 2, 3, 15);
      // flashes red/yellow; glyph shades add up to +15 to the base colour, so each base stays 16 below its ramp's end
      drawText(s, A.big, text, x, y + 3, this.st.animFrame % 4 < 2 ? 16 * 2 - 1 : 16 * 1 - 1, { align: "center", width: w, contrast: true });
      this.drawHostAiButton(y + 24);
    } else this.drawHostAiButton(3);
    this.drawSquadMembers();
    // squads
    b.players.forEach((p, i) => {
      const alive = b.units.filter((u) => u.originalOwner === i && !isOut(u)).length;
      const text = `${p.name.toUpperCase()}${p.eliminated ? " (OUT)" : ""}${i === this.you ? " *" : ""}`;
      const y = 14 + i * 9;
      s.fillRect(4, y + 1, 5, 5, teamColor(i) + 3);
      // dimmed text without contrast: with it, base 8's shades would run on into the next colour ramp
      drawText(s, A.small, text, 12, y, p.eliminated ? 8 : 0, { contrast: !p.eliminated });
      void alive;
    });
    // supply drops off screen: a pointer at the edge of the view, towards the beacon
    const mapH = this.vh - ICONS_H;
    // incoming drops (yellow, with the rounds left) and landed crates (brown, no number)
    const pointers = [
      ...this.st.supplyMarkers.map((m) => ({ pos: m.pos, label: m.label, color: 16 + 1 })),
      ...[...this.st.crates].map((t) => ({ pos: b.posOf(t), label: "", color: 16 * 10 + 4 })),
    ];
    for (const m of pointers) {
      const sp = mapToScreen(m.pos);
      const px = sp.x + this.st.camera.x + 16, py = sp.y + this.st.camera.y + 8;
      if (px >= 0 && px < this.vw && py >= 0 && py < mapH) continue;
      // keep clear of the round/squad/supply text in the top-left corner
      const top = 36 + b.players.length * 9, bottom = mapH - 12;
      const cx = this.vw / 2, cy = (top + bottom) / 2;
      const dx = px - cx, dy = py - cy;
      const k = Math.min((this.vw / 2 - 10) / Math.max(1, Math.abs(dx)), ((bottom - top) / 2) / Math.max(1, Math.abs(dy)));
      const ex = Math.round(cx + dx * k), ey = Math.round(cy + dy * k);
      // a small, steady arrowhead at the edge, with the rounds left beside it
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const color = m.color;
      for (let i = 0; i <= 5; i++)
        for (let j = -i; j <= i; j++) {
          const qx = ex + ux * (5 - i) - uy * j * 0.6, qy = ey + uy * (5 - i) + ux * j * 0.6;
          s.setPixel(Math.round(qx), Math.round(qy), color);
        }
      if (m.label) drawTinyText(s, m.label, Math.round(ex - ux * 8) - 1, Math.round(ey - uy * 8) - 2, color);
    }
    // supply drop info
    const pending = b.supply.filter((d) => !d.dropped);
    if (pending.length) {
      const d = pending[0];
      drawText(s, A.small, `SUPPLY DROP IN ${Math.max(0, d.dropRound - b.round)} ROUND(S) AT ${d.pos.x},${d.pos.y}`, 4, 16 + b.players.length * 9, 16 * 3 - 1, { contrast: true });
    } else if (this.st.crates.size) {
      const n = this.st.crates.size;
      drawText(s, A.small, `SUPPLY CRATE${n > 1 ? "S" : ""} ON THE MAP: ${n} (M: MINIMAP)`, 4, 16 + b.players.length * 9, 8, { contrast: true });
    }
    // messages
    const now = performance.now();
    this.messages = this.messages.filter((m) => now - m.time < 4000).slice(-5);
    this.messages.forEach((m, i) => {
      drawText(s, A.small, m.text.toUpperCase(), 0, 4 + i * 9, 16 * 4 - 1, { contrast: true, align: "center", width: this.vw });
    });
    // warnings show inside the panel, like the original
    if (this.hud.warning && now - this.hud.warningTime < 2500) {
      const fade = Math.min(12, Math.floor((now - this.hud.warningTime) / 200));
      s.fillRect(ix + 48, iy + 32, 224, 24, 16 * 2 + fade);
      drawText(s, A.small, this.hud.warning, ix + 48, iy + 40, 16 - 1, { align: "center", width: 224, contrast: true });
    }
    if (this.hud.tooltip) drawText(s, A.small, this.hud.tooltip, ix + 2, iy - 10, 0, { contrast: true });
    // co-op: whose the selected unit is
    const selU = this.selectedUnit();
    if (selU && isShared(b.players[this.you])) {
      const c = controllerOf(b, selU);
      const label = !c ? "SHARED UNIT" : c === this.me.id ? "YOUR UNIT" : `${(membersOf(b.players[this.you]).find((m) => m.userId === c)?.name ?? "").toUpperCase()}'S UNIT`;
      drawText(s, A.small, label, ix + 318 - textWidth(A.small, label), iy - 10, c === this.me.id ? 16 * 4 - 1 : 16 * 3 - 1, { contrast: true });
    }
    // psi / launch buttons at the top right
    const sel = this.selectedUnit();
    const spicons = A.dat("UFOGRAPH/SPICONS.DAT", 32, 24);
    if (sel && this.canPsi(sel)) s.blit(spicons[1], this.vw - 32, 25);
    if (this.action?.kind === "launch") {
      if (this.action.waypoints.length) s.blit(spicons[0], this.vw - 32, 0);
      const w = sel ? this.b!.itemInSlot(sel, this.action.hand as Hand) : undefined;
      const max = w ? itemRule(w.type).waypoints : 1;
      const n = this.action.waypoints.length;
      const hint = n >= max ? `${n}/${max} WAYPOINTS - CLICK LAUNCH (TOP RIGHT)` : n ? `WAYPOINT ${n}/${max} SET - CLICK MORE, OR LAUNCH (TOP RIGHT)` : `CLICK UP TO ${max} WAYPOINTS FOR THE BLASTER BOMB (LAST ONE = TARGET)`;
      drawText(s, A.small, hint, 0, iy - 22, 16 * 3, { contrast: true, align: "center", width: this.vw });
    }
    if (this.inputLocked()) drawText(s, A.small, "...", this.vw - 16, iy - 10, 0);
    if (!this.online.has(this.me.id) && this.ws?.readyState !== 1) drawText(s, A.small, "OFFLINE", this.vw - 40, 4, 32 - 1);
    // battle over (or your squad out of it): a way back out from the map view, and to start over
    if (this.outOfIt()) {
      for (const [r, label] of [[this.exitButtonRect(), "BACK TO MATCHES"], [this.retryButtonRect(), "RETRY"]] as const) {
        if (!r) continue;
        const hover = inRect(this.mouse.x, this.mouse.y, r.x, r.y, r.w, r.h);
        drawFrame(s, r.x, r.y, r.w, r.h, hover ? 16 * 4 : 16 * 2, 2, 15);
        drawText(s, A.small, label, r.x, r.y + 5, hover ? 16 * 4 - 1 : 0, { align: "center", width: r.w, contrast: true });
      }
    }
  }

  /** Co-op status for the centre banner during your squad's turn ("" when there's nothing to say). */
  private coopBanner(): string {
    const b = this.b!, me = this.member();
    if (!me || !this.myTurn()) return "";
    if (isAfk(me)) return "AFK - THE AI IS PLAYING YOUR UNITS";
    if (!me.locked || !isShared(b.players[this.you])) return "";
    if (b.settings.coop?.turnEnd === "timer" && b.settings.turnTimer > 0) return "LOCKED IN - THE TURN ENDS ON THE TIMER";
    const n = waitingFor(b, this.you).length;
    return n ? `LOCKED IN - WAITING FOR ${n} TEAMMATE${n > 1 ? "S" : ""}` : "LOCKED IN - WAITING FOR THE AI";
  }

  /** Co-op: the people in your squad at the top right, with who has locked in, is AFK or offline. */
  private drawSquadMembers() {
    const s = this.surf, A = this.assets, b = this.b!;
    const members = membersOf(b.players[this.you]);
    if (members.length < 2) return;
    const ourTurn = this.myTurn();
    members.forEach((m, i) => {
      const units = b.units.filter((u) => u.owner === this.you && !isOut(u) && controllerOf(b, u) === m.userId).length;
      const status = m.observer ? "GM" : isAfk(m) ? "AI" : !this.online.has(m.userId) ? "OFFLINE" : ourTurn ? (m.locked ? "DONE" : "PLAYING") : "";
      const text = `${m.name.toUpperCase()}${m.userId === this.me.id ? " *" : ""} (${units})${status ? " " + status : ""}`;
      const offline = !m.observer && !isAfk(m) && !this.online.has(m.userId);
      const color = isAfk(m) ? 16 * 3 - 1 : m.locked && ourTurn ? 16 * 4 - 1 : offline ? 8 : 0;
      drawText(s, A.small, text, this.vw - 4 - textWidth(A.small, text), 52 + i * 9, color, { contrast: !offline });
    });
  }

  private canPsi(u: Unit): boolean {
    if (!this.b?.settings.psionics) return false;
    return u.psiWeapon;
  }

  // ------------------------------------------------------------------------------------------
  // dialogs
  // ------------------------------------------------------------------------------------------

  private dialogRects: { x: number; y: number; w: number; h: number; run: () => void }[] = [];

  private drawDialog() {
    const s = this.surf, A = this.assets, d = this.dialog!;
    this.dialogRects = [];
    const cx = Math.floor((this.vw - 320) / 2), cy = Math.floor((this.vh - 200) / 2);
    const button = (x: number, y: number, w: number, h: number, label: string, run: () => void, color = 16 * 0 + 3) => {
      drawFrame(s, x, y, w, h, color, 2, 15);
      drawText(s, A.small, label.toUpperCase(), x, y + Math.floor((h - 9) / 2) + 1, -1, { align: "center", width: w, contrast: true });
      this.dialogRects.push({ x, y, w, h, run });
    };
    switch (d.kind) {
      case "menu": {
        const ix = Math.floor((this.vw - ICONS_W) / 2), iy = this.vh - ICONS_H;
        d.items.forEach((it, i) => {
          const x = ix + 24, y = iy - 40 * (i + 1) + 4;
          const hover = inRect(this.mouse.x, this.mouse.y, x, y, 272, 40);
          drawFrame(s, x, y, 272, 40, 3 + (hover ? 3 : 0), 8, 14);
          drawText(s, A.big, it.label, x + 10, y + 13, -1, { contrast: true });
          if (it.acc !== undefined) drawText(s, A.big, `ACC>${it.acc}%`, x + 124, y + 13, -1, { contrast: true });
          drawText(s, A.big, `TU>${it.tu}`, x + 262 - textWidth(A.big, `TU>${it.tu}`), y + 13, -1, { contrast: true });
          this.dialogRects.push({ x, y, w: 272, h: 40, run: () => { this.dialog = null; it.run(); } });
        });
        break;
      }
      case "prime": {
        drawFrame(s, cx + 32, cy + 20, 256, 160, 16 * 1 + 2, 8, 15);
        drawText(s, A.big, "SET TIMER", cx + 32, cy + 32, 16 - 1, { align: "center", width: 256, contrast: true });
        for (let i = 0; i < 24; i++) {
          const x = cx + 52 + (i % 6) * 36, y = cy + 56 + Math.floor(i / 6) * 28;
          button(x, y, 32, 22, String(i), () => this.doPrime(d.hand, i));
        }
        break;
      }
      case "medikit": {
        s.blit(A.spk("UFOGRAPH/MEDIBORD.PCK"), cx, cy);
        const target = this.b!.unit(d.target);
        const parts = ["HEAD", "TORSO", "RIGHT ARM", "LEFT ARM", "RIGHT LEG", "LEFT LEG"];
        drawText(s, A.big, (target?.name ?? "").toUpperCase(), cx + 10, cy + 6, 16 * 4 - 1, { contrast: true });
        parts.forEach((p, i) => {
          const w = target?.wounds[i] ?? 0;
          const x = cx + 16, y = cy + 40 + i * 16;
          button(x, y, 120, 14, `${p}  ${w}`, () => ((this.dialog as any).part = i), i === d.part ? 16 * 2 + 3 : 3);
        });
        const kit = this.b!.itemInSlot(this.selectedUnit()!, d.hand);
        const uses = kit?.uses ?? (kit ? [itemRule(kit.type).painKiller, itemRule(kit.type).heal, itemRule(kit.type).stimulant] : [0, 0, 0]);
        button(cx + 180, cy + 50, 110, 20, `HEAL (${uses[1]})`, () => this.doMedikit(d, "heal"));
        button(cx + 180, cy + 76, 110, 20, `STIMULANT (${uses[2]})`, () => this.doMedikit(d, "stim"));
        button(cx + 180, cy + 102, 110, 20, `PAINKILLER (${uses[0]})`, () => this.doMedikit(d, "pain"));
        button(cx + 220, cy + 160, 60, 20, "OK", () => (this.dialog = null));
        if (target) drawText(s, A.small, `HEALTH ${target.health}/${target.stats.health}  STUN ${target.stun}`, cx + 16, cy + 146, 16 * 4 - 1, { contrast: true });
        break;
      }
      case "scanner": {
        s.blit(A.spk("UFOGRAPH/SCANBORD.PCK"), cx, cy);
        const blob = A.dat("UFOGRAPH/DETBLOB.DAT", 16, 16);
        for (const bl of d.blips) {
          // the scanner is oriented with the unit's facing at the top
          const x = cx + 152 + bl.x * 10, y = cy + 92 + bl.y * 10;
          const f = blob[Math.min(blob.length - 1, Math.max(0, bl.size - 1 + 6 * ((this.st.animFrame >> 1) % 2)))];
          if (f) s.blit(f, x, y);
        }
        drawText(s, A.small, "MOTION SCANNER - CLICK TO CLOSE", cx, cy + 186, 16 * 4 - 1, { align: "center", width: 320, contrast: true });
        this.dialogRects.push({ x: 0, y: 0, w: this.vw, h: this.vh, run: () => (this.dialog = null) });
        break;
      }
      case "unitinfo": {
        s.blit(A.spk("UFOGRAPH/UNIBORD.PCK"), cx, cy);
        const u = d.unit;
        const st = d.stats ?? (u && { stats: u.stats, tu: u.tu, energy: u.energy, health: u.health, stun: u.stun, armor: u.armorNow, wounds: u.wounds, name: u.name, rank: u.rank });
        if (st) {
          drawText(s, A.big, String(st.name).toUpperCase(), cx + 4, cy + 4, 16 * 4 - 1, { contrast: true });
          drawText(s, A.small, String(st.rank ?? "").toUpperCase(), cx + 4, cy + 22, 16 * 8 - 1, { contrast: true });
          const rows: [string, number, number, number][] = [
            ["TIME UNITS", st.tu, st.stats.tu, 64], ["ENERGY", st.energy, st.stats.stamina, 144], ["HEALTH", st.health, st.stats.health, 32],
            ["FATAL WOUNDS", st.wounds.reduce((a: number, c: number) => a + c, 0), 10, 32], ["REACTIONS", st.stats.reactions, st.stats.reactions, 144],
            ["FIRING ACCURACY", st.stats.firing, st.stats.firing, 128], ["THROWING ACCURACY", st.stats.throwing, st.stats.throwing, 96],
            ["MELEE ACCURACY", st.stats.melee, st.stats.melee, 224], ["STRENGTH", st.stats.strength, st.stats.strength, 48],
            ["PSIONIC STRENGTH", st.stats.psiStrength, st.stats.psiStrength, 192], ["PSIONIC SKILL", st.stats.psiSkill, st.stats.psiSkill, 192],
            ["FRONT ARMOR", st.armor[0], st.armor[0], 80], ["LEFT ARMOR", st.armor[1], st.armor[1], 80], ["RIGHT ARMOR", st.armor[2], st.armor[2], 80],
            ["REAR ARMOR", st.armor[3], st.armor[3], 80], ["UNDER ARMOR", st.armor[4], st.armor[4], 80],
          ];
          rows.forEach(([label, v, max, color], i) => {
            const y = cy + 38 + i * 9;
            drawText(s, A.small, label, cx + 6, y, 16 * 3 - 1, { contrast: true });
            drawText(s, A.small, String(v), cx + 150, y, 16 * 9 - 1, { contrast: true });
            s.fillRect(cx + 170, y + 1, Math.min(140, max), 5, color + 12);
            s.fillRect(cx + 170, y + 1, Math.min(140, Math.max(0, v)), 5, color + 4);
          });
        }
        this.dialogRects.push({ x: 0, y: 0, w: this.vw, h: this.vh, run: () => (this.dialog = null) });
        break;
      }
      case "minimap":
        this.drawMinimap();
        break;
      case "options": {
        drawFrame(s, cx + 16, cy + 2, 288, 196, 16 * 0 + 3, 8, 14);
        drawText(s, A.big, "OPTIONS", cx, cy + 12, -1, { align: "center", width: 320 });
        const step = (v: number) => (v >= 1 ? 0.2 : Math.round((v + 0.2) * 10) / 10);
        button(cx + 40, cy + 32, 116, 16, `SOUND FX: ${audioSettings.muted ? "OFF" : "ON"}`, () => { audioSettings.muted = !audioSettings.muted; saveAudioSettings(); });
        button(cx + 164, cy + 32, 116, 16, `FX VOLUME: ${Math.round(audioSettings.volume * 100)}%`, () => { audioSettings.volume = step(audioSettings.volume); saveAudioSettings(); });
        button(cx + 40, cy + 50, 116, 16, `MUSIC: ${audioSettings.music ? "ON" : "OFF"}`, () => { audioSettings.music = !audioSettings.music; saveAudioSettings(); applyMusicSettings(); });
        button(cx + 164, cy + 50, 116, 16, `MUSIC VOL: ${Math.round(audioSettings.musicVolume * 100)}%`, () => { audioSettings.musicVolume = step(audioSettings.musicVolume); saveAudioSettings(); applyMusicSettings(); });
        const me = this.member();
        const afkable = me && !me.observer;
        button(cx + 40, cy + 68, afkable ? 116 : 240, 16, `PATH PREVIEW: ${this.pathPreview ? "ON" : "OFF"}`, () => { this.pathPreview = !this.pathPreview; try { localStorage.setItem("xcom.pathPreview", this.pathPreview ? "1" : "0"); } catch { /* */ } });
        // the AI plays your units while you're away (co-op squads, or a solo squad you want auto-played)
        if (afkable) button(cx + 164, cy + 68, 116, 16, `AFK (AI PLAYS): ${isAfk(me) ? "ON" : "OFF"}`, () => this.toggleAfk(), isAfk(me) ? 16 * 2 + 3 : 3);
        const help = [
          "LEFT CLICK: SELECT / MOVE (CLICK TWICE) / FIRE",
          "RIGHT CLICK: TURN OR OPEN DOOR / CANCEL",
          "WHEEL, PGUP/PGDN: VIEW LEVEL",
          "ARROWS, WASD, SCREEN EDGES, MIDDLE DRAG: SCROLL",
          "TAB NEXT UNIT  K KNEEL  I INVENTORY  C CENTER",
          `M MINIMAP  1/2 USE LEFT/RIGHT HAND${isShared(this.b?.players[this.you]) ? "  G GIVE UNIT" : ""}`,
          "ENTER: CHAT  HOLD SHIFT: FAST ANIMATIONS",
        ];
        help.forEach((h, i) => drawText(s, A.small, h, cx, cy + 88 + i * 9, 16 * 4 - 1, { align: "center", width: 320 }));
        // against the AI: start over (giving this battle up), or dare others to do better from the same start
        const restart = this.replayAllowed(true), share = this.replayAllowed() || !!this.challengeId;
        if (restart) button(cx + 40, cy + 152, share ? 116 : 240, 14, this.outOfIt() ? "RETRY" : "RESTART BATTLE", () => (this.outOfIt() ? this.retry() : (this.dialog = { kind: "restart" })));
        if (share) button(restart ? cx + 164 : cx + 40, cy + 152, restart ? 116 : 240, 14, "SHARE AS CHALLENGE", () => this.share());
        button(cx + 40, cy + 170, 110, 18, "LEAVE BATTLE", () => this.onExit());
        button(cx + 170, cy + 170, 110, 18, "OK", () => (this.dialog = null));
        break;
      }
      case "abort": {
        drawFrame(s, cx + 40, cy + 60, 240, 80, 16 * 2 + 3, 8, 14);
        drawText(s, A.big, "SURRENDER?", cx + 40, cy + 72, -1, { align: "center", width: 240, contrast: true });
        drawText(s, A.small, "YOUR SQUAD LEAVES THE BATTLE FOR GOOD", cx + 40, cy + 92, -1, { align: "center", width: 240, contrast: true });
        button(cx + 60, cy + 110, 90, 20, "SURRENDER", () => { this.dialog = null; this.send({ c: "surrender" }); }, 16 * 2 + 3);
        button(cx + 170, cy + 110, 90, 20, "CANCEL", () => (this.dialog = null));
        break;
      }
      case "restart": {
        drawFrame(s, cx + 30, cy + 56, 260, 88, 16 * 2 + 3, 8, 14);
        drawText(s, A.big, "START OVER?", cx + 30, cy + 68, -1, { align: "center", width: 260, contrast: true });
        drawText(s, A.small, "YOUR SQUAD SURRENDERS THIS BATTLE AND", cx + 30, cy + 88, -1, { align: "center", width: 260, contrast: true });
        drawText(s, A.small, "A NEW ONE BEGINS FROM THE SAME START", cx + 30, cy + 97, -1, { align: "center", width: 260, contrast: true });
        button(cx + 50, cy + 116, 100, 20, "RESTART", () => this.retry(), 16 * 2 + 3);
        button(cx + 170, cy + 116, 100, 20, "CANCEL", () => (this.dialog = null));
        break;
      }
      case "nextturn": {
        s.clear(0);
        s.blit(A.scr("UFOGRAPH/TAC00.SCR"), cx, cy);
        drawText(s, A.big, d.title, cx, cy + 68, 0, { align: "center", width: 320, contrast: true });
        drawText(s, A.big, d.sub, cx, cy + 92, 16 * 4 - 1, { align: "center", width: 320, contrast: true });
        drawText(s, A.big, "PRESS BUTTON TO CONTINUE", cx, cy + 132, 0, { align: "center", width: 320, contrast: true });
        this.dialogRects.push({ x: 0, y: 0, w: this.vw, h: this.vh, run: () => (this.dialog = null) });
        break;
      }
      case "gameover": {
        const b = this.b!;
        drawFrame(s, cx + 20, cy + 30, 280, 140, 16 * 4 + 3, 8, 14);
        const winner = b.winner >= 0 ? b.players[b.winner].name : "Nobody";
        drawText(s, A.big, b.winner === this.you ? "VICTORY!" : "BATTLE OVER", cx + 20, cy + 44, -1, { align: "center", width: 280, contrast: true });
        drawText(s, A.small, `${winner.toUpperCase()} HOLDS THE FIELD`, cx + 20, cy + 66, -1, { align: "center", width: 280, contrast: true });
        b.players.forEach((p, i) => {
          const fallen = b.units.filter((u) => u.originalOwner === i && isOut(u)).length;
          drawText(s, A.small, `${p.name.toUpperCase()}${p.surrendered ? " (SURRENDERED)" : ""}`, cx + 40, cy + 84 + i * 9, teamColor(i) - 1, { contrast: true });
          void fallen;
        });
        if (this.replayAllowed() || this.challengeId) button(cx + 60, cy + 124, 200, 16, this.challengeId ? "SHARE THIS CHALLENGE" : "SHARE AS CHALLENGE", () => this.share());
        if (this.replayAllowed()) {
          button(cx + 32, cy + 146, 76, 18, "VIEW MAP", () => (this.dialog = null));
          button(cx + 122, cy + 146, 76, 18, "RETRY", () => this.retry(), 16 * 2 + 3);
          button(cx + 212, cy + 146, 76, 18, "EXIT", () => this.onExit());
        } else {
          button(cx + 60, cy + 146, 90, 18, "VIEW MAP", () => (this.dialog = null));
          button(cx + 170, cy + 146, 90, 18, "EXIT", () => this.onExit());
        }
        break;
      }
    }
  }

  private drawMinimap() {
    const s = this.surf, b = this.b!, A = this.assets;
    const scang = A.dat("GEODATA/SCANG.DAT", 4, 4);
    const z = this.st.camera.z;
    const cell = 4;
    const w = b.sx * cell, h = b.sy * cell;
    const ox = Math.floor((this.vw - w) / 2), oy = Math.floor((this.vh - ICONS_H - h) / 2);
    s.fillRect(ox - 4, oy - 14, w + 8, h + 28, 15);
    drawText(s, A.small, `MINIMAP - LEVEL ${z + 1} (CLICK TO CENTER, RIGHT CLICK TO CLOSE)`, ox, oy - 11, 16 * 4 - 1, { contrast: true });
    const disc = b.discovered[this.you];
    // like OpenXcom's MiniMapView: every level up to the viewed one, bottom first, each part's
    // SCANG.DAT frame (minimap index + 35), darkened with the tile's shade
    for (let lvl = 0; lvl <= z; lvl++)
      for (let y = 0; y < b.sy; y++)
        for (let x = 0; x < b.sx; x++) {
          const t = b.idx(x, y, lvl);
          if (!(disc[t] & 4)) continue;
          const shade = Math.min(7, b.shade(t, this.you));
          for (const p of [0, 1, 2, 3] as const) {
            const md = b.part(t, p);
            const frame = md && md.scanG ? scang[md.scanG + 35] : undefined;
            if (frame) s.blitShade(frame, ox + x * cell, oy + y * cell, shade);
          }
        }
    for (const u of b.units) {
      if (isOut(u) || u.pos.z > z) continue;
      const c = teamColor(u.owner) + 2;
      s.fillRect(ox + u.pos.x * cell, oy + u.pos.y * cell, cell * u.size, cell * u.size, c);
      if (u.id === this.st.selected) s.rect(ox + u.pos.x * cell - 1, oy + u.pos.y * cell - 1, cell * u.size + 2, cell * u.size + 2, 1 + (this.st.animFrame % 2) * 3);
    }
    // supply drops: a blinking crosshair beacon, and a legend line
    const blink = 16 + 1;
    for (const m of this.st.supplyMarkers) {
      const cx = ox + m.pos.x * cell + 2, cy = oy + m.pos.y * cell + 2;
      s.rect(cx - 5, cy - 5, 11, 11, blink);
      s.fillRect(cx - 8, cy, 5, 1, blink);
      s.fillRect(cx + 4, cy, 5, 1, blink);
      s.fillRect(cx, cy - 8, 1, 5, blink);
      s.fillRect(cx, cy + 4, 1, 5, blink);
    }
    s.rect(ox - 1, oy - 1, w + 2, h + 2, 16 * 4 + 8);
    // landed crates: a plain brown square (no blinking)
    for (const t of this.st.crates) {
      const p = b.posOf(t);
      s.fillRect(ox + p.x * cell, oy + p.y * cell, cell, cell, 16 * 10 + 4);
      s.rect(ox + p.x * cell - 1, oy + p.y * cell - 1, cell + 2, cell + 2, 16 * 10 + 9);
    }
    const legend = this.st.supplyMarkers.map((m) => `+ SUPPLY DROP IN ${m.label} ROUND(S)`);
    if (!legend.length && this.st.crates.size) legend.push("BROWN SQUARE: SUPPLY CRATE");
    if (legend.length) drawText(s, A.small, legend[0], ox, oy + h + 3, 16 * 9, { contrast: true });
    this.dialogRects.push({ x: ox, y: oy, w, h, run: () => {
      const mx = Math.floor((this.mouse.x - ox) / cell), my = Math.floor((this.mouse.y - oy) / cell);
      this.centerOn({ x: mx, y: my, z });
      this.dialog = null;
    } });
  }

  private showNextTurn() {
    const b = this.b!;
    this.dialog = { kind: "nextturn", title: `TURN ${b.round}`, sub: `SIDE: ${b.players[b.current].name.toUpperCase()}` };
    const first = this.myUnits().find((u) => u.tu > 0);
    if (first) {
      this.select(first);
      this.centerOn(first.pos);
    }
  }

  // ------------------------------------------------------------------------------------------
  // actions
  // ------------------------------------------------------------------------------------------

  cancelAction() {
    this.action = null;
    this.pathTarget = null;
    this.st.path = null;
  }

  private openActionMenu(hand: Hand) {
    const u = this.selectedUnit();
    if (!u || !this.myTurn()) return;
    const b = this.b!;
    const it = b.itemInSlot(u, hand);
    if (!it) return;
    const r = itemRule(it.type);
    const items: MenuItem[] = [];
    const add = (label: string, kind: ActionKind | null, tu: number, acc: number | undefined, run?: () => void) =>
      items.push({ label, tu, acc, run: run ?? (() => this.beginAction(kind!, hand)) });
    if (!r.fixedWeapon) add("THROW", "throw", actionTUs(u, "throw", r), Math.floor((u.stats.throwing * (Math.floor((25 * u.health) / u.stats.health) + 75)) / 100));
    if ((r.battleType === BattleType.GRENADE || r.battleType === BattleType.PROXIMITYGRENADE) && it.fuse < 0)
      add("PRIME GRENADE", null, actionTUs(u, "prime", r), undefined, () => {
        if (r.battleType === BattleType.PROXIMITYGRENADE) this.doPrime(hand, 0);
        else this.dialog = { kind: "prime", hand, proximity: false };
      });
    if (r.battleType === BattleType.FIREARM) {
      if (r.waypoints) add("LAUNCH", "launch", actionTUs(u, "launch", r), firingAccuracy(b, u, "aimed", it));
      else {
        if (r.accuracyAuto) add("AUTO SHOT", "auto", actionTUs(u, "auto", r), firingAccuracy(b, u, "auto", it));
        if (r.accuracySnap) add("SNAP SHOT", "snap", actionTUs(u, "snap", r), firingAccuracy(b, u, "snap", it));
        if (r.accuracyAimed) add("AIMED SHOT", "aimed", actionTUs(u, "aimed", r), firingAccuracy(b, u, "aimed", it));
      }
    }
    if (r.tuMelee) add(r.damageType === 6 ? "STUN" : "HIT", "melee", actionTUs(u, "hit", r), firingAccuracy(b, u, "hit", it));
    else if (r.battleType === BattleType.MEDIKIT) add("USE MEDI-KIT", null, actionTUs(u, "use", r), undefined, () => this.openMedikit(hand));
    else if (r.battleType === BattleType.SCANNER) add("USE SCANNER", null, actionTUs(u, "use", r), undefined, async () => {
      const res = await this.send({ c: "scan", unit: u.id, hand });
      if (res.ok && res.private) this.dialog = { kind: "scanner", blips: res.private.blips, dir: u.dir };
    });
    else if (r.battleType === BattleType.PSIAMP && u.stats.psiSkill > 0 && b.settings.psionics) add("MIND CONTROL", "psi", actionTUs(u, "mindcontrol", r), undefined);
    else if (r.battleType === BattleType.MINDPROBE) add("USE MIND PROBE", "probe", actionTUs(u, "use", r), undefined);
    if (!items.length) return;
    this.dialog = { kind: "menu", items };
  }

  private beginAction(kind: ActionKind, hand: Hand | "innate") {
    this.action = { kind, hand, waypoints: [] };
    this.st.path = null;
    this.pathTarget = null;
  }

  private async doPrime(hand: Hand, fuse: number) {
    const u = this.selectedUnit();
    this.dialog = null;
    if (u) await this.send({ c: "prime", unit: u.id, hand, fuse });
  }

  private openMedikit(hand: Hand) {
    const u = this.selectedUnit()!;
    const b = this.b!;
    // patient: the unit in front, an unconscious body there, else yourself
    const front = { x: u.pos.x + [0, 1, 1, 1, 0, -1, -1, -1][u.dir], y: u.pos.y + [-1, -1, 0, 1, 1, 1, 0, -1][u.dir], z: u.pos.z };
    let target: Unit | undefined = b.unitOnTile(b.idxP(front));
    if (!target) {
      for (const id of b.itemsOnTile(b.idxP(front))) {
        const it = b.item(id);
        if (it && it.unitId >= 0) target = b.unit(it.unitId);
      }
    }
    if (!target || target.owner !== this.you) target = u;
    const part = Math.max(0, target.wounds.findIndex((w) => w > 0));
    this.dialog = { kind: "medikit", hand, target: target.id, part };
  }

  private async doMedikit(d: Extract<Dialog, { kind: "medikit" }>, mode: "heal" | "stim" | "pain") {
    const u = this.selectedUnit();
    if (!u) return;
    await this.send({ c: "medikit", unit: u.id, hand: d.hand, target: d.target, part: d.part, mode });
  }

  private refreshPath() {
    const u = this.selectedUnit();
    if (!u || !this.pathTarget || !this.b) {
      this.st.path = null;
      this.st.pathInfo = null;
      return;
    }
    const pf = new Pathfinder(this.b, u);
    const path = pf.calculate(this.pathTarget);
    if (!path) {
      this.st.path = null;
      this.st.pathInfo = null;
      return;
    }
    let tu = u.tu - (u.kneeled ? 8 : 0);
    let p = { ...u.pos };
    const out: { pos: Pos; tu: number; ok: boolean }[] = [];
    const reserve = this.reservedTU(u);
    for (const d of path) {
      const { cost, dest } = pf.tuCost(p, d);
      tu -= cost;
      p = dest;
      out.push({ pos: dest, tu: Math.max(0, tu), ok: tu >= reserve });
    }
    this.st.path = out;
    // exposure at the destination (cached: it's a few hundred line-of-fire traces)
    const dest = out[out.length - 1]?.pos;
    if (dest) {
      const key = `${u.id}:${dest.x},${dest.y},${dest.z}:${u.kneeled}:${this.b.round}:${this.b.units.filter((e) => e.owner !== this.you && !isOut(e) && e.pos.x >= 0).map((e) => e.id + "@" + e.pos.x + "," + e.pos.y).join()}`;
      if (this.exposureKey !== key) {
        this.exposureKey = key;
        this.st.pathInfo = exposureAt(this.b, u, dest, this.you);
      }
    }
  }

  private reservedTU(u: Unit): number {
    const b = this.b!;
    let tu = 0;
    if (this.hud.reserve !== "none") {
      const w = b.itemInSlot(u, u.activeHand) ?? b.itemInSlot(u, "STR_RIGHT_HAND") ?? b.itemInSlot(u, "STR_LEFT_HAND");
      if (w) tu = actionTUs(u, this.hud.reserve, itemRule(w.type));
    }
    if (this.hud.reserveKneel) tu += 4;
    return tu;
  }

  private async mapClick(t: Pos, right: boolean) {
    const b = this.b!;
    const u = this.selectedUnit();
    if (right) {
      if (this.action) return this.cancelAction();
      if (this.st.path) {
        this.st.path = null;
        this.pathTarget = null;
        return;
      }
      if (u && this.myTurn()) await this.send({ c: "turn", unit: u.id, to: t });
      return;
    }
    const clickedUnit = b.unitOnTile(b.idxP(t)) ?? b.unitOnTile(b.idx(t.x, t.y, t.z - 1));
    if (this.action && u) {
      const a = this.action;
      const hand = a.hand;
      if (a.kind === "launch") {
        const w = b.itemInSlot(u, hand as Hand);
        const max = w ? itemRule(w.type).waypoints : 1;
        if (a.waypoints.length < max) a.waypoints.push(t);
        return;
      }
      this.action = null;
      switch (a.kind) {
        case "snap": case "aimed": case "auto":
          await this.send({ c: "shoot", unit: u.id, hand: hand as Hand, mode: a.kind, target: clickedUnit && !isOut(clickedUnit) ? clickedUnit.pos : t });
          break;
        case "throw":
          await this.send({ c: "throw", unit: u.id, hand: hand as Hand, target: t });
          break;
        case "melee":
          await this.send({ c: "melee", unit: u.id, hand: hand as Hand, target: t });
          break;
        case "psi":
          await this.send({ c: "psi", unit: u.id, hand, target: clickedUnit ? clickedUnit.pos : t });
          break;
        case "probe": {
          const res = await this.send({ c: "probe", unit: u.id, hand: hand as Hand, target: clickedUnit ? clickedUnit.pos : t });
          if (res.ok && res.private) this.dialog = { kind: "unitinfo", unit: null, stats: res.private.stats };
          break;
        }
      }
      return;
    }
    if (clickedUnit && clickedUnit.owner === this.you && !isOut(clickedUnit)) {
      this.select(clickedUnit);
      return;
    }
    if (!u || !this.myTurn()) return;
    // a teammate's unit can be selected (to look, or to hand over with G) but not ordered about
    if (!this.mayCommand(u)) return this.warn(mayCommand(b, this.me.id, u)!);
    if (this.pathPreview && (!this.pathTarget || !posEq(this.pathTarget, t))) {
      this.pathTarget = t;
      this.refreshPath();
      if (!this.st.path) this.warn("STR_NO_PATH");
      return;
    }
    this.st.path = null;
    this.pathTarget = null;
    await this.send({ c: "move", unit: u.id, to: t });
  }

  private async hudClick(btn: HudButton, right: boolean) {
    const b = this.b!;
    const u = this.selectedUnit();
    unlockAudio();
    switch (btn) {
      case "mapUp":
        this.st.camera.z = Math.min(b.sz - 1, this.st.camera.z + 1);
        break;
      case "mapDown":
        this.st.camera.z = Math.max(0, this.st.camera.z - 1);
        break;
      case "unitUp":
      case "unitDown":
        if (u && this.myTurn()) {
          if (u.movementType !== 1 && !b.part(b.idxP(u.pos), 0)?.gravLift) return this.warn("STR_ACTION_NOT_POSSIBLE");
          await this.send({ c: "move", unit: u.id, to: { ...u.pos, z: u.pos.z + (btn === "unitUp" ? 1 : -1) } });
        }
        break;
      case "map":
        this.dialog = { kind: "minimap" };
        break;
      case "kneel":
        if (u && this.myTurn()) await this.send({ c: "kneel", unit: u.id });
        break;
      case "inventory":
        if (u) this.openInventory();
        break;
      case "center":
        if (u) this.centerOn(u.pos);
        break;
      case "next":
        this.nextUnit(false);
        break;
      case "nextStop":
        this.nextUnit(true);
        break;
      case "layers":
        this.hud.showLayers = !this.hud.showLayers;
        break;
      case "options":
        this.dialog = { kind: "options" };
        break;
      case "endTurn":
        if (this.myTurn()) {
          this.cancelAction();
          this.st.path = null;
          // in a co-op squad this locks you in (press again to unlock); the turn ends when everyone has
          const shared = isShared(b.players[this.you]) && !!this.member();
          this.endingTurn = !shared;
          const r = await this.send({ c: "endturn" });
          this.endingTurn = false;
          // say so: the turn has passed to someone else (unless the battle just ended)
          if (r.ok && this.b && this.b.phase === Phase.PLAYING && !this.myTurn()) {
            const next = this.b.players[this.b.current];
            this.dialog = { kind: "nextturn", title: "TURN OVER", sub: `WAITING FOR ${(next?.name ?? "").toUpperCase()}` };
          } else if (r.ok && shared && this.myTurn()) {
            this.say(r.private?.locked ? "Locked in (end turn again to unlock)" : "Unlocked: carry on");
          }
        }
        break;
      case "abort":
        this.dialog = { kind: "abort" };
        break;
      case "stats":
        if (u) this.dialog = { kind: "unitinfo", unit: u };
        break;
      case "reserveNone": this.hud.reserve = "none"; break;
      case "reserveSnap": this.hud.reserve = "snap"; break;
      case "reserveAimed": this.hud.reserve = "aimed"; break;
      case "reserveAuto": this.hud.reserve = "auto"; break;
      case "reserveKneel": this.hud.reserveKneel = !this.hud.reserveKneel; break;
      case "zeroTU":
        if (right && u && this.myTurn()) this.warn("STR_ZERO_TU_NOT_SUPPORTED");
        break;
      case "leftHand":
      case "rightHand": {
        if (!u) return;
        const hand: Hand = btn === "leftHand" ? "STR_LEFT_HAND" : "STR_RIGHT_HAND";
        if (!b.itemInSlot(u, hand)) {
          // empty hand: aliens with innate psionics use them from here, like the psi button
          return;
        }
        this.openActionMenu(hand);
        break;
      }
    }
  }

  private nextUnit(done: boolean) {
    const mine = this.myUnits();
    if (!mine.length) return;
    const cur = mine.findIndex((u) => u.id === this.st.selected);
    if (done && cur >= 0) (this as any)._done = new Set([...(((this as any)._done as Set<number>) ?? []), mine[cur].id]);
    const doneSet: Set<number> = (this as any)._done ?? new Set();
    for (let k = 1; k <= mine.length; k++) {
      const u = mine[(cur + k + mine.length) % mine.length];
      if (doneSet.has(u.id) && k < mine.length) continue;
      this.select(u);
      this.centerOn(u.pos);
      return;
    }
  }

  private openInventory() {
    const b = this.b!;
    const screen = this;
    const unitList = () => this.myUnits().filter((u) => u.hasInventory);
    const cur = () => this.selectedUnit();
    const toInv = (it: Item): InvItem => {
      const ammo = it.ammo >= 0 && it.ammo !== it.id ? b.item(it.ammo) : undefined;
      return { id: it.id, type: it.type, slot: (it.tile >= 0 ? "STR_GROUND" : it.slot) as SlotId, x: it.sx, y: it.sy, ammoType: ammo?.type, ammoQty: ammo ? ammo.ammoQty : it.ammoQty, selfPowered: it.ammo === it.id, fuse: it.fuse, isBody: it.unitId >= 0 };
    };
    const adapter: InvAdapter = {
      unit() {
        const u = cur()!;
        return {
          name: u.name, rank: u.rank, armor: u.armor, gender: u.gender, look: u.look, standHeight: u.baseHeights.stand,
          tu: u.tu, weight: carriedWeight(screen.b!, u), strength: u.stats.strength, firing: u.stats.firing, reactions: u.stats.reactions,
          psiSkill: u.stats.psiSkill, psiStrength: u.stats.psiStrength, hasInventory: u.hasInventory,
        };
      },
      items() {
        const bb = screen.b!;
        const u = cur();
        if (!u) return [];
        const here = bb.idxP(u.pos);
        return bb.items.filter((it) => it.owner === u.id || it.tile === here).filter((it) => !itemRule(it.type).fixedWeapon).map(toInv);
      },
      async move(item, slot, x, y) {
        if (!screen.myTurn()) return "STR_NOT_YOUR_TURN";
        const r = await screen.send({ c: "inv", unit: cur()!.id, item: item.id, slot, x, y });
        if (r.ok) playSound(SND.ITEM_DROP);
        return r.ok ? null : r.error ?? null;
      },
      async load(weapon, ammo) {
        if (!screen.myTurn()) return "STR_NOT_YOUR_TURN";
        const r = await screen.send({ c: "load", unit: cur()!.id, weapon: weapon.id, ammo: ammo.id });
        if (r.ok) playSound(SND.RELOAD);
        return r.ok ? null : r.error ?? null;
      },
      async unload(weapon) {
        if (!screen.myTurn()) return "STR_NOT_YOUR_TURN";
        const r = await screen.send({ c: "unload", unit: cur()!.id, weapon: weapon.id });
        return r.ok ? null : r.error ?? null;
      },
      prev() {
        const l = unitList();
        const i = l.findIndex((u) => u.id === screen.st.selected);
        if (l.length) screen.st.selected = l[(i - 1 + l.length) % l.length].id;
      },
      next() {
        const l = unitList();
        const i = l.findIndex((u) => u.id === screen.st.selected);
        if (l.length) screen.st.selected = l[(i + 1) % l.length].id;
      },
      close() {
        screen.inventory = null;
        const u = cur();
        if (u) screen.centerOn(u.pos);
      },
    };
    this.inventory = new InventoryScreen(this.assets, adapter);
  }

  // ------------------------------------------------------------------------------------------
  // input
  // ------------------------------------------------------------------------------------------

  private virt(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: Math.floor(((e.clientX - r.left) / r.width) * this.vw), y: Math.floor(((e.clientY - r.top) / r.height) * this.vh) };
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("mousemove", (e) => {
      const p = this.virt(e);
      this.mouse = { ...p, inside: true };
      if (this.drag) {
        this.st.camera.x = this.drag.cx + (p.x - this.drag.x);
        this.st.camera.y = this.drag.cy + (p.y - this.drag.y);
      }
      this.updateHover();
    });
    c.addEventListener("mouseleave", () => (this.mouse.inside = false));
    c.addEventListener("mousedown", (e) => {
      unlockAudio();
      const p = this.virt(e);
      if (e.button === 1) {
        this.drag = { x: p.x, y: p.y, cx: this.st.camera.x, cy: this.st.camera.y };
        e.preventDefault();
        return;
      }
      this.onPress(p.x, p.y, e.button === 2);
    });
    window.addEventListener("mouseup", this.onMouseUp);
    c.addEventListener("wheel", (e) => {
      if (!this.b || this.inventory) return;
      e.preventDefault();
      if (e.deltaY < 0) this.st.camera.z = Math.min(this.b.sz - 1, this.st.camera.z + 1);
      else this.st.camera.z = Math.max(0, this.st.camera.z - 1);
    }, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 1) this.drag = null;
  };
  private onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT" || this.destroyed) return;
    this.keys.add(keyName(e));
    this.onKey(e);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(keyName(e));
  };
  private onBlur = () => this.keys.clear();

  private chatInput: HTMLInputElement | null = null;

  private openChat() {
    if (this.chatInput) return;
    const inp = document.createElement("input");
    inp.className = "chat-input";
    inp.maxLength = 200;
    inp.placeholder = "Say something (Enter to send, Esc to cancel)";
    this.root.appendChild(inp);
    this.chatInput = inp;
    inp.focus();
    inp.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        const text = inp.value.trim();
        if (text) this.ws?.send(JSON.stringify({ t: "chat", text }));
      }
      if (e.key === "Enter" || e.key === "Escape") {
        inp.remove();
        this.chatInput = null;
        this.canvas.focus();
      }
    });
  }

  private onKey(e: KeyboardEvent) {
    if (!this.b) return;
    if (e.key === "Enter" && !this.dialog && !this.inventory) {
      e.preventDefault();
      this.openChat();
      return;
    }
    if (this.inventory) {
      if (e.key === "Escape" || e.key === "i") this.inventory.adapter.close();
      return;
    }
    if (this.dialog) {
      if (e.key === "Escape" || (this.dialog.kind === "nextturn" && (e.key === "Enter" || e.key === " "))) this.dialog = null;
      return;
    }
    const viewOnly = ["Escape", "Tab", "c", "m", "PageUp", "PageDown"].includes(e.key);
    if (!viewOnly && (this.inputLocked() || e.repeat)) return;
    switch (e.key) {
      case "Escape": this.cancelAction(); break;
      case "Tab": e.preventDefault(); this.nextUnit(false); break;
      case "k": this.hudClick("kneel", false); break;
      case "i": this.hudClick("inventory", false); break;
      case "c": this.hudClick("center", false); break;
      case "m": this.hudClick("map", false); break;
      case "PageUp": this.hudClick("mapUp", false); break;
      case "PageDown": this.hudClick("mapDown", false); break;
      case "1": this.hudClick("leftHand", false); break;
      case "2": this.hudClick("rightHand", false); break;
      case "g": case "G": this.giveUnit(); break;
    }
  }

  /** Co-op: hands the selected unit to the next person in the squad (yours, or any if you lead it). */
  private async giveUnit() {
    const b = this.b, u = this.selectedUnit();
    const members = b ? membersOf(b.players[this.you]) : [];
    if (!b || !u || members.length < 2) return;
    const cur = controllerOf(b, u);
    const next = members[(members.findIndex((m) => m.userId === cur) + 1) % members.length];
    const r = await this.sendMsg({ t: "assign", unit: u.id, to: next.userId });
    if (r.ok) this.say(`${u.name} now answers to ${next.userId === this.me.id ? "you" : next.name}`);
  }

  /** Toggles AFK: the AI plays your units until you come back. */
  private async toggleAfk() {
    const me = this.member();
    if (!me) return;
    // also how you take your units back from an AI the host called in for this turn
    const on = !isAfk(me);
    const r = await this.sendMsg({ t: "afk", on });
    if (r.ok) this.say(on ? "AFK: the AI plays your units until you come back" : "Welcome back: your units are yours again");
  }

  /** A line in the message list at the top of the screen. */
  private say(text: string) {
    this.messages.push({ text, time: performance.now() });
  }

  private scrollStep() {
    if (!this.b || this.inventory || this.dialog?.kind === "minimap") return;
    const speed = 8;
    let dx = 0, dy = 0;
    if (this.keys.has("ArrowLeft") || this.keys.has("KeyA")) dx += speed;
    if (this.keys.has("ArrowRight") || this.keys.has("KeyD")) dx -= speed;
    if (this.keys.has("ArrowUp") || this.keys.has("KeyW")) dy += speed;
    if (this.keys.has("ArrowDown") || this.keys.has("KeyS")) dy -= speed;
    if (this.mouse.inside && !this.drag && document.hasFocus()) {
      // edge scrolling: starts EDGE_ZONE pixels in, faster the closer to the edge (full speed at the edge)
      const m = this.mouse;
      const pull = (d: number) => Math.max(0, Math.min(1, (EDGE_ZONE - d) / (EDGE_ZONE - 2)));
      // over the icon panel only the very bottom edge scrolls, so the buttons stay usable
      const bottom = this.inHud(m.x, m.y) ? (m.y > this.vh - 3 ? 1 : 0) : pull(this.vh - 1 - m.y);
      dx += speed * pull(m.x) - speed * pull(this.vw - 1 - m.x);
      dy += speed * pull(m.y) - speed * bottom;
    }
    // keep fractional speeds so slow scrolling near the start of the zone still moves
    this.scrollRest.x += dx;
    this.scrollRest.y += dy;
    dx = Math.trunc(this.scrollRest.x);
    dy = Math.trunc(this.scrollRest.y);
    this.scrollRest.x -= dx;
    this.scrollRest.y -= dy;
    if (dx || dy) {
      this.st.camera.x += dx;
      this.st.camera.y += dy;
      this.updateHover();
    }
  }

  /** People the current turn is waiting on, other than you (what the host's AI button would play for). */
  private stalledOn(): string[] {
    const b = this.b;
    if (!b || b.phase !== Phase.PLAYING) return [];
    const p = b.players[b.current];
    if (!p || p.userId.startsWith("bot:") || !p.members) return [];
    // another squad's units are mostly hidden by the fog of war: go by who hasn't locked in (the server checks properly)
    const waiting = b.current === this.you ? waitingFor(b, b.current) : p.members.filter((m) => !m.locked && !isAfk(m) && !m.observer);
    return waiting.filter((m) => m.userId !== this.me.id).map((m) => m.name);
  }

  /** The host's way to keep a stalled game moving: the AI plays the rest of this turn for whoever isn't responding. */
  private drawHostAiButton(y: number) {
    this.hostAiRect = null;
    const names = this.isHost ? this.stalledOn() : [];
    if (!names.length) return;
    const who = names.length > 2 ? `${names.length} PLAYERS` : names.join(" & ").toUpperCase();
    const label = `AI: PLAY THIS TURN FOR ${who}`;
    const w = Math.min(this.vw - 8, textWidth(this.assets.small, label) + 16), h = 14;
    const r = { x: Math.floor((this.vw - w) / 2), y, w, h };
    const hover = inRect(this.mouse.x, this.mouse.y, r.x, r.y, r.w, r.h);
    drawFrame(this.surf, r.x, r.y, r.w, r.h, hover ? 16 * 4 : 16 * 0 + 3, 2, 15);
    drawText(this.surf, this.assets.small, label, r.x, r.y + 3, hover ? 16 * 4 - 1 : 0, { align: "center", width: r.w, contrast: true });
    this.hostAiRect = r;
  }

  private async hostAiPlay() {
    // everyone (the host included) gets the server's "the host had the AI play..." message
    if (this.stalledOn().length) await this.sendMsg({ t: "aiplay" });
  }

  private exitButtonRect() {
    const w = textWidth(this.assets.small, "BACK TO MATCHES") + 16;
    return { x: this.vw - w - 4, y: 4, w, h: 16 };
  }
  private retryButtonRect() {
    if (!this.replayAllowed()) return null;
    const e = this.exitButtonRect();
    const w = textWidth(this.assets.small, "RETRY") + 16;
    return { x: e.x - w - 4, y: 4, w, h: 16 };
  }

  /** The battle is over, or your squad is out of it. */
  private outOfIt(): boolean {
    const b = this.b;
    return !!b && (b.phase === Phase.FINISHED || !!b.players[this.you]?.eliminated);
  }

  /**
   * Whether you may play this battle again from its start now (the server has the last word): once you're out of
   * it, or while nobody but the AI fights you; a retry also gives up a battle still on, so not with teammates in it.
   */
  private replayAllowed(retry = false): boolean {
    const b = this.b;
    if (!b || !this.replayable) return false;
    if (this.outOfIt()) return true;
    if (b.players.some((p, i) => i !== this.you && !p.eliminated && !p.userId.startsWith("bot:"))) return false;
    return !retry || !membersOf(b.players[this.you]).some((m) => m.userId !== this.me.id && !m.observer);
  }

  /** Starts over from the beginning of the battle, in a new match (a battle still on is given up). */
  private async retry() {
    try {
      const r = await api<{ id: string }>(`/api/matches/${this.matchId}/retry`, { body: {} });
      this.go(`/m/${r.id}`);
    } catch (e) {
      this.dialog = null;
      this.say((e as Error).message);
    }
  }

  private share() {
    this.dialog = null;
    shareDialog(this.root, this.matchId, this.b?.settings.name ?? "", this.challengeId, this.go);
  }

  private inHud(x: number, y: number) {
    const ix = Math.floor((this.vw - ICONS_W) / 2), iy = this.vh - ICONS_H;
    return x >= ix && x < ix + ICONS_W && y >= iy ? { x: x - ix, y: y - iy } : null;
  }

  private updateHover() {
    if (!this.b) return;
    const m = this.mouse;
    if (this.inventory) {
      const ox = Math.floor((this.vw - 320) / 2), oy = Math.floor((this.vh - 200) / 2);
      this.inventory.mouse = { x: m.x - ox, y: m.y - oy };
      return;
    }
    const h = this.inHud(m.x, m.y);
    this.hud.tooltip = "";
    if (h) {
      const btn = hudHit(h.x, h.y);
      this.hud.tooltip = btn ? TOOLTIPS[btn] : "";
      this.st.cursor.visible = false;
      return;
    }
    const t = screenToMap(m.x, m.y, this.st.camera, this.b);
    const cur = this.st.cursor;
    cur.x = t.x;
    cur.y = t.y;
    cur.z = this.st.camera.z;
    cur.visible = t.x >= 0 && t.y >= 0 && t.x < this.b.sx && t.y < this.b.sy && !this.dialog;
    const a = this.action;
    cur.kind = !a ? "normal" : a.kind === "throw" ? "throw" : a.kind === "psi" || a.kind === "probe" ? "psi" : a.kind === "launch" ? "waypoint" : "aim";
    const u = this.selectedUnit();
    cur.size = !a && u ? u.size : 1;
  }

  private async onPress(x: number, y: number, right: boolean) {
    if (!this.b) return;
    // the camera may have moved (wheel, animation, unit selection) since the last mouse move
    this.mouse.x = x;
    this.mouse.y = y;
    this.updateHover();
    if (this.inventory) {
      const ox = Math.floor((this.vw - 320) / 2), oy = Math.floor((this.vh - 200) / 2);
      await this.inventory.click(x - ox, y - oy, right);
      return;
    }
    if (this.dialog) {
      if (right) {
        this.dialog = null;
        return;
      }
      for (const r of [...this.dialogRects].reverse()) {
        if (inRect(x, y, r.x, r.y, r.w, r.h)) {
          r.run();
          return;
        }
      }
      if (this.dialog?.kind === "menu") this.dialog = null;
      return;
    }
    if (this.outOfIt()) {
      const r = this.exitButtonRect(), rr = this.retryButtonRect();
      if (inRect(x, y, r.x, r.y, r.w, r.h)) return this.onExit();
      if (rr && inRect(x, y, rr.x, rr.y, rr.w, rr.h)) return this.retry();
    }
    const ai = this.hostAiRect;
    if (ai && inRect(x, y, ai.x, ai.y, ai.w, ai.h)) {
      if (!this.inputLocked()) await this.hostAiPlay();
      return;
    }
    // psi / launch buttons
    const sel = this.selectedUnit();
    if (sel && this.canPsi(sel) && inRect(x, y, this.vw - 32, 25, 32, 24)) {
      if (this.myTurn()) this.beginAction("psi", "innate");
      return;
    }
    if (this.action?.kind === "launch" && this.action.waypoints.length && inRect(x, y, this.vw - 32, 0, 32, 24) && sel) {
      const a = this.action;
      this.action = null;
      await this.send({ c: "launch", unit: sel.id, hand: a.hand as Hand, waypoints: a.waypoints });
      return;
    }
    // visible enemy indicators
    const ix = Math.floor((this.vw - ICONS_W) / 2), iy = this.vh - ICONS_H;
    const enemies = this.visibleEnemies();
    for (let i = 0; i < enemies.length; i++) {
      if (inRect(x, y, ix + 300, iy - 16 - i * 13, 15, 12)) {
        this.centerOn(enemies[i].pos);
        return;
      }
    }
    const h = this.inHud(x, y);
    if (h) {
      const btn = hudHit(h.x, h.y);
      if (btn) {
        this.hud.pressed = btn;
        setTimeout(() => (this.hud.pressed = null), 120);
        if (!this.inputLocked()) await this.hudClick(btn, right);
      }
      return;
    }
    if (this.inputLocked()) return;
    const c = this.st.cursor;
    if (!c.visible) return;
    await this.mapClick({ x: c.x, y: c.y, z: c.z }, right);
  }
}

function inRect(x: number, y: number, rx: number, ry: number, w: number, h: number) {
  return x >= rx && y >= ry && x < rx + w && y < ry + h;
}

function rnd(a: number, b: number) {
  return Math.round(a + Math.random() * (b - a));
}

/** Every voxel along a straight line (the client only needs it for drawing bullets). */
function voxelLine(a: Pos, b: Pos): Pos[] {
  const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(b.z - a.z), 1);
  const out: Pos[] = [];
  for (let i = 0; i <= n; i++) out.push({ x: Math.round(a.x + ((b.x - a.x) * i) / n), y: Math.round(a.y + ((b.y - a.y) * i) / n), z: Math.round(a.z + ((b.z - a.z) * i) / n) });
  return out;
}

function densify(path: Pos[]): Pos[] {
  if (path.length < 2) return path;
  const out: Pos[] = [];
  for (let i = 0; i + 1 < path.length; i++) out.push(...voxelLine(path[i], path[i + 1]).slice(0, -1));
  out.push(path[path.length - 1]);
  return out;
}

export { DIR_UP, DIR_DOWN, directionTo, explosionRadius, roundsLeft, textWidth, wrapText, voxelToScreen };

/** Letters/arrows by physical key so Shift or layout changes can't leave a key "stuck". */
function keyName(e: KeyboardEvent): string {
  return e.code.startsWith("Key") || e.code.startsWith("Arrow") ? e.code : e.key;
}
