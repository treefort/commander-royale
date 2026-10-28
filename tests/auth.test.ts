import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function setup() {
  if (!process.env.DB_PATH) process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "xcom-auth-")), "test.sqlite");
  return { db: (await import("../server/db.ts")).db, auth: await import("../server/auth.ts") };
}

/** The session cookie a sign-in response set, as a request header. */
function sid(res: Response): string {
  const c = res.headers.getSetCookie().find((h) => h.startsWith("sid="))!;
  return c.split(";")[0];
}

test("name sign-in: the same name is the same account, and only same-site destinations are followed", async () => {
  const { auth } = await setup();
  await auth.loadPlugins({});
  expect(auth.signInOptions(new Request("http://localhost/"))).toEqual([{ label: "Enter", field: { name: "name", placeholder: "Commander name" }, action: "/auth/name" }]);
  const res = (await auth.pluginRoute(new Request("http://localhost/auth/name?name=%20Ripley%20&next=/m/abc")))!;
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/m/abc");
  const me = auth.currentUser(new Request("http://localhost/api/me", { headers: { cookie: sid(res) } }))!;
  expect([me.name, me.login]).toEqual(["Ripley", "name:ripley"]);
  const again = (await auth.pluginRoute(new Request("http://localhost/auth/name?name=RIPLEY&next=//evil.example")))!;
  expect(again.headers.get("location")).toBe("/");
  expect(auth.currentUser(new Request("http://localhost/", { headers: { cookie: sid(again) } }))!.id).toBe(me.id);
  // plain http: no Secure flag; behind an https proxy: Secure
  expect(again.headers.getSetCookie().join()).not.toContain("Secure");
  const tls = (await auth.pluginRoute(new Request("http://localhost/auth/name?name=Hicks", { headers: { "x-forwarded-proto": "https" } })))!;
  expect(tls.headers.getSetCookie().join()).toContain("Secure");
  expect(auth.canSignOut(new Request("http://localhost/", { headers: { cookie: sid(again) } }))).toBe(true);
  await expect(auth.loadPlugins({ AUTH: "none" })).rejects.toThrow("Nobody can sign in");
  await expect(auth.loadPlugins({ AUTH: "header" })).rejects.toThrow("AUTH_HEADER");
});

test("header sign-in trusts the proxy's header (RFC 2047 names too) and has no sign-out", async () => {
  const { auth } = await setup();
  await auth.loadPlugins({ AUTH: "header", AUTH_HEADER: "Tailscale-User-Login", AUTH_NAME_HEADER: "Tailscale-User-Name" });
  expect(auth.currentUser(new Request("http://localhost/"))).toBeNull();
  const req = (name: string) => new Request("http://localhost/", { headers: { "Tailscale-User-Login": "Vasquez@example.com", "Tailscale-User-Name": name } });
  const u = auth.currentUser(req("=?utf-8?q?Jenette_V=C3=A1squez?="))!;
  expect([u.name, u.login, u.email]).toEqual(["Jenette Vásquez", "header:vasquez@example.com", "Vasquez@example.com"]);
  // the same account every request; a rename sticks
  auth.renameUser(u.id, "Vasquez");
  expect(auth.currentUser(req("Someone Else"))!).toMatchObject({ id: u.id, name: "Vasquez" });
  expect(auth.canSignOut(req("Vasquez"))).toBe(false);
  expect(auth.signInOptions(new Request("http://localhost/"))[0]).toHaveProperty("text");
});

test("the passkey plugin gates accounts until they enter it, limits guesses, and logs every try", async () => {
  const { db, auth } = await setup();
  const dir = join(import.meta.dir, "..", "plugins");
  await expect(auth.loadPlugins({ AUTH: "name", PLUGINS: join(dir, "passkey.ts") })).rejects.toThrow("PASSKEY");
  process.env.PASSKEY = "open sesame";
  try {
    // a path relative to the working directory works too
    expect(await auth.loadPlugins({ PLUGINS: "plugins/passkey.ts" })).toEqual(["name", "passkey"]);
  } finally {
    delete process.env.PASSKEY;
  }
  const signIn = (await auth.pluginRoute(new Request("http://localhost/auth/name?name=Zed", { headers: { "x-real-ip": "203.0.113.7", "user-agent": "test" } })))!;
  const cookie = sid(signIn);
  const zed = auth.currentUser(new Request("http://localhost/", { headers: { cookie } }))!;
  expect(auth.gateFor(zed, new Request("http://localhost/"))).toMatchObject({ action: "/auth/passkey", field: { type: "password" } });
  const tryKey = async (value: string) => {
    const r = (await auth.pluginRoute(new Request("http://localhost/auth/passkey", { method: "POST", body: JSON.stringify({ value }), headers: { cookie, "x-real-ip": "203.0.113.7", "user-agent": "test" } })))!;
    return [r.status, await r.json()];
  };
  expect(await tryKey("sesame")).toEqual([403, { error: "That's not the passkey" }]);
  expect(await tryKey(" open sesame ")).toEqual([200, { ok: true }]);
  expect(auth.gateFor(zed, new Request("http://localhost/"))).toBeNull();
  const log = auth.accessLog().filter((r) => r.user_id === zed.id);
  expect(log.map((r) => r.event)).toEqual(["passkey_ok", "passkey_fail", "login"]);
  expect(log[2]).toMatchObject({ name: "Zed", ip: "203.0.113.7", agent: "test" });
  // too many wrong guesses in an hour locks guessing out for a while
  const yan = auth.userByLogin("name:yan", { name: "Yan" });
  for (let i = 0; i < 10; i++) db.query("INSERT INTO access_log (at, user_id, event) VALUES (?, ?, 'passkey_fail')").run(Date.now(), yan.id);
  const r = (await auth.pluginRoute(new Request("http://localhost/auth/passkey", { method: "POST", body: JSON.stringify({ value: "open sesame" }), headers: { cookie: sid((await auth.pluginRoute(new Request("http://localhost/auth/name?name=Yan")))!) } })))!;
  expect((await r.json()).error).toContain("Too many");
  await auth.loadPlugins({});
});

test("the allow-list plugin lets in only the listed emails and logins", async () => {
  const { auth } = await setup();
  const allowlist = (await import("../plugins/allowlist.ts")).default;
  const p = allowlist(null, "Ann@Example.com, name:bob");
  const ann = auth.userByLogin("google:al1", { name: "Ann", email: "ann@example.com" });
  const bob = auth.userByLogin("name:bob", { name: "Bob" });
  const eve = auth.userByLogin("name:eve", { name: "Eve" });
  const req = new Request("http://localhost/");
  expect([p.gate!(ann, req), p.gate!(bob, req)]).toEqual([null, null]);
  expect(p.gate!(eve, req)).toMatchObject({ text: expect.stringContaining("invite-only") });
  expect(p.gate!(eve, req)!.field).toBeUndefined();
});

test("accounts from before pluggable sign-in keep working", async () => {
  const { migrateLogins } = await import("../server/db.ts");
  const d = new Database(":memory:");
  d.exec("CREATE TABLE users (id TEXT PRIMARY KEY, google_sub TEXT UNIQUE, email TEXT, name TEXT NOT NULL, picture TEXT, created INTEGER NOT NULL, unlocked INTEGER NOT NULL DEFAULT 0)");
  d.exec("INSERT INTO users VALUES ('a', '1093', 'a@example.com', 'Ann', NULL, 0, 1), ('b', 'dev:bob', NULL, 'Bob', NULL, 0, 0), ('c', NULL, NULL, 'Bot', NULL, 0, 0)");
  migrateLogins(d);
  migrateLogins(d);
  expect(d.query("SELECT id, login FROM users ORDER BY id").all()).toEqual([{ id: "a", login: "google:1093" }, { id: "b", login: "name:bob" }, { id: "c", login: null }]);
});
