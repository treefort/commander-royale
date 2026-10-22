// X-COM Battlescape multiplayer server (Bun).
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { currentUser, googleStart, googleCallback, devLogin, logout, DEV_LOGIN, googleEnabled, renameUser, PUBLIC_URL } from "./auth.ts";
import { mayPlay, passkeyRequired, tryPasskey, accessLog } from "./access.ts";
import {
  createMatch, listMatches, lobbyState, joinMatch, leaveMatch, updateSettings, saveLoadout, setReady, startMatch, deleteMatch,
  resolveGamePath, wsOpen, wsClose, wsMessage, tickTimers, type WsData, GAME_DIR, matchRecords, addBot, removeBot, tuneBot, joinSquad, resumeBots } from "./game.ts";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = join(import.meta.dir, "..");

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const err = (message: string, status = 400) => json({ error: message }, status);

/** ADMIN_EMAILS (comma separated) may download match statistics; anyone can on a local dev-login server. */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
function isAdmin(user: { email: string | null }): boolean {
  return (!!user.email && ADMIN_EMAILS.includes(user.email.toLowerCase())) || DEV_LOGIN;
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

function staticFile(path: string, type?: string, cache = "no-cache"): Response {
  const f = Bun.file(path);
  return new Response(f, { headers: { "Content-Type": type ?? f.type, "Cache-Control": cache } });
}

if (!existsSync(join(GAME_DIR, "GEODATA"))) {
  console.error(`Game data not found in ${GAME_DIR} (set GAME_DIR to your X-COM UFO Defense folder).`);
  process.exit(1);
}

const server = Bun.serve<WsData>({
  port: PORT,
  development: false,
  error(e) {
    console.error("request failed", e);
    return err("Something went wrong", 500);
  },
  async fetch(req, srv) {
    try {
      return await handle(req, srv);
    } catch (e) {
      console.error("request failed", req.method, new URL(req.url).pathname, e);
      return err("Something went wrong", 500);
    }
  },
  websocket: {
    open: wsOpen,
    close: wsClose,
    message: (ws, msg) => wsMessage(ws, typeof msg === "string" ? msg : new TextDecoder().decode(msg)),
    idleTimeout: 120,
    sendPings: true,
  },
});

async function handle(req: Request, srv: import("bun").Server<WsData>): Promise<Response | undefined> {
  {
    const url = new URL(req.url);
    const path = url.pathname;
    const user = currentUser(req);

    if (path === "/health") return json({ ok: true });
    if (path === "/auth/google") return googleEnabled() ? googleStart(req) : err("Google sign-in is not configured", 503);
    if (path === "/auth/google/callback") return googleCallback(req);
    if (path === "/auth/dev") return devLogin(req);
    if (path === "/auth/logout") return logout(req);

    if (path === "/ws") {
      const matchId = url.searchParams.get("match") ?? "";
      if (!user) return err("Sign in first", 401);
      if (!mayPlay(user)) return err("Enter the passkey first", 403);
      if (srv.upgrade(req, { data: { user, matchId } })) return undefined;
      return err("WebSocket upgrade failed");
    }

    if (path.startsWith("/api/")) {
      if (path === "/api/me") {
        if (req.method === "POST" && user) {
          const b = await body<{ name?: string }>(req);
          if (b.name) renameUser(user.id, b.name);
          return json({ ok: true });
        }
        return json({ user: user && { id: user.id, name: user.name, picture: user.picture }, needsPasskey: !!user && !mayPlay(user), devLogin: DEV_LOGIN, google: googleEnabled() });
      }
      if (path === "/api/passkey" && req.method === "POST") {
        if (!user) return err("Sign in first", 401);
        const e = tryPasskey(req, user, (await body<{ passkey?: string }>(req)).passkey);
        return e ? err(e, 403) : json({ ok: true });
      }
      // signed in isn't enough to play: with a passkey set, the account has to have entered it
      if (user && !mayPlay(user)) return json({ error: "Enter the passkey first", passkey: true }, 403);
      // sign-ins and passkey attempts: admins only
      if (path === "/api/admin/access-log" && req.method === "GET") {
        if (!user) return err("Sign in first", 401);
        if (!isAdmin(user)) return err("Not allowed", 403);
        return json(accessLog(Number(url.searchParams.get("limit")) || 500));
      }
      // statistics export for balancing (tools/player-stats.ts --json): admins only
      if (path === "/api/admin/match-records" && req.method === "GET") {
        if (!user) return err("Sign in first", 401);
        if (!isAdmin(user)) return err("Not allowed", 403);
        const since = Date.parse(url.searchParams.get("since") ?? "") || 0;
        return new Response(JSON.stringify(matchRecords(since)), {
          headers: { "content-type": "application/json", "content-disposition": "attachment; filename=match-records.json" },
        });
      }
      const m = path.match(/^\/api\/matches(?:\/([A-Za-z0-9]+))?(?:\/(\w+))?$/);
      if (m) {
        const [, id, action] = m;
        if (!id && req.method === "GET") return user ? json(listMatches(user)) : err("Sign in first", 401);
        if (!user) return err("Sign in first", 401);
        if (!id && req.method === "POST") return json(createMatch(user, (await body<{ settings?: object }>(req)).settings ?? {}));
        if (id && !action && req.method === "GET") {
          const s = lobbyState(id, user);
          return s ? json(s) : err("Match not found", 404);
        }
        if (id && !action && req.method === "DELETE") {
          const e = deleteMatch(id, user);
          return e ? err(e) : json({ ok: true });
        }
        if (id && req.method === "POST") {
          let e: string | null = null;
          switch (action) {
            case "join": {
              const o = await body<{ squad?: string }>(req);
              e = joinMatch(id, user, o.squad ? String(o.squad) : undefined);
              break;
            }
            case "leave": e = leaveMatch(id, user); break;
            case "settings": e = updateSettings(id, user, (await body<{ settings?: object }>(req)).settings ?? {}); break;
            case "loadout": {
              const r = saveLoadout(id, user, (await body<{ loadout: never }>(req)).loadout);
              return r.error ? err(r.error) : json(r);
            }
            case "ready": e = setReady(id, user, !!(await body<{ ready?: boolean }>(req)).ready); break;
            case "start": e = startMatch(id, user); break;
            case "addbot": {
              const o = await body<{ strategy?: string; ai?: object }>(req);
              e = addBot(id, user, String(o.strategy ?? "random"), o.ai);
              break;
            }
            case "tunebot": {
              const o = await body<{ botId?: string; ai?: object }>(req);
              e = tuneBot(id, user, String(o.botId ?? ""), o.ai);
              break;
            }
            case "squad": e = joinSquad(id, user, String((await body<{ leader?: string }>(req)).leader ?? "")); break;
            case "removebot": e = removeBot(id, user, String((await body<{ botId?: string }>(req)).botId ?? "")); break;
            default: return err("Unknown action", 404);
          }
          return e ? err(e) : json({ ok: true });
        }
      }
      return err("Not found", 404);
    }

    // the original game's data files are served only to signed-in players
    if (path.startsWith("/game/")) {
      if (!user) return err("Sign in first", 401);
      if (!mayPlay(user)) return err("Enter the passkey first", 403);
      let rel: string;
      try {
        rel = decodeURIComponent(path.slice(6));
      } catch {
        return err("Not found", 404);
      }
      const p = resolveGamePath(rel);
      if (!p) return err("Not found", 404);
      return staticFile(p, "application/octet-stream", "private, max-age=604800, immutable");
    }

    if (path.startsWith("/dist/")) {
      const p = join(ROOT, "dist", path.slice(6).replace(/\.\./g, ""));
      if (existsSync(p) && statSync(p).isFile()) return staticFile(p);
      return err("Not found", 404);
    }
    if (path === "/style.css") return staticFile(join(ROOT, "client", "style.css"), "text/css");
    if (path === "/favicon.ico") return new Response(null, { status: 204 });
    // single page app
    return staticFile(join(ROOT, "client", "index.html"), "text/html; charset=utf-8");
  }
}

setInterval(tickTimers, 3000);
resumeBots();
console.log(`X-COM battlescape server on ${PUBLIC_URL} (port ${server.port})${DEV_LOGIN ? " — DEV LOGIN ENABLED" : ""}${passkeyRequired() ? " — passkey required to play" : ""}`);
