// Access plugin: "Sign in with Google" (OAuth 2.0 authorization code flow, then a normal session).
//   PLUGINS=plugins/google.ts GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
// In the Google Cloud console (APIs & Services → Credentials → OAuth client ID → Web application), add
// `<your address>/auth/google/callback` as an authorized redirect URI. Set PUBLIC_URL so the redirect matches.
// Usually paired with AUTH=none (no name sign-in), and perhaps plugins/passkey.ts to keep it to invited players.
import type { AccessPlugin, PluginContext } from "../server/plugin.ts";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

/** Google's "G" mark, for the sign-in button. */
const GOOGLE_G = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.7 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>`;

export default function google(ctx: PluginContext): AccessPlugin {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("plugins/google.ts needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET");
  const redirect = (req: Request) => `${ctx.origin(req)}/auth/google/callback`;

  function start(req: Request): Response {
    const state = crypto.randomUUID();
    const next = ctx.safeNext(new URL(req.url).searchParams.get("next"));
    const params = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: redirect(req), response_type: "code", scope: "openid email profile", state, prompt: "select_account" });
    return new Response(null, {
      status: 302,
      headers: { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, "Set-Cookie": ctx.cookie(req, "oauth_state", `${state}|${next}`, 600) },
    });
  }

  async function callback(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [expected, next] = (ctx.cookies(req).oauth_state ?? "").split("|");
    if (!expected || url.searchParams.get("state") !== expected) return new Response("Sign-in expired, please try again.", { status: 400 });
    const code = url.searchParams.get("code");
    if (!code) return new Response("Sign-in was cancelled.", { status: 400 });
    const tok = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirect(req), grant_type: "authorization_code" }),
    });
    if (!tok.ok) return new Response("Google sign-in failed.", { status: 502 });
    const { id_token } = (await tok.json()) as { id_token: string };
    // the token came straight from Google's token endpoint over TLS, so its claims can be trusted
    const claims = JSON.parse(Buffer.from(id_token.split(".")[1], "base64url").toString("utf8")) as { sub: string; email?: string; name?: string; picture?: string; aud: string; iss: string };
    if (claims.aud !== CLIENT_ID || !/accounts\.google\.com$/.test(claims.iss)) return new Response("Invalid sign-in token.", { status: 400 });
    const user = ctx.userByLogin(`google:${claims.sub}`, { name: claims.name ?? claims.email ?? "Commander", email: claims.email, picture: claims.picture });
    return ctx.startSession(req, user, next, new Headers({ "Set-Cookie": ctx.cookie(req, "oauth_state", "", 0) }));
  }

  return {
    name: "google",
    signIn: () => [{ label: "Sign in with Google", href: "/auth/google?next={next}", icon: GOOGLE_G }],
    routes(req) {
      const path = new URL(req.url).pathname;
      if (path === "/auth/google") return start(req);
      if (path === "/auth/google/callback") return callback(req);
      return undefined;
    },
  };
}
