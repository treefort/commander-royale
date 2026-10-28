import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files } from "../tools/gamefiles.ts";
import { defaultSettings } from "../shared/protocol.ts";
import { generatePool } from "../shared/rules/catalog.ts";
import { buildSquad } from "../shared/rules/squads.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { RNG } from "../shared/engine/rng.ts";
import { TilePart, parseMcd } from "../shared/formats/terrain.ts";
import { TERRAINS } from "../shared/rules/index.ts";
import { encodeParts, decodeParts, sanitizeMapDoc, allDatasets, type MapDoc } from "../shared/maps/format.ts";
import { mapBattle, battleDoc, checkMap, pickZones, blockInfo, asciiPlan } from "../shared/maps/build.ts";
import { compileRecipe, runOp, OPS } from "../shared/maps/recipe.ts";
import { MATERIALS, BLOCK_NOTES, material } from "../shared/maps/catalog.ts";
import { mapsReference, RECIPE_EXAMPLES } from "../shared/maps/docs.ts";
import type { EditCtx } from "../shared/maps/ops.ts";
import type { UserRow } from "../server/db.ts";

test("tile parts survive the run-length encoding", () => {
  const parts = new Int16Array(40 * 30 * 4 * 4).fill(-1);
  const rng = new RNG(5);
  for (let i = 0; i < parts.length; i++) if (rng.percent(30)) parts[i] = rng.int(0, 400);
  parts.fill(7, 100, 100 + 70_000);
  expect(decodeParts(encodeParts(parts), parts.length)).toEqual(parts);
});

test("every named material is a real part of the right kind, and every original block is described", () => {
  const names = new Set<string>();
  for (const m of MATERIALS) {
    const key = `${m.dataset}:${m.name}`;
    expect(names.has(key) ? `duplicate ${key}` : key).toBe(key);
    names.add(key);
    // plain names are unique across the whole catalog (an AI writes them without the part set)
    expect(material(m.name)?.dataset === m.dataset ? m.name : `${m.name} is also in ${material(m.name)?.dataset}`).toBe(m.name);
    const defs = parseMcd(files(`TERRAIN/${m.dataset}.MCD`), 0);
    const local = [m.part, m.west, m.north, m.low, m.high, ...(m.parts ?? []).map((p) => p[2])].filter((p): p is number => p !== undefined);
    expect(local.length ? m.name : `${m.name} has no parts`).toBe(m.name);
    for (const p of local) expect(p >= 0 && p < defs.length ? m.name : `${m.name}: ${m.dataset} has no part ${p}`).toBe(m.name);
    if (m.kind === "floor") expect([m.name, defs[m.part!].objectType]).toEqual([m.name, TilePart.FLOOR]);
    if (m.kind === "stairs") expect(["north", "south", "east", "west"]).toContain(m.dir!);
    // wall pairs: the west part stands on the west edge (one BARN record says otherwise, and the maps ignore it)
    if (m.west !== undefined && defs[m.west].objectType <= 3) expect([m.name, defs[m.west].objectType]).toEqual([m.name, TilePart.WESTWALL]);
    if (m.north !== undefined && defs[m.north].objectType <= 3) expect([m.name, defs[m.north].objectType]).toEqual([m.name, TilePart.NORTHWALL]);
  }
  for (const t of TERRAINS.values()) for (const b of t.mapBlocks) expect(BLOCK_NOTES[b.name] ? b.name : `no note for ${b.name}`).toBe(b.name);
  for (const name of Object.keys(BLOCK_NOTES)) expect(blockInfo(name) ? name : `not a block: ${name}`).toBe(name);
});

test("the reference's example recipes build playable maps without a warning", () => {
  for (const e of RECIPE_EXAMPLES) {
    const { doc, warnings, issues } = compileRecipe(e.recipe, files);
    expect([e.recipe.name, warnings, issues]).toEqual([e.recipe.name, [], []]);
    expect(sanitizeMapDoc(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  }
  // the same recipe makes the same map
  const a = compileRecipe(RECIPE_EXAMPLES[0].recipe, files).doc, b = compileRecipe(RECIPE_EXAMPLES[0].recipe, files).doc;
  expect(a.parts).toBe(b.parts);
});

test("recipes: buildings get walls, doors, stairs and a roof; bad ops are reported, not fatal", () => {
  const { doc, warnings } = compileRecipe({
    terrain: "URBAN", size: 30, zones: 2,
    ops: [
      { op: "building", area: [5, 5, 8, 6], wall: "blue-brick-wall", floor: "wood-floor", storeys: 2, doors: ["south", { side: "west", at: 1 }] },
      { op: "block", name: "NOT_A_BLOCK", at: [0, 0] },
      { op: "floor", material: "no-such-floor", area: [0, 0, 3, 3] },
      { op: "teleport" },
    ],
  }, files);
  expect(warnings.length).toBe(3);
  expect(warnings[0]).toContain("NOT_A_BLOCK");
  expect(warnings[2]).toContain("unknown op");
  const b = mapBattle(doc, files);
  const at = (x: number, y: number, z: number, p: TilePart) => b.part(b.idx(x, y, z), p);
  // walls on all four sides of both storeys, doors in the south and west walls on the ground storey only
  expect(at(6, 5, 0, TilePart.NORTHWALL)).toBeTruthy();
  expect(at(6, 11, 1, TilePart.NORTHWALL)).toBeTruthy();
  expect(at(13, 7, 0, TilePart.WESTWALL)).toBeTruthy();
  expect(at(8, 11, 0, TilePart.NORTHWALL)!.door).toBe(true);
  expect(at(5, 6, 0, TilePart.WESTWALL)!.door).toBe(true);
  expect(at(8, 11, 1, TilePart.NORTHWALL)!.door).toBe(false);
  // an upper floor and a roof, and stairs between the storeys that soldiers can climb
  expect(at(9, 8, 1, TilePart.FLOOR)).toBeTruthy();
  expect(at(9, 8, 2, TilePart.FLOOR)).toBeTruthy();
  const stairs = [...Array(b.sx * b.sy).keys()].filter((i) => (b.part(i, TilePart.OBJECT)?.terrainLevel ?? 0) <= -8);
  expect(stairs.length).toBe(2);
  expect(checkMap(b, doc.zones, null)).toEqual([]);
  // inside the building's ground storey can walk up to its first floor
  const { walkable, standable } = require("../shared/maps/build.ts") as typeof import("../shared/maps/build.ts");
  const reach = walkable(b, standable(b, { x: 6, y: 6, w: 1, h: 1 }).filter((p) => p.z === 0));
  expect(reach[b.idx(10, 8, 1)]).toBe(1);
});

test("hills, scatter, roads and UFOs", () => {
  const { doc, warnings } = compileRecipe({
    terrain: "DESERT", size: [40, 30], seed: 9, zones: [[0, 0, 8, 8], [32, 22, 8, 8]],
    ops: [
      { op: "hill", area: [15, 10, 9, 9], height: 3 },
      { op: "path", material: "sand-hollow", points: [[0, 25], [39, 25]], width: 2 },
      { op: "scatter", materials: ["saguaro-cactus", "desert-rock"], count: 30, spacing: 1 },
      { op: "ufo", type: "STR_SMALL_SCOUT", at: [2, 12] },
    ],
  }, files);
  expect(warnings).toEqual([]);
  expect(doc.ufo).toEqual({ x: 2, y: 12, w: 10, h: 10 });
  const b = mapBattle(doc, files);
  // a full-height hilltop, slopes round it
  expect(b.part(b.idx(19, 14, 0), TilePart.OBJECT)!.terrainLevel).toBe(-24);
  expect(b.part(b.idx(15, 14, 0), TilePart.OBJECT)!.terrainLevel).toBe(-4);
  // nothing scattered in the landing zones
  for (const z of doc.zones) for (let x = z.x; x < z.x + z.w; x++) for (let y = z.y; y < z.y + z.h; y++) expect(b.part(b.idx(x, y, 0), TilePart.OBJECT)).toBeNull();
  const text = asciiPlan(b, doc.zones);
  expect(text.split("\n").length).toBe(31);
  expect(text).toContain("1111");
});

test("a battle on a custom map: its tiles and zones (more made at the edge when there are more squads)", () => {
  const { doc } = compileRecipe({ terrain: "URBAN", size: 40, zones: [[0, 0, 8, 8], [32, 32, 8, 8]], ops: [{ op: "building", area: [16, 16, 8, 8], wall: "concrete-wall" }] }, files);
  const s = { ...defaultSettings(), budget: 150_000, timeOfDay: "night" as const, map: "x" };
  const pool = generatePool(s, 4);
  const rng = new RNG(4);
  const players = ["ann", "ben", "cat"].map((id) => ({ userId: id, name: id, loadout: buildSquad("swarm", s, pool, rng), members: [{ userId: id, name: id }] }));
  const b = createBattle(s, players, pool, 4, files, doc);
  expect([b.sx, b.sy]).toEqual([40, 40]);
  expect(b.lib.datasetNames).toEqual(doc.datasets);
  expect(b.globalShade).toBe(15);
  expect(b.landingZones.length).toBe(3);
  const mapZones = doc.zones.map((z) => JSON.stringify(z));
  expect(b.zones.filter((z) => mapZones.includes(JSON.stringify(z))).length).toBe(2);
  for (let seat = 0; seat < 3; seat++) {
    const z = b.zones[seat];
    for (const u of b.units.filter((x) => x.owner === seat)) expect(Math.hypot(u.pos.x - (z.x + z.w / 2), u.pos.y - (z.y + z.h / 2))).toBeLessThan(12);
  }
  // the building is there
  expect(b.part(b.idx(16, 18, 0), TilePart.WESTWALL)).toBeTruthy();
  // two sides pick the two zones furthest apart
  const four = [{ x: 0, y: 0, w: 5, h: 5 }, { x: 10, y: 0, w: 5, h: 5 }, { x: 35, y: 35, w: 5, h: 5 }, { x: 0, y: 35, w: 5, h: 5 }];
  for (let seed = 0; seed < 8; seed++) {
    const [a, c] = pickZones(four, 2, seed);
    expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeGreaterThan(30);
  }
});

test("map checks: too few zones, and zones nobody can walk between", () => {
  const { doc } = compileRecipe({ terrain: "URBAN", size: 30, zones: [[0, 0, 6, 6], [24, 24, 6, 6]] }, files);
  const b = mapBattle(doc, files);
  expect(checkMap(b, doc.zones, null)).toEqual([]);
  expect(checkMap(b, [doc.zones[0]], null).map((i) => i.level)).toContain("error");
  // wall the second zone in
  const ctx: EditCtx = { b, files, rng: new RNG(1), zones: doc.zones, ufo: null, warnings: [] };
  runOp(ctx, { op: "building", area: [22, 22, 8, 8], wall: "concrete-wall", windows: "none", doors: [] });
  const issues = checkMap(b, doc.zones, null);
  expect(issues.some((i) => i.text.includes("walk"))).toBe(true);
  // a door lets them in
  runOp(ctx, { op: "wall", material: "white-door", from: [25, 22], to: [26, 22] });
  expect(checkMap(b, doc.zones, null).some((i) => i.text.includes("walk"))).toBe(false);
  const again = battleDoc(b, { name: "x", description: "", terrain: "URBAN", zones: doc.zones, ufo: null });
  expect(mapBattle(again, files).parts).toEqual(b.parts);
});

test("map documents are checked before they're stored", () => {
  const { doc } = compileRecipe({ terrain: "POLAR", size: 20 }, files);
  expect(() => sanitizeMapDoc({ ...doc, size: [5, 20, 4] })).toThrow();
  expect(() => sanitizeMapDoc({ ...doc, datasets: ["NOPE"] })).toThrow();
  expect(() => sanitizeMapDoc({ ...doc, terrain: "MOON" })).toThrow();
  const clipped = sanitizeMapDoc({ ...doc, name: "x".repeat(99), zones: [{ x: 15, y: 15, w: 30, h: 30 }] });
  expect(clipped.name.length).toBe(40);
  expect(clipped.zones[0]).toEqual({ x: 15, y: 15, w: 5, h: 5 });
  expect(allDatasets()).toContain("XBASE1");
});

test("the map reference covers every op, terrain and material, and links to the editor", () => {
  const ref = mapsReference("https://xcom.example");
  for (const op of OPS) expect(ref).toContain(`\`${op}\``);
  for (const t of TERRAINS.keys()) expect(ref).toContain(`### ${t}`);
  for (const m of MATERIALS) expect(ref).toContain(m.name);
  expect(ref).toContain("https://xcom.example/maps/new?recipe=");
  expect(ref.length).toBeLessThan(80_000);
  expect(mapsReference("https://xcom.example", "URBAN").length).toBeLessThan(25_000);
});

test("custom maps on the server: saved by their author, listed for everyone, played on", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-maps-")), "test.sqlite");
  const { db } = await import("../server/db.ts");
  const maps = await import("../server/maps.ts");
  const game = await import("../server/game.ts");
  const mkUser = (id: string) => {
    db.query("INSERT OR IGNORE INTO users (id, login, email, name, picture, created) VALUES (?, NULL, NULL, ?, NULL, ?)").run(id, id, Date.now());
    return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  };
  const [ann, ben] = ["mp_ann", "mp_ben"].map(mkUser);
  const { doc } = compileRecipe({ ...RECIPE_EXAMPLES[0].recipe }, files);
  expect(maps.saveMap(ann, null, { ...doc, v: 2 }).error).toContain("version");
  const { id } = maps.saveMap(ann, null, doc);
  expect(id).toBeTruthy();
  expect(maps.listMaps(ben).find((m) => m.id === id)).toMatchObject({ name: "Crossroads", mine: false, author: ann.name, zones: 4, size: "50x50x4" });
  expect(maps.saveMap(ben, id!, doc).error).toContain("author");
  expect(maps.deleteMap(ben, id!)).toContain("author");
  expect(maps.saveMap(ann, id!, { ...doc, name: "Crossroads II" }).id).toBe(id);
  // a match on it: the lobby shows its name; the battle has its tiles, terrain and size
  expect(() => game.createMatch(ben, { map: "nosuchmap" })).toThrow();
  const m = game.createMatch(ben, { map: id!, budget: 150_000, biome: "MARS", ufo: "random", timeOfDay: "day" });
  expect(game.joinMatch(m.id, ann)).toBeNull();
  const lobby = game.lobbyState(m.id, ben)!;
  expect(lobby.settings).toMatchObject({ map: id, mapName: "Crossroads II" });
  for (const [u, seed] of [[ann, 1], [ben, 2]] as const) {
    expect(game.saveLoadout(m.id, u, buildSquad("swarm", lobby.settings, lobby.pool, new RNG(seed))).check!.ok).toBe(true);
    expect(game.setReady(m.id, u, true)).toBeNull();
  }
  // changing the map afterwards doesn't reach a battle already on it
  expect(game.startMatch(m.id, ben)).toBeNull();
  expect(maps.deleteMap(ann, id!)).toBeNull();
  const after = game.lobbyState(m.id, ben)!;
  expect(after.settings).toMatchObject({ biome: "URBAN", ufo: "none", mapBlocks: 5 });
  const sock = { data: { user: ben, matchId: m.id }, sent: [] as string[], send(x: string) { this.sent.push(x); }, close() {} };
  game.wsOpen(sock as never);
  const view = sock.sent.map((x) => JSON.parse(x)).filter((x) => x.view).at(-1).view;
  expect(view.size).toEqual([50, 50, 4]);
  expect(view.datasets).toEqual(doc.datasets);
  game.wsClose(sock as never);
  // a new match can't use a map that's gone
  expect(() => game.createMatch(ben, { map: id! })).toThrow();
  void ({} as MapDoc);
});
