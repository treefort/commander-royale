// Access plugin: a shared passkey. Anyone can sign in (by whatever method), but an account has to enter the
// passkey once before it can see or join matches; it stays unlocked on every device. Wrong guesses are limited
// per account and every attempt is in the access log.
//   PLUGINS=plugins/passkey.ts PASSKEY=<what you tell your friends>
import { timingSafeEqual } from "node:crypto";
import type { AccessPlugin, PluginContext, UserRow } from "../server/plugin.ts";

/** Wrong guesses allowed per account per hour. */
const MAX_FAILURES = 10;

export default function passkey(ctx: PluginContext, key = process.env.PASSKEY ?? ""): AccessPlugin {
  if (!key) throw new Error("plugins/passkey.ts needs PASSKEY");
  const { db } = ctx;
  db.exec("CREATE TABLE IF NOT EXISTS passkey_unlocked (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, at INTEGER NOT NULL)");
  // accounts unlocked before this was a plugin (a users.unlocked column)
  if ((db.query("SELECT COUNT(*) AS n FROM pragma_table_info('users') WHERE name = 'unlocked'").get() as { n: number }).n) {
    db.exec("INSERT OR IGNORE INTO passkey_unlocked (user_id, at) SELECT id, created FROM users WHERE unlocked = 1");
  }
  const unlocked = (user: UserRow) => !!db.query("SELECT 1 FROM passkey_unlocked WHERE user_id = ?").get(user.id);

  /** Checks a guess; on success the account is unlocked for good. Returns an error message or null. */
  function tryPasskey(req: Request, user: UserRow, guess: unknown): string | null {
    if (unlocked(user)) return null;
    const hourAgo = Date.now() - 3600_000;
    const fails = (db.query("SELECT COUNT(*) AS n FROM access_log WHERE user_id = ? AND event = 'passkey_fail' AND at > ?").get(user.id, hourAgo) as { n: number }).n;
    if (fails >= MAX_FAILURES) return "Too many wrong tries: wait a while and try again";
    const a = Buffer.from(String(guess ?? "").trim());
    const b = Buffer.from(key);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    ctx.logAccess(req, user, ok ? "passkey_ok" : "passkey_fail");
    if (!ok) return "That's not the passkey";
    db.query("INSERT OR IGNORE INTO passkey_unlocked (user_id, at) VALUES (?, ?)").run(user.id, Date.now());
    return null;
  }

  return {
    name: "passkey",
    gate: (user) => unlocked(user) ? null : {
      text: "This server is for invited players: enter the passkey you were given. You only need it once.",
      field: { placeholder: "Passkey", type: "password" },
      action: "/auth/passkey",
    },
    async routes(req, c) {
      if (new URL(req.url).pathname !== "/auth/passkey" || req.method !== "POST") return undefined;
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      const user = c.currentUser(req);
      if (!user) return json({ error: "Sign in first" }, 401);
      const body = (await req.json().catch(() => ({}))) as { value?: unknown };
      const e = tryPasskey(req, user, body.value);
      return e ? json({ error: e }, 403) : json({ ok: true });
    },
  };
}
