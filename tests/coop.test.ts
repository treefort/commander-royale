import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files } from "../tools/gamefiles.ts";
import { defaultSettings, sanitizeSettings, sanitizeBotTuning, DEFAULT_BOT_TUNING } from "../shared/protocol.ts";
import { generatePool } from "../shared/rules/catalog.ts";
import { buildSquad } from "../shared/rules/squads.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { GameRules } from "../shared/engine/actions.ts";
import { AIPlayer, aiOptionsFor, DEFAULT_AI } from "../shared/engine/ai.ts";
import { RNG } from "../shared/engine/rng.ts";
import { isOut, Phase } from "../shared/engine/state.ts";
import { controllerOf, mayCommand, waitingFor, playedByAI, seatOfUser, dealUnits } from "../shared/engine/coop.ts";
import { serializeBattle, deserializeBattle } from "../shared/engine/serialize.ts";
import type { UserRow } from "../server/db.ts";

test("co-op settings and AI tuning are sanitized", () => {
  const d = defaultSettings();
  expect(d.coop).toEqual({ squadSize: 1, turnEnd: "lockin", dailyAt: "20:00", timeZone: "UTC", afkAI: false });
  expect(sanitizeSettings({ coop: { ...d.coop, squadSize: 50, turnEnd: "timer", afkAI: true } }).coop).toMatchObject({ squadSize: 10, turnEnd: "lockin", afkAI: true });
  // ending on the timer needs one
  expect(sanitizeSettings({ turnTimer: 90, coop: { ...d.coop, squadSize: 3, turnEnd: "timer" } }).coop.turnEnd).toBe("timer");
  // settings saved before co-op existed
  expect(sanitizeSettings({ name: "old" }).coop.squadSize).toBe(1);
  expect(sanitizeBotTuning({ aggression: 9, strength: 10, intelligence: "x" })).toEqual({ ...DEFAULT_BOT_TUNING, aggression: 3, strength: 25 });
  expect(aiOptionsFor(undefined)).toBe(DEFAULT_AI);
  expect(aiOptionsFor({ ...DEFAULT_BOT_TUNING, aggression: 0, cheatTurn: 5 })).toMatchObject({ aggression: 0, cheatTurn: 5, grenadeTurn: DEFAULT_AI.grenadeTurn });
});

test("units are dealt out evenly, honouring the leader's picks", () => {
  const units = Array.from({ length: 7 }, (_, i) => ({ id: i } as never as import("../shared/engine/state.ts").Unit));
  dealUnits(units, ["a", "b", "c"], ["c", undefined, "c", undefined, "zz", undefined, undefined]);
  const count = (m: string) => units.filter((u) => u.controller === m).length;
  expect(units[0].controller).toBe("c");
  expect(units[2].controller).toBe("c");
  expect([count("a"), count("b"), count("c")].sort()).toEqual([2, 2, 3]);
  expect(units.every((u) => ["a", "b", "c"].includes(u.controller!))).toBe(true);
});

function coopBattle(seed = 31) {
  const s = { ...defaultSettings(), biome: "CULTA" as const, timeOfDay: "day" as const, ufo: "none", budget: 300_000 };
  const pool = generatePool(s, seed);
  const rng = new RNG(seed);
  const team = buildSquad("swarm", s, pool, rng);
  team.squad[0].controller = "dave";
  const players = [
    { userId: "alice", name: "Alice", loadout: team, members: [{ userId: "alice", name: "Alice" }, { userId: "dave", name: "Dave" }] },
    { userId: "bot:elite:x", name: "Bot", loadout: buildSquad("elite", s, pool, rng), ai: { ...DEFAULT_BOT_TUNING, aggression: 2 } },
  ];
  return { b: createBattle(s, players, pool, seed, files), team };
}

test("a co-op squad shares out its units, and only the controller may give them orders", () => {
  const { b, team } = coopBattle();
  expect(b.players[0].members!.map((m) => m.userId)).toEqual(["alice", "dave"]);
  expect(b.players[1].members).toBeUndefined();
  expect(b.players[1].ai!.aggression).toBe(2);
  expect(seatOfUser(b, "dave")).toBe(0);
  const mine = b.units.filter((u) => u.owner === 0);
  const first = mine.find((u) => u.recruitId === team.squad[0].recruitId)!;
  expect(first.controller).toBe("dave");
  const byAlice = mine.filter((u) => controllerOf(b, u) === "alice");
  const byDave = mine.filter((u) => controllerOf(b, u) === "dave");
  expect(byAlice.length + byDave.length).toBe(mine.length);
  expect(Math.abs(byAlice.length - byDave.length)).toBeLessThanOrEqual(1);
  expect(mayCommand(b, "dave", first)).toBeNull();
  expect(mayCommand(b, "alice", first)).toBe("STR_TEAMMATES_UNIT");
  expect(mayCommand(b, "eve", first)).toBe("STR_INVALID_UNIT");
  // both have to lock in; an AFK member is never waited for, and the AI plays their units
  expect(waitingFor(b, 0).map((m) => m.userId).sort()).toEqual(["alice", "dave"]);
  b.players[0].members![0].locked = true;
  expect(waitingFor(b, 0).map((m) => m.userId)).toEqual(["dave"]);
  b.players[0].members![1].afk = true;
  expect(waitingFor(b, 0)).toEqual([]);
  expect(playedByAI(b, first)).toBe(true);
  expect(mayCommand(b, "dave", first)).toBeNull();
  expect(mayCommand(b, "alice", first)).toBe("STR_UNIT_PLAYED_BY_AI");
  expect(byAlice.some((u) => playedByAI(b, u))).toBe(false);
  // all of it survives saving
  const b2 = deserializeBattle(serializeBattle(b), files);
  expect(b2.players[0].members).toEqual(b.players[0].members);
  expect(b2.units.find((u) => u.id === first.id)!.controller).toBe("dave");
});

test("the AI can stand in for some of a squad's units without ending its turn", () => {
  const { b } = coopBattle(32);
  const rules = new GameRules(b);
  // make it the co-op squad's turn
  if (b.current !== 0) rules.apply(b.current, { c: "endturn" });
  expect(b.current).toBe(0);
  const round = b.round;
  b.players[0].members![1].afk = true;
  const before = new Map(b.units.map((u) => [u.id, u.tu]));
  const ai = new AIPlayer(b, 0);
  for (const _ of ai.turnSteps(rules, (u) => playedByAI(b, u)));
  expect(b.current).toBe(0);
  expect(b.round).toBe(round);
  const acted = b.units.filter((u) => u.owner === 0 && u.tu !== before.get(u.id));
  expect(acted.length).toBeGreaterThan(0);
  for (const u of acted) if (!isOut(u)) expect(controllerOf(b, u)).toBe("dave");
  // locks are cleared when the squad's next turn begins
  b.players[0].members![0].locked = true;
  rules.apply(0, { c: "endturn" });
  for (let k = 0; k < 4 && b.current !== 0 && b.phase === Phase.PLAYING; k++) rules.apply(b.current, { c: "endturn" });
  expect(b.players[0].members![0].locked).toBe(false);
}, 60_000);

test("co-op on the server: joining a squad, lock-ins, AFK and AI tuning", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-coop-")), "test.sqlite");
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  const mkUser = (id: string) => {
    db.query("INSERT OR IGNORE INTO users (id, google_sub, email, name, picture, created) VALUES (?, NULL, NULL, ?, NULL, ?)").run(id, id, Date.now());
    return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  };
  const [ann, ben, dot, eli] = ["co_ann", "co_ben", "co_dot", "co_eli"].map(mkUser);
  const { id } = game.createMatch(ann, { budget: 200_000, biome: "CULTA", timeOfDay: "day", maxPlayers: 2, coop: { ...defaultSettings().coop, squadSize: 2 } });
  expect(game.joinMatch(id, ben)).toBeNull();
  // every squad slot is taken: Dot joins the first squad with room
  expect(game.joinMatch(id, dot)).toBeNull();
  expect(game.joinMatch(id, eli, ann.id)).toBe("That squad is full");
  let lobby = game.lobbyState(id, dot)!;
  expect(lobby.players.find((p) => p.userId === dot.id)!.squadOf).toBe(ann.id);
  expect(lobby.you!.leaderName).toBe(ann.id);
  expect(game.setReady(id, dot, true)).toBe("Your squad leader readies the squad");
  expect(game.updateSettings(id, ann, { ...lobby.settings, coop: { ...lobby.settings.coop, squadSize: 1 } })).toContain("split up");
  const loadout = buildSquad("swarm", lobby.settings, lobby.pool, new RNG(5));
  loadout.squad[0].controller = dot.id;
  expect(game.saveLoadout(id, dot, loadout).error).toBe("Your squad leader hires and equips the squad");
  for (const u of [ann, ben]) {
    expect(game.saveLoadout(id, u, u === ann ? loadout : buildSquad("swarm", lobby.settings, lobby.pool, new RNG(6))).error).toBeUndefined();
    expect(game.setReady(id, u, true)).toBeNull();
  }
  lobby = game.lobbyState(id, dot)!;
  expect(lobby.you!.loadout!.squad[0].controller).toBe(dot.id);
  expect(game.startMatch(id, ann)).toBeNull();
  const sockets = [ann, ben, dot].map((user) => ({ data: { user, matchId: id }, sent: [] as string[], send(m: string) { this.sent.push(m); }, close() {} }));
  for (const s of sockets) game.wsOpen(s as never);
  const [sa, sb, sd] = sockets;
  const msgs = (s: typeof sa) => s.sent.map((m) => JSON.parse(m));
  const lastView = (s: typeof sa) => msgs(s).filter((m) => m.view).at(-1)!.view;
  const result = (s: typeof sa, seq: number) => msgs(s).find((m) => m.t === "result" && m.seq === seq);
  const send = (s: typeof sa, msg: object) => game.wsMessage(s as never, JSON.stringify(msg));
  const annSeat = lastView(sa).you;
  expect(lastView(sd).you).toBe(annSeat);
  if (lastView(sa).current !== annSeat) send(sb, { t: "cmd", seq: 1, cmd: { c: "endturn" } });
  expect(lastView(sa).current).toBe(annSeat);
  // Dot's unit is Dot's: Ann can't move it
  const view = lastView(sd);
  const dots = view.units.filter((u: { mine: boolean; controller?: string }) => u.mine && u.controller === dot.id);
  const anns = view.units.filter((u: { mine: boolean; controller?: string }) => u.mine && u.controller === ann.id);
  expect(dots.length).toBeGreaterThan(0);
  expect(anns.length).toBeGreaterThan(0);
  send(sa, { t: "cmd", seq: 10, cmd: { c: "kneel", unit: dots[0].id } });
  expect(result(sa, 10)).toMatchObject({ ok: false, error: "STR_TEAMMATES_UNIT", noUpdate: true });
  send(sd, { t: "cmd", seq: 11, cmd: { c: "kneel", unit: dots[0].id } });
  expect(result(sd, 11).ok).toBe(true);
  // the updates say who acted, so each client only waits for its own
  expect(msgs(sa).filter((m) => m.t === "update").at(-1).by).toBe(dot.id);
  // the turn ends once both have locked in; ending again unlocks
  send(sa, { t: "cmd", seq: 12, cmd: { c: "endturn" } });
  expect(result(sa, 12).private.locked).toBe(true);
  expect(lastView(sa).current).toBe(annSeat);
  send(sa, { t: "cmd", seq: 13, cmd: { c: "endturn" } });
  expect(result(sa, 13).private.locked).toBe(false);
  send(sa, { t: "cmd", seq: 14, cmd: { c: "endturn" } });
  // only the leader may surrender for everyone
  send(sd, { t: "cmd", seq: 15, cmd: { c: "surrender" } });
  expect(result(sd, 15).error).toBe("STR_ONLY_LEADER_SURRENDERS");
  send(sd, { t: "cmd", seq: 16, cmd: { c: "endturn" } });
  expect(lastView(sa).current).not.toBe(annSeat);
  // the match list says whose turn it is per person
  send(sb, { t: "cmd", seq: 2, cmd: { c: "endturn" } });
  expect(lastView(sa).current).toBe(annSeat);
  expect(lastView(sa).players[annSeat].members.every((m: { locked: boolean }) => !m.locked)).toBe(true);
  expect(game.listMatches(dot).find((m) => m.id === id)!.yourTurn).toBe(true);
  // Dot goes AFK: the AI plays Dot's units, and once Ann locks in the turn ends by itself
  send(sd, { t: "afk", seq: 20, on: true });
  expect(result(sd, 20).ok).toBe(true);
  send(sa, { t: "cmd", seq: 21, cmd: { c: "endturn" } });
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && lastView(sa).current === annSeat && lastView(sa).phase === Phase.PLAYING) await Bun.sleep(200);
  expect(lastView(sa).current === annSeat && lastView(sa).phase === Phase.PLAYING).toBe(false);
  expect(msgs(sa).some((m) => m.t === "update" && m.by === "" && m.events.length)).toBe(true);
}, 120_000);

test("computer squads take AI settings, and their strength scales what they hire", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-coop-")), "test.sqlite");
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  db.query("INSERT OR IGNORE INTO users (id, google_sub, email, name, picture, created) VALUES ('co_fay', NULL, NULL, 'co_fay', NULL, ?)").run(Date.now());
  const fay = db.query("SELECT * FROM users WHERE id = 'co_fay'").get() as never;
  const { id } = game.createMatch(fay, { budget: 150_000, biome: "CULTA", timeOfDay: "day" });
  expect(game.addBot(id, fay, "swarm", { aggression: 3, strength: 100 })).toBeNull();
  let bot = game.lobbyState(id, fay)!.players.find((p) => p.bot)!;
  expect(bot.ai!.aggression).toBe(3);
  const seatsOf = () => {
    const row = db.query("SELECT loadout FROM match_players WHERE match_id = ? AND user_id = ?").get(id, bot.botId!) as { loadout: string };
    return JSON.parse(row.loadout).squad.length as number;
  };
  const before = seatsOf();
  expect(game.tuneBot(id, fay, bot.botId!, { ...bot.ai, strength: 300 })).toBeNull();
  bot = game.lobbyState(id, fay)!.players.find((p) => p.bot)!;
  expect(bot.ai!.strength).toBe(300);
  expect(bot.ready).toBe(true);
  expect(seatsOf()).toBeGreaterThan(before);
  expect(game.joinMatch(id, fay, bot.botId!)).toBe("Computer squads don't take teammates");
});
