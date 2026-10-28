import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

test("every environment variable the server and plugins read is documented in examples/README.md", () => {
  const doc = readFileSync(join(ROOT, "examples", "README.md"), "utf8");
  const sources = ["server", "plugins", "shared"].flatMap((d) =>
    readdirSync(join(ROOT, d), { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(ROOT, d, f), "utf8")));
  const vars = new Set(sources.flatMap((s) => [...s.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1])));
  expect(vars.size).toBeGreaterThan(10);
  for (const v of vars) expect(doc.includes(`\`${v}\``) ? v : `undocumented: ${v}`).toBe(v);
});
