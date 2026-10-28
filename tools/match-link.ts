// Match settings for AI agents working in this repo, no running server needed.
//   bun tools/match-link.ts                          # print the reference (the same as the server's /llms.txt)
//   bun tools/match-link.ts '<settings JSON>'        # check settings and print the link that opens them in the form
//   bun tools/match-link.ts --server http://192.168.1.20:3000 settings.json   # a file works too; - reads stdin
// The link opens the New Match form filled in: the player reviews it and presses Create (they become the match's
// creator — in co-op, its game master — so an agent should never create the match itself).
import { readFileSync, existsSync } from "node:fs";
import { settingsReference, checkSettings, parseSettingsText, settingsDelta } from "../shared/settings-docs.ts";

/** What to print for `args` (exported for the tests). */
export function run(args: string[], stdin = () => readFileSync(0, "utf8")): { out: string; ok: boolean } {
  let server = "http://localhost:3000";
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--server") server = (args[++i] ?? server).replace(/\/$/, "");
    else rest.push(args[i]);
  }
  if (!rest.length) return { out: settingsReference(server), ok: true };
  const arg = rest.join(" ");
  const text = arg === "-" ? stdin() : existsSync(arg) ? readFileSync(arg, "utf8") : arg;
  let raw: unknown;
  try {
    raw = parseSettingsText(text);
  } catch (e) {
    return { out: `Couldn't read settings: ${(e as Error).message}`, ok: false };
  }
  const { settings, warnings } = checkSettings(raw);
  const delta = settingsDelta(settings);
  const lines = [
    warnings.length ? `Adjusted (fix these if they're not what you meant):\n${warnings.map((w) => `  - ${w}`).join("\n")}` : "Settings OK.",
    "",
    "Open this link to get the New Match form filled in, check it, and press Create:",
    `${server}/?settings=${encodeURIComponent(JSON.stringify(delta))}`,
    "",
    "Or paste this into the form's \"Set up a match with AI\" box:",
    JSON.stringify(delta, null, 2),
  ];
  return { out: lines.join("\n"), ok: warnings.length === 0 };
}

if (import.meta.main) {
  const { out, ok } = run(process.argv.slice(2));
  console.log(out);
  if (!ok) process.exitCode = 1;
}
