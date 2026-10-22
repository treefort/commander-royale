import { test, expect } from "bun:test";
import { defaultSettings, sanitizeSettings } from "../shared/protocol.ts";
import { FIELDS, EXAMPLES, settingsReference, checkSettings, parseSettingsText, settingsDelta } from "../shared/settings-docs.ts";
import { enemyTypeChoices } from "../shared/rules/scenario.ts";

/** Every leaf setting path of an object ("scenario.enemies" counts as one, its groups are documented as []). */
function leaves(o: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) => {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) return leaves(v as Record<string, unknown>, p);
    return [p];
  });
}

function setAt(o: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.replace("enemies[]", "enemies.0").split(".");
  let cur: Record<string, unknown> = o;
  keys.slice(0, -1).forEach((k, i) => {
    cur[k] ??= /^\d+$/.test(keys[i + 1]) ? [] : {};
    cur = cur[k] as Record<string, unknown>;
  });
  cur[keys[keys.length - 1]] = value;
}

function getAt(o: unknown, path: string): unknown {
  return path.replace("enemies[]", "enemies.0").split(".").reduce((a, k) => (a as Record<string, unknown>)?.[k], o);
}

test("every setting is documented for AI assistants, and nothing documented is made up", () => {
  const documented = new Set(FIELDS.map((f) => f.path));
  // "strength" only matters for free-for-all computer squads, which are added in the lobby
  const all = leaves(defaultSettings() as unknown as Record<string, unknown>).filter((p) => p !== "scenario.ai.strength");
  for (const p of all) expect(documented.has(p) ? p : `undocumented: ${p}`).toBe(p);
  for (const f of FIELDS) if (!f.path.includes("[]")) expect(getAt(defaultSettings(), f.path) === undefined ? `not a setting: ${f.path}` : f.path).toBe(f.path);
});

test("the documented ranges are the ones the server enforces", () => {
  for (const f of FIELDS) {
    if (!f.range) continue;
    const [lo, hi] = f.range;
    for (const [v, want] of [[lo - 1, lo], [hi + 1, hi], [lo, lo], [hi, hi]] as const) {
      const raw: Record<string, unknown> = { mode: f.mode === "ffa" ? "ffa" : "coop", scenario: { enemies: [{ type: "STR_SECTOID_SOLDIER", round: 1 }] } };
      setAt(raw, f.path, v);
      // an enemy group arriving later still needs one there from the start
      if (f.path === "scenario.enemies[].round") (raw.scenario as { enemies: unknown[] }).enemies.push({ type: "STR_SECTOID_SOLDIER", round: 1 });
      expect([f.path, v, getAt(sanitizeSettings(raw), f.path)]).toEqual([f.path, v, want]);
    }
  }
});

test("the examples are valid as written, and the reference lists every enemy", () => {
  for (const e of EXAMPLES) expect([e.ask, checkSettings(e.settings).warnings]).toEqual([e.ask, []]);
  const ref = settingsReference("https://xcom.example");
  for (const t of enemyTypeChoices()) expect(ref).toContain(`\`${t.id}\``);
  expect(ref).toContain("https://xcom.example/?settings=");
  expect(ref.length).toBeLessThan(60_000);
});

test("pasted answers are read whatever shape they come in, and mistakes are reported", () => {
  const s = { mode: "coop", biome: "MARS" };
  const json = JSON.stringify(s);
  expect(parseSettingsText(json)).toEqual(s);
  expect(parseSettingsText(`Here you go:\n\`\`\`json\n${json}\n\`\`\`\nHave fun!`)).toEqual(s);
  expect(parseSettingsText(`https://xcom.example/?settings=${encodeURIComponent(json)}`)).toEqual(s);
  expect(() => parseSettingsText("make it hard please")).toThrow();
  const { warnings } = checkSettings({ mode: "coop", maxPlayers: 40, bogus: 1, ufo: "none", scenario: { enemies: [{ type: "STR_MUTON_SOLDIER", placement: "ufo" }, { type: "STR_NOPE", weapon: "STR_SPOON" }] } });
  expect(warnings.join("\n")).toContain("maxPlayers: 40 isn't allowed here, using 10");
  expect(warnings.join("\n")).toContain("bogus: not a setting");
  expect(warnings.join("\n")).toContain("\"ufo\" placement without a landed UFO");
  expect(warnings.join("\n")).toContain("no such unit \"STR_NOPE\"");
  expect(warnings.join("\n")).toContain("no such weapon \"STR_SPOON\"");
  // what comes back is what will happen: the unknown group is gone, the unknown weapon is standard
  const fixed = checkSettings({ mode: "coop", scenario: { enemies: [{ type: "STR_MUTON_SOLDIER", weapon: "STR_SPOON" }, { type: "STR_NOPE" }] } }).settings;
  expect(fixed.scenario.enemies.map((g) => [g.type, g.weapon])).toEqual([["STR_MUTON_SOLDIER", "standard"]]);
  // partial nested settings keep the other defaults (a drop tier alone doesn't switch drops off)
  expect(checkSettings({ supplyDrops: { tier: "alien" } }).settings.supplyDrops).toEqual({ ...defaultSettings().supplyDrops, tier: "alien" });
});

test("copying the form as JSON gives just what changed, and it comes back the same", () => {
  for (const e of EXAMPLES) {
    const full = sanitizeSettings(e.settings);
    const delta = settingsDelta(full);
    expect(sanitizeSettings(delta)).toEqual(full);
    expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(full).length);
  }
  expect(settingsDelta(defaultSettings())).toEqual({ mode: "ffa" });
});
