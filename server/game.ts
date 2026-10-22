// Match lobby + authoritative battle hosting. Battles are persisted to SQLite after every action
// so matches can be played asynchronously and survive restarts.
import type { ServerWebSocket } from "bun";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { db, randomId, type MatchRow, type PlayerRow, type UserRow } from "./db.ts";
import { sanitizeSettings, resolveBiome, resolveTimeOfDay, type MatchSettings, type Recruit, type Loadout } from "../shared/protocol.ts";
import { generatePool, checkLoadout, catalogFor, armorsFor, armorPrice } from "../shared/rules/catalog.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { GameRules, type Command } from "../shared/engine/actions.ts";
import { type Battle, Phase } from "../shared/engine/state.ts";
import { serializeBattle, deserializeBattle } from "../shared/engine/serialize.ts";
import { buildRecord, type MatchRecord } from "../shared/engine/record.ts";
import { recordEvents } from "../shared/engine/stats.ts";
import { AIPlayer } from "../shared/engine/ai.ts";
import { buildSquad, STRATEGIES, type Strategy } from "../shared/rules/squads.ts";
import { RNG } from "../shared/engine/rng.ts";
import { recalcAllLighting } from "../shared/engine/tileengine.ts";
import { extractView, newSentState, type SentState } from "../shared/engine/view.ts";
import { BattleEvents } from "../shared/engine/events.ts";

export const GAME_DIR = process.env.GAME_DIR ?? join(import.meta.dir, "..", "gamedata");

const fileCache = new Map<string, Uint8Array>();
export function gameFile(path: string): Uint8Array {
  const key = path.toUpperCase().replace(/\\/g, "/");
  let d = fileCache.get(key);
  if (!d) {
    const p = resolveGamePath(path);
    if (!p) throw new Error("missing game file " + path);
    d = new Uint8Array(readFileSync(p));
    fileCache.set(key, d);
  }
  return d;
}
/** Game files may be stored in any letter case; only paths inside GAME_DIR are allowed. */
export function resolveGamePath(path: string): string | null {
  const clean = normalize(path).replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.includes("..")) return null;
  for (const variant of [clean, clean.toUpperCase(), clean.toLowerCase()]) {
    const p = join(GAME_DIR, variant);
    if (existsSync(p)) return p;
  }
  return null;
}

export interface WsData {
  user: UserRow;
  matchId: string;
}
type Sock = ServerWebSocket<WsData>;

interface Host {
  id: string;
  battle: Battle;
  rules: GameRules;
  sent: SentState[];
}

const hosts = new Map<string, Host>();
const sockets = new Map<string, Set<Sock>>();

/** Battles are stored gzipped (an 80x80 map is ~800 KB of JSON). */
function packBattle(b: Battle): Uint8Array {
  return Bun.gzipSync(new TextEncoder().encode(serializeBattle(b)));
}
function unpackBattle(data: string | Uint8Array): string {
  if (typeof data === "string") return data;
  return new TextDecoder().decode(Bun.gunzipSync(data as Uint8Array<ArrayBuffer>));
}

function getMatch(id: string): MatchRow | null {
  return db.query("SELECT * FROM matches WHERE id = ?").get(id) as MatchRow | null;
}
function getPlayers(id: string): PlayerRow[] {
  return db.query("SELECT * FROM match_players WHERE match_id = ? ORDER BY seat").all(id) as PlayerRow[];
}

// ------------------------------------------------------------------------------------------
// lobby
// ------------------------------------------------------------------------------------------

export function createMatch(user: UserRow, raw: Partial<MatchSettings>) {
  const settings = sanitizeSettings(raw);
  const id = randomId(10);
  const seed = Math.floor(Math.random() * 2 ** 31);
  const pool = generatePool(settings, seed);
  const now = Date.now();
  db.query("INSERT INTO matches (id, owner, settings, status, seed, pool, created, updated) VALUES (?, ?, ?, 'lobby', ?, ?, ?, ?)").run(id, user.id, JSON.stringify(settings), seed, JSON.stringify(pool), now, now);
  db.query("INSERT INTO match_players (match_id, user_id, seat, name) VALUES (?, ?, 0, ?)").run(id, user.id, user.name);
  return { id };
}

export function listMatches(user: UserRow) {
  const rows = db.query("SELECT m.* FROM matches m JOIN match_players p ON p.match_id = m.id WHERE p.user_id = ? ORDER BY m.updated DESC LIMIT 100").all(user.id) as MatchRow[];
  return rows.map((m) => {
    const players = getPlayers(m.id);
    const s = JSON.parse(m.settings) as MatchSettings;
    let turnOf: string | null = null, yourTurn = false, round = 0, winner: string | null = null;
    const host = hosts.get(m.id);
    const battle = host?.battle;
    if (m.status !== "lobby") {
      const meta = battle ? { current: battle.current, round: battle.round, winner: battle.winner, players: battle.players } : m.battle ? metaFromJson(unpackBattle(m.battle)) : null;
      if (meta) {
        turnOf = meta.players[meta.current]?.name ?? null;
        yourTurn = meta.players[meta.current]?.userId === user.id && m.status === "playing";
        round = meta.round;
        winner = meta.winner >= 0 ? meta.players[meta.winner]?.name ?? null : null;
      }
    }
    return { id: m.id, name: s.name, status: m.status, biome: s.biome, settings: s, created: m.created, players: players.map((p) => p.name), maxPlayers: s.maxPlayers, turnOf, yourTurn, round, winner, updated: m.updated };
  });
}

function metaFromJson(json: string) {
  // cheap partial parse for the match list
  const o = JSON.parse(json);
  return { current: o.current as number, round: o.round as number, winner: o.winner as number, players: o.players as { name: string; userId: string }[] };
}

export function lobbyState(id: string, user: UserRow | null) {
  const m = getMatch(id);
  if (!m) return null;
  const settings = JSON.parse(m.settings) as MatchSettings;
  const players = getPlayers(id);
  const me = user ? players.find((p) => p.user_id === user.id) : undefined;
  const pool = JSON.parse(m.pool) as Recruit[];
  return {
    id: m.id,
    status: m.status,
    owner: m.owner,
    isOwner: !!user && m.owner === user.id,
    settings,
    players: players.map((p) => ({
      name: p.name, seat: p.seat, ready: !!p.ready, hasLoadout: !!p.loadout, you: !!user && p.user_id === user.id, owner: p.user_id === m.owner,
      ...(isBot(p.user_id) ? { bot: true, botId: p.user_id } : {}),
    })),
    strategies: STRATEGIES,
    you: me ? { seat: me.seat, loadout: me.loadout ? (JSON.parse(me.loadout) as Loadout) : null, ready: !!me.ready } : null,
    pool,
    catalog: catalogFor(settings),
    armors: armorsFor(settings).map((a) => ({ type: a, price: armorPrice(a) })),
  };
}

export function joinMatch(id: string, user: UserRow): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  const players = getPlayers(id);
  if (players.some((p) => p.user_id === user.id)) return null;
  if (m.status !== "lobby") return "This match has already started";
  const s = JSON.parse(m.settings) as MatchSettings;
  if (players.length >= s.maxPlayers) return "This match is full";
  const seats = new Set(players.map((p) => p.seat));
  let seat = 0;
  while (seats.has(seat)) seat++;
  db.query("INSERT INTO match_players (match_id, user_id, seat, name) VALUES (?, ?, ?, ?)").run(id, user.id, seat, user.name);
  touch(id);
  return null;
}

export function leaveMatch(id: string, user: UserRow): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  if (m.status !== "lobby") return "The match is in progress — surrender from the battlescape instead";
  if (m.owner === user.id) {
    db.query("DELETE FROM matches WHERE id = ?").run(id);
    broadcastLobby(id, true);
    return null;
  }
  db.query("DELETE FROM match_players WHERE match_id = ? AND user_id = ?").run(id, user.id);
  touch(id);
  return null;
}

export function updateSettings(id: string, user: UserRow, raw: Partial<MatchSettings>): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  if (m.owner !== user.id) return "Only the match creator can change settings";
  if (m.status !== "lobby") return "The match has already started";
  const old = JSON.parse(m.settings) as MatchSettings;
  const s = sanitizeSettings(raw);
  const players = getPlayers(id);
  if (s.maxPlayers < players.length) s.maxPlayers = players.length;
  // pool-affecting changes reroll the recruits and invalidate loadouts
  const poolKeys: (keyof MatchSettings)[] = ["poolSize", "allowAliens", "allowHWP", "psionics", "techLevel"];
  const reroll = poolKeys.some((k) => JSON.stringify(old[k]) !== JSON.stringify(s[k]));
  if (reroll) {
    db.query("UPDATE matches SET pool = ? WHERE id = ?").run(JSON.stringify(generatePool(s, m.seed)), id);
    db.query("UPDATE match_players SET loadout = NULL, ready = 0 WHERE match_id = ?").run(id);
  } else {
    db.query("UPDATE match_players SET ready = 0 WHERE match_id = ?").run(id);
  }
  db.query("UPDATE matches SET settings = ? WHERE id = ?").run(JSON.stringify(s), id);
  rehireBots(id);
  touch(id);
  return null;
}

export function saveLoadout(id: string, user: UserRow, loadout: Loadout) {
  const m = getMatch(id);
  if (!m) return { error: "Match not found" };
  if (m.status !== "lobby") return { error: "The match has already started" };
  const me = getPlayers(id).find((p) => p.user_id === user.id);
  if (!me) return { error: "You are not in this match" };
  const settings = JSON.parse(m.settings) as MatchSettings;
  const pool = JSON.parse(m.pool) as Recruit[];
  const raw = (loadout && typeof loadout === "object" ? loadout : {}) as Partial<Loadout>;
  const squad = Array.isArray(raw.squad) ? raw.squad : [];
  const clean: Loadout = {
    squad: squad.filter((m) => m && typeof m === "object").slice(0, 40).map((m) => ({
      recruitId: String(m.recruitId),
      armor: String(m.armor ?? "STR_NONE_UC"),
      items: (Array.isArray(m.items) ? m.items : []).filter((i) => i && typeof i === "object").slice(0, 40)
        .map((i) => ({ type: String(i.type), slot: String(i.slot), x: Number(i.x) | 0, y: Number(i.y) | 0, ammo: i.ammo ? String(i.ammo) : undefined })),
    })),
    stash: (Array.isArray(raw.stash) ? raw.stash : []).slice(0, 200).map(String),
  };
  const check = checkLoadout(settings, pool, clean);
  db.query("UPDATE match_players SET loadout = ?, ready = 0 WHERE match_id = ? AND user_id = ?").run(JSON.stringify(clean), id, user.id);
  touch(id);
  return { check };
}

export function setReady(id: string, user: UserRow, ready: boolean): string | null {
  const m = getMatch(id);
  if (!m || m.status !== "lobby") return "Match not open";
  const me = getPlayers(id).find((p) => p.user_id === user.id);
  if (!me) return "You are not in this match";
  if (ready) {
    if (!me.loadout) return "Save a loadout first";
    const check = checkLoadout(JSON.parse(m.settings), JSON.parse(m.pool), JSON.parse(me.loadout));
    if (!check.ok) return check.errors.join("; ");
  }
  db.query("UPDATE match_players SET ready = ? WHERE match_id = ? AND user_id = ?").run(ready ? 1 : 0, id, user.id);
  touch(id);
  return null;
}

export function startMatch(id: string, user: UserRow): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  if (m.owner !== user.id) return "Only the match creator can start the match";
  if (m.status !== "lobby") return "Already started";
  const players = getPlayers(id);
  if (players.length < 2) return "Waiting for at least one opponent";
  if (players.some((p) => !p.ready)) return "Every player must be ready";
  const settings = JSON.parse(m.settings) as MatchSettings;
  const pool = JSON.parse(m.pool) as Recruit[];
  // turn order is shuffled so the creator doesn't always go first
  const order = [...players].sort(() => Math.random() - 0.5);
  // a "Random" environment is decided now (the lobby only ever shows "Random")
  if (settings.biome === "RANDOM" || settings.timeOfDay === "random") {
    if (settings.biome === "RANDOM") {
      settings.biome = resolveBiome(settings.biome, m.seed);
      settings.randomBiome = true;
    }
    if (settings.timeOfDay === "random") {
      settings.timeOfDay = resolveTimeOfDay(settings.timeOfDay, m.seed);
      settings.randomTime = true;
    }
    db.query("UPDATE matches SET settings = ? WHERE id = ?").run(JSON.stringify(settings), id);
  }
  const battle = createBattle(settings, order.map((p) => ({ userId: p.user_id, name: p.name, loadout: JSON.parse(p.loadout!) })), pool, m.seed, gameFile);
  const host: Host = { id, battle, rules: new GameRules(battle), sent: battle.players.map(() => newSentState()) };
  hosts.set(id, host);
  db.query("UPDATE matches SET status = 'playing', battle = ?, turn_deadline = ?, updated = ? WHERE id = ?").run(packBattle(battle), deadline(settings), Date.now(), id);
  broadcastLobby(id);
  // a bot that moves first starts once people have had a moment to load the battle
  setTimeout(() => runBotTurn(host), 4000);
  return null;
}

export function deleteMatch(id: string, user: UserRow): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  if (m.owner !== user.id) return "Only the match creator can delete it";
  if (m.status === "playing") return "Can't delete a match in progress";
  db.query("DELETE FROM matches WHERE id = ?").run(id);
  hosts.delete(id);
  broadcastLobby(id, true);
  return null;
}

function deadline(s: MatchSettings): number | null {
  return s.turnTimer ? Date.now() + s.turnTimer * 1000 : null;
}

function touch(id: string) {
  db.query("UPDATE matches SET updated = ? WHERE id = ?").run(Date.now(), id);
  broadcastLobby(id);
}

// ------------------------------------------------------------------------------------------
// live connections
// ------------------------------------------------------------------------------------------

function loadHost(id: string): Host | null {
  let h = hosts.get(id);
  if (h) return h;
  const m = getMatch(id);
  if (!m || !m.battle) return null;
  const battle = deserializeBattle(unpackBattle(m.battle), gameFile);
  recalcAllLighting(battle);
  h = { id, battle, rules: new GameRules(battle), sent: battle.players.map(() => newSentState()) };
  hosts.set(id, h);
  runBotTurn(h);
  return h;
}

function seatOf(h: Host, userId: string): number {
  return h.battle.players.findIndex((p) => p.userId === userId);
}

function send(ws: Sock, msg: unknown) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket went away */
  }
}

export function broadcastLobby(id: string, deleted = false) {
  const set = sockets.get(id);
  if (!set) return;
  for (const ws of set) {
    if (deleted) send(ws, { t: "deleted" });
    else send(ws, { t: "lobby", lobby: lobbyState(id, ws.data.user) });
  }
}

function isMember(matchId: string, userId: string): boolean {
  return !!db.query("SELECT 1 FROM match_players WHERE match_id = ? AND user_id = ?").get(matchId, userId);
}

export function wsOpen(ws: Sock) {
  // only players of this match may follow it
  if (!isMember(ws.data.matchId, ws.data.user.id)) {
    send(ws, { t: "error", error: "You are not part of this match" });
    ws.close(4003, "not a member");
    return;
  }
  let set = sockets.get(ws.data.matchId);
  if (!set) sockets.set(ws.data.matchId, (set = new Set()));
  set.add(ws);
  const m = getMatch(ws.data.matchId);
  if (!m) return send(ws, { t: "deleted" });
  if (m.status === "lobby") return send(ws, { t: "lobby", lobby: lobbyState(m.id, ws.data.user) });
  sendFullView(ws);
  broadcastPresence(ws.data.matchId);
}

function sendFullView(ws: Sock) {
  const h = loadHost(ws.data.matchId);
  if (!h) return;
  const seat = seatOf(h, ws.data.user.id);
  if (seat < 0) return send(ws, { t: "error", error: "You are not part of this battle" });
  // keep the player's memory of the map across reconnects (only a server restart forgets it)
  const m = getMatch(h.id)!;
  send(ws, { t: "view", view: extractView(h.battle, seat, h.sent[seat], true), deadline: m.turn_deadline });
}

export function wsClose(ws: Sock) {
  sockets.get(ws.data.matchId)?.delete(ws);
  broadcastPresence(ws.data.matchId);
}

function broadcastPresence(id: string) {
  const set = sockets.get(id);
  if (!set) return;
  const online = [...new Set([...set].map((s) => s.data.user.id))];
  for (const ws of set) send(ws, { t: "presence", online });
}

export function wsMessage(ws: Sock, raw: string) {
  let msg: { t: string; seq?: number; cmd?: Command; text?: string };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.t === "resync") return sendFullView(ws);
  if (!sockets.get(ws.data.matchId)?.has(ws)) return;
  if (msg.t === "chat" && msg.text) {
    const text = String(msg.text).slice(0, 200);
    for (const s of sockets.get(ws.data.matchId) ?? []) send(s, { t: "chat", from: ws.data.user.name, text });
    return;
  }
  if (msg.t !== "cmd" || !msg.cmd) return;
  const h = loadHost(ws.data.matchId);
  if (!h) return send(ws, { t: "result", seq: msg.seq, ok: false, error: "STR_NO_BATTLE" });
  const seat = seatOf(h, ws.data.user.id);
  if (seat < 0) return send(ws, { t: "result", seq: msg.seq, ok: false, error: "STR_NOT_IN_BATTLE" });
  const before = h.battle.current;
  let res;
  try {
    res = h.rules.apply(seat, msg.cmd);
  } catch (e) {
    console.error("action failed", h.id, msg.cmd, e);
    return send(ws, { t: "result", seq: msg.seq, ok: false, error: "STR_INTERNAL_ERROR" });
  }
  send(ws, { t: "result", seq: msg.seq, ok: res.ok, error: res.error, private: res.privateData });
  publish(h, res.events, before !== h.battle.current);
}

/** Persists the battle and sends each player their filtered events + view changes. */
function publish(h: Host, ev: BattleEvents, turnChanged: boolean) {
  const b = h.battle;
  const m = getMatch(h.id)!;
  const settings = b.settings;
  let dl = m.turn_deadline;
  if (turnChanged) dl = deadline(settings);
  const status = b.phase === Phase.FINISHED ? "finished" : "playing";
  db.query("UPDATE matches SET battle = ?, status = ?, turn_deadline = ?, updated = ? WHERE id = ?").run(packBattle(b), status, status === "finished" ? null : dl, Date.now(), h.id);
  if (status === "finished") saveRecord(h, m);
  for (const ws of sockets.get(h.id) ?? []) {
    const seat = seatOf(h, ws.data.user.id);
    if (seat < 0) continue;
    const events = ev.list.filter((r) => r.vis & (1 << seat)).map((r) => r.e);
    send(ws, { t: "update", events, view: extractView(b, seat, h.sent[seat], false), deadline: dl });
  }
  for (const ai of botsOf(h).values()) ai.observe();
  runBotTurn(h);
}

/** Ends turns whose timer ran out. */
export function tickTimers() {
  const rows = db.query("SELECT id FROM matches WHERE status = 'playing' AND turn_deadline IS NOT NULL AND turn_deadline < ?").all(Date.now()) as { id: string }[];
  for (const { id } of rows) {
    const h = loadHost(id);
    if (!h) continue;
    const ev = new BattleEvents(h.battle);
    try {
      h.rules.endTurn(ev);
    } catch (e) {
      console.error("timer end turn failed", id, e);
    }
    ev.msg("STR_TURN_TIMER_EXPIRED", ev.all());
    recordEvents(h.battle, ev);
    publish(h, ev, true);
  }
}

// ------------------------------------------------------------------------------------------
// statistics
// ------------------------------------------------------------------------------------------

/** Stores the finished match's statistics record (once). */
function saveRecord(h: Host, m: MatchRow) {
  try {
    if (db.query("SELECT 1 FROM match_records WHERE match_id = ?").get(h.id)) return;
    const players = getPlayers(h.id);
    const loadouts = h.battle.players.map((p) => {
      const row = players.find((r) => r.user_id === p.userId);
      return row?.loadout ? (JSON.parse(row.loadout) as Loadout) : { squad: [], stash: [] };
    });
    const rec = buildRecord(h.battle, JSON.parse(m.pool) as Recruit[], loadouts, h.id, "human");
    db.query("INSERT OR IGNORE INTO match_records (match_id, finished, record) VALUES (?, ?, ?)").run(h.id, rec.finishedAt, JSON.stringify(rec));
  } catch (e) {
    console.error("saving match record failed", h.id, e);
  }
}

/** Every stored match record, oldest first (for tools/player-stats.ts). */
export function matchRecords(since = 0): MatchRecord[] {
  const rows = db.query("SELECT record FROM match_records WHERE finished >= ? ORDER BY finished").all(since) as { record: string }[];
  return rows.map((r) => JSON.parse(r.record));
}

// ------------------------------------------------------------------------------------------
// computer players
// ------------------------------------------------------------------------------------------

/** Bot players are users with ids "bot:<strategy>:<random>" (they can't sign in). */
export function isBot(userId: string): boolean {
  return userId.startsWith("bot:");
}
function botStrategy(userId: string): Strategy {
  const s = userId.split(":")[1] as Strategy;
  return STRATEGIES.includes(s) ? s : "balanced";
}

const STRATEGY_NAMES: Record<Strategy, string> = {
  swarm: "Swarm", elite: "Elite", balanced: "Balanced", heavy: "Heavy Weapons", monster: "Monster", aliens: "Alien Legion",
  tanks: "Armored", psi: "Psionic", random: "Wildcard",
};

function botLoadout(settings: MatchSettings, pool: Recruit[], strategy: Strategy, seed: number): Loadout {
  return buildSquad(strategy, settings, pool, new RNG(seed));
}

/** Adds a computer-controlled squad to a lobby (creator only). */
export function addBot(id: string, user: UserRow, strategy: string): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  if (m.owner !== user.id) return "Only the match creator can add AI squads";
  if (m.status !== "lobby") return "The match has already started";
  const settings = JSON.parse(m.settings) as MatchSettings;
  const players = getPlayers(id);
  if (players.length >= settings.maxPlayers) return "The match is full (raise the number of squads in the settings)";
  const st: Strategy = STRATEGIES.includes(strategy as Strategy) ? (strategy as Strategy) : STRATEGIES[Math.floor(Math.random() * STRATEGIES.length)];
  const seats = new Set(players.map((p) => p.seat));
  let seat = 0;
  while (seats.has(seat)) seat++;
  const n = players.filter((p) => isBot(p.user_id)).length + 1;
  const name = `AI ${n}: ${STRATEGY_NAMES[st]}`;
  const botId = `bot:${st}:${randomId(8)}`;
  let loadout: Loadout;
  try {
    loadout = botLoadout(settings, JSON.parse(m.pool), st, m.seed + seat * 101);
  } catch (e) {
    return "Couldn't build that squad: " + (e as Error).message;
  }
  db.query("INSERT INTO users (id, google_sub, email, name, picture, created) VALUES (?, NULL, NULL, ?, NULL, ?)").run(botId, name, Date.now());
  db.query("INSERT INTO match_players (match_id, user_id, seat, name, loadout, ready) VALUES (?, ?, ?, ?, ?, 1)").run(id, botId, seat, name, JSON.stringify(loadout));
  touch(id);
  return null;
}

export function removeBot(id: string, user: UserRow, botId: string): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  if (m.owner !== user.id) return "Only the match creator can remove AI squads";
  if (m.status !== "lobby") return "The match has already started";
  if (!isBot(botId)) return "That's not an AI squad";
  db.query("DELETE FROM match_players WHERE match_id = ? AND user_id = ?").run(id, botId);
  touch(id);
  return null;
}

/** After a settings change bots hire again (the pool or budget may differ) and stay ready. */
function rehireBots(id: string) {
  const m = getMatch(id)!;
  const settings = JSON.parse(m.settings) as MatchSettings;
  const pool = JSON.parse(m.pool) as Recruit[];
  for (const p of getPlayers(id)) {
    if (!isBot(p.user_id)) continue;
    try {
      const l = botLoadout(settings, pool, botStrategy(p.user_id), m.seed + p.seat * 101);
      db.query("UPDATE match_players SET loadout = ?, ready = 1 WHERE match_id = ? AND user_id = ?").run(JSON.stringify(l), id, p.user_id);
    } catch (e) {
      console.error("bot rehire failed", id, e);
    }
  }
}

const botPlayers = new Map<string, Map<number, AIPlayer>>();
function botsOf(h: Host): Map<number, AIPlayer> {
  let m = botPlayers.get(h.id);
  if (!m || [...m.values()].some((a) => a.b !== h.battle)) {
    m = new Map();
    h.battle.players.forEach((p, seat) => {
      if (isBot(p.userId)) m!.set(seat, new AIPlayer(h.battle, seat, undefined, h.battle.round * 31 + seat));
    });
    botPlayers.set(h.id, m);
  }
  return m;
}

/** Pause between a bot's actions, so the people in the match can follow along. */
const BOT_PACE_MS = 250;
const botRunning = new Set<string>();

/** If it's a bot's turn, plays it one action at a time (each action is published like a player's). */
function runBotTurn(h: Host) {
  const b = h.battle;
  if (b.phase !== Phase.PLAYING || botRunning.has(h.id)) return;
  const ai = botsOf(h).get(b.current);
  if (!ai) return;
  botRunning.add(h.id);
  const seat = b.current;
  const rules = {
    apply: (player: number, cmd: Command) => {
      const before = b.current;
      const res = h.rules.apply(player, cmd);
      publish(h, res.events, before !== b.current);
      return res;
    },
  };
  const steps = ai.turnSteps(rules);
  const finish = () => {
    botRunning.delete(h.id);
    // the next player may be a bot too
    setTimeout(() => runBotTurn(h), BOT_PACE_MS);
  };
  const step = () => {
    if (hosts.get(h.id) !== h) return botRunning.delete(h.id);
    try {
      if (!steps.next().done && b.phase === Phase.PLAYING && b.current === seat) {
        setTimeout(step, BOT_PACE_MS);
        return;
      }
      // a turn the bot didn't end itself still ends
      if (b.phase === Phase.PLAYING && b.current === seat) rules.apply(seat, { c: "endturn" });
    } catch (e) {
      console.error("bot turn failed", h.id, e);
      try {
        if (b.phase === Phase.PLAYING && b.current === seat) rules.apply(seat, { c: "endturn" });
      } catch {
        /* nothing more to do */
      }
    }
    finish();
  };
  setTimeout(step, 800);
}

/** On startup: resume matches where a bot was in the middle of (or due) its turn. */
export function resumeBots() {
  const rows = db.query("SELECT m.id FROM matches m WHERE m.status = 'playing' AND EXISTS (SELECT 1 FROM match_players p WHERE p.match_id = m.id AND p.user_id LIKE 'bot:%')").all() as { id: string }[];
  for (const { id } of rows) {
    try {
      loadHost(id);
    } catch (e) {
      console.error("resuming bots failed", id, e);
    }
  }
}
