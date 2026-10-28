// Commander Royale server (Bun): the lobby API, battles over WebSockets, and the original game's files.
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { currentUser, logout, renameUser, loadPlugins, pluginRoute, signInOptions, gateFor, canSignOut, isAdmin, accessLog, origin } from "./auth.ts";
import { settingsReference } from "../shared/settings-docs.ts";
import { mapsReference } from "../shared/maps/docs.ts";
import { listMaps, mapState, saveMap, deleteMap } from "./maps.ts";

/** The match settings reference for AI assistants (public: no secrets, and an assistant can't sign in), per address. */
const references = new Map<string, string>();
/** The same for map recipes. */
const mapReferences = new Map<string, string>();
import {
  createMatch, listMatches, lobbyState, joinMatch, leaveMatch, updateSettings, saveLoadout, setReady, startMatch, deleteMatch,
  resolveGamePath, wsOpen, wsClose, wsMessage, tickTimers, type WsData, GAME_DIR, matchRecords, addBot, removeBot, tuneBot, joinSquad, resumeBots, saveMemories,
  retryMatch, shareChallenge, challengeState, acceptChallenge, listChallenges } from "./game.ts";

const PORT = Number(process.env.PORT ?? 3000);
/** The address to listen on: 0.0.0.0 (everywhere, the default) or e.g. 127.0.0.1 when a proxy is in front. */
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = join(import.meta.dir, "..");

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const err = (message: string, status = 400) => json({ error: message }, status);

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

let signIns: string[];
try {
  signIns = await loadPlugins();
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
if (signIns.includes("header") && !/^(127\.|::1$|localhost$)/.test(HOST)) {
  console.warn(`AUTH=header while listening on ${HOST}: anyone who can reach port ${PORT} directly can claim to be anyone. Set HOST=127.0.0.1 (or firewall the port) so only your proxy gets through.`);
}

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: HOST,
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
    if (path === "/maps.txt" || path === "/docs/map-recipes.md") {
      const o = origin(req);
      if (!mapReferences.has(o)) mapReferences.set(o, mapsReference(o));
      return new Response(mapReferences.get(o), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    if (path === "/llms.txt" || path === "/docs/match-settings.md") {
      const o = origin(req);
      if (!references.has(o)) references.set(o, settingsReference(o));
      return new Response(references.get(o), { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" } });
    }
    if (path === "/logo.webp") return staticFile(join(ROOT, "client", "logo.webp"), "image/webp", "public, max-age=86400");
    // sign-in methods and access plugins answer their own routes
    const routed = await pluginRoute(req);
    if (routed) return routed;
    if (path === "/auth/logout") return logout(req);
    // whatever a plugin still wants from this account before it plays (a passkey...)
    const gate = user && gateFor(user, req);

    if (path === "/ws") {
      const matchId = url.searchParams.get("match") ?? "";
      if (!user) return err("Sign in first", 401);
      if (gate) return err(gate.text, 403);
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
        return json({ user: user && { id: user.id, name: user.name, picture: user.picture }, signIn: user ? [] : signInOptions(req), gate, signOut: canSignOut(req) });
      }
      // signed in isn't always enough to play
      if (gate) return json({ error: gate.text, gate: true }, 403);
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
      // custom maps: anyone signed in can list, open and play on them; only their author changes them
      const mp = path.match(/^\/api\/maps(?:\/([A-Za-z0-9]+))?$/);
      if (mp) {
        if (!user) return err("Sign in first", 401);
        const mid = mp[1];
        if (!mid && req.method === "GET") return json(listMaps(user));
        if (!mid && req.method === "POST") {
          const r = saveMap(user, null, (await body<{ doc?: unknown }>(req)).doc);
          return r.error ? err(r.error) : json(r);
        }
        if (mid && req.method === "GET") {
          const st = mapState(mid, user);
          return st ? json(st) : err("Map not found", 404);
        }
        if (mid && req.method === "POST") {
          const r = saveMap(user, mid, (await body<{ doc?: unknown }>(req)).doc);
          return r.error ? err(r.error) : json(r);
        }
        if (mid && req.method === "DELETE") {
          const e = deleteMap(user, mid);
          return e ? err(e) : json({ ok: true });
        }
        return err("Not found", 404);
      }
      // challenges: a battle's start shared for anyone to play
      const c = path.match(/^\/api\/challenges(?:\/([A-Za-z0-9]+))?(?:\/(play))?$/);
      if (c) {
        if (!user) return err("Sign in first", 401);
        const [, cid, play] = c;
        if (!cid && req.method === "GET") return json(listChallenges(user));
        if (cid && !play && req.method === "GET") {
          const st = challengeState(cid, user);
          return st ? json(st) : err("Challenge not found", 404);
        }
        if (cid && play && req.method === "POST") {
          const r = acceptChallenge(cid, user);
          return r.error ? err(r.error) : json(r);
        }
        return err("Not found", 404);
      }
      const m = path.match(/^\/api\/matches(?:\/([A-Za-z0-9]+))?(?:\/(\w+))?$/);
      if (m) {
        const [, id, action] = m;
        if (!id && req.method === "GET") return user ? json(listMatches(user)) : err("Sign in first", 401);
        if (!user) return err("Sign in first", 401);
        if (!id && req.method === "POST") {
          const settings = (await body<{ settings?: object }>(req)).settings ?? {};
          try {
            return json(createMatch(user, settings));
          } catch (e) {
            return err((e as Error).message);
          }
        }
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
            case "retry": {
              const r = retryMatch(id, user);
              return r.error ? err(r.error) : json(r);
            }
            case "challenge": {
              const r = shareChallenge(id, user, (await body<{ title?: string }>(req)).title);
              return r.error ? err(r.error) : json(r);
            }
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
      if (gate) return err(gate.text, 403);
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
// a restart (a deploy: systemd stops us with SIGTERM) keeps what everyone has seen out of sight
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    saveMemories();
    process.exit(0);
  });
console.log(`Commander Royale on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${server.port} (sign-in: ${signIns.join(", ")})`);
