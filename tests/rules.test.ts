import { test, expect } from "bun:test";
import { files } from "../tools/render-map.ts";
import { Battle, TerrainLib, isOut } from "../shared/engine/state.ts";
import { TilePart } from "../shared/formats/terrain.ts";
import { defaultSettings, type Recruit } from "../shared/protocol.ts";
import { createUnit, giveItem, spawnGroundItem } from "../shared/engine/units.ts";
import { GameRules } from "../shared/engine/actions.ts";
import { BattleEvents } from "../shared/engine/events.ts";
import { recalcAllLighting, recalculateAllFOV } from "../shared/engine/tileengine.ts";
import { extractView, newSentState } from "../shared/engine/view.ts";
import { SOLDIER, unitRule } from "../shared/rules/index.ts";

/** A flat 30x30 field of desert sand, 2 levels high. */
function field(players = 2, settings = defaultSettings()) {
  const lib = new TerrainLib(["BLANKS", "DESERT"], files);
  const b = new Battle(lib, { ...settings, supplyDrops: { ...settings.supplyDrops, enabled: false } }, 7);
  b.initMap(30, 30, 2, players);
  const sand = lib.mapData.findIndex((m, i) => i >= lib.datasetStart[1] && m.objectType === TilePart.FLOOR && m.tuWalk === 4 && !m.noFloor && m.terrainLevel === 0);
  for (let x = 0; x < 30; x++) for (let y = 0; y < 30; y++) b.parts[b.idx(x, y, 0) * 4] = sand;
  b.players = Array.from({ length: players }, (_, i) => ({ index: i, userId: "u" + i, name: "P" + i, eliminated: false, surrendered: false, endedTurnCount: 0 }));
  return b;
}

const rookie = (over: Partial<Recruit["stats"]> = {}): Recruit => ({
  id: "r", kind: "soldier", type: "SOLDIER", name: "Test", rank: "STR_ROOKIE", gender: 0, look: 0,
  stats: { ...SOLDIER.maxStats, psiSkill: 0, ...over }, price: 0, notes: [],
});
const alien = (type: string): Recruit => ({ id: "a", kind: "alien", type, name: type, rank: "", gender: 0, look: 0, stats: { ...unitRule(type).stats }, price: 0, notes: [] });

function start(b: Battle) {
  b.rebuildUnitIndex();
  recalcAllLighting(b);
  recalculateAllFOV(b);
  const rules = new GameRules(b);
  rules.beginTurn(0, new BattleEvents(b));
  return rules;
}

test("kneeling costs 4 TU, standing 8; only soldiers can kneel", () => {
  const b = field();
  const u = createUnit(b, rookie(), "STR_NONE_UC", 0, { x: 2, y: 2, z: 0 }, 2);
  const s = createUnit(b, alien("STR_SECTOID_SOLDIER"), "", 1, { x: 27, y: 27, z: 0 }, 6);
  const rules = start(b);
  const tu = u.tu;
  expect(rules.apply(0, { c: "kneel", unit: u.id }).ok).toBe(true);
  expect(u.tu).toBe(tu - 4);
  expect(rules.apply(0, { c: "kneel", unit: u.id }).ok).toBe(true);
  expect(u.tu).toBe(tu - 12);
  rules.apply(0, { c: "endturn" });
  expect(rules.apply(1, { c: "kneel", unit: s.id }).error).toBe("STR_CANNOT_KNEEL");
});

test("walking costs 4 TU per straight step, 6 diagonally; out-of-turn commands are refused", () => {
  const b = field();
  const u = createUnit(b, rookie(), "STR_NONE_UC", 0, { x: 2, y: 2, z: 0 }, 2);
  createUnit(b, rookie(), "STR_NONE_UC", 1, { x: 28, y: 28, z: 0 }, 6);
  const rules = start(b);
  const tu = u.tu;
  rules.apply(0, { c: "move", unit: u.id, to: { x: 5, y: 2, z: 0 } });
  expect(u.pos).toEqual({ x: 5, y: 2, z: 0 });
  expect(u.tu).toBe(tu - 12);
  rules.apply(0, { c: "move", unit: u.id, to: { x: 6, y: 3, z: 0 } });
  expect(u.tu).toBe(tu - 18);
  expect(rules.apply(1, { c: "move", unit: u.id, to: { x: 7, y: 3, z: 0 } }).ok).toBe(false);
});

test("inventory moves cost the original TUs and you can only grab items from your own tile", () => {
  const b = field();
  const u = createUnit(b, rookie(), "STR_NONE_UC", 0, { x: 2, y: 2, z: 0 }, 2);
  createUnit(b, rookie(), "STR_NONE_UC", 1, { x: 28, y: 28, z: 0 }, 6);
  const g = giveItem(b, u, "STR_GRENADE", "STR_BELT", 0, 0);
  const far = spawnGroundItem(b, "STR_RIFLE", b.idx(10, 10, 0));
  const near = spawnGroundItem(b, "STR_PISTOL", b.idx(2, 2, 0));
  const rules = start(b);
  const tu = u.tu;
  expect(rules.apply(0, { c: "inv", unit: u.id, item: g.id, slot: "STR_RIGHT_HAND", x: 0, y: 0 }).ok).toBe(true);
  expect(u.tu).toBe(tu - 4);
  expect(rules.apply(0, { c: "inv", unit: u.id, item: far.id, slot: "STR_LEFT_HAND", x: 0, y: 0 }).ok).toBe(false);
  expect(rules.apply(0, { c: "inv", unit: u.id, item: near.id, slot: "STR_LEFT_HAND", x: 0, y: 0 }).ok).toBe(true);
  expect(u.tu).toBe(tu - 12);
});

test("reaction fire: a watcher with a loaded rifle snap-fires at an enemy walking into view", () => {
  const b = field();
  const watcher = createUnit(b, rookie({ reactions: 100 }), "STR_NONE_UC", 1, { x: 15, y: 5, z: 0 }, 4);
  giveItem(b, watcher, "STR_RIFLE", "STR_RIGHT_HAND", 0, 0, "STR_RIFLE_CLIP");
  const mover = createUnit(b, rookie({ reactions: 10 }), "STR_NONE_UC", 0, { x: 15, y: 25, z: 0 }, 0);
  const rules = start(b);
  const before = watcher.tu;
  const r = rules.apply(0, { c: "move", unit: mover.id, to: { x: 15, y: 12, z: 0 } });
  expect(r.events.list.some((e) => e.e.t === "reaction")).toBe(true);
  expect(watcher.tu).toBeLessThan(before);
});

test("fog of war: an enemy out of sight is not in the player's view", () => {
  const b = field();
  createUnit(b, rookie(), "STR_NONE_UC", 0, { x: 2, y: 2, z: 0 }, 2);
  // behind the soldier and out of range
  const hidden = createUnit(b, rookie(), "STR_NONE_UC", 1, { x: 28, y: 28, z: 0 }, 6);
  start(b);
  const v = extractView(b, 0, newSentState(), true);
  expect(v.units.some((u) => u.id === hidden.id)).toBe(false);
  // and undiscovered tiles aren't sent at all
  expect(v.tiles.some((t) => t[0] === b.idx(29, 29, 0))).toBe(false);
});

test("mind control hands the unit over until the controller's next turn", () => {
  const b = field();
  const sectoid = createUnit(b, { ...alien("STR_SECTOID_COMMANDER"), stats: { ...unitRule("STR_SECTOID_COMMANDER").stats, psiSkill: 100, psiStrength: 100 } }, "", 0, { x: 10, y: 10, z: 0 }, 2);
  const victim = createUnit(b, rookie({ psiStrength: 0 }), "STR_NONE_UC", 1, { x: 14, y: 10, z: 0 }, 6);
  const rules = start(b);
  let ok = false;
  for (let i = 0; i < 8 && !ok; i++) {
    sectoid.tu = sectoid.stats.tu;
    const r = rules.apply(0, { c: "psi", unit: sectoid.id, hand: "innate", target: victim.pos });
    expect(r.ok).toBe(true);
    ok = victim.owner === 0;
  }
  expect(ok).toBe(true);
  expect(victim.originalOwner).toBe(1);
  rules.apply(0, { c: "endturn" }); // player 1's turn: the unit is still controlled
  expect(victim.owner).toBe(0);
  rules.apply(1, { c: "endturn" }); // player 0's next turn begins: control wears off
  expect(victim.owner).toBe(1);
});

test("a squad with nobody left standing is eliminated and the survivor wins", () => {
  const b = field();
  const a = createUnit(b, rookie(), "STR_NONE_UC", 0, { x: 10, y: 10, z: 0 }, 2);
  const v = createUnit(b, rookie(), "STR_NONE_UC", 1, { x: 11, y: 10, z: 0 }, 6);
  giveItem(b, a, "STR_STUN_ROD", "STR_RIGHT_HAND", 0, 0);
  const rules = start(b);
  v.health = 1;
  v.armorNow = [0, 0, 0, 0, 0];
  for (let i = 0; i < 20 && !isOut(v); i++) {
    a.tu = a.stats.tu;
    rules.apply(0, { c: "melee", unit: a.id, hand: "STR_RIGHT_HAND", target: v.pos });
  }
  expect(isOut(v)).toBe(true);
  expect(b.players[1].eliminated).toBe(true);
  expect(b.winner).toBe(0);
});

test("supply drops are announced ahead of time and land as a ground pile", () => {
  const s = defaultSettings();
  const b = field(2, s);
  b.settings = { ...s, supplyDrops: { enabled: true, everyRounds: 2, warningRounds: 1, tier: "basic" } };
  createUnit(b, rookie(), "STR_NONE_UC", 0, { x: 1, y: 1, z: 0 }, 2);
  createUnit(b, rookie(), "STR_NONE_UC", 1, { x: 28, y: 28, z: 0 }, 6);
  const rules = start(b);
  let announced = false, landed = false;
  for (let i = 0; i < 12; i++) {
    const r = rules.apply(b.current, { c: "endturn" });
    if (r.events.list.some((e) => e.e.t === "supply" && !e.e.dropped)) announced = true;
    if (r.events.list.some((e) => e.e.t === "supply" && e.e.dropped)) {
      landed = true;
      // everyone is told
      expect(r.events.list.find((e) => e.e.t === "supply" && e.e.dropped)!.vis).toBe(3);
    }
  }
  expect(announced).toBe(true);
  expect(landed).toBe(true);
  const d = b.supply.find((x) => x.dropped)!;
  expect(b.itemsOnTile(b.idxP(d.pos)).length).toBeGreaterThan(0);
});

test("malformed commands are rejected (fake fire modes, non-hand slots, bad positions)", () => {
  const b = field();
  const u = createUnit(b, rookie(), "STR_NONE_UC", 0, { x: 2, y: 2, z: 0 }, 2);
  giveItem(b, u, "STR_RIFLE", "STR_BACK_PACK", 0, 0, "STR_RIFLE_CLIP");
  createUnit(b, rookie(), "STR_NONE_UC", 1, { x: 6, y: 2, z: 0 }, 6);
  const rules = start(b);
  const tu = u.tu;
  expect(rules.apply(0, { c: "shoot", unit: u.id, hand: "STR_BACK_PACK" as never, mode: "snap", target: { x: 6, y: 2, z: 0 } }).error).toBe("STR_INVALID_COMMAND");
  expect(rules.apply(0, { c: "shoot", unit: u.id, hand: "STR_RIGHT_HAND", mode: "bogus" as never, target: { x: 6, y: 2, z: 0 } }).error).toBe("STR_INVALID_COMMAND");
  expect(rules.apply(0, { c: "move", unit: u.id, to: { x: 1.5, y: 99, z: 0 } }).error).toBe("STR_INVALID_COMMAND");
  expect(u.tu).toBe(tu);
});

test("a soldier killed outright by a chryssalid rises as a zombie for the chryssalid's owner", () => {
  const b = field();
  const c = createUnit(b, alien("STR_CHRYSSALID_TERRORIST"), "", 0, { x: 10, y: 10, z: 0 }, 2);
  const v = createUnit(b, rookie(), "STR_NONE_UC", 1, { x: 11, y: 10, z: 0 }, 6);
  createUnit(b, rookie(), "STR_NONE_UC", 1, { x: 25, y: 25, z: 0 }, 6);
  const rules = start(b);
  for (let i = 0; i < 20 && !isOut(v); i++) {
    c.tu = c.stats.tu;
    rules.apply(0, { c: "melee", unit: c.id, hand: "STR_RIGHT_HAND", target: v.pos });
  }
  expect(isOut(v)).toBe(true);
  const zombie = b.units.find((u) => u.type === "STR_ZOMBIE");
  expect(zombie).toBeDefined();
  expect(zombie!.owner).toBe(0);
});

test("mind-controlled units go home when their controller is eliminated", () => {
  const b = field(3);
  const ctrl = createUnit(b, rookie(), "STR_NONE_UC", 0, { x: 10, y: 10, z: 0 }, 2);
  const victim = createUnit(b, rookie(), "STR_NONE_UC", 1, { x: 12, y: 10, z: 0 }, 6);
  createUnit(b, rookie(), "STR_NONE_UC", 2, { x: 25, y: 25, z: 0 }, 6);
  const rules = start(b);
  victim.owner = 0;
  victim.mindControllerId = ctrl.id;
  ctrl.health = 0; // controller dies
  rules.apply(0, { c: "kneel", unit: victim.id });
  expect(b.players[0].eliminated).toBe(true);
  expect(victim.owner).toBe(1);
  expect(b.current).toBe(1); // the eliminated player's turn passed on
});

test("supply drops only land outdoors on clear ground", async () => {
  const { generateMap, openSkyTiles } = await import("../shared/engine/mapgen.ts");
  const { defaultSettings } = await import("../shared/protocol.ts");
  const { files } = await import("../tools/gamefiles.ts");
  for (const biome of ["URBAN", "CULTA", "UBASE"] as const) {
    const { battle: b } = generateMap({ ...defaultSettings(), biome, mapBlocks: 5, ufo: "random" }, 2, 9, files);
    const spots = openSkyTiles(b, 4);
    expect(spots.length).toBeGreaterThan(0);
    for (const p of spots) {
      expect(b.parts[b.idxP(p) * 4 + 3]).toBe(-1); // no object (crate, table, bush) on the landing tile
      for (let z = p.z + 1; z < b.sz; z++) for (let part = 0; part < 4; part++) expect(b.parts[b.idx(p.x, p.y, z) * 4 + part]).toBe(-1);
    }
  }
});

test("match settings keep the host's message and re-roll a reused Random environment", async () => {
  const { sanitizeSettings, defaultSettings } = await import("../shared/protocol.ts");
  const s = sanitizeSettings({ ...defaultSettings(), notes: "no tanks\r\nplay evenings" + "x".repeat(2000) });
  expect(s.notes.startsWith("no tanks\nplay evenings")).toBe(true);
  expect(s.notes.length).toBe(1000);
  // a finished match stores the rolled environment plus the flag; reusing it goes back to Random
  const reused = sanitizeSettings({ ...defaultSettings(), biome: "POLAR", randomBiome: true });
  expect(reused.biome).toBe("RANDOM");
  expect(reused.randomBiome).toBeUndefined();
  expect(sanitizeSettings({ ...defaultSettings(), biome: "POLAR" }).biome).toBe("POLAR");
  // the same for a random time of day
  expect(sanitizeSettings({ ...defaultSettings(), timeOfDay: "random" }).timeOfDay).toBe("random");
  expect(sanitizeSettings({ ...defaultSettings(), timeOfDay: "night", randomTime: true }).timeOfDay).toBe("random");
  expect(sanitizeSettings({ ...defaultSettings(), timeOfDay: "night" }).timeOfDay).toBe("night");
});
