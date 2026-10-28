import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files } from "../tools/gamefiles.ts";
import { PLAY_EXAMPLES, checkSetup, isSetup, parseSetupText, playLinks, setupDelta, settingsReference } from "../shared/settings-docs.ts";
import { compileRecipe } from "../shared/maps/recipe.ts";
import type { UserRow } from "../server/db.ts";

test("the play link examples are valid as written, their recipes build, and the reference shows their links", () => {
  const ref = settingsReference("https://xcom.example");
  for (const e of PLAY_EXAMPLES) {
    expect([e.ask, checkSetup(e.setup).warnings]).toEqual([e.ask, []]);
    if (e.setup.recipe) {
      const { warnings, issues } = compileRecipe(e.setup.recipe, files);
      expect([e.ask, warnings, issues.filter((i) => i.level === "error")]).toEqual([e.ask, [], []]);
    }
    const links = playLinks("https://xcom.example", e.setup);
    expect(ref).toContain(links.auto);
    expect(ref).toContain(links.equip);
    expect(checkSetup(parseSetupText(links.equip)).setup.squad).toBe("equip");
  }
});

test("a play setup is checked: opponents, squad, recipe and co-op teams", () => {
  // nothing said: one computer squad, auto-configured, starting by itself
  const plain = checkSetup({ settings: { biome: "MARS" } });
  expect(plain.warnings).toEqual([]);
  expect(plain.setup.opponents).toHaveLength(1);
  expect(plain.setup.squad).toBe("auto");
  expect(plain.setup.settings.autoStart).toBe(true);
  expect(checkSetup({ opponents: [] }).setup.opponents).toEqual([]);
  const bad = checkSetup({ settings: { mapBlocks: 2, map: "abc" }, recipe: { terrain: "URBAN" }, opponents: [{ strategy: "sneaky", ai: { aggression: 9, mood: 1 } }], squad: "later", extra: 1 });
  const w = bad.warnings.join("\n");
  for (const s of ["settings.mapBlocks: 2 isn't allowed here", "settings.map: the recipe's map is played instead", "no such strategy \"sneaky\"", "ai.aggression: 9 isn't allowed here, using 3", "ai.mood: not an AI setting", "squad: \"auto\" or \"equip\"", "extra: not part of a setup"]) expect(w).toContain(s);
  expect(bad.setup.settings.map).toBe("");
  expect(bad.setup.opponents[0].strategy).toBeNull();
  // co-op: no computer squads, and the player is on the team (said only if they asked to just watch)
  const coop = checkSetup({ settings: { mode: "coop" }, opponents: [{}] });
  expect(coop.setup.opponents).toEqual([]);
  expect(coop.setup.settings.scenario.gmPlays).toBe(true);
  expect(coop.warnings.join("\n")).toContain("opponents: only used in free-for-all");
  expect(checkSetup({ settings: { mode: "coop", scenario: { gmPlays: false } } }).warnings.join("\n")).toContain("gmPlays");
  // bare settings aren't a setup; a setup made short comes back the same
  expect(isSetup({ mode: "ffa", biome: "MARS" })).toBe(false);
  expect(isSetup({ settings: {}, squad: "auto" })).toBe(true);
  for (const e of PLAY_EXAMPLES) {
    const { setup } = checkSetup(e.setup);
    expect(checkSetup(setupDelta(setup)).setup).toEqual(setup);
  }
});

test("tools/match-link.ts prints both play links for a setup, and for bare settings too", async () => {
  const { run } = await import("../tools/match-link.ts");
  for (const e of PLAY_EXAMPLES) {
    const { out, ok } = run(["--server", "http://game.lan:3000", JSON.stringify(e.setup)]);
    expect([e.ask, ok]).toEqual([e.ask, true]);
    const play = out.split("\n").filter((l) => l.startsWith("http://game.lan:3000/play?setup="));
    expect(play.map((l) => checkSetup(parseSetupText(l)).setup.squad)).toEqual(["auto", "equip"]);
    expect(checkSetup(parseSetupText(play[0])).setup.settings).toEqual(checkSetup(e.setup).setup.settings);
  }
  const bare = run(['{"mode":"ffa","biome":"MARS"}']);
  expect(bare.out).toContain("/play?setup=");
  expect(bare.out).toContain("/?settings=");
  // a recipe that doesn't build is reported
  const broken = run(["--recipe", '{"terrain":"URBAN","blocks":["NOPE"]}', '{"mode":"ffa"}']);
  expect([broken.ok, broken.out]).toEqual([false, expect.stringContaining("The map recipe")]);
});

test("a play link sets up the whole match: map, opponents, squad, and the battle starts by itself", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-play-")), "test.sqlite");
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  const user = (name: string): UserRow => {
    const id = `play-${name}`;
    db.query("INSERT OR IGNORE INTO users (id, login, email, name, picture, created) VALUES (?, ?, NULL, ?, NULL, ?)").run(id, `name:${id}`, name, Date.now());
    return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  };
  const ivy = user("Ivy");
  const recipe = { name: "Play Test Farm", terrain: "CULTA", size: 40, base: "generated", zones: 4 };

  // jump in: the map is built and saved, a computer squad added, Ivy's squad hired and readied, and the battle is on
  const a = game.quickPlay(ivy, { settings: { name: "Quick", budget: 200_000 }, recipe, opponents: [{ strategy: "swarm" }], squad: "auto" });
  expect(a.error).toBeUndefined();
  expect(a.started).toBe(true);
  const sa = game.lobbyState(a.id!, ivy)!;
  expect(sa.status).toBe("playing");
  expect(sa.settings.mapName).toBe("Play Test Farm");
  expect(sa.players.map((p) => !!p.bot)).toEqual([false, true]);
  expect(sa.you!.deployed).toBe(true);

  // set up the squad first: the same map is reused, the lobby waits for Ivy, and Ready starts the battle
  const b = game.quickPlay(ivy, { settings: { name: "Equip", budget: 200_000 }, recipe, squad: "equip" });
  expect(b.started).toBe(false);
  const sb = game.lobbyState(b.id!, ivy)!;
  expect(sb.settings.map).toBe(sa.settings.map);
  expect(sb.you!.loadout).toBeNull();
  const { autoSquad } = await import("../shared/rules/squads.ts");
  expect(game.saveLoadout(b.id!, ivy, autoSquad(sb.settings, sb.pool).loadout).check?.ok).toBe(true);
  expect(game.setReady(b.id!, ivy, true)).toBeNull();
  expect(game.lobbyState(b.id!, ivy)!.status).toBe("playing");

  // no opponents: Ivy waits, ready, until a friend is ready too
  const c = game.quickPlay(ivy, { settings: { name: "Friends", budget: 200_000 }, opponents: [], squad: "auto" });
  expect(c.started).toBe(false);
  const jo = user("Jo");
  expect(game.joinMatch(c.id!, jo)).toBeNull();
  const sc = game.lobbyState(c.id!, jo)!;
  game.saveLoadout(c.id!, jo, autoSquad(sc.settings, sc.pool).loadout);
  expect(game.setReady(c.id!, jo, true)).toBeNull();
  expect(game.lobbyState(c.id!, jo)!.status).toBe("playing");

  // co-op: Ivy on the team against the scenario's enemy, playing at once
  const d = game.quickPlay(ivy, { settings: { mode: "coop", name: "Raid", budget: 200_000, scenario: { gmPlays: false } }, squad: "auto" });
  expect(d.started).toBe(true);

  // a recipe that can't make a map is an error, and nothing is created
  const before = (db.query("SELECT COUNT(*) AS n FROM matches").get() as { n: number }).n;
  expect(game.quickPlay(ivy, { recipe: { terrain: "MOON" } }).error).toContain("Couldn't build the map");
  expect((db.query("SELECT COUNT(*) AS n FROM matches").get() as { n: number }).n).toBe(before);
});
