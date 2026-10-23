// Who may play: anyone can sign in, but with PASSKEY set, an account must enter it once before it can see or
// join matches (it stays unlocked on every device). Sign-ins and passkey attempts are kept in access_log.
import { timingSafeEqual } from "node:crypto";
import { db, type UserRow } from "./db.ts";

const PASSKEY = process.env.PASSKEY ?? "";

/** Wrong guesses allowed per account per hour. */
const MAX_FAILURES = 10;

export type AccessEvent = "login" | "logout" | "passkey_ok" | "passkey_fail";

export function passkeyRequired(): boolean {
  return PASSKEY !== "";
}

/** Whether this account may play (always, when no passkey is set). */
export function mayPlay(user: UserRow): boolean {
  return !PASSKEY || !!user.unlocked;
}

/** The client's address as nginx saw it (the server only listens on localhost behind it). */
function clientIp(req: Request): string {
  return (req.headers.get("x-real-ip") ?? "").slice(0, 64);
}

export function logAccess(req: Request, user: UserRow | null, event: AccessEvent) {
  db.query("INSERT INTO access_log (at, user_id, email, name, event, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    Date.now(), user?.id ?? null, user?.email ?? null, user?.name ?? null, event, clientIp(req), (req.headers.get("user-agent") ?? "").slice(0, 300),
  );
}

/** Checks a passkey for `user`; on success the account is unlocked for good. Returns an error message or null. */
export function tryPasskey(req: Request, user: UserRow, guess: unknown): string | null {
  if (mayPlay(user)) return null;
  const hourAgo = Date.now() - 3600_000;
  const fails = (db.query("SELECT COUNT(*) AS n FROM access_log WHERE user_id = ? AND event = 'passkey_fail' AND at > ?").get(user.id, hourAgo) as { n: number }).n;
  if (fails >= MAX_FAILURES) return "Too many wrong tries: wait a while and try again";
  const a = Buffer.from(String(guess ?? "").trim());
  const b = Buffer.from(PASSKEY);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  logAccess(req, user, ok ? "passkey_ok" : "passkey_fail");
  if (!ok) return "That's not the passkey";
  db.query("UPDATE users SET unlocked = 1 WHERE id = ?").run(user.id);
  return null;
}

export interface AccessLogRow { at: number; user_id: string | null; email: string | null; name: string | null; event: AccessEvent; ip: string; agent: string }

/** The most recent access log entries, newest first. */
export function accessLog(limit = 500): AccessLogRow[] {
  return db.query("SELECT at, user_id, email, name, event, ip, agent FROM access_log ORDER BY at DESC, id DESC LIMIT ?").all(limit) as AccessLogRow[];
}
