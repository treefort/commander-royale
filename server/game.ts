// Match lobby + authoritative battle hosting. Battles are persisted to SQLite after every action
// so matches can be played asynchronously and survive restarts.
import type { ServerWebSocket } from "bun";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize } from "node:path";
import { db, randomId, type MatchRow, type PlayerRow, type UserRow } from "./db.ts";
import { sanitizeSettings, defaultSettings, resolveBiome, resolveTimeOfDay, sanitizeBotTuning, type MatchSettings, type Recruit, type Loadout, type BotTuning } from "../shared/protocol.ts";
import { generatePool, checkLoadout, catalogFor, armorsFor, armorPrice } from "../shared/rules/catalog.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { GameRules, type Command } from "../shared/engine/actions.ts";
import { type Battle, type Unit, Phase } from "../shared/engine/state.ts";
import { serializeBattle, deserializeBattle } from "../shared/engine/serialize.ts";
import { buildRecord, type MatchRecord } from "../shared/engine/record.ts";
import { recordEvents } from "../shared/engine/stats.ts";
import { AIPlayer, aiOptionsFor } from "../shared/engine/ai.ts";
import { seatOfUser, memberOf, mayCommand, playedByAI, waitingFor, isShared } from "../shared/engine/coop.ts";
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
  /** co-op: units the AI has already played for AFK members this turn ("round:seat") */
  aiPlayed: { turn: string; units: Set<number> };
}

function newHost(id: string, battle: Battle): Host {
  return { id, battle, rules: new GameRules(battle), sent: battle.players.map(() => newSentState()), aiPlayed: { turn: "", units: new Set() } };
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
/** Stored settings, with what matches from before newer options get by default. */
function parseSettings(json: string): MatchSettings {
  const s = JSON.parse(json) as MatchSettings;
  s.coop ??= defaultSettings().coop;
  return s;
}
/** Players who field a squad (everyone else plays in one of theirs). */
function leadersOf(players: PlayerRow[]): PlayerRow[] {
  return players.filter((p) => !p.squad_of);
}
/** A squad's people, leader first. */
function squadOf(players: PlayerRow[], leader: PlayerRow): PlayerRow[] {
  return [leader, ...players.filter((p) => p.squad_of === leader.user_id)];
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
    const s = parseSettings(m.settings);
    let turnOf: string | null = null, yourTurn = false, round = 0, winner: string | null = null;
    const host = hosts.get(m.id);
    const battle = host?.battle;
    if (m.status !== "lobby") {
      const meta = battle ? { current: battle.current, round: battle.round, winner: battle.winner, players: battle.players } : m.battle ? metaFromJson(unpackBattle(m.battle)) : null;
      if (meta) {
        const cur = meta.players[meta.current];
        turnOf = cur?.name ?? null;
        // co-op: it's still "your turn" until you've locked in
        const mine = cur?.members ? cur.members.some((x) => x.userId === user.id && !x.locked) : cur?.userId === user.id;
        yourTurn = mine && m.status === "playing";
        round = meta.round;
        winner = meta.winner >= 0 ? meta.players[meta.winner]?.name ?? null : null;
      }
    }
    // co-op squads are listed as "Leader + Member + ..."
    const squads = leadersOf(players).map((l) => squadOf(players, l).map((p) => p.name).join(" + "));
    return { id: m.id, name: s.name, status: m.status, biome: s.biome, settings: s, created: m.created, players: squads, maxPlayers: s.maxPlayers, turnOf, yourTurn, round, winner, updated: m.updated };
  });
}

function metaFromJson(json: string) {
  // cheap partial parse for the match list
  const o = JSON.parse(json);
  return { current: o.current as number, round: o.round as number, winner: o.winner as number, players: o.players as { name: string; userId: string; members?: { userId: string; locked: boolean }[] }[] };
}

export function lobbyState(id: string, user: UserRow | null) {
  const m = getMatch(id);
  if (!m) return null;
  const settings = parseSettings(m.settings);
  const players = getPlayers(id);
  const me = user ? players.find((p) => p.user_id === user.id) : undefined;
  const pool = JSON.parse(m.pool) as Recruit[];
  const leader = me?.squad_of ? players.find((p) => p.user_id === me.squad_of) : me;
  return {
    id: m.id,
    status: m.status,
    owner: m.owner,
    isOwner: !!user && m.owner === user.id,
    settings,
    players: players.map((p) => ({
      name: p.name, seat: p.seat, ready: !!p.ready, hasLoadout: !!p.loadout, you: !!user && p.user_id === user.id, owner: p.user_id === m.owner,
      userId: p.user_id, squadOf: p.squad_of,
      ...(isBot(p.user_id) ? { bot: true, botId: p.user_id, ai: botTuning(p) } : {}),
    })),
    strategies: STRATEGIES,
    you: me ? {
      seat: me.seat, loadout: leader?.loadout ? (JSON.parse(leader.loadout) as Loadout) : null, ready: !!leader?.ready,
      // co-op: the leader whose squad you play in (they hire and equip it; you see their loadout)
      squadOf: me.squad_of, leaderName: me.squad_of ? leader?.name ?? null : null,
    } : null,
    pool,
    catalog: catalogFor(settings),
    armors: armorsFor(settings).map((a) => ({ type: a, price: armorPrice(a) })),
  };
}

/**
 * Joins a lobby with a squad of your own, or (co-op) as a teammate in `squad`'s (a leader's user id). With no
 * choice and every squad slot taken, you join the first human squad with room.
 */
export function joinMatch(id: string, user: UserRow, squad?: string): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  const players = getPlayers(id);
  if (players.some((p) => p.user_id === user.id)) return squad !== undefined ? joinSquad(id, user, squad) : null;
  if (m.status !== "lobby") return "This match has already started";
  const s = parseSettings(m.settings);
  let leader: PlayerRow | undefined;
  if (squad) {
    leader = players.find((p) => p.user_id === squad && !p.squad_of);
    const e = squadRoom(s, players, leader);
    if (e) return e;
  } else if (leadersOf(players).length >= s.maxPlayers) {
    leader = leadersOf(players).find((l) => !squadRoom(s, players, l));
    if (!leader) return "This match is full";
  }
  const seats = new Set(players.map((p) => p.seat));
  let seat = 0;
  while (seats.has(seat)) seat++;
  db.query("INSERT INTO match_players (match_id, user_id, seat, name, squad_of) VALUES (?, ?, ?, ?, ?)").run(id, user.id, seat, user.name, leader?.user_id ?? null);
  touch(id);
  return null;
}

/** Why `leader`'s squad can't take another person (null: it can). */
function squadRoom(s: MatchSettings, players: PlayerRow[], leader: PlayerRow | undefined): string | null {
  if (!leader) return "That squad doesn't exist";
  if (isBot(leader.user_id)) return "Computer squads don't take teammates";
  if (s.coop.squadSize <= 1) return "Co-op squads are off in this match";
  if (squadOf(players, leader).length >= s.coop.squadSize) return "That squad is full";
  return null;
}

/** Co-op: move into `leaderId`'s squad, or (with "") back out to field a squad of your own. */
export function joinSquad(id: string, user: UserRow, leaderId: string): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  if (m.status !== "lobby") return "The match has already started";
  const s = parseSettings(m.settings);
  const players = getPlayers(id);
  const me = players.find((p) => p.user_id === user.id);
  if (!me) return "You are not in this match";
  if (!leaderId) {
    if (!me.squad_of) return null;
    if (leadersOf(players).length >= s.maxPlayers) return "There's no room for another squad (raise the number of squads in the settings)";
    db.query("UPDATE match_players SET squad_of = NULL, ready = 0 WHERE match_id = ? AND user_id = ?").run(id, user.id);
  } else {
    if (leaderId === user.id || leaderId === me.squad_of) return null;
    if (players.some((p) => p.squad_of === user.id)) return "Your teammates would be left without a squad: they have to leave yours first";
    const e = squadRoom(s, players, players.find((p) => p.user_id === leaderId && !p.squad_of));
    if (e) return e;
    db.query("UPDATE match_players SET squad_of = ?, ready = 0 WHERE match_id = ? AND user_id = ?").run(leaderId, id, user.id);
    // the leader's units dealt to this player keep their pick; nothing else to undo
  }
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
  // a leader's squad passes to the next teammate in line, loadout and all
  const players = getPlayers(id);
  const me = players.find((p) => p.user_id === user.id);
  const heir = me && !me.squad_of ? players.find((p) => p.squad_of === user.id) : undefined;
  if (me && heir) {
    db.query("UPDATE match_players SET squad_of = NULL, loadout = ?, ready = 0 WHERE match_id = ? AND user_id = ?").run(me.loadout, id, heir.user_id);
    db.query("UPDATE match_players SET squad_of = ? WHERE match_id = ? AND squad_of = ?").run(heir.user_id, id, user.id);
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
  const old = parseSettings(m.settings);
  const s = sanitizeSettings(raw);
  const players = getPlayers(id);
  const leaders = leadersOf(players);
  if (s.maxPlayers < leaders.length) s.maxPlayers = leaders.length;
  const biggest = Math.max(1, ...leaders.map((l) => squadOf(players, l).length));
  if (biggest > s.coop.squadSize) return `A squad already has ${biggest} people: they have to split up before squads can be that small`;
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
  const players = getPlayers(id);
  const me = players.find((p) => p.user_id === user.id);
  if (!me) return { error: "You are not in this match" };
  if (me.squad_of) return { error: "Your squad leader hires and equips the squad" };
  const team = new Set(squadOf(players, me).map((p) => p.user_id));
  const settings = parseSettings(m.settings);
  const pool = JSON.parse(m.pool) as Recruit[];
  const raw = (loadout && typeof loadout === "object" ? loadout : {}) as Partial<Loadout>;
  const squad = Array.isArray(raw.squad) ? raw.squad : [];
  const clean: Loadout = {
    squad: squad.filter((m) => m && typeof m === "object").slice(0, 40).map((m) => ({
      recruitId: String(m.recruitId),
      armor: String(m.armor ?? "STR_NONE_UC"),
      ...(m.controller && team.has(String(m.controller)) ? { controller: String(m.controller) } : {}),
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
  if (me.squad_of) return "Your squad leader readies the squad";
  if (ready) {
    if (!me.loadout) return "Save a loadout first";
    const check = checkLoadout(parseSettings(m.settings), JSON.parse(m.pool), JSON.parse(me.loadout));
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
  const everyone = getPlayers(id);
  const players = leadersOf(everyone);
  if (players.length < 2) return "Waiting for at least one opponent";
  if (players.some((p) => !p.ready)) return "Every squad must be ready";
  const settings = parseSettings(m.settings);
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
  const battle = createBattle(settings, order.map((p) => ({
    userId: p.user_id, name: p.name, loadout: JSON.parse(p.loadout!),
    ...(isBot(p.user_id) ? { ai: botTuning(p) } : { members: squadOf(everyone, p).map((x) => ({ userId: x.user_id, name: x.name })) }),
  })), pool, m.seed, gameFile);
  const host = newHost(id, battle);
  hosts.set(id, host);
  db.query("UPDATE matches SET status = 'playing', battle = ?, turn_deadline = ?, updated = ? WHERE id = ?").run(packBattle(battle), deadline(settings), Date.now(), id);
  broadcastLobby(id);
  // a bot that moves first starts once people have had a moment to load the battle
  setTimeout(() => runAI(host), 4000);
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
  h = newHost(id, battle);
  hosts.set(id, h);
  // nobody is connected yet: people who stay away get the AI (if the match uses it) after the grace period
  scheduleAwayCheck(h);
  runAI(h);
  return h;
}

function seatOf(h: Host, userId: string): number {
  return seatOfUser(h.battle, userId);
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
  // back from being away: the AI hands their units back
  const h = hosts.get(ws.data.matchId);
  if (h) {
    const seat = seatOf(h, ws.data.user.id);
    const me = seat >= 0 ? memberOf(h.battle, seat, ws.data.user.id) : undefined;
    if (me?.away) {
      me.away = false;
      publish(h, new BattleEvents(h.battle), false, ws.data.user.id);
    }
  }
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
  const h = hosts.get(ws.data.matchId);
  if (h) scheduleAwayCheck(h);
}

function onlineUsers(id: string): Set<string> {
  return new Set([...(sockets.get(id) ?? [])].map((s) => s.data.user.id));
}

function broadcastPresence(id: string) {
  const set = sockets.get(id);
  if (!set) return;
  const online = [...onlineUsers(id)];
  for (const ws of set) send(ws, { t: "presence", online });
}

/** How long someone can be offline (a reload, a flaky connection) before the AI takes over their units. */
export const AWAY_GRACE_MS = Number(process.env.AWAY_GRACE_MS ?? 30_000);
const awayTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** With the co-op "afkAI" setting, people offline for a while are marked away and the AI plays for them. */
function scheduleAwayCheck(h: Host) {
  if (!h.battle.settings.coop?.afkAI || h.battle.phase !== Phase.PLAYING) return;
  clearTimeout(awayTimers.get(h.id));
  awayTimers.set(h.id, setTimeout(() => {
    awayTimers.delete(h.id);
    if (hosts.get(h.id) !== h || h.battle.phase !== Phase.PLAYING) return;
    const online = onlineUsers(h.id);
    let changed = false;
    for (const p of h.battle.players)
      for (const m of p.members ?? []) {
        const away = !online.has(m.userId);
        if (m.away !== away) {
          m.away = away;
          changed = true;
        }
      }
    if (changed) publish(h, new BattleEvents(h.battle), false, "");
  }, AWAY_GRACE_MS));
}

export function wsMessage(ws: Sock, raw: string) {
  let msg: { t: string; seq?: number; cmd?: Command; text?: string; on?: boolean; unit?: number; to?: string };
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
  if (msg.t === "afk" || msg.t === "assign") {
    const h = loadHost(ws.data.matchId);
    const error = !h ? "STR_NO_BATTLE" : msg.t === "afk" ? setAfk(h, ws.data.user.id, !!msg.on) : assignUnit(h, ws.data.user.id, Number(msg.unit), String(msg.to ?? ""));
    send(ws, { t: "result", seq: msg.seq, ok: !error, error: error ?? undefined, noUpdate: !!error });
    return;
  }
  if (msg.t !== "cmd" || !msg.cmd) return;
  const h = loadHost(ws.data.matchId);
  if (!h) return send(ws, { t: "result", seq: msg.seq, ok: false, error: "STR_NO_BATTLE", noUpdate: true });
  const userId = ws.data.user.id;
  const seat = seatOf(h, userId);
  if (seat < 0) return send(ws, { t: "result", seq: msg.seq, ok: false, error: "STR_NOT_IN_BATTLE", noUpdate: true });
  const b = h.battle;
  const cmd = msg.cmd;
  const me = memberOf(b, seat, userId);
  // turned away up front: no update follows the result
  const reject = (error: string) => send(ws, { t: "result", seq: msg.seq, ok: false, error, noUpdate: true });
  if (cmd.c === "endturn" && me) {
    // co-op: "end turn" locks you in (again to unlock); the squad's turn ends once nobody is left to wait for
    if (b.phase !== Phase.PLAYING || b.current !== seat) return reject("STR_NOT_YOUR_TURN");
    me.locked = !me.locked;
    send(ws, { t: "result", seq: msg.seq, ok: true, private: { locked: me.locked } });
    if (!endSharedTurnIfDone(h, userId)) publish(h, new BattleEvents(b), false, userId);
    return;
  }
  if (cmd.c === "surrender" && isShared(b.players[seat]) && b.players[seat].userId !== userId) return reject("STR_ONLY_LEADER_SURRENDERS");
  if ("unit" in cmd && typeof cmd.unit === "number") {
    const u = b.unit(cmd.unit);
    const e = u ? mayCommand(b, userId, u) : null;
    if (e) return reject(e);
  }
  // giving orders again takes back a lock-in
  if (me?.locked && cmd.c !== "surrender" && b.current === seat) me.locked = false;
  const before = b.current;
  let res;
  try {
    res = h.rules.apply(seat, cmd);
  } catch (e) {
    console.error("action failed", h.id, cmd, e);
    return reject("STR_INTERNAL_ERROR");
  }
  send(ws, { t: "result", seq: msg.seq, ok: res.ok, error: res.error, private: res.privateData });
  publish(h, res.events, before !== b.current, userId);
}

/** Co-op: going AFK hands your units to the AI (coming back takes them over again). */
function setAfk(h: Host, userId: string, on: boolean): string | null {
  const b = h.battle;
  const seat = seatOf(h, userId);
  const me = seat >= 0 ? memberOf(b, seat, userId) : undefined;
  if (!me || b.phase !== Phase.PLAYING) return "STR_NOT_IN_BATTLE";
  me.afk = on;
  if (!on) me.away = false;
  publish(h, new BattleEvents(b), false, userId);
  return null;
}

/** Co-op: hand a unit to another member of its squad (its controller, or the squad leader, may). */
function assignUnit(h: Host, userId: string, unitId: number, to: string): string | null {
  const b = h.battle;
  const u = b.unit(unitId);
  if (!u || u.owner !== seatOf(h, userId)) return "STR_INVALID_UNIT";
  const p = b.players[u.owner];
  const cur = u.controller ?? "";
  if (cur && cur !== userId && p.userId !== userId && memberOf(b, u.owner, cur)) return "STR_TEAMMATES_UNIT";
  if (!memberOf(b, u.owner, to)) return "STR_INVALID_UNIT";
  u.controller = to;
  publish(h, new BattleEvents(b), false, userId);
  return null;
}

/**
 * Co-op: ends the current squad's turn if everyone has locked in and the AI has nothing left to play for AFK
 * members (with the "timer" setting a shared squad's turn only ends when the clock runs out). True if it ended.
 */
function endSharedTurnIfDone(h: Host, by = ""): boolean {
  const b = h.battle;
  const p = b.players[b.current];
  if (b.phase !== Phase.PLAYING || !p?.members || isBot(p.userId)) return false;
  if (waitingFor(b, b.current).length || aiPending(h)) return false;
  if (isShared(p) && b.settings.coop?.turnEnd === "timer" && b.settings.turnTimer > 0) return false;
  const seat = b.current;
  const res = h.rules.apply(seat, { c: "endturn" });
  publish(h, res.events, true, by);
  return true;
}

/** Persists the battle and sends each player their filtered events + view changes (`by`: who acted, "" the game). */
function publish(h: Host, ev: BattleEvents, turnChanged: boolean, by: string) {
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
    send(ws, { t: "update", events, view: extractView(b, seat, h.sent[seat], false), deadline: dl, by });
  }
  for (const ai of aisOf(h).values()) ai.observe();
  runAI(h);
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
    publish(h, ev, true, "");
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

/** A computer squad's AI settings (defaults for bots added before they existed). */
function botTuning(p: PlayerRow): BotTuning {
  let raw: unknown = null;
  try {
    raw = p.ai ? JSON.parse(p.ai) : null;
  } catch {
    /* defaults */
  }
  return sanitizeBotTuning(raw);
}

/** Hires a bot's squad; its "strength" scales the budget and seats it gets (a handicap for co-op games). */
function botLoadout(settings: MatchSettings, pool: Recruit[], strategy: Strategy, seed: number, tuning: BotTuning): Loadout {
  const k = tuning.strength / 100;
  const scaled = { ...settings, budget: Math.round(settings.budget * k), squadLimit: Math.max(1, Math.min(60, Math.round(settings.squadLimit * k))) };
  return buildSquad(strategy, scaled, pool, new RNG(seed));
}

/** Adds a computer-controlled squad to a lobby (creator only). */
export function addBot(id: string, user: UserRow, strategy: string, rawTuning?: unknown): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  if (m.owner !== user.id) return "Only the match creator can add AI squads";
  if (m.status !== "lobby") return "The match has already started";
  const settings = parseSettings(m.settings);
  const players = getPlayers(id);
  if (leadersOf(players).length >= settings.maxPlayers) return "The match is full (raise the number of squads in the settings)";
  const st: Strategy = STRATEGIES.includes(strategy as Strategy) ? (strategy as Strategy) : STRATEGIES[Math.floor(Math.random() * STRATEGIES.length)];
  const tuning = sanitizeBotTuning(rawTuning);
  const seats = new Set(players.map((p) => p.seat));
  let seat = 0;
  while (seats.has(seat)) seat++;
  const n = players.filter((p) => isBot(p.user_id)).length + 1;
  const name = `AI ${n}: ${STRATEGY_NAMES[st]}`;
  const botId = `bot:${st}:${randomId(8)}`;
  let loadout: Loadout;
  try {
    loadout = botLoadout(settings, JSON.parse(m.pool), st, m.seed + seat * 101, tuning);
  } catch (e) {
    return "Couldn't build that squad: " + (e as Error).message;
  }
  db.query("INSERT INTO users (id, google_sub, email, name, picture, created) VALUES (?, NULL, NULL, ?, NULL, ?)").run(botId, name, Date.now());
  db.query("INSERT INTO match_players (match_id, user_id, seat, name, loadout, ready, ai) VALUES (?, ?, ?, ?, ?, 1, ?)").run(id, botId, seat, name, JSON.stringify(loadout), JSON.stringify(tuning));
  touch(id);
  return null;
}

/** Changes a computer squad's AI settings (creator only); it hires again if its strength changed. */
export function tuneBot(id: string, user: UserRow, botId: string, rawTuning: unknown): string | null {
  const m = getMatch(id);
  if (!m) return "Match not found";
  if (m.owner !== user.id) return "Only the match creator can change AI squads";
  if (m.status !== "lobby") return "The match has already started";
  const p = getPlayers(id).find((x) => x.user_id === botId);
  if (!p || !isBot(botId)) return "That's not an AI squad";
  const tuning = sanitizeBotTuning(rawTuning);
  let loadout = p.loadout;
  if (tuning.strength !== botTuning(p).strength) {
    try {
      loadout = JSON.stringify(botLoadout(parseSettings(m.settings), JSON.parse(m.pool), botStrategy(botId), m.seed + p.seat * 101, tuning));
    } catch (e) {
      return "Couldn't build that squad: " + (e as Error).message;
    }
  }
  db.query("UPDATE match_players SET ai = ?, loadout = ? WHERE match_id = ? AND user_id = ?").run(JSON.stringify(tuning), loadout, id, botId);
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
  const settings = parseSettings(m.settings);
  const pool = JSON.parse(m.pool) as Recruit[];
  for (const p of getPlayers(id)) {
    if (!isBot(p.user_id)) continue;
    try {
      const l = botLoadout(settings, pool, botStrategy(p.user_id), m.seed + p.seat * 101, botTuning(p));
      db.query("UPDATE match_players SET loadout = ?, ready = 1 WHERE match_id = ? AND user_id = ?").run(JSON.stringify(l), id, p.user_id);
    } catch (e) {
      console.error("bot rehire failed", id, e);
    }
  }
}

/** One AI per squad: computer squads play with theirs; human squads' stand in for AFK members. */
const aiPlayers = new Map<string, Map<number, AIPlayer>>();
function aisOf(h: Host): Map<number, AIPlayer> {
  let m = aiPlayers.get(h.id);
  if (!m || [...m.values()].some((a) => a.b !== h.battle)) {
    m = new Map();
    h.battle.players.forEach((p, seat) => {
      const opts = isBot(p.userId) ? aiOptionsFor(p.ai) : undefined;
      m!.set(seat, new AIPlayer(h.battle, seat, opts, h.battle.round * 31 + seat));
    });
    aiPlayers.set(h.id, m);
  }
  return m;
}

/** Pause between a bot's actions, so the people in the match can follow along. */
const BOT_PACE_MS = 250;
const botRunning = new Set<string>();

/** Co-op: units the AI still has to play this turn for AFK members of the squad whose turn it is. */
function afkWork(h: Host): Unit[] {
  const b = h.battle;
  const turn = `${b.round}:${b.current}`;
  if (h.aiPlayed.turn !== turn) h.aiPlayed = { turn, units: new Set() };
  return b.units.filter((u) => u.owner === b.current && !h.aiPlayed.units.has(u.id) && playedByAI(b, u));
}

/** The AI is (or is about to be) playing someone's units in the current turn. */
function aiPending(h: Host): boolean {
  return botRunning.has(h.id) || afkWork(h).length > 0;
}

/**
 * If it's a bot's turn, plays it one action at a time (each action is published like a player's). In a human
 * squad's turn, plays the units of AFK members the same way, alongside the people still at the keyboard.
 */
function runAI(h: Host) {
  const b = h.battle;
  if (b.phase !== Phase.PLAYING || botRunning.has(h.id)) return;
  const seat = b.current;
  const bot = isBot(b.players[seat].userId);
  if (!bot && !afkWork(h).length) return;
  const ai = aisOf(h).get(seat);
  if (!ai) return;
  botRunning.add(h.id);
  const rules = {
    apply: (player: number, cmd: Command) => {
      const before = b.current;
      const res = h.rules.apply(player, cmd);
      publish(h, res.events, before !== b.current, "");
      return res;
    },
  };
  const played = h.aiPlayed.units;
  // an AFK member who comes back mid-turn takes their units over at once
  const only = bot ? undefined : (u: Unit) => !played.has(u.id) && playedByAI(b, u);
  const steps = ai.turnSteps(rules, only);
  const stillOurs = () => b.phase === Phase.PLAYING && b.current === seat;
  const finish = () => {
    botRunning.delete(h.id);
    if (!bot && stillOurs()) {
      for (const u of b.units) if (u.owner === seat && playedByAI(b, u)) played.add(u.id);
      endSharedTurnIfDone(h);
    }
    // the next player may be a bot too
    setTimeout(() => runAI(h), BOT_PACE_MS);
  };
  const step = () => {
    if (hosts.get(h.id) !== h) return botRunning.delete(h.id);
    try {
      if (!steps.next().done && stillOurs()) {
        setTimeout(step, BOT_PACE_MS);
        return;
      }
      // a turn the bot didn't end itself still ends
      if (bot && stillOurs()) rules.apply(seat, { c: "endturn" });
    } catch (e) {
      console.error("AI turn failed", h.id, e);
      try {
        if (bot && stillOurs()) rules.apply(seat, { c: "endturn" });
      } catch {
        /* nothing more to do */
      }
    }
    finish();
  };
  setTimeout(step, bot ? 800 : BOT_PACE_MS);
}

/** On startup: resume matches where the AI was in the middle of (or due) a turn, or stands in for people. */
export function resumeBots() {
  const rows = db.query(`SELECT m.id FROM matches m WHERE m.status = 'playing' AND (m.settings LIKE '%"afkAI":true%' OR
    EXISTS (SELECT 1 FROM match_players p WHERE p.match_id = m.id AND p.user_id LIKE 'bot:%'))`).all() as { id: string }[];
  for (const { id } of rows) {
    try {
      loadHost(id);
    } catch (e) {
      console.error("resuming bots failed", id, e);
    }
  }
}
