import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMatch } from "../tools/arena.ts";
import { files } from "../tools/gamefiles.ts";
import { serializeBattle, deserializeBattle } from "../shared/engine/serialize.ts";
import { defaultSettings } from "../shared/protocol.ts";
import { generatePool } from "../shared/rules/catalog.ts";
import { buildSquad } from "../shared/rules/squads.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { GameRules } from "../shared/engine/actions.ts";
import { AIPlayer } from "../shared/engine/ai.ts";
import { RNG } from "../shared/engine/rng.ts";
import { Phase } from "../shared/engine/state.ts";

test("battles record per-unit statistics that survive saving", () => {
  const s = { ...defaultSettings(), biome: "CULTA" as const, timeOfDay: "day" as const, ufo: "none" };
  const pool = generatePool(s, 21);
  const rng = new RNG(2);
  const players = ["elite", "swarm"].map((st, i) => ({ userId: "u" + i, name: "P" + i, loadout: buildSquad(st as never, s, pool, rng) }));
  const b = createBattle(s, players, pool, 21, files);
  const rules = new GameRules(b);
  const bots = [0, 1].map((p) => new AIPlayer(b, p));
  for (let t = 0; t < 16 && b.phase === Phase.PLAYING; t++) bots[b.current].playTurn(rules);
  const units = Object.values(b.stats.units);
  expect(units.reduce((a, u) => a + u.tilesMoved, 0)).toBeGreaterThan(0);
  expect(units.reduce((a, u) => a + u.tuSpent, 0)).toBeGreaterThan(0);
  expect(units.some((u) => Object.keys(u.shots).length > 0)).toBe(true);
  const b2 = deserializeBattle(serializeBattle(b), files);
  expect(b2.stats).toEqual(JSON.parse(JSON.stringify(b.stats)));
}, 120_000);

test("a bot match produces a full match record", () => {
  const r = runMatch({ seed: 3, strategies: ["elite", "swarm"], settings: { biome: "CULTA", timeOfDay: "day", ufo: "none" }, maxRounds: 40 });
  expect(r.players.length).toBe(2);
  expect(r.units.length).toBeGreaterThan(5);
  const dealt = r.units.reduce((a, u) => a + u.damage, 0);
  const taken = r.units.reduce((a, u) => a + u.stats.damageTaken, 0);
  expect(dealt).toBeGreaterThan(0);
  // what's dealt to enemies is part of what's taken (the rest is fire, friendly fire...)
  expect(taken).toBeGreaterThanOrEqual(dealt);
  for (const u of r.units) {
    expect(u.cost).toBeGreaterThanOrEqual(u.price);
    expect(["alive", "dead", "unconscious", "evacuated"]).toContain(u.outcome);
    if (!u.survived) expect(u.stats.downRound).toBeGreaterThan(0);
  }
  if (r.winner >= 0) expect(r.players[r.winner].won).toBe(true);
}, 180_000);

test("the server stores a record when a real match finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xcom-stats-"));
  process.env.DB_PATH = join(dir, "test.sqlite");
  process.env.ADMIN_EMAILS = "boss@example.com";
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  const mkUser = (id: string, email: string | null) => {
    db.query("INSERT INTO users (id, google_sub, email, name, picture, created) VALUES (?, NULL, ?, ?, NULL, ?)").run(id, email, id, Date.now());
    return db.query("SELECT * FROM users WHERE id = ?").get(id) as never;
  };
  const alice = mkUser("alice", "boss@example.com"), bob = mkUser("bob", null);
  const { id } = game.createMatch(alice, { budget: 200_000, biome: "CULTA", timeOfDay: "day" });
  expect(game.joinMatch(id, bob)).toBeNull();
  const lobby = game.lobbyState(id, alice)!;
  const pool = lobby.pool;
  for (const u of [alice, bob]) {
    const r = game.saveLoadout(id, u, buildSquad("swarm", lobby.settings, pool, new RNG(1)));
    expect(r.error).toBeUndefined();
    expect(game.setReady(id, u, true)).toBeNull();
  }
  expect(game.startMatch(id, alice)).toBeNull();
  // a socket stand-in for each player
  const sockets = [alice, bob].map((user) => ({ data: { user, matchId: id }, sent: [] as string[], send(m: string) { this.sent.push(m); }, close() {} }));
  for (const s of sockets) game.wsOpen(s as never);
  // Bob gives up
  game.wsMessage(sockets[1] as never, JSON.stringify({ t: "cmd", seq: 1, cmd: { c: "surrender" } }));
  // other test files may have stored records in the same database
  const recs = game.matchRecords().filter((r) => r.id === id);
  expect(recs.length).toBe(1);
  const rec = recs[0];
  expect(rec.source).toBe("human");
  expect(rec.players.map((p) => p.userId).sort()).toEqual(["alice", "bob"]);
  expect(rec.players.find((p) => p.userId === "alice")!.won).toBe(true);
  expect(rec.players.find((p) => p.userId === "bob")!.surrendered).toBe(true);
  expect(rec.units.filter((u) => u.outcome === "evacuated").length).toBeGreaterThan(0);
  // no duplicate when the finished match is published again
  game.wsMessage(sockets[0] as never, JSON.stringify({ t: "cmd", seq: 2, cmd: { c: "endturn" } }));
  expect(game.matchRecords().filter((r) => r.id === id).length).toBe(1);
}, 120_000);

test("an AI squad joins a lobby ready, and plays its turn on the server", async () => {
  // reuses the database the previous test opened
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  db.query("INSERT INTO users (id, google_sub, email, name, picture, created) VALUES ('carol', NULL, NULL, 'carol', NULL, ?)").run(Date.now());
  const carol = db.query("SELECT * FROM users WHERE id = 'carol'").get() as never;
  const { id } = game.createMatch(carol, { budget: 200_000, biome: "CULTA", timeOfDay: "day" });
  expect(game.addBot(id, carol, "swarm")).toBeNull();
  const lobby = game.lobbyState(id, carol)!;
  const bot = lobby.players.find((p) => p.bot)!;
  expect(bot.ready).toBe(true);
  expect(game.saveLoadout(id, carol, buildSquad("swarm", lobby.settings, lobby.pool, new RNG(4))).error).toBeUndefined();
  expect(game.setReady(id, carol, true)).toBeNull();
  expect(game.startMatch(id, carol)).toBeNull();
  const sock = { data: { user: carol, matchId: id }, sent: [] as string[], send(m: string) { this.sent.push(m); }, close() {} };
  game.wsOpen(sock as never);
  const turnOf = () => {
    const views = sock.sent.map((m) => JSON.parse(m)).filter((m) => m.view);
    return views.length ? views[views.length - 1].view.current : -1;
  };
  const humanSeat = JSON.parse(sock.sent.find((m) => JSON.parse(m).t === "view")!).view.you;
  // whoever goes first, the bot's turn must come and go on its own
  if (turnOf() === humanSeat) game.wsMessage(sock as never, JSON.stringify({ t: "cmd", seq: 1, cmd: { c: "endturn" } }));
  const t0 = Date.now();
  let sawBot = false;
  while (Date.now() - t0 < 90_000) {
    await Bun.sleep(500);
    const cur = turnOf();
    if (cur >= 0 && cur !== humanSeat) sawBot = true;
    if (sawBot && cur === humanSeat) break;
  }
  expect(sawBot).toBe(true);
  expect(turnOf()).toBe(humanSeat);
  expect(game.removeBot(id, carol, bot.botId!)).toBe("The match has already started");
}, 120_000);
