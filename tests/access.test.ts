import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UserRow } from "../server/db.ts";

test("the passkey unlocks an account for good, wrong guesses are limited, and everything is logged", async () => {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-access-")), "test.sqlite");
  process.env.PASSKEY = "clapthemcheeks";
  const { db } = await import("../server/db.ts");
  const access = await import("../server/access.ts");
  db.query("INSERT OR IGNORE INTO users (id, google_sub, email, name, picture, created) VALUES ('ac_zed', 'g:zed', 'zed@example.com', 'Zed', NULL, ?)").run(Date.now());
  const zed = () => db.query("SELECT * FROM users WHERE id = 'ac_zed'").get() as UserRow;
  const req = new Request("http://localhost/api/passkey", { headers: { "x-real-ip": "203.0.113.7", "user-agent": "test" } });
  expect(access.passkeyRequired()).toBe(true);
  access.logAccess(req, zed(), "login");
  expect(access.mayPlay(zed())).toBe(false);
  expect(access.tryPasskey(req, zed(), "clap")).toBe("That's not the passkey");
  expect(access.mayPlay(zed())).toBe(false);
  expect(access.tryPasskey(req, zed(), " clapthemcheeks ")).toBeNull();
  expect(access.mayPlay(zed())).toBe(true);
  const log = access.accessLog().filter((r) => r.user_id === "ac_zed");
  expect(log.map((r) => r.event)).toEqual(["passkey_ok", "passkey_fail", "login"]);
  expect(log[0]).toMatchObject({ email: "zed@example.com", ip: "203.0.113.7", agent: "test" });
  // too many wrong guesses in an hour locks guessing out for a while
  db.query("INSERT OR IGNORE INTO users (id, google_sub, email, name, picture, created) VALUES ('ac_yan', 'g:yan', NULL, 'Yan', NULL, ?)").run(Date.now());
  const yan = db.query("SELECT * FROM users WHERE id = 'ac_yan'").get() as UserRow;
  for (let i = 0; i < 10; i++) access.tryPasskey(req, yan, "nope");
  expect(access.tryPasskey(req, yan, "clapthemcheeks")).toContain("Too many");
  delete process.env.PASSKEY;
});
