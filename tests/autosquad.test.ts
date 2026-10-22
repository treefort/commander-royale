import { test, expect } from "bun:test";
import { defaultSettings, sanitizeSettings, type MatchSettings } from "../shared/protocol.ts";
import { generatePool, checkLoadout } from "../shared/rules/catalog.ts";
import { autoSquad } from "../shared/rules/squads.ts";

function check(raw: Partial<MatchSettings>, seed = 3) {
  const s = sanitizeSettings({ ...defaultSettings(), ...raw });
  const pool = generatePool(s, seed);
  const { loadout, strategy } = autoSquad(s, pool);
  const limitSettings = s.mode === "coop" ? s : s;
  const chk = checkLoadout(limitSettings, pool, loadout);
  return { s, pool, loadout, strategy, chk };
}

test("auto-configure builds a legal squad that uses the money and seats, whatever the settings", () => {
  for (const raw of [
    {},
    { budget: 50_000 },
    { budget: 5_000_000 },
    { techLevel: "conventional" as const, allowArmor: false, allowAliens: false, allowHWP: false, psionics: false },
    { squadLimit: 4, budget: 1_000_000 },
    { timeOfDay: "night" as const },
  ]) {
    for (const seed of [1, 2, 3]) {
      const { s, loadout, chk } = check(raw, seed);
      expect([JSON.stringify(raw), chk.errors]).toEqual([JSON.stringify(raw), []]);
      expect(loadout.squad.length).toBeGreaterThan(0);
      // the money goes on the squad, not back in the bank (unless the seats run out first)
      if (chk.seats < s.squadLimit - 3) expect(chk.cost).toBeGreaterThan(s.budget * 0.6);
    }
  }
});

test("auto-configure follows the settings: no banned units or gear, flares at night, a medikit", () => {
  const { pool, loadout } = check({ techLevel: "conventional", allowAliens: false, allowHWP: false, allowArmor: false });
  for (const m of loadout.squad) {
    expect(pool.find((p) => p.id === m.recruitId)!.kind).toBe("soldier");
    expect(m.armor).toBe("STR_NONE_UC");
    for (const it of m.items) expect(it.type).not.toMatch(/LASER|PLASMA|BLASTER/);
  }
  const night = check({ timeOfDay: "night" });
  expect(night.loadout.squad.some((m) => m.items.some((i) => i.type === "STR_ELECTRO_FLARE"))).toBe(true);
  expect(check({}).loadout.squad.some((m) => m.items.some((i) => i.type === "STR_MEDI_KIT"))).toBe(true);
});

test("in a co-op scenario it fills the player's own Skyranger seats", () => {
  for (const seats of [1, 3, 8]) {
    const s = sanitizeSettings({ ...defaultSettings(), mode: "coop", budget: 400_000, scenario: { ...defaultSettings().scenario, seatsPerPlayer: seats } });
    const pool = generatePool(s, 5);
    const { loadout } = autoSquad(s, pool);
    const chk = checkLoadout(s, pool, loadout);
    expect([seats, chk.errors]).toEqual([seats, []]);
    expect(chk.seats).toBeLessThanOrEqual(seats);
    expect(chk.seats).toBeGreaterThan(0);
  }
});
