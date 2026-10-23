import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files } from "../tools/gamefiles.ts";
import { defaultSettings } from "../shared/protocol.ts";
import { generatePool } from "../shared/rules/catalog.ts";
import { buildSquad } from "../shared/rules/squads.ts";
import { createBattle, replayBattle } from "../shared/engine/setup.ts";
import { RNG } from "../shared/engine/rng.ts";
import { type Battle, Phase } from "../shared/engine/state.ts";
import { seatOfUser } from "../shared/engine/coop.ts";
import { serializeBattle, deserializeBattle } from "../shared/engine/serialize.ts";
import type { UserRow } from "../server/db.ts";

const where = (b: Battle, seat: number) => b.units.filter((u) => u.originalOwner === seat).map((u) => [u.name, u.type, u.armor, u.pos.x, u.pos.y, u.pos.z]);

test("a battle's start played again by one person: their side, everyone else the AI, new dice", () => {
  const s = { ...defaultSettings(), biome: "CULTA" as const, timeOfDay: "day" as const, ufo: "none", budget: 200_000 };
  const pool = generatePool(s, 5);
  const rng = new RNG(5);
  const b = createBattle(s, [
    { userId: "ann", name: "Ann", loadout: buildSquad("balanced", s, pool, rng), members: [{ userId: "ann", name: "Ann" }, { userId: "amy", name: "Amy" }] },
    { userId: "ben", name: "Ben", loadout: buildSquad("balanced", s, pool, rng), members: [{ userId: "ben", name: "Ben" }] },
    { userId: "bot:swarm:x", name: "AI 1", loadout: buildSquad("swarm", s, pool, rng), ai: { ...defaultSettings().scenario.ai, aggression: 3 } },
  ], pool, 5, files);
  const start = serializeBattle(b);
  const again = replayBattle(deserializeBattle(start, files), 1, { userId: "zed", name: "Zed" }, 99);
  expect(again.players[1]).toMatchObject({ userId: "zed", name: "Zed", members: [{ userId: "zed", name: "Zed" }] });
  // Ann and Amy's squad is the AI's now; the computer squad keeps its own settings
  expect(again.players[0].userId.startsWith("bot:")).toBe(true);
  expect(again.players[0].members).toBeUndefined();
  expect(again.players[2]).toMatchObject({ userId: "bot:swarm:x", ai: { aggression: 3 } });
  expect(seatOfUser(again, "ann")).toBe(-1);
  // the same field: units, gear and positions, turn order; nobody's units are dealt to anyone
  for (const seat of [0, 1, 2]) expect(where(again, seat)).toEqual(where(b, seat));
  expect(again.items.map((i) => [i.type, i.owner, i.tile])).toEqual(b.items.map((i) => [i.type, i.owner, i.tile]));
  expect(again.units.every((u) => u.controller === undefined)).toBe(true);
  expect([again.round, again.current, again.phase]).toEqual([1, 0, Phase.PLAYING]);
  expect(again.settings.coop.afkAI).toBe(false);
  // but the dice are new
  expect(again.rng.state()).not.toEqual(deserializeBattle(start, files).rng.state());
});

test("retries and challenges on the server", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-replay-")), "test.sqlite");
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  const mkUser = (id: string) => {
    db.query("INSERT OR IGNORE INTO users (id, google_sub, email, name, picture, created) VALUES (?, NULL, NULL, ?, NULL, ?)").run(id, id, Date.now());
    return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  };
  const battleOf = (id: string, col = "battle") => {
    const row = db.query(`SELECT ${col} AS b FROM matches WHERE id = ?`).get(id) as { b: Uint8Array };
    return deserializeBattle(new TextDecoder().decode(Bun.gunzipSync(row.b as Uint8Array<ArrayBuffer>)), files);
  };
  const sock = (user: UserRow, matchId: string) => ({ data: { user, matchId }, sent: [] as string[], send(m: string) { this.sent.push(m); }, close() {} });
  const [ann, ben, cat] = ["rp_ann", "rp_ben", "rp_cat"].map(mkUser);
  const { id } = game.createMatch(ann, { budget: 150_000, biome: "CULTA", timeOfDay: "day", turnTimer: 0 });
  expect(game.joinMatch(id, ben)).toBeNull();
  const lobby = game.lobbyState(id, ann)!;
  for (const [u, seed] of [[ann, 1], [ben, 2]] as const) {
    expect(game.saveLoadout(id, u, buildSquad("balanced", lobby.settings, lobby.pool, new RNG(seed))).check!.ok).toBe(true);
    expect(game.setReady(id, u, true)).toBeNull();
  }
  expect(game.addBot(id, ann, "swarm")).toBeNull();
  expect(game.startMatch(id, ann)).toBeNull();
  const start = battleOf(id, "start_battle");
  const seat = seatOfUser(start, ann.id);

  // Ben is still fighting: Ann can't replay the start (it would show where Ben began) until she's out of it
  expect(game.retryMatch(id, ann).error).toContain("Other people");
  expect(game.shareChallenge(id, ann, "x").error).toContain("Other people");
  const sa = sock(ann, id);
  game.wsOpen(sa as never);
  game.wsMessage(sa as never, JSON.stringify({ t: "cmd", seq: 1, cmd: { c: "surrender" } }));
  expect(JSON.parse(sa.sent.find((m) => JSON.parse(m).t === "view")!).replayable).toBe(true);
  game.wsClose(sa as never);

  // a retry: a new match from the same start, Ann against the AI (Ben's squad included)
  const retry = game.retryMatch(id, ann);
  expect(retry.error).toBeUndefined();
  const r = retry.id!;
  const rb = battleOf(r);
  expect(seatOfUser(rb, ann.id)).toBe(seat);
  expect(rb.players.filter((p) => !p.userId.startsWith("bot:")).length).toBe(1);
  for (const s of [0, 1, 2]) expect(where(rb, s)).toEqual(where(start, s));
  expect(game.lobbyState(r, ann)).toMatchObject({ status: "playing", settings: { name: `${lobby.settings.name} (retry)` } });
  expect(game.listMatches(ann).find((m) => m.id === r)!.players.length).toBe(3);
  // nobody else gets in
  expect(game.joinMatch(r, ben)).toContain("own go");

  // a challenge: Cat plays Ann's side from the start; it's on the challenge's record
  const ch = game.shareChallenge(id, ann, "Hold the farm");
  expect(ch.error).toBeUndefined();
  expect(game.shareChallenge(id, ann, "").id).toBe(ch.id!);
  let page = game.challengeState(ch.id!, cat)!;
  expect(page).toMatchObject({ title: "Hold the farm", by: ann.name, yours: false, attempts: [] });
  expect(page.summary.sides.map((x) => x.yours)).toEqual(start.players.map((_, i) => i === seat));
  expect(page.summary.squad.length).toBe(where(start, seat).length);
  const go = game.acceptChallenge(ch.id!, cat).id!;
  const cb = battleOf(go);
  expect(seatOfUser(cb, cat.id)).toBe(seat);
  expect(cb.players[seat].name).toBe(cat.name);
  for (const s of [0, 1, 2]) expect(where(cb, s)).toEqual(where(start, s));
  page = game.challengeState(ch.id!, cat)!;
  expect(page.attempts).toMatchObject([{ name: cat.name, you: true, matchId: go, finished: null }]);
  expect(game.challengeState(ch.id!, ann)!.attempts[0].matchId).toBeUndefined();

  // Cat gives up: the go is over at once (the AI squads left don't fight on), a loss on the record
  const sc = sock(cat, go);
  game.wsOpen(sc as never);
  game.wsMessage(sc as never, JSON.stringify({ t: "cmd", seq: 1, cmd: { c: "surrender" } }));
  game.wsClose(sc as never);
  expect(game.lobbyState(go, cat)!.battle!.over).toBe(true);
  page = game.challengeState(ch.id!, cat)!;
  expect(page.attempts[0]).toMatchObject({ won: false, rounds: 1, lost: 0 });
  expect(page.attempts[0].finished).toBeGreaterThan(0);
  // a retry of a go is another go at the same challenge; sharing it shares the challenge
  const again = game.retryMatch(go, cat).id!;
  expect(game.lobbyState(again, cat)!.settings.name).toBe("Hold the farm");
  expect(game.challengeState(ch.id!, cat)!.attempts.length).toBe(2);
  expect(game.shareChallenge(again, cat, "mine now").id).toBe(ch.id!);
  expect(game.listChallenges(cat)).toMatchObject([{ id: ch.id, title: "Hold the farm", yours: false, goes: 2, wins: 0, beaten: false }]);
  expect(game.listChallenges(ann)[0]).toMatchObject({ id: ch.id, yours: true });
  // starting over in the middle of a battle against the AI gives that one up
  const third = game.retryMatch(again, cat).id!;
  expect(game.lobbyState(again, cat)!.battle!.over).toBe(true);
  expect(battleOf(again).players[seat].surrendered).toBe(true);
  expect(game.challengeState(ch.id!, cat)!.attempts.map((a) => [a.matchId, !!a.finished])).toEqual([[go, true], [again, true], [third, false]]);
});
