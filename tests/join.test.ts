import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files } from "../tools/gamefiles.ts";
import { defaultSettings, sanitizeSettings, resolveMapBlocks } from "../shared/protocol.ts";
import { generatePool } from "../shared/rules/catalog.ts";
import { buildSquad } from "../shared/rules/squads.ts";
import { createBattle, joinBattle } from "../shared/engine/setup.ts";
import { GameRules } from "../shared/engine/actions.ts";
import { BattleEvents } from "../shared/engine/events.ts";
import { RNG } from "../shared/engine/rng.ts";
import { isOut, Phase } from "../shared/engine/state.ts";
import { serializeBattle, deserializeBattle } from "../shared/engine/serialize.ts";
import type { UserRow } from "../server/db.ts";

test("no player cap; the map is sized when the battle starts unless set", () => {
  const d = defaultSettings();
  expect("maxPlayers" in d).toBe(false);
  expect(d.mapBlocks).toBe(0);
  expect(sanitizeSettings({ maxPlayers: 4 } as never).mapBlocks).toBe(0);
  expect(sanitizeSettings({ mapBlocks: 7 }).mapBlocks).toBe(7);
  // reusing a finished match's settings: a size that was picked automatically is automatic again
  expect(sanitizeSettings({ mapBlocks: 6, autoMap: true }).mapBlocks).toBe(0);
  expect(resolveMapBlocks(d, 2, 1)).toBe(5);
  expect(resolveMapBlocks(d, 6, 1)).toBe(7);
  expect(resolveMapBlocks({ ...d, mapBlocks: 9 }, 2, 1)).toBe(9);
});

test("a squad joining the battle in progress lands at the edge, away from everyone, and plays last", () => {
  const s = { ...defaultSettings(), biome: "CULTA" as const, timeOfDay: "day" as const, ufo: "none", budget: 200_000 };
  const pool = generatePool(s, 11);
  const rng = new RNG(11);
  const b = createBattle(s, [
    { userId: "ann", name: "Ann", loadout: buildSquad("balanced", s, pool, rng), members: [{ userId: "ann", name: "Ann" }] },
    { userId: "ben", name: "Ben", loadout: buildSquad("balanced", s, pool, rng), members: [{ userId: "ben", name: "Ben" }] },
  ], pool, 11, files);
  expect(b.settings.mapBlocks).toBe(5);
  const rules = new GameRules(b);
  rules.endTurn(new BattleEvents(b));
  expect(b.current).toBe(1);
  const ev = new BattleEvents(b);
  const cat = buildSquad("swarm", s, pool, rng);
  const seat = joinBattle(b, { userId: "cat", name: "Cat", loadout: cat, members: [{ userId: "cat", name: "Cat" }] }, pool, ev);
  expect(seat).toBe(2);
  expect(b.players[2]).toMatchObject({ name: "Cat", joinedRound: 1, eliminated: false });
  expect(b.discovered.length).toBe(3);
  expect(ev.list.some((r) => r.e.t === "msg" && (r.e as { text: string }).text === "STR_JOINED_BATTLE")).toBe(true);
  const cats = b.units.filter((u) => u.owner === 2);
  expect(cats.length).toBe(cat.squad.length);
  expect(cats.every((u) => u.controller === "cat")).toBe(true);
  // a landing zone of its own on the map edge, not on top of anyone
  const z = b.zones[2];
  expect(z.x === 0 || z.y === 0 || z.x + z.w === b.sx || z.y + z.h === b.sy).toBe(true);
  for (const other of b.landingZones.filter((l) => l.seat !== 2)) expect(Math.hypot(other.x - z.x, other.y - z.y)).toBeGreaterThanOrEqual(20);
  const nearest = Math.min(...cats.flatMap((c) => b.units.filter((u) => u.owner !== 2 && !isOut(u)).map((u) => Math.hypot(u.pos.x - c.pos.x, u.pos.y - c.pos.y))));
  expect(nearest).toBeGreaterThan(10);
  // Cat sees what their own units see
  expect(b.discovered[2].some((d) => d)).toBe(true);
  // turn order: Ben, then Cat, then a new round with Ann
  rules.endTurn(new BattleEvents(b));
  expect([b.current, b.round]).toEqual([2, 1]);
  rules.endTurn(new BattleEvents(b));
  expect([b.current, b.round]).toEqual([0, 2]);
  // it all survives a save and reload
  const again = deserializeBattle(serializeBattle(b), files);
  expect(again.players.length).toBe(3);
  expect(again.discovered.length).toBe(3);
  expect(again.units.filter((u) => u.owner === 2).length).toBe(cats.length);
});

test("joining a battle in progress on the server: hire, deploy, and teammates joining a squad that's fighting", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-join-")), "test.sqlite");
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  const mkUser = (id: string) => {
    db.query("INSERT OR IGNORE INTO users (id, google_sub, email, name, picture, created) VALUES (?, NULL, NULL, ?, NULL, ?)").run(id, id, Date.now());
    return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  };
  const [ann, ben, cat, dot, eve] = ["jn_ann", "jn_ben", "jn_cat", "jn_dot", "jn_eve"].map(mkUser);
  const { id } = game.createMatch(ann, { budget: 150_000, biome: "CULTA", timeOfDay: "day", coop: { ...defaultSettings().coop, squadSize: 2 } });
  for (const u of [ben, cat]) expect(game.joinMatch(id, u)).toBeNull();
  let lobby = game.lobbyState(id, ann)!;
  expect(lobby.settings.mapBlocks).toBe(0);
  for (const [u, seed] of [[ann, 1], [ben, 2]] as const) {
    expect(game.saveLoadout(id, u, buildSquad("swarm", lobby.settings, lobby.pool, new RNG(seed))).check!.ok).toBe(true);
    expect(game.setReady(id, u, true)).toBeNull();
  }
  // Cat isn't ready: the battle starts without them
  expect(game.startMatch(id, ann)).toBeNull();
  lobby = game.lobbyState(id, cat)!;
  expect(lobby.status).toBe("playing");
  expect(lobby.settings).toMatchObject({ mapBlocks: 5, autoMap: true });
  expect(lobby.battle!.sides.map((p) => p.name).sort()).toEqual([ann.name, ben.name].sort());
  expect(lobby.you!.deployed).toBe(false);
  // someone who wasn't even in the lobby joins too
  expect(game.joinMatch(id, eve)).toBeNull();
  expect(game.lobbyState(id, eve)!.you!.deployed).toBe(false);
  expect(game.leaveMatch(id, eve)).toBeNull();
  // the people fighting get the battle; Cat still gets the lobby, to hire and deploy from
  const sock = (user: UserRow) => ({ data: { user, matchId: id }, sent: [] as string[], send(m: string) { this.sent.push(m); }, close() {} });
  const sa = sock(ann), sc = sock(cat);
  game.wsOpen(sa as never);
  game.wsOpen(sc as never);
  const msgs = (s: typeof sa) => s.sent.map((m) => JSON.parse(m));
  const lastView = (s: typeof sa) => msgs(s).filter((m) => m.view).at(-1)?.view;
  expect(lastView(sa).players.length).toBe(2);
  expect(msgs(sc).at(-1).t).toBe("lobby");
  expect(lastView(sc)).toBeUndefined();
  expect(game.saveLoadout(id, cat, buildSquad("elite", lobby.settings, lobby.pool, new RNG(3))).check!.ok).toBe(true);
  expect(game.setReady(id, cat, true)).toBeNull();
  // Cat's squad is the third side, and everyone in the battle hears about it
  const v = lastView(sa);
  expect(v.players.map((p: { name: string }) => p.name)[2]).toBe(cat.name);
  expect(msgs(sa).some((m) => m.t === "update" && m.events.some((e: { text?: string }) => e.text === "STR_JOINED_BATTLE"))).toBe(true);
  expect(game.lobbyState(id, cat)!.you!.deployed).toBe(true);
  expect(game.saveLoadout(id, cat, { squad: [], stash: [] }).error).toBe("Your squad is already in the battle");
  expect(game.leaveMatch(id, cat)).toContain("surrender");
  sc.sent.length = 0;
  game.wsOpen(sc as never);
  expect(lastView(sc).you).toBe(2);
  // Dot joins Cat's squad while it fights: in at once, with nothing until Cat hands over a unit
  expect(game.joinMatch(id, dot, cat.id)).toBeNull();
  expect(game.lobbyState(id, dot)!.you!.deployed).toBe(true);
  expect(lastView(sc).players[2].members.map((m: { userId: string }) => m.userId)).toEqual([cat.id, dot.id]);
  expect(game.joinMatch(id, eve, cat.id)).toBe("That squad is full");
  expect(game.lobbyState(id, ann)!.battle!.sides[2].room).toBe(false);
  expect(lastView(sa).phase).toBe(Phase.PLAYING);
});
