import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { files } from "../tools/gamefiles.ts";
import { defaultSettings, pricingTime } from "../shared/protocol.ts";
import { generatePool, checkLoadout, priceUnit, trainedStats, trainingCost, trainingErrors, MAX_SESSIONS, TRAINING_PREMIUM } from "../shared/rules/catalog.ts";
import { SOLDIER } from "../shared/rules/index.ts";
import { createBattle } from "../shared/engine/setup.ts";
import type { UserRow } from "../server/db.ts";

const s = { ...defaultSettings(), biome: "CULTA" as const, timeOfDay: "day" as const, ufo: "none" };
const pool = generatePool(s, 21);
const rookie = pool.find((r) => r.kind === "soldier" && r.rank === "STR_ROOKIE")!;
const alien = pool.find((r) => r.kind === "alien")!;

test("training adds to a soldier's stats, never past the original caps", () => {
  const t = trainedStats(rookie.stats, { marksmanship: 2, fitness: 1 });
  expect(t.firing).toBe(Math.min(SOLDIER.statCaps.firing, rookie.stats.firing + 10));
  expect(t.tu).toBe(Math.min(SOLDIER.statCaps.tu, rookie.stats.tu + 3));
  expect(t.stamina).toBe(Math.min(SOLDIER.statCaps.stamina, rookie.stats.stamina + 5));
  expect(t.reactions).toBe(rookie.stats.reactions);
  // sessions past the limit don't count
  expect(trainedStats(rookie.stats, { reflexes: 99 }).reactions).toBe(Math.min(SOLDIER.statCaps.reactions, rookie.stats.reactions + 5 * MAX_SESSIONS));
  const maxed = trainedStats({ ...rookie.stats, health: 59, strength: 69 }, { toughness: 4 });
  expect([maxed.health, maxed.strength]).toEqual([SOLDIER.statCaps.health, SOLDIER.statCaps.strength]);
});

test("training costs what the better stats are worth, plus the premium", () => {
  const time = pricingTime(s.timeOfDay);
  const t = { marksmanship: 3, reflexes: 2 };
  const worth = priceUnit("soldier", "SOLDIER", trainedStats(rookie.stats, t), s.psionics, undefined, time).price - priceUnit("soldier", "SOLDIER", rookie.stats, s.psionics, undefined, time).price;
  expect(worth).toBeGreaterThan(0);
  // the model values soldier stats modestly (gear decides fights): a session costs $1,000 unless it's worth more
  expect(trainingCost(s, rookie, t)).toBe(Math.max(5 * 1000, Math.round((worth * TRAINING_PREMIUM) / 500) * 500));
  const psiAce = { ...rookie, stats: { ...rookie.stats, psiStrength: 90 } };
  const psiWorth = priceUnit("soldier", "SOLDIER", trainedStats(psiAce.stats, { psi: 4 }), s.psionics, undefined, time).price - priceUnit("soldier", "SOLDIER", psiAce.stats, s.psionics, undefined, time).price;
  expect(trainingCost(s, psiAce, { psi: 4 })).toBe(Math.max(4000, Math.round((psiWorth * TRAINING_PREMIUM) / 500) * 500));
  // more training costs more; none is free; even barely-valued training costs something
  expect(trainingCost(s, rookie, { marksmanship: 4 })).toBeGreaterThan(trainingCost(s, rookie, { marksmanship: 1 }));
  expect(trainingCost(s, rookie, undefined)).toBe(0);
  expect(trainingCost(s, rookie, { grenadier: 2 })).toBeGreaterThanOrEqual(2000);
  // it's part of what the squad costs
  const base = checkLoadout(s, pool, { squad: [{ recruitId: rookie.id, armor: "STR_NONE_UC", items: [] }], stash: [] });
  const trained = checkLoadout(s, pool, { squad: [{ recruitId: rookie.id, armor: "STR_NONE_UC", items: [], training: t }], stash: [] });
  expect(trained.cost - base.cost).toBe(trainingCost(s, rookie, t));
  expect(trained.ok).toBe(true);
});

test("only human soldiers train, psi training needs psionics, and sessions are limited", () => {
  expect(trainingErrors(s, alien, { marksmanship: 1 }).join()).toContain("only human soldiers");
  expect(trainingErrors({ ...s, psionics: false }, rookie, { psi: 1 }).join()).toContain("psionics");
  expect(trainingErrors(s, rookie, { psi: 1 })).toEqual([]);
  expect(trainingErrors(s, rookie, { fitness: MAX_SESSIONS + 1 }).join()).toContain(`0-${MAX_SESSIONS}`);
  expect(trainingErrors(s, rookie, { nope: 1 } as never).join()).toContain("Unknown training");
  expect(checkLoadout(s, pool, { squad: [{ recruitId: alien.id, armor: "STR_NONE_UC", items: [], training: { reflexes: 1 } }], stash: [] }).ok).toBe(false);
});

test("trained soldiers fight with their trained stats", () => {
  const other = pool.filter((r) => r.kind === "soldier")[5];
  const b = createBattle(s, [
    { userId: "a", name: "A", loadout: { squad: [{ recruitId: rookie.id, armor: "STR_NONE_UC", items: [], training: { marksmanship: 4, psi: 2 } }], stash: [] } },
    { userId: "b", name: "B", loadout: { squad: [{ recruitId: other.id, armor: "STR_NONE_UC", items: [] }], stash: [] } },
  ], pool, 21, files);
  const u = b.units.find((x) => x.owner === 0)!;
  expect(u.stats.firing).toBe(Math.min(SOLDIER.statCaps.firing, rookie.stats.firing + 20));
  expect(u.stats.psiSkill).toBe(rookie.stats.psiSkill + 20);
  // the pool itself is untouched
  expect(pool.find((r) => r.id === rookie.id)!.stats.firing).toBe(rookie.stats.firing);
});

test("the server keeps a loadout's training and charges for it", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-train-")), "test.sqlite");
  const { db } = await import("../server/db.ts");
  const game = await import("../server/game.ts");
  db.query("INSERT OR IGNORE INTO users (id, google_sub, email, name, picture, created) VALUES ('tr_ann', NULL, NULL, 'tr_ann', NULL, ?)").run(Date.now());
  const ann = db.query("SELECT * FROM users WHERE id = 'tr_ann'").get() as UserRow;
  const { id } = game.createMatch(ann, { budget: 200_000 });
  const lobby = game.lobbyState(id, ann)!;
  const r = lobby.pool.find((x) => x.kind === "soldier")!;
  const res = game.saveLoadout(id, ann, { squad: [{ recruitId: r.id, armor: "STR_NONE_UC", items: [], training: { reflexes: 2, bogus: 3, fitness: -1 } as never }], stash: [] });
  expect(res.check!.ok).toBe(true);
  const saved = game.lobbyState(id, ann)!.you!.loadout!;
  expect(saved.squad[0].training).toEqual({ reflexes: 2 });
  expect(res.check!.cost).toBe(r.price + trainingCost(lobby.settings, r, { reflexes: 2 }));
  expect(game.saveLoadout(id, ann, { squad: [{ recruitId: r.id, armor: "STR_NONE_UC", items: [], training: { reflexes: 9 } }], stash: [] }).check!.ok).toBe(false);
  game.deleteMatch(id, ann);
});
