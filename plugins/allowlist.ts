// Access plugin: only the people listed may play. Anyone can still sign in (by whatever method the server uses),
// but everyone else is told they aren't on the list.
//   PLUGINS=plugins/allowlist.ts ALLOWLIST=alice@example.com,bob@example.com,name:carol
// Entries are emails (when the sign-in method knows one: Google, a proxy header holding an email) or logins:
// "name:<lowercased name>", "header:<header value>", "google:<id>".
// It's also the shortest example of a plugin: a gate and nothing else.
import type { AccessPlugin } from "../server/plugin.ts";

export default function allowlist(_ctx: unknown, list = process.env.ALLOWLIST ?? ""): AccessPlugin {
  const allowed = new Set(list.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (!allowed.size) throw new Error("plugins/allowlist.ts needs ALLOWLIST");
  return {
    name: "allowlist",
    gate: (user) => (user.email && allowed.has(user.email.toLowerCase())) || (user.login && allowed.has(user.login.toLowerCase()))
      ? null
      : { text: "This server is invite-only and your account isn't on its list. Ask whoever runs it to add you." },
  };
}
