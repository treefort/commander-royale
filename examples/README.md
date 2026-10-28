# Hosting Commander Royale

The server doesn't decide who's allowed in: it only needs to know who each player is. Pick the setup that matches
where your friends are and how much you trust the network, then add whatever access rules you like with
[access plugins](#access-plugins).

| Setup | Who can play | Sign-in | You need |
|---|---|---|---|
| [Local network](#local-network-lan) | anyone on your Wi-Fi/LAN | type a name | nothing extra |
| [Tailnet, plain](#tailnet-tailscale) | anyone on your tailnet | type a name | Tailscale |
| [Tailnet, Tailscale Serve](#tailscale-serve-https-and-real-identities) | anyone on your tailnet | automatic (their Tailscale identity) | Tailscale |
| [Public, Caddy + passwords](#public-internet-caddy-with-a-password-per-player) | people you give a password | browser password prompt | a domain, a server with ports 80/443 |
| [Public, Cloudflare Tunnel + Access](#public-internet-cloudflare-tunnel--access) | emails you allow | Cloudflare's one-time code or SSO | a domain on Cloudflare |
| [Public, oauth2-proxy](#public-internet-any-oidc-provider-with-oauth2-proxy) | accounts you allow at GitHub, Google, Keycloak... | OAuth | an OAuth app |
| [Public, Google sign-in plugin](#public-internet-google-sign-in-and-a-passkey) | anyone with a Google account (+ a passkey) | Sign in with Google | a Google OAuth client, a reverse proxy |

Whatever you choose, first get the game running locally (see the main [README](../README.md#running-it)):
`bun install`, the original game's data in `gamedata/`, `bun run build`.

## The knobs

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Address to listen on. Use `127.0.0.1` whenever a proxy in front does the sign-in |
| `PUBLIC_URL` | where each request came in | The server's external address, e.g. `https://game.example.com` (for links and OAuth redirects) |
| `AUTH` | `name` | Built-in sign-in, comma separated: `name` (type a commander name), `header` (trust a proxy's header), `none` |
| `AUTH_HEADER` | — | With `AUTH=header`: the header holding who the player is (an email or user name) |
| `AUTH_NAME_HEADER` | — | With `AUTH=header`: optional header with their display name |
| `PLUGINS` | — | Access plugins to load, comma separated paths (e.g. `plugins/passkey.ts`) |
| `ADMINS` | — | Emails or logins (`name:alice`) allowed to download the access log and match statistics (`ADMIN_EMAILS` works too) |
| `GAME_DIR` | `./gamedata` | The original game's data folders |
| `DB_PATH` | `./data/xcom.sqlite` | SQLite database (accounts, sessions, matches) |
| `AWAY_GRACE_MS` | `30000` | How long someone can be offline before the AI plays for them (when a match allows it) |

Plugins read their own variables (`PASSKEY`, `ALLOWLIST`, `GOOGLE_CLIENT_ID`...), listed with each below.

**Name sign-in is trust-based**: whoever types "Alice" is Alice, on any device. That's what you want on a LAN or a
tailnet of friends; on the open internet, put something in front (a proxy that signs people in, or at least the
passkey plugin), or use `AUTH=header` / a sign-in plugin instead.

## Local network (LAN)

```sh
bun run start
```

The server listens on every interface by default. Find your computer's address (`ipconfig` on Windows,
`ip addr` / `ifconfig` elsewhere) and have everyone open `http://<that address>:3000` and type a commander name.
Allow port 3000 through your firewall if it asks (Windows: allow Bun on private networks). Nothing leaves your network.

Want a door code so a roommate's laptop can't wander in? Add the passkey plugin:

```sh
PLUGINS=plugins/passkey.ts PASSKEY="nobody expects the sectoid" bun run start
```

## Tailnet (Tailscale)

Friends on your [tailnet](https://tailscale.com/kb/1136/tailnet) (or ones you've
[shared the machine with](https://tailscale.com/kb/1084/sharing)) can reach it just like a LAN:
`http://<machine name or 100.x address>:3000`, with name sign-in. The tailnet is the access control.

### Tailscale Serve: HTTPS and real identities

[Tailscale Serve](https://tailscale.com/kb/1312/serve) puts the game on `https://<machine>.<tailnet>.ts.net`
and tells it who each visitor is, so nobody types a name and nobody can pretend to be someone else:

```sh
HOST=127.0.0.1 AUTH=header AUTH_HEADER=Tailscale-User-Login AUTH_NAME_HEADER=Tailscale-User-Name bun run start
tailscale serve --bg 3000
```

`HOST=127.0.0.1` matters: only Tailscale can then reach the game, so only Tailscale can set those headers. Serve
adds no identity for tagged devices, and Funnel visitors are anonymous: neither can sign in this way.

## Public internet: Caddy with a password per player

[Caddy](https://caddyserver.com) gets a certificate on its own and asks each player for their own user name and
password; the game trusts the user name Caddy passes on. See [`Caddyfile`](Caddyfile):

```sh
caddy hash-password            # once per player; paste the hashes into the Caddyfile
HOST=127.0.0.1 PUBLIC_URL=https://game.example.com AUTH=header AUTH_HEADER=X-Remote-User bun run start
caddy run --config examples/Caddyfile
```

To run it as a service, see [`commander-royale.service`](commander-royale.service) and
[`commander-royale.env`](commander-royale.env).

## Public internet: Cloudflare Tunnel + Access

No open ports at all: [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
connects out to Cloudflare, and [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
lets in only the emails (or Google/GitHub accounts...) your policy allows.

1. Create a tunnel for `game.example.com` pointing at `http://localhost:3000` (see [`cloudflared.yml`](cloudflared.yml)).
2. In Zero Trust → Access → Applications, add a self-hosted application for `game.example.com` with a policy
   listing your players.
3. Start the game trusting the email header Access adds:

```sh
HOST=127.0.0.1 PUBLIC_URL=https://game.example.com AUTH=header AUTH_HEADER=Cf-Access-Authenticated-User-Email bun run start
```

WebSockets go through tunnels as they are. With `HOST=127.0.0.1` only `cloudflared` reaches the game.

## Public internet: any OIDC provider with oauth2-proxy

[oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) signs people in with GitHub, Google, GitLab,
Keycloak, Entra ID... and passes their email on:

```sh
HOST=127.0.0.1 PUBLIC_URL=https://game.example.com AUTH=header AUTH_HEADER=X-Forwarded-Email AUTH_NAME_HEADER=X-Forwarded-Preferred-Username bun run start
oauth2-proxy --provider=github --client-id=... --client-secret=... --cookie-secret=... \
  --email-domain='*' --github-user=alice,bob --upstream=http://127.0.0.1:3000 \
  --http-address=127.0.0.1:4180 --redirect-url=https://game.example.com/oauth2/callback
```

Put your TLS proxy (Caddy, nginx) in front of port 4180.

## Public internet: Google sign-in and a passkey

The game can also do the signing-in itself with the bundled plugins: "Sign in with Google"
([`plugins/google.ts`](../plugins/google.ts)), and a shared passkey every account enters once
([`plugins/passkey.ts`](../plugins/passkey.ts)). Behind any TLS proxy (see [`nginx.conf`](nginx.conf)):

```sh
HOST=127.0.0.1 PUBLIC_URL=https://game.example.com AUTH=none \
PLUGINS=plugins/google.ts,plugins/passkey.ts \
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... PASSKEY="..." bun run start
```

In the Google Cloud console (APIs & Services → Credentials → Create OAuth client ID → Web application) add
`https://game.example.com/auth/google/callback` as an authorized redirect URI.

## Access plugins

A plugin is a TypeScript module listed in `PLUGINS`; it can add sign-in buttons and pages, recognise users from a
request, or hold signed-in users back until they've done something (enter a code, be on a list). Bundled ones:

| Plugin | Variables | Does |
|---|---|---|
| [`plugins/passkey.ts`](../plugins/passkey.ts) | `PASSKEY` | Every account enters a shared passkey once (wrong guesses limited, all logged) |
| [`plugins/allowlist.ts`](../plugins/allowlist.ts) | `ALLOWLIST` | Only listed emails/logins may play |
| [`plugins/google.ts`](../plugins/google.ts) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | "Sign in with Google" |

They combine: `AUTH=header` + `plugins/allowlist.ts`, `AUTH=name` + `plugins/passkey.ts`, and so on. To write
your own, start from [`server/plugin.ts`](../server/plugin.ts) (the whole API, documented) and
[`plugins/allowlist.ts`](../plugins/allowlist.ts) (a dozen lines). A plugin can keep its own tables in the game's
SQLite database and write to its access log; `ADMINS` can download that log from `/api/admin/access-log`.
