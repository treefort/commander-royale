// Match settings and play links for AI agents working in this repo, no running server needed.
//   bun tools/match-link.ts                          # print the reference (the same as the server's /llms.txt)
//   bun tools/match-link.ts '<settings JSON>'        # check settings and print the link that opens them in the form
//   bun tools/match-link.ts '<setup JSON>'           # check a play setup ({ settings, recipe, opponents, squad })
//   bun tools/match-link.ts --server http://192.168.1.20:3000 settings.json   # a file works too; - reads stdin
//   bun tools/match-link.ts --recipe recipe.json '<settings or setup JSON>'   # play on a map recipe (tools/map.ts)
// The form link opens the New Match form filled in: the player reviews it and presses Create. Play links open a page
// describing the setup, with buttons to create it (squad auto-configured, or theirs to equip first). Either
// way the player creates the match (they become its creator — in co-op, its game master), never the agent.
import { readFileSync, existsSync } from "node:fs";
import { settingsReference, checkSettings, checkSetup, isSetup, parseSettingsText, settingsDelta, setupDelta, playLinks } from "../shared/settings-docs.ts";
import { compileRecipe } from "../shared/maps/recipe.ts";
import { files, has } from "./gamefiles.ts";

/** Problems building a recipe, or null when there's no game data here to build it with. */
function recipeProblems(recipe: unknown): string[] | null {
  if (!has("GEODATA/LOFTEMPS.DAT")) return null;
  try {
    const { warnings, issues } = compileRecipe(recipe, files);
    return [...warnings, ...issues.map((i) => `${i.level}: ${i.text}`)];
  } catch (e) {
    return [(e as Error).message];
  }
}

/** What to print for `args` (exported for the tests). */
export function run(args: string[], stdin = () => readFileSync(0, "utf8")): { out: string; ok: boolean } {
  let server = "http://localhost:3000";
  let recipeArg: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server") server = (args[++i] ?? server).replace(/\/$/, "");
    else if (args[i] === "--recipe") recipeArg = args[++i];
    else rest.push(args[i]);
  }
  if (!rest.length && !recipeArg) return { out: settingsReference(server), ok: true };
  const read = (arg: string) => (arg === "-" ? stdin() : existsSync(arg) ? readFileSync(arg, "utf8") : arg);
  let raw: unknown;
  let recipe: unknown;
  try {
    raw = rest.length ? parseSettingsText(read(rest.join(" "))) : {};
    if (recipeArg) recipe = JSON.parse(read(recipeArg));
  } catch (e) {
    return { out: `Couldn't read settings: ${(e as Error).message}`, ok: false };
  }
  const bare = !isSetup(raw);
  const given = (bare ? { settings: raw } : raw) as Record<string, unknown>;
  if (recipe !== undefined) given.recipe = recipe;
  const { setup, warnings } = checkSetup(given);
  // bare settings are for the form first: what only a play link changes (the player on a co-op team) is a note
  const formWarnings = new Set(checkSettings(given.settings ?? {}).warnings.map((w) => `settings.${w}`));
  const fix = bare ? warnings.filter((w) => formWarnings.has(w)) : warnings;
  const notes = warnings.filter((w) => !fix.includes(w));
  const lines: string[] = [];
  let ok = fix.length === 0;
  lines.push(fix.length ? `Adjusted (fix these if they're not what you meant):\n${fix.map((w) => `  - ${w}`).join("\n")}` : "Settings OK.");
  if (notes.length) lines.push(`The play links differ from the form:\n${notes.map((w) => `  - ${w}`).join("\n")}`);
  if (setup.recipe) {
    const problems = recipeProblems(setup.recipe);
    if (problems === null) lines.push("(No game data here to build the recipe with: check it with bun tools/map.ts build.)");
    else if (problems.length) {
      ok = false;
      lines.push(`The map recipe (fix it, or check it with bun tools/map.ts build):\n${problems.map((w) => `  - ${w}`).join("\n")}`);
    } else lines.push("Map recipe OK.");
  }
  const delta = setupDelta(setup);
  const links = playLinks(server, delta);
  lines.push(
    "",
    "Auto-configured squad, the battle starts at once:",
    links.auto,
    "",
    "The player hires and equips the squad; the battle starts when they press Ready:",
    links.equip,
  );
  if (!setup.recipe) {
    // the form doesn't take opponents (they're added in the lobby), so it gets the settings as they were asked for
    const settings = settingsDelta(checkSettings(given.settings ?? {}).settings);
    lines.push(
      "",
      "Or open the New Match form filled in, check it, and press Create:",
      `${server}/?settings=${encodeURIComponent(JSON.stringify(settings))}`,
      "",
      "Or paste this into the form's \"Set up a match with AI\" box:",
      JSON.stringify(settings, null, 2),
    );
  }
  lines.push("", "The play setup:", JSON.stringify(delta, null, 2));
  return { out: lines.join("\n"), ok };
}

if (import.meta.main) {
  const { out, ok } = run(process.argv.slice(2));
  console.log(out);
  if (!ok) process.exitCode = 1;
}
