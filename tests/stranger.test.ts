import { test, expect } from "bun:test";
import { files } from "../tools/render-map.ts";
import { defaultSettings, sanitizeSettings, type Loadout } from "../shared/protocol.ts";
import { generatePool } from "../shared/rules/catalog.ts";
import { createBattle } from "../shared/engine/setup.ts";
import { GameRules } from "../shared/engine/actions.ts";
import { type Battle, type Unit, isOut } from "../shared/engine/state.ts";
import { BattleEvents } from "../shared/engine/events.ts";
import { STRANGER_ID } from "../shared/engine/defs.ts";
import { canStand } from "../shared/engine/mapgen.ts";
import { recalculateAllFOV, isUnitVisibleTo } from "../shared/engine/tileengine.ts";

function battle(stranger: number) {
  const settings = { ...defaultSettings(), biome: "CULTA" as const, mapBlocks: 4, budget: 5_000_000, stranger };
  const pool = generatePool(settings, 5);
  const soldiers = pool.filter((p) => p.kind === "soldier").map((p) => p.id);
  const loadout = (ids: string[]): Loadout => ({
    squad: ids.map((id) => ({ recruitId: id, armor: "STR_NONE_UC", items: [{ type: "STR_RIFLE", slot: "STR_RIGHT_HAND", x: 0, y: 0, ammo: "STR_RIFLE_CLIP" }] })),
    stash: [],
  });
  return createBattle(settings, [{ userId: "a", name: "A", loadout: loadout(soldiers.slice(0, 2)) }, { userId: "b", name: "B", loadout: loadout(soldiers.slice(2, 4)) }], pool, 11, files);
}

/** Puts one unit of each side face to face on open ground, `gap` tiles apart, in plain view of each other. */
function faceOff(b: Battle, gap = 6): [Unit, Unit] {
  const a = b.units.find((u) => u.owner === 0)!, e = b.units.find((u) => u.owner === 1)!;
  // the other units out of the way (they'd only block lines of fire)
  for (const u of b.units) if (u !== a && u !== e) b.clearUnitTiles(u);
  for (let y = 3; y < b.sy - 3; y++)
    for (let x = 3; x + gap < b.sx - 3; x++) {
      const p = { x, y, z: 0 }, q = { x: x + gap, y, z: 0 };
      let open = true;
      for (let dy = -3; dy <= 3 && open; dy++) for (let dx = -3; dx <= gap + 3 && open; dx++) open = canStand(b, { x: x + dx, y: y + dy, z: 0 }, 1) || (dx === 0 && dy === 0) || (dx === gap && dy === 0);
      if (!open) continue;
      b.placeUnit(a, p);
      b.placeUnit(e, q);
      a.dir = 2;
      e.dir = 6;
      recalculateAllFOV(b);
      if (isUnitVisibleTo(b, e, 0)) return [a, e];
    }
  throw new Error("no open ground");
}

test("the Mysterious Stranger appears beside the attacker, shoots the enemy and is gone", () => {
  const b = battle(10);
  const [a, e] = faceOff(b);
  e.health = e.stats.health = 1000; // survives the shot, so we can see it was hit
  const units = b.units.length;
  const ev = new BattleEvents(b);
  expect(new GameRules(b).mysteriousStranger(a, e, ev)).toBe(true);
  const kinds = ev.list.map((r) => r.e.t);
  expect(kinds.slice(0, 5)).toEqual(["stranger", "aim", "shot", "hit", "damage"]);
  const [came, went] = ev.list.filter((r) => r.e.t === "stranger").map((r) => r.e as Extract<typeof r.e, { t: "stranger" }>);
  expect([came.gone, went.gone]).toEqual([false, true]);
  // beside the attacker, on a free tile
  expect(Math.max(Math.abs(came.at.x - a.pos.x), Math.abs(came.at.y - a.pos.y))).toBeLessThanOrEqual(3);
  expect(b.unitOnTile(b.idxP(came.at))).toBeUndefined();
  expect(e.health).toBeLessThan(1000);
  // he's not a unit of the battle, and nobody is credited with his shot
  expect(b.units.length).toBe(units);
  expect(b.unit(STRANGER_ID)).toBeUndefined();
  // the attacker's side always sees him
  for (const r of ev.list) if (r.e.t === "stranger" || r.e.t === "shot") expect(r.vis & 1).toBe(1);
});

test("he comes now and then when an attack leaves a seen enemy standing, and never when off", () => {
  for (const chance of [0, 50]) {
    const b = battle(chance);
    const [a, e] = faceOff(b);
    const rules = new GameRules(b);
    let visits = 0, shots = 0;
    for (let i = 0; i < 40; i++) {
      e.health = e.stats.health = 1000;
      a.tu = a.stats.tu = 200;
      const clip = b.items.find((it) => it.id === b.itemInSlot(a, "STR_RIGHT_HAND")!.ammo);
      if (clip) clip.ammoQty = 20;
      const r = rules.apply(0, { c: "shoot", unit: a.id, hand: "STR_RIGHT_HAND", mode: "snap", target: e.pos });
      expect(r.error).toBeUndefined();
      shots++;
      visits += r.events.list.filter((x) => x.e.t === "stranger" && !x.e.gone).length;
    }
    expect(shots).toBe(40);
    if (chance === 0) expect(visits).toBe(0);
    else expect(visits).toBeGreaterThan(5);
    expect(isOut(e)).toBe(false);
  }
});

test("the setting is a percentage, off by default", () => {
  expect(defaultSettings().stranger).toBe(0);
  expect(sanitizeSettings({ stranger: 10 } as never).stranger).toBe(10);
  expect(sanitizeSettings({ stranger: 500 } as never).stranger).toBe(50);
  expect(sanitizeSettings({} as never).stranger).toBe(0);
});
