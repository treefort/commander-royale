// The access plugin API: how a server decides who may play, beyond the built-in sign-ins (server/auth.ts).
// A plugin is a module whose default export is an AccessPlugin, or a function given the PluginContext that returns
// one; list its path in PLUGINS. Examples: plugins/google.ts (Sign in with Google), plugins/passkey.ts (a shared
// passkey every account enters once). Plugins run in order; each part is optional.
import type { Database } from "bun:sqlite";
import type { UserRow } from "./db.ts";

/** One way to sign in, shown on the front door. */
export type SignInOption =
  /** a button that sends the browser to `href` ("{next}" becomes where the player was going, URL-encoded) */
  | { label: string; href: string; /** inline SVG shown on the button */ icon?: string }
  /** a one-field form: the browser goes to `action?<field.name>=<value>&next=<where they were going>` (GET) */
  | { label: string; field: { name: string; placeholder: string; type?: "text" | "password" }; action?: string }
  /** a note */
  | { text: string };

/**
 * What a signed-in account must do before it can play: fill in one field, POSTed as JSON `{ value }` to `action`
 * (which answers `{ ok: true }`, or an error status with `{ error: "message" }`). Without a field it's just a message
 * (you can't play here).
 */
export interface Gate {
  title?: string;
  text: string;
  field?: { placeholder: string; type?: "text" | "password" };
  action?: string;
  button?: string;
}

export interface AccessPlugin {
  name: string;
  /** Handle a request before the game does (sign-in pages and callbacks, the gate's action); undefined passes it on. */
  routes?(req: Request, ctx: PluginContext): Response | undefined | Promise<Response | undefined>;
  /** Sign-in options for the front door. */
  signIn?(req: Request): SignInOption[];
  /** Recognise a request's user without a session (e.g. from a trusted proxy's header). */
  identify?(req: Request, ctx: PluginContext): UserRow | null;
  /** Hold a signed-in user back from playing until they've done something. Null lets them through. */
  gate?(user: UserRow, req: Request): Gate | null;
}

export interface PluginContext {
  /** The server's SQLite database: plugins can keep their own tables (CREATE TABLE IF NOT EXISTS ...). */
  db: Database;
  /** The server's external address ("https://game.example.com"): PUBLIC_URL, or where the request came in. */
  origin(req: Request): string;
  cookies(req: Request): Record<string, string>;
  /** A Set-Cookie value (HttpOnly, SameSite=Lax, Secure over https); maxAge 0 deletes it. */
  cookie(req: Request, name: string, value: string, maxAge: number): string;
  /** `next` if it's a path on this site, otherwise "/". */
  safeNext(next: string | null | undefined): string;
  /** Who the request is from (null: not signed in). */
  currentUser(req: Request): UserRow | null;
  /** The account for `login` ("<plugin>:<id>"), created on first sign-in; email and picture are updated. */
  userByLogin(login: string, profile: { name: string; email?: string | null; picture?: string | null }): UserRow;
  /** Signs `user` in (session cookie, logged) and redirects to `next`. Extra headers (e.g. clearing your cookies) go along. */
  startSession(req: Request, user: UserRow, next: string, headers?: Headers): Response;
  /** Keeps an event in the access log (admins can download it from /api/admin/access-log). */
  logAccess(req: Request, user: UserRow | null, event: string): void;
}

export type { UserRow };
