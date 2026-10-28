// Who a request comes from. The game only needs a user; how people prove who they are is up to whoever runs the
// server. Built in (AUTH, comma separated):
//   name   — type a commander name, kept in a cookie session (the default; for a LAN or a group of friends: anyone
//            can sign in under any name)
//   header — trust a header set by an authenticating reverse proxy (Tailscale Serve, Caddy, oauth2-proxy,
//            Cloudflare Access...): AUTH_HEADER holds who it is, AUTH_NAME_HEADER optionally their display name
//   none   — neither: sign-in comes only from plugins
// Anything else (OAuth providers, passwords, invite codes, allow-lists) is an access plugin: a module named in
// PLUGINS (see server/plugin.ts and plugins/).
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { db, randomId, type UserRow } from "./db.ts";
import type { AccessPlugin, Gate, PluginContext, SignInOption } from "./plugin.ts";

/** Fixed external address (`https://game.example.com`); without it links use the address each request came in on. */
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const SESSION_DAYS = 60;

export function origin(req: Request): string {
  if (PUBLIC_URL) return PUBLIC_URL;
  const u = new URL(req.url);
  // behind a TLS-terminating proxy the request itself arrives over plain http
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || u.host;
  return `${proto === "https" || proto === "http" ? proto : u.protocol.slice(0, -1)}://${host}`;
}

export function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* not ours */
      }
    }
  }
  return out;
}

export function cookie(req: Request, name: string, value: string, maxAge: number): string {
  const secure = origin(req).startsWith("https://") ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

/** Only same-site paths are allowed as post-sign-in destinations (no //host, /\host or control chars). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(next)) return "/";
  try {
    const u = new URL(next, "http://x");
    return u.origin === "http://x" ? u.pathname + u.search : "/";
  } catch {
    return "/";
  }
}

/** The account that signs in as `login` ("<method>:<id>"), made on first sign-in. Email and picture follow the sign-in. */
export function userByLogin(login: string, profile: { name: string; email?: string | null; picture?: string | null }): UserRow {
  const found = db.query("SELECT * FROM users WHERE login = ?").get(login) as UserRow | null;
  const email = profile.email ?? null, picture = profile.picture ?? null;
  if (found) {
    if (found.email === email && found.picture === picture) return found;
    db.query("UPDATE users SET email = ?, picture = ? WHERE id = ?").run(email, picture, found.id);
    return { ...found, email, picture };
  }
  const id = randomId(16);
  db.query("INSERT INTO users (id, login, email, name, picture, created) VALUES (?, ?, ?, ?, ?, ?)").run(id, login, email, cleanName(profile.name), picture, Date.now());
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
}

function cleanName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 40) || "Commander";
}

export function renameUser(userId: string, name: string) {
  db.query("UPDATE users SET name = ? WHERE id = ?").run(cleanName(name), userId);
}

/** Signs `user` in with a cookie session and sends the browser on to `next`. */
export function startSession(req: Request, user: UserRow, next: string, headers = new Headers()): Response {
  const sid = randomId(32);
  const now = Date.now();
  db.query("INSERT INTO sessions (id, user_id, created, expires) VALUES (?, ?, ?, ?)").run(sid, user.id, now, now + SESSION_DAYS * 86400_000);
  logAccess(req, user, "login");
  headers.set("Location", safeNext(next));
  headers.append("Set-Cookie", cookie(req, "sid", sid, SESSION_DAYS * 86400));
  return new Response(null, { status: 302, headers });
}

function sessionUser(req: Request): UserRow | null {
  const sid = cookies(req).sid;
  if (!sid) return null;
  return db.query("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires > ?").get(sid, Date.now()) as UserRow | null;
}

export function logout(req: Request): Response {
  const sid = cookies(req).sid;
  const user = sessionUser(req);
  if (user) logAccess(req, user, "logout");
  if (sid) db.query("DELETE FROM sessions WHERE id = ?").run(sid);
  return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookie(req, "sid", "", 0) } });
}

/** The client's address: from the proxy's headers when there is one. */
function clientIp(req: Request): string {
  return (req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim().slice(0, 64);
}

/** Records a sign-in event (login, logout, or anything a plugin wants kept) in access_log. */
export function logAccess(req: Request, user: UserRow | null, event: string) {
  db.query("INSERT INTO access_log (at, user_id, email, name, event, ip, agent) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    Date.now(), user?.id ?? null, user?.email ?? null, user?.name ?? null, event.slice(0, 40), clientIp(req), (req.headers.get("user-agent") ?? "").slice(0, 300),
  );
}

export interface AccessLogRow { at: number; user_id: string | null; email: string | null; name: string | null; event: string; ip: string; agent: string }

/** The most recent access log entries, newest first. */
export function accessLog(limit = 500): AccessLogRow[] {
  return db.query("SELECT at, user_id, email, name, event, ip, agent FROM access_log ORDER BY at DESC, id DESC LIMIT ?").all(limit) as AccessLogRow[];
}

export const context: PluginContext = { db, currentUser, origin, cookies, cookie, safeNext, userByLogin, startSession, logAccess };

// ---- the built-in sign-ins ----

/** Type a name: the same name (any case) is the same account, from any device. */
export function nameSignIn(): AccessPlugin {
  return {
    name: "name",
    signIn: () => [{ label: "Enter", field: { name: "name", placeholder: "Commander name" }, action: "/auth/name" }],
    routes(req, ctx) {
      const url = new URL(req.url);
      if (url.pathname !== "/auth/name") return undefined;
      const name = cleanName(url.searchParams.get("name") ?? "");
      if (!url.searchParams.get("name")?.trim()) return new Response("name required", { status: 400 });
      return ctx.startSession(req, ctx.userByLogin(`name:${name.toLowerCase()}`, { name }), url.searchParams.get("next") ?? "/");
    },
  };
}

/** Header values may be RFC 2047 encoded (Tailscale does this for names outside ASCII). */
function decodeHeader(v: string): string {
  return v.replace(/=\?utf-8\?([bq])\?([^?]*)\?=/gi, (_, enc: string, text: string) => {
    try {
      const bytes = enc.toLowerCase() === "b"
        ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return bytes.toString("utf8");
    } catch {
      return text;
    }
  });
}

/**
 * A reverse proxy in front of the server signs people in and says who they are in a header. Only safe when
 * nobody can reach the server except through that proxy (bind HOST to 127.0.0.1, or firewall the port).
 */
export function headerSignIn(header: string, nameHeader = ""): AccessPlugin {
  return {
    name: "header",
    signIn: () => [{ text: "This server signs players in through its proxy, and your request didn't come through it signed in. Open the server's usual address, or ask whoever runs it." }],
    identify(req, ctx) {
      const who = decodeHeader(req.headers.get(header) ?? "").trim().slice(0, 200);
      if (!who) return null;
      const name = (nameHeader && decodeHeader(req.headers.get(nameHeader) ?? "").trim()) || who.split("@")[0];
      return ctx.userByLogin(`header:${who.toLowerCase()}`, { name, email: who.includes("@") ? who : null, picture: null });
    },
  };
}

// ---- the plugins in use ----

export const plugins: AccessPlugin[] = [];

/** Sets up the built-in sign-ins named in AUTH and loads the modules named in PLUGINS (paths or package names). */
export async function loadPlugins(env = process.env): Promise<string[]> {
  plugins.length = 0;
  const methods = (env.AUTH ?? "name").split(",").map((m) => m.trim().toLowerCase()).filter(Boolean);
  for (const m of methods) {
    if (m === "none") continue;
    if (m === "name") plugins.push(nameSignIn());
    else if (m === "header") {
      if (!env.AUTH_HEADER) throw new Error("AUTH=header needs AUTH_HEADER (the header your proxy puts the signed-in user in)");
      plugins.push(headerSignIn(env.AUTH_HEADER, env.AUTH_NAME_HEADER));
    } else throw new Error(`Unknown AUTH method "${m}" (name, header or none)`);
  }
  for (const spec of (env.PLUGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    // a file (relative to the working directory) if there is one, otherwise a package name
    const target = existsSync(resolve(spec)) ? pathToFileURL(resolve(spec)).href : spec;
    const mod = (await import(target)) as { default?: AccessPlugin | ((ctx: PluginContext) => AccessPlugin | Promise<AccessPlugin>) };
    const p = typeof mod.default === "function" ? await mod.default(context) : mod.default;
    if (!p?.name) throw new Error(`${spec} doesn't export an access plugin (export default { name, ... } or a function returning one)`);
    plugins.push(p);
  }
  if (!plugins.some((p) => p.signIn || p.identify || p.routes)) throw new Error("Nobody can sign in: set AUTH (name, header) or PLUGINS");
  return plugins.map((p) => p.name);
}

/** Who this request is from: a plugin that recognises it (header sign-in), or a session cookie. */
export function currentUser(req: Request): UserRow | null {
  for (const p of plugins) {
    const u = p.identify?.(req, context);
    if (u) return u;
  }
  return sessionUser(req);
}

/** Lets plugins answer their own routes (sign-in callbacks, forms...). */
export async function pluginRoute(req: Request): Promise<Response | undefined> {
  for (const p of plugins) {
    const r = await p.routes?.(req, context);
    if (r) return r;
  }
  return undefined;
}

/** Ways to sign in, for the front door (notes only when there's nothing to press). */
export function signInOptions(req: Request): SignInOption[] {
  const all = plugins.flatMap((p) => p.signIn?.(req) ?? []);
  return all.some((o) => !("text" in o)) ? all.filter((o) => !("text" in o)) : all;
}

/** Something a signed-in user still has to do before playing (a passkey, accepting terms...), or null. */
export function gateFor(user: UserRow, req: Request): Gate | null {
  for (const p of plugins) {
    const g = p.gate?.(user, req);
    if (g) return g;
  }
  return null;
}

/** Whether there's a session to end (not when a proxy says who you are). */
export function canSignOut(req: Request): boolean {
  return !!sessionUser(req);
}

/** ADMINS (comma separated emails or logins such as "name:alice") may download the access log and match statistics. */
const ADMINS = `${process.env.ADMINS ?? ""},${process.env.ADMIN_EMAILS ?? ""}`.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
export function isAdmin(user: UserRow): boolean {
  return (!!user.email && ADMINS.includes(user.email.toLowerCase())) || (!!user.login && ADMINS.includes(user.login.toLowerCase()));
}
