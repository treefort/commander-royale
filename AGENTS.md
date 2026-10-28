# Commander Royale: notes for AI agents

A browser remake of the X-COM: UFO Defense **battlescape** (no geoscape) for multiplayer: free-for-all battles
between any number of squads (people and/or computer), co-op scenarios against an enemy a game master designs,
asynchronous turns, joinable mid-battle. TypeScript on [Bun](https://bun.sh); the rules are ported from OpenXcom.
Graphics, sounds and maps come from the user's **own copy** of the original game, which the repo never contains.
`README.md` is the player-facing overview; this file is what you need to help someone use it or work on it.

## Helping someone use it

**Get it running locally.** Needs Bun 1.3+ and an X-COM: UFO Defense install (GOG or Steam; ask where it is if you
can't find it. Common places: `C:\Program Files (x86)\GOG Galaxy\Games\X-COM UFO Defense`, `C:\GOG Games\`,
Steam's `steamapps/common/XCom UFO Defense/XCOM`). Copy its `GEODATA GEOGRAPH MAPS ROUTES SOUND TERRAIN UFOGRAPH
UNITS` folders into `gamedata/` (or set `GAME_DIR` to the folder holding them), then `bun install` and `bun run dev`
(http://localhost:3000; sign in by typing any name). Music is optional: `bun tools/render-music.ts` (needs ffmpeg).
If the server says it can't find the game data, `GAME_DIR` doesn't point at the folder with `GEODATA` in it.

**Host it for friends.** [`examples/README.md`](examples/README.md) has a recipe per situation (LAN, tailnet,
Tailscale Serve, Caddy with passwords, Cloudflare Tunnel + Access, oauth2-proxy, Google sign-in) and every
environment variable. Ask who should be able to play and from where, then pick the simplest recipe that fits. The
default "type a name" sign-in trusts everyone who can reach the server: fine on a LAN or tailnet, not on the open
internet without something in front.

**Set up a match.** Matches are created in the browser by the player, never by you: whoever creates a match owns it
(in co-op they're the game master). Your job is a link that opens the New Match form filled in:

1. Read the reference: `bun tools/match-link.ts` prints it (every setting, mode, enemy unit and weapon id, budget
   rules of thumb, examples). A running server also serves it at `/llms.txt`.
2. Write settings JSON with only what the player asked for (everything else has sensible defaults).
3. `bun tools/match-link.ts --server <address the players use> '<json>'` checks it and prints the link and JSON.
   Fix anything it reports as adjusted. Use the address friends will open (e.g. `http://192.168.1.20:3000`), not
   `localhost`, unless it's just for this machine.
4. Give the player the link; they check the form and press Create, then share the match's invite link.

Computer squads in free-for-all are added in the lobby, not through settings (the reference explains).

**Set up a game to play now.** When the player wants to play rather than review a form, give them play links
(`/play?setup=<json>`). A setup holds the settings, an optional map recipe (see "Make a map"), the computer
opponents and how the player's squad is chosen. `bun tools/match-link.ts --server <address> '<setup JSON>'` (or
`--recipe recipe.json '<settings JSON>'`) checks the setup, builds the recipe, and prints two links: one
auto-configures the squad and starts the battle at once, the other lets the player hire and equip first and starts
the battle when they press Ready. Give the player both and say which is which. Each opens a page describing the
setup, and nothing is created until the player presses a button there, so the player still creates the match.

**Make a map.** Custom maps are made in the map editor (`/maps`) and played with the `map` setting. To design one
for the player, write a **recipe** (JSON: terrain, size, original blocks, ops like `building`, `hill`, `scatter`):

1. Read the reference: `bun tools/map.ts reference [--terrain URBAN]` (a running server serves it at `/maps.txt`):
   coordinates, every op, every terrain's original blocks (described) and named materials, what plays well, examples.
2. `bun tools/map.ts build recipe.json --plan plan.png --iso iso.png --server <address>` compiles it, lists warnings
   and playability problems (zones without room, zones nobody can walk between), draws a top-down plan (8 px a tile,
   a line every 10, zones numbered) and the in-game view, and prints the editor link. Look at the pictures; fix the
   recipe until there are no warnings.
3. Give the player the link (`/maps/new?recipe=...`): it opens the editor with the map built; they Save it, then
   pick it under "Map" in the New Match form. To play on it straight away, put the recipe in play links instead.
   `bun tools/map.ts render <exported map.json>` checks and draws a map exported from the editor;
   `bun tools/map.ts blocks <dir>` draws every original block.

**Restrict who can play / custom sign-in.** Write an access plugin: the API is documented in
[`server/plugin.ts`](server/plugin.ts); [`plugins/allowlist.ts`](plugins/allowlist.ts) is the shortest example,
[`plugins/passkey.ts`](plugins/passkey.ts) shows a gate with a form and its own table, [`plugins/google.ts`](plugins/google.ts)
a full OAuth sign-in. Load it with `PLUGINS=path/to/plugin.ts`, and add any new variables it reads to the table in
`examples/README.md` (a test checks).

**Balance questions.** `bun tools/balance.ts --games 300 [--budget 400000] [--strategies a,b]` plays bot
tournaments; `bun tools/duels.ts` measures prices; `bun tools/player-stats.ts --db data/xcom.sqlite` reports on
real games. The bots are simple players, so treat their numbers as "what a consistent, unsubtle player gets".

## Working on the code

### Commands

```sh
bun test                       # all tests (~1 min); keep them green
bunx tsc --noEmit -p .         # typecheck (must be clean)
bun run build                  # bundle the client into dist/ (needed after client changes)
bun run dev                    # build + start http://localhost:3000
bun tools/dev-match.ts [--bot swarm] [--biome MOUNT] [--time night] [--drops 3]   # a started test match on a running server
bun tools/dev-endturn.ts Bob <matchId>    # end a test player's turn (fast-forward rounds)
bun tools/render-map.ts out.png URBAN 5 none day   # render a whole map offline
```

Client-only changes need `bun run build` and a browser refresh; anything the server runs (`server/`, `shared/`)
needs a server restart. Check UI changes in a real browser, not just the tests: sign in as anyone with
`http://localhost:3000/auth/name?name=Alice&next=/m/<matchId>` (a second name in a private window for multiplayer).
Matches you create while testing are stored in `data/xcom.sqlite`: delete them afterwards
(`DELETE /api/matches/<id>`), and leave the user's own matches alone.

### Layout

- `shared/engine/`: the authoritative simulation (runs on the server; the client reuses it for rendering helpers
  and previews): `state.ts` (Battle/Unit/Item), `tileengine.ts` (voxel line of sight/fire, lighting, explosions,
  doors), `pathfinding.ts`, `actions.ts` (`GameRules.apply`: every command goes through it, bots included),
  `mapgen.ts`, `setup.ts`, `view.ts` (per-player fog-of-war views and diffs), `ai.ts` (OpenXcom AI port),
  `coop.ts` (several people sharing a squad), `deploy.ts` (landing zones, reinforcement waves), `stats.ts` /
  `record.ts` (per-unit match statistics), `serialize.ts`.
- `shared/rules/`: `generated.json` (from `tools/convert-rules.ts`, OpenXcom's xcom1 rulesets), `catalog.ts`
  (prices, recruit pool, loadout validation, training courses), `value.ts` (price model), `calibration.json`
  (measured price corrections), `squads.ts` (bot hiring strategies), `scenario.ts` (co-op enemy forces).
- `shared/maps/`: custom maps: `format.ts` (`MapDoc`, run-length encoded tile parts), `build.ts` (a doc as a
  battle and back, original blocks and UFOs from any terrain, landing zones, `checkMap` playability checks),
  `ops.ts` (the edit operations: buildings, hills, walls, scatter... used by the editor's tools and by recipes),
  `recipe.ts` (AI recipes to map docs), `catalog.ts` + `catalog/*.json` (hand-labelled names for terrain parts and
  notes on every original block), `docs.ts` (`/maps.txt`).
- `shared/protocol.ts`: `MatchSettings` and `sanitizeSettings` (every setting passes through it).
- `shared/settings-docs.ts`: the reference for AI assistants (`/llms.txt`, `tools/match-link.ts`) and play-link
  setups (`checkSetup`).
- `server/`: `index.ts` (routes), `auth.ts` (sessions, built-in sign-in, plugin host; API in `plugin.ts`), `db.ts`
  (SQLite), `game.ts` (lobby, battle hosting, WebSockets, bots, match records), `maps.ts` (custom maps). `quickPlay` in `game.ts` runs a play link.
- `client/`: `ui/` (front door, home, lobby, equip screen, play-link page `play.ts`, the map editor: `maps.ts`,
  `editor.ts`), `battle/` (`screen.ts` is the battlescape: input, dialogs, animation; `hud.ts`), `render/` (map and unit renderers, `plan.ts` top-down plans, fonts), `audio.ts`.
- `plugins/`: access plugins. `examples/`: hosting recipes. `tools/`: balance, stats, music, dev helpers.
  `tests/`: `bun test`.

### Rules of the house

- **Keep the AI reference current.** `/llms.txt` must describe every game feature and option. Adding or changing a
  setting, lobby option, AI option, bot strategy, training course or anything players do: update `FIELDS`,
  `BOT_TUNING_DOCS` or the prose in `shared/settings-docs.ts` in the same change. Tests catch missing settings,
  wrong ranges, strategies and courses; the prose is on you.
- **Keep the map reference current.** `/maps.txt` is built from `recipe.ts`, `ops.ts` and the catalog: a new op or
  option goes in its tables in `shared/maps/docs.ts`; tests compile its examples and check it names every op,
  terrain and material. New terrain parts get names in `shared/maps/catalog/*.json` (`bun tools/terrain-sheet.ts`
  draws a part set's sprites with their numbers).
- **Never leak hidden information.** Clients only get what `extractView` sends them; never leak enemy positions or
  inventories. The AI plays on the real battle but only "knows" enemies it has seen (plus OpenXcom's round-20 cheat).
- **The original rules are the spec.** Mechanics follow OpenXcom's xcom1 behaviour; deliberate departures: no
  civilians, no morale/panic, any unit but tanks can carry items, picked-up gear works at once (no research),
  optional extras (supply drops, the Mysterious Stranger) are match settings. The UI should feel like the original
  (320x200-style canvas, original palette and fonts) with modern conveniences.
- **Access stays pluggable.** The core only knows sessions, `AUTH=name|header|none` and plugins; anything
  provider-specific belongs in a plugin.
- **Balance**: prices are the `value.ts` model × `calibration.json`. Don't hand-tweak calibration without re-running
  `tools/duels.ts`.
- **Bun does proper tail calls**: accidental self-recursion hangs forever instead of overflowing the stack. Watch
  for it after search-and-replace edits.
- **Never commit the original game's files**: `gamedata/` (rendered music included), `data/` and `tools/.cache/`
  stay gitignored.

### How some of the trickier parts fit together

- **Custom maps**: `settings.map` is a map id; `startMatch` loads the doc (later edits don't reach a battle on it),
  sets `biome` from its terrain, and `createBattle(..., custom)` builds the battle with `customMap` (zones picked
  far apart, extras made with `newLandingZone`). A map's part ids index its `datasets` in order; placing anything
  from another part set adds that set (`ensureDataset`, 16 at most). The client loads a battle's part sets from
  the view's `datasets`, so nothing else needs to know a map was custom.
- **Co-op squads**: a battle "player" is a squad; `PlayerState.members` are its people and `Unit.controller` who
  commands a unit. The server's `mayCommand` gates commands; "endturn" from a member toggles their lock-in. Updates
  carry `by` (who acted) so a client only waits for its own; rejected commands reply `noUpdate`. Bots and AFK
  players share `runAI`. `publish` builds one view diff per side (`SentState` is per seat, never per socket) plus
  an omniscient one for a game master who only watches.
- **Co-op scenarios**: seat 0 is the team (everyone's loadouts merged, `controller` = who hired the unit, the game
  master as an `observer` member); seat 1 is `bot:scenario:<id>` with reinforcement `b.waves`. The enemy force is
  rebuilt deterministically from settings + seed (`buildEnemyForce`).
- **Joining late**: `joinBattle` (setup.ts) adds a side last in turn order with a new edge landing zone, or a person
  to an existing side. `MAX_SIDES` (30) is the limit of the 32-bit event visibility masks.
- **Retries and challenges**: `startMatch` stores the battle as created plus each seat's loadout; `replayBattle`
  gives one seat to a person and the rest to the AI with new dice; `playFrom` makes a solo match of it. Challenges
  copy the start into `challenges`, each go is a `challenge_attempts` row. `replayBlocked` stops replays while
  other people are still fighting.
- **The Mysterious Stranger** (`GameRules.mysteriousStranger`) is never in `b.units`: events use `STRANGER_ID`,
  the client adds and removes a stand-in, and his damage is credited to nobody.
