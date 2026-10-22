import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files } from "../tools/gamefiles.ts";
import { defaultSettings, sanitizeSettings, nextDailyDeadline, DAILY_MIN_TURN_MS, type MatchSettings } from "../shared/protocol.ts";
import { generatePool, checkLoadout } from "../shared/rules/catalog.ts";
import { buildSquad } from "../shared/rules/squads.ts";
import { buildEnemyForce, forceSummary, enemyTypeChoices } from "../shared/rules/scenario.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { GameRules } from "../shared/engine/actions.ts";
import { extractView, newSentState } from "../shared/engine/view.ts";
import { mayCommand, waitingFor, isShared } from "../shared/engine/coop.ts";
import { serializeBattle, deserializeBattle } from "../shared/engine/serialize.ts";
import { isOut, Phase } from "../shared/engine/state.ts";
import { RNG } from "../shared/engine/rng.ts";
import type { UserRow } from "../server/db.ts";

function scenarioSettings(extra: Partial<MatchSettings["scenario"]> = {}): MatchSettings {
  const d = defaultSettings();
  return sanitizeSettings({
    ...d, mode: "coop", biome: "CULTA", timeOfDay: "day", ufo: "STR_SMALL_SCOUT", mapBlocks: 5, budget: 150_000,
    scenario: {
      ...d.scenario, seatsPerPlayer: 2, ...extra,
      enemies: extra.enemies ?? [
        { type: "STR_SECTOID_SOLDIER", count: 3, weapon: "standard", grenades: 1, armor: "STR_NONE_UC", placement: "ufo", round: 1 },
        { type: "SOLDIER:3", count: 2, weapon: "STR_LASER_RIFLE", grenades: 0, armor: "STR_PERSONAL_ARMOR_UC", placement: "spread", round: 1 },
        { type: "STR_CHRYSSALID_TERRORIST", count: 2, weapon: "none", grenades: 0, armor: "STR_NONE_UC", placement: "edge", round: 3 },
      ],
    },
  });
}

test("daily turn ends land on the right wall-clock time, a decent while ahead", () => {
  const now = Date.UTC(2026, 9, 22, 12, 0);
  expect(new Date(nextDailyDeadline(now, "20:00", "UTC")).toISOString()).toBe("2026-10-22T20:00:00.000Z");
  // New York, daylight saving time (UTC-4)
  expect(new Date(nextDailyDeadline(now, "20:00", "America/New_York")).toISOString()).toBe("2026-10-23T00:00:00.000Z");
  // across the switch back to standard time (UTC-5)
  expect(new Date(nextDailyDeadline(Date.UTC(2026, 10, 1, 0, 30), "20:00", "America/New_York")).toISOString()).toBe("2026-11-02T01:00:00.000Z");
  // too close to today's time: tomorrow's
  const t = nextDailyDeadline(Date.UTC(2026, 9, 22, 19, 30), "20:00", "UTC");
  expect(new Date(t).toISOString()).toBe("2026-10-23T20:00:00.000Z");
  expect(t - Date.UTC(2026, 9, 22, 19, 30)).toBeGreaterThan(DAILY_MIN_TURN_MS);
  // only scenarios end turns daily
  expect(sanitizeSettings({ coop: { ...defaultSettings().coop, turnEnd: "daily" } }).coop.turnEnd).toBe("lockin");
  expect(sanitizeSettings({ mode: "coop", coop: { ...defaultSettings().coop, turnEnd: "daily", timeZone: "Not/AZone" } }).coop).toMatchObject({ turnEnd: "daily", timeZone: "UTC" });
});

test("the game master's enemy force: types, numbers, weapons and reinforcement waves", () => {
  const s = scenarioSettings();
  expect(enemyTypeChoices().some((t) => t.id === "STR_SECTOPOD_TERRORIST")).toBe(true);
  const f = buildEnemyForce(s, 7);
  expect(f.recruits.length).toBe(7);
  expect(f.initial.length).toBe(5);
  expect(f.waves).toEqual([{ round: 3, members: expect.any(Array) }]);
  expect(f.waves[0].members.length).toBe(2);
  // standard plasma for alien tech, the chosen laser rifle and armor for the human soldiers, a grenade each
  const sectoid = f.initial.find((m) => f.recruits.find((r) => r.id === m.recruitId)!.type === "STR_SECTOID_SOLDIER")!;
  expect(sectoid.items.map((i) => i.type)).toContain("STR_PLASMA_RIFLE");
  expect(sectoid.items.map((i) => i.type)).toContain("STR_ALIEN_GRENADE");
  expect(sectoid.deploy).toBe("ufo");
  const soldier = f.initial.find((m) => f.recruits.find((r) => r.id === m.recruitId)!.kind === "soldier")!;
  expect(soldier.items[0].type).toBe("STR_LASER_RIFLE");
  expect(soldier.armor).toBe("STR_PERSONAL_ARMOR_UC");
  // deterministic for the match seed (the server rebuilds it for the match record)
  expect(buildEnemyForce(s, 7)).toEqual(f);
  expect(forceSummary(s)[2]).toContain("round 3");
  // players are limited by units, not seats
  const pool = generatePool(s, 3);
  const l = buildSquad("swarm", { ...s, mode: "ffa" }, pool, new RNG(1));
  expect(checkLoadout(s, pool, l).errors.join()).toContain("limit is 2 each");
  expect(checkLoadout(s, pool, { ...l, squad: l.squad.slice(0, 2) }).errors).toEqual([]);
});

function scenarioBattle(seed = 11) {
  const s = scenarioSettings();
  const pool = generatePool(s, seed);
  const force = buildEnemyForce(s, seed);
  const rng = new RNG(seed);
  // two each for Ann and Ben (in the lobby each hires from their own copy of the pool; here ids must be unique)
  const hires = buildSquad("swarm", { ...s, mode: "ffa" }, pool, rng).squad;
  const team = hires.slice(0, 4).map((m, i) => ({ ...m, controller: i < 2 ? "ann" : "ben" }));
  const b = createBattle(s, [
    { userId: "gm", name: "X-COM", loadout: { squad: team, stash: [] }, members: [{ userId: "gm", name: "GM", observer: true }, { userId: "ann", name: "Ann" }, { userId: "ben", name: "Ben" }] },
    { userId: "bot:scenario:t", name: "Aliens", loadout: { squad: force.initial, stash: [] }, ai: s.scenario.ai, waves: force.waves },
  ], [...pool, ...force.recruits], seed, files);
  return { b, s, team };
}

test("a scenario battle: one team against the game master's enemies, placed as set up, with reinforcements", () => {
  const { b, team } = scenarioBattle();
  expect(b.current).toBe(0); // the team moves first
  const mine = b.units.filter((u) => u.owner === 0);
  const theirs = b.units.filter((u) => u.owner === 1);
  expect(mine.length).toBe(team.length);
  expect(theirs.length).toBe(5);
  expect(mine.every((u) => u.controller === "ann" || u.controller === "ben")).toBe(true);
  // the watching game master commands nothing and is never waited for
  expect(isShared(b.players[0])).toBe(true);
  expect(mayCommand(b, "gm", mine[0])).toBe("STR_GAME_MASTER_WATCHES");
  expect(waitingFor(b, 0).map((m) => m.userId).sort()).toEqual(["ann", "ben"]);
  // the sectoids start in and around the UFO
  const a = b.ufoArea!;
  expect(a).not.toBeNull();
  const sectoids = theirs.filter((u) => u.type === "STR_SECTOID_SOLDIER");
  for (const u of sectoids) expect(Math.max(Math.abs(u.pos.x - (a.x + a.w / 2)), Math.abs(u.pos.y - (a.y + a.h / 2)))).toBeLessThan(a.w / 2 + 14);
  // the game master sees every enemy; the team only what it has spotted
  const gmView = extractView(b, 0, newSentState(), true, true);
  const teamView = extractView(b, 0, newSentState(), true);
  expect(gmView.units.filter((u) => !u.mine).length).toBe(5);
  expect(teamView.units.filter((u) => !u.mine).length).toBeLessThan(5);
  expect(gmView.tiles.length).toBeGreaterThan(teamView.tiles.length);
  // reinforcements land in round 3, and survive saving until then
  const rules = new GameRules(b);
  const round = () => {
    for (let k = 0; k < 2 && b.phase === Phase.PLAYING; k++) rules.apply(b.current, { c: "endturn" });
  };
  round();
  expect(b.round).toBe(2);
  expect(b.units.filter((u) => u.owner === 1).length).toBe(5);
  const b2 = deserializeBattle(serializeBattle(b), files);
  expect(b2.waves.length).toBe(1);
  expect(b2.ufoArea).toEqual(b.ufoArea);
  round();
  expect(b.round).toBe(3);
  expect(b.waves.length).toBe(0);
  expect(b.units.filter((u) => u.owner === 1 && u.type === "STR_CHRYSSALID_TERRORIST").length).toBe(2);
});

test("the enemy isn't beaten while reinforcements are still coming", () => {
  const { b } = scenarioBattle(12);
  const rules = new GameRules(b);
  // every enemy on the map drops dead
  for (const u of b.units.filter((x) => x.owner === 1)) {
    u.health = 0;
    u.status = 6 as never; // DEAD
    b.clearUnitTiles(u);
  }
  rules.apply(0, { c: "endturn" });
  expect(b.phase).toBe(Phase.PLAYING);
  expect(b.players[1].eliminated).toBe(false);
  expect(b.units.filter((u) => u.owner === 1 && !isOut(u)).length).toBe(0);
  // with no waves left, it is
  b.waves = [];
  rules.apply(b.current, { c: "endturn" });
  expect(b.phase).toBe(Phase.FINISHED);
  expect(b.winner).toBe(0);
});

test("each person fills Skyranger seats (a tank takes 4), and older settings carry over", () => {
  const s = scenarioSettings({ seatsPerPlayer: 4 });
  expect(sanitizeSettings({ mode: "coop", scenario: { unitsPerPlayer: 6 } as never }).scenario.seatsPerPlayer).toBe(6);
  const pool = generatePool({ ...s, allowHWP: true }, 5);
  const tank = pool.find((r) => r.kind === "hwp")!;
  const soldiers = pool.filter((r) => r.kind === "soldier");
  const hire = (rs: typeof pool) => ({ squad: rs.map((r) => ({ recruitId: r.id, armor: "STR_NONE_UC", items: [] })), stash: [] });
  expect(checkLoadout(s, pool, hire([tank])).errors).toEqual([]);
  expect(checkLoadout(s, pool, hire(soldiers.slice(0, 4))).errors).toEqual([]);
  expect(checkLoadout(s, pool, hire([tank, soldiers[0]])).errors.join()).toContain("Squad needs 5 seats, limit is 4 each");
});

test("a team landing apart: each person's units come down in their own zone", () => {
  const s = scenarioSettings({ teamStart: "apart" });
  const pool = generatePool(s, 21);
  const force = buildEnemyForce(s, 21);
  const hires = buildSquad("swarm", { ...s, mode: "ffa" }, pool, new RNG(4)).squad;
  const team = hires.slice(0, 6).map((m, i) => ({ ...m, controller: ["ann", "ben", "cat"][i % 3], zone: i % 3 }));
  const b = createBattle(s, [
    { userId: "ann", name: "X-COM", loadout: { squad: team, stash: [] }, members: ["ann", "ben", "cat"].map((u) => ({ userId: u, name: u })), landings: 3, zoneStash: [["STR_MEDI_KIT"], [], []] },
    { userId: "bot:scenario:t", name: "Aliens", loadout: { squad: force.initial, stash: [] }, ai: s.scenario.ai, waves: force.waves },
  ], [...pool, ...force.recruits], 21, files);
  expect(b.landingZones.map((z) => z.seat)).toEqual([0, 0, 0, 1]);
  expect(b.zones[1]).toEqual({ x: b.landingZones[3].x, y: b.landingZones[3].y, w: b.landingZones[3].w, h: b.landingZones[3].h });
  const centre = (k: number) => ({ x: b.landingZones[k].x + 5, y: b.landingZones[k].y + 5 });
  const near = (p: { x: number; y: number }, k: number) => Math.max(Math.abs(p.x - centre(k).x), Math.abs(p.y - centre(k).y));
  ["ann", "ben", "cat"].forEach((who, k) => {
    const units = b.units.filter((u) => u.owner === 0 && u.controller === who);
    expect(units.length).toBe(2);
    // closest to their own zone
    for (const u of units) for (let j = 0; j < 4; j++) if (j !== k) expect(near(u.pos, k)).toBeLessThan(near(u.pos, j));
  });
  // Ann's spare medikit is in Ann's zone
  const kit = b.items.find((it) => it.type === "STR_MEDI_KIT" && it.tile >= 0)!;
  expect(near(b.posOf(kit.tile), 0)).toBeLessThan(near(b.posOf(kit.tile), 1));
  // the landing zones survive saving
  expect(deserializeBattle(serializeBattle(b), files).landingZones).toEqual(b.landingZones);
});

test("a co-op scenario on the server: game master, team, lock-ins and the GM's view", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-scn-")), "test.sqlite");
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  const mkUser = (id: string) => {
    db.query("INSERT OR IGNORE INTO users (id, google_sub, email, name, picture, created) VALUES (?, NULL, NULL, ?, NULL, ?)").run(id, id, Date.now());
    return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  };
  const [gm, ann, ben, cat] = ["sc_gm", "sc_ann", "sc_ben", "sc_cat"].map(mkUser);
  const settings = scenarioSettings({ gmPlays: false });
  const { id } = game.createMatch(gm, settings);
  expect(game.joinMatch(id, ann)).toBeNull();
  expect(game.joinMatch(id, ben)).toBeNull();
  // no head count: Cat joins too, but isn't ready when the battle starts
  expect(game.joinMatch(id, cat)).toBeNull();
  expect(game.addBot(id, gm, "swarm")).toContain("scenario");
  let lobby = game.lobbyState(id, gm)!;
  expect(lobby.gameMaster).toBe(true);
  expect(game.setReady(id, gm, true)).toContain("game master");
  expect(game.startMatch(id, gm)).toBe("Nobody on the team is ready yet");
  for (const [u, seed] of [[ann, 1], [ben, 2]] as const) {
    const full = buildSquad("swarm", { ...lobby.settings, mode: "ffa" }, lobby.pool, new RNG(seed));
    expect(game.saveLoadout(id, u, full).check!.ok).toBe(false); // more than 2 units
    expect(game.saveLoadout(id, u, { squad: full.squad.slice(0, 2), stash: [] }).check!.ok).toBe(true);
    expect(game.setReady(id, u, true)).toBeNull();
  }
  lobby = game.lobbyState(id, gm)!;
  expect(game.startMatch(id, gm)).toBeNull();
  // the map was sized for who was there (auto unless set: here the test settings chose 5)
  expect(game.lobbyState(id, cat)!.battle!.sides.length).toBe(2);
  expect(game.lobbyState(id, cat)!.you!.deployed).toBe(false);
  const sockets = [gm, ann, ben].map((user) => ({ data: { user, matchId: id }, sent: [] as string[], send(m: string) { this.sent.push(m); }, close() {} }));
  for (const s of sockets) game.wsOpen(s as never);
  const [sg, sa, sb] = sockets;
  const msgs = (s: typeof sa) => s.sent.map((m) => JSON.parse(m));
  const lastView = (s: typeof sa) => msgs(s).filter((m) => m.view).at(-1)!.view;
  const result = (s: typeof sa, seq: number) => msgs(s).find((m) => m.t === "result" && m.seq === seq);
  const send = (s: typeof sa, msg: object) => game.wsMessage(s as never, JSON.stringify(msg));
  const v = lastView(sa);
  expect(v.players.length).toBe(2);
  expect(v.players[0].name).toBe("X-COM");
  expect(v.current).toBe(0);
  expect(lastView(sg).you).toBe(0);
  // the game master sees the whole enemy force; the team doesn't (yet)
  const enemies = (view: { units: { mine: boolean; status?: number }[] }) => view.units.filter((u) => !u.mine && u.status !== 8).length;
  expect(enemies(lastView(sg))).toBe(5);
  expect(enemies(lastView(sa))).toBeLessThan(5);
  // and can't give orders or lock in
  const annUnit = v.units.find((u: { mine: boolean; controller?: string }) => u.mine && u.controller === ann.id);
  send(sg, { t: "cmd", seq: 1, cmd: { c: "kneel", unit: annUnit.id } });
  expect(result(sg, 1).error).toBe("STR_GAME_MASTER_WATCHES");
  send(sg, { t: "cmd", seq: 2, cmd: { c: "endturn" } });
  expect(result(sg, 2).error).toBe("STR_GAME_MASTER_WATCHES");
  // teammates both get the same update (each side's diff is shared by everyone on it)
  send(sa, { t: "cmd", seq: 3, cmd: { c: "kneel", unit: annUnit.id } });
  expect(result(sa, 3).ok).toBe(true);
  expect(sb.sent.at(-1)).toBe(sa.sent.at(-1));
  expect(JSON.parse(sg.sent.at(-1)!).by).toBe(ann.id);
  // lock-ins end the team's turn; the enemy AI then plays and hands it back
  send(sa, { t: "cmd", seq: 4, cmd: { c: "endturn" } });
  expect(lastView(sa).current).toBe(0);
  send(sb, { t: "cmd", seq: 5, cmd: { c: "endturn" } });
  expect(lastView(sa).current).toBe(1);
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000 && lastView(sa).current !== 0 && lastView(sa).phase === Phase.PLAYING) await Bun.sleep(200);
  expect(lastView(sa).round).toBe(2);
  expect(game.listMatches(ann).find((m) => m.id === id)!.yourTurn).toBe(true);
  expect(game.listMatches(gm).find((m) => m.id === id)!.yourTurn).toBe(false);
  // Cat gets ready late: their units land with the team, theirs to command, and the team waits for them now
  const catKit = buildSquad("swarm", { ...lobby.settings, mode: "ffa" }, lobby.pool, new RNG(9));
  expect(game.saveLoadout(id, cat, { squad: catKit.squad.slice(0, 2), stash: [] }).check!.ok).toBe(true);
  expect(game.setReady(id, cat, true)).toBeNull();
  expect(game.lobbyState(id, cat)!.you!.deployed).toBe(true);
  expect(game.setReady(id, cat, true)).toBe("Your squad is already in the battle");
  const mine = lastView(sa).units.filter((u: { mine: boolean; status?: number }) => u.mine && u.status !== 8);
  expect(mine.filter((u: { controller?: string }) => u.controller === cat.id).length).toBe(2);
  expect(lastView(sa).players[0].members.map((m: { userId: string }) => m.userId)).toContain(cat.id);
  const sc = { data: { user: cat, matchId: id }, sent: [] as string[], send(m: string) { this.sent.push(m); }, close() {} };
  game.wsOpen(sc as never);
  expect(lastView(sc).you).toBe(0);
  // the game master can call it off
  send(sg, { t: "cmd", seq: 6, cmd: { c: "surrender" } });
  expect(lastView(sa).phase).toBe(Phase.FINISHED);
  expect(lastView(sa).winner).toBe(1);
  const rec = game.matchRecords().find((r) => r.id === id)!;
  expect(rec.units.filter((u) => u.player === 0).length).toBe(6);
  expect(rec.units.filter((u) => u.player === 1).length).toBeGreaterThanOrEqual(5);
}, 120_000);

test("a daily turn end sets the team's deadline to the next daily time", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-scn-")), "test.sqlite");
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  db.query("INSERT OR IGNORE INTO users (id, google_sub, email, name, picture, created) VALUES ('sc_dee', NULL, NULL, 'sc_dee', NULL, ?)").run(Date.now());
  const dee = db.query("SELECT * FROM users WHERE id = 'sc_dee'").get() as UserRow;
  const s = scenarioSettings({ gmPlays: true });
  s.coop = { ...s.coop, turnEnd: "daily", dailyAt: "06:15", timeZone: "Asia/Tokyo" };
  const { id } = game.createMatch(dee, s);
  const lobby = game.lobbyState(id, dee)!;
  expect(lobby.settings.coop.turnEnd).toBe("daily");
  const full = buildSquad("swarm", { ...lobby.settings, mode: "ffa" }, lobby.pool, new RNG(3));
  game.saveLoadout(id, dee, { squad: full.squad.slice(0, 2), stash: [] });
  expect(game.setReady(id, dee, true)).toBeNull();
  const before = Date.now();
  expect(game.startMatch(id, dee)).toBeNull();
  const row = db.query("SELECT turn_deadline FROM matches WHERE id = ?").get(id) as { turn_deadline: number };
  expect(row.turn_deadline).toBe(nextDailyDeadline(before, "06:15", "Asia/Tokyo"));
  expect(new Date(row.turn_deadline).toISOString().slice(11, 16)).toBe("21:15"); // 06:15 in Tokyo
});
