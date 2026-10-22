// Google sign-in (OAuth 2.0 authorization code flow) and cookie sessions.
// Without GOOGLE_CLIENT_ID a local "dev login" is offered instead (never enable it in production).
import { db, randomId, type UserRow } from "./db.ts";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
// Dev login must be asked for explicitly, or the server must only be reachable on localhost.
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(PUBLIC_URL);
export const DEV_LOGIN = process.env.DEV_LOGIN === "1" || (LOCAL && !CLIENT_ID && process.env.DEV_LOGIN !== "0");
const SECURE = PUBLIC_URL.startsWith("https://");
const SESSION_DAYS = 60;

export function googleEnabled() {
  return !!CLIENT_ID && !!CLIENT_SECRET;
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE ? "; Secure" : ""}`;
}

export function currentUser(req: Request): UserRow | null {
  const sid = cookies(req).sid;
  if (!sid) return null;
  const row = db.query("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires > ?").get(sid, Date.now()) as UserRow | null;
  return row;
}

function startSession(userId: string, next: string): Response {
  const sid = randomId(32);
  const now = Date.now();
  db.query("INSERT INTO sessions (id, user_id, created, expires) VALUES (?, ?, ?, ?)").run(sid, userId, now, now + SESSION_DAYS * 86400_000);
  const headers = new Headers({ Location: safeNext(next) });
  headers.append("Set-Cookie", cookie("sid", sid, SESSION_DAYS * 86400));
  headers.append("Set-Cookie", cookie("oauth_state", "", 0));
  return new Response(null, { status: 302, headers });
}

/** Only same-site paths are allowed as post-login destinations (no //host, /\host or control chars). */
function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\x00-\x1f\x7f]/.test(next)) return "/";
  try {
    const u = new URL(next, PUBLIC_URL);
    return u.origin === new URL(PUBLIC_URL).origin ? u.pathname + u.search : "/";
  } catch {
    return "/";
  }
}

export function logout(req: Request): Response {
  const sid = cookies(req).sid;
  if (sid) db.query("DELETE FROM sessions WHERE id = ?").run(sid);
  return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookie("sid", "", 0) } });
}

export function googleStart(req: Request): Response {
  const url = new URL(req.url);
  const state = randomId(24);
  const next = safeNext(url.searchParams.get("next"));
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${PUBLIC_URL}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return new Response(null, {
    status: 302,
    headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, "Set-Cookie": cookie("oauth_state", `${state}|${next}`, 600) },
  });
}

export async function googleCallback(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const [expected, next] = (cookies(req).oauth_state ?? "").split("|");
  if (!expected || url.searchParams.get("state") !== expected) return new Response("Sign-in expired, please try again.", { status: 400 });
  const code = url.searchParams.get("code");
  if (!code) return new Response("Sign-in was cancelled.", { status: 400 });
  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: `${PUBLIC_URL}/auth/google/callback`, grant_type: "authorization_code" }),
  });
  if (!tok.ok) return new Response("Google sign-in failed.", { status: 502 });
  const { id_token } = (await tok.json()) as { id_token: string };
  // the token came straight from Google's token endpoint over TLS, so its claims can be trusted
  const claims = JSON.parse(Buffer.from(id_token.split(".")[1], "base64url").toString("utf8")) as { sub: string; email?: string; name?: string; picture?: string; aud: string; iss: string };
  if (claims.aud !== CLIENT_ID || !/accounts\.google\.com$/.test(claims.iss)) return new Response("Invalid sign-in token.", { status: 400 });
  let user = db.query("SELECT * FROM users WHERE google_sub = ?").get(claims.sub) as UserRow | null;
  if (!user) {
    const id = randomId(16);
    db.query("INSERT INTO users (id, google_sub, email, name, picture, created) VALUES (?, ?, ?, ?, ?, ?)").run(id, claims.sub, claims.email ?? null, (claims.name ?? claims.email ?? "Commander").slice(0, 40), claims.picture ?? null, Date.now());
    user = db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  } else {
    db.query("UPDATE users SET email = ?, picture = ? WHERE id = ?").run(claims.email ?? null, claims.picture ?? null, user.id);
  }
  return startSession(user.id, next);
}

/** Local development only: sign in as any name. */
export function devLogin(req: Request): Response {
  if (!DEV_LOGIN) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const name = (url.searchParams.get("name") ?? "").trim().slice(0, 40);
  if (!name) return new Response("name required", { status: 400 });
  const sub = "dev:" + name.toLowerCase();
  let user = db.query("SELECT * FROM users WHERE google_sub = ?").get(sub) as UserRow | null;
  if (!user) {
    const id = randomId(16);
    db.query("INSERT INTO users (id, google_sub, email, name, picture, created) VALUES (?, ?, NULL, ?, NULL, ?)").run(id, sub, name, Date.now());
    user = db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow;
  }
  return startSession(user.id, url.searchParams.get("next") ?? "/");
}

export function renameUser(userId: string, name: string) {
  db.query("UPDATE users SET name = ? WHERE id = ?").run(name.trim().slice(0, 40) || "Commander", userId);
}
