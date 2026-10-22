# X-COM Battlescape (multiplayer) — notes for Claude sessions

A browser port of the X-COM: UFO Defense **battlescape only** (no geoscape): free-for-all multiplayer matches
between 2–8 squads (people and/or AI), asynchronous turns, Google sign-in, running on Bun. The rules are ported
from OpenXcom's faithful reimplementation; graphics/sounds/music come from the user's own GOG copy. Read
`README.md` for the player-facing feature list, setup, controls and the balance/stats tools — this file is
about how to work on it.

## Owner's decisions (don't re-litigate)

- Game data: full GOG install at `C:\Program Files (x86)\GOG Galaxy\Games\X-COM UFO Defense`, copied to
  `gamedata/` (gitignored; the repo's `xcom/` folder is only the old demo — ignore it). Assets are served by our
  own server to signed-in players only (private deployment for friends).
- Free-for-all between squads, last squad standing wins. Sequential async turns, optional turn timer.
- Co-op scenario mode (2026-10-22, `settings.mode = "coop"`): the creator is a game master who designs the enemy
  (groups by type/count/weapon/placement/arrival round, AI tactics) and the battlefield; 1–10 people form one team,
  each filling `seatsPerPlayer` Skyranger seats (large units take 4) and commanding those units; the team lands
  together or apart (each person in their own zone, `teamStart`). Turn ends on lock-in (default), a daily time, or the timer;
  offline players' units stay put. A GM who doesn't play watches everything (omniscient view) and commands nothing.
- Co-op (2026-10-22): up to 10 people can share one squad, each commanding the units dealt to them, all acting
  at once on its turn; the turn ends when everyone locks in (or only on the timer). AFK/offline people's units
  are played by the AI. Computer squads have tunable AI (aggression, memory, explosives, cheat round, strength).
- Hire pool mixes humans, every alien race/rank and tanks, priced by capability; any unit except tanks carries
  items (yes, a Chryssalid with a grenade). Picked-up gear is usable at once (no research).
- In: psionics/mind control, armor, HWPs. Out: civilians, morale/panic/berserk.
- Supply drops: location + countdown public; land as a crate looted like a corpse pile; creator picks the
  loot table. They must land outdoors, on clear ground a squad can walk to. Indicators stay **subtle** (the
  user pushed back twice on flashy markers).
- UI should feel like the original (320x200-style canvas, original palette/fonts) with modern conveniences.

## Layout

- `shared/engine/` — the authoritative simulation (runs on the server; the client reuses it for rendering
  helpers and previews): `state.ts` (Battle/Unit/Item), `tileengine.ts` (voxel LOS/LOF, lighting, explosions,
  doors, gravity), `pathfinding.ts`, `actions.ts` (`GameRules.apply` — every command goes through here),
  `mapgen.ts`, `setup.ts`, `view.ts` (per-player fog-of-war views/diffs), `ai.ts` (OpenXcom AIModule port),
  `coop.ts` (co-op squads: who controls which unit, lock-ins, AFK — the engine itself only knows squads),
  `deploy.ts` (placing units: landing zone, UFO, middle, scattered; also reinforcement waves),
  `stats.ts`/`record.ts` (per-unit match statistics), `serialize.ts`.
- `shared/rules/` — `generated.json` (from `tools/convert-rules.ts`, OpenXcom xcom1 rulesets), `catalog.ts`
  (prices, pool generation, loadout validation, budget guide), `value.ts` (price model), `calibration.json`
  (measured price corrections), `squads.ts` (bot hiring strategies), `scenario.ts` (co-op scenario enemy forces).
- `shared/protocol.ts` — `MatchSettings` + `sanitizeSettings` (all settings pass through it), recruits, loadouts.
- `server/` — Bun.serve (`index.ts` routes), Google OAuth + dev login (`auth.ts`), SQLite (`db.ts`), lobby,
  battle hosting, websocket, bots, match records (`game.ts`).
- `client/` — `ui/` (home, lobby, loadout/equip screen with the shop grid, inventory), `battle/` (screen.ts is
  the battlescape: input, dialogs, animation; hud.ts; exposure.ts), `render/` (map/unit renderers, fonts),
  `audio.ts` (SAMPLE2.CAT sfx, music, turn chime).
- `tools/` — balance tournaments/duels, real-game stats report, music rendering, dev helpers (below).
- `tests/` — `bun test` (sim, rules, AI, stats/server). `deploy/deploy-xcom.py` — droplet deploy (see below).

## Commands

```sh
bun test                       # all tests (~1 min); keep them green
bunx tsc --noEmit -p .         # typecheck (must be clean)
bun run build                  # bundle the client into dist/ (needed after client changes)
bun run dev                    # build + start http://localhost:3000 (dev login on when no Google creds)
bun tools/render-music.ts      # one-off: GM*.MID -> gamedata/MUSIC/*.ogg (needs ffmpeg)
bun tools/dev-match.ts [--bot swarm] [--biome MOUNT] [--time night] [--drops 3] [--kit STR_BLASTER_LAUNCHER:STR_BLASTER_BOMB]
bun tools/dev-endturn.ts Bob <matchId>   # end a dev player's turn (fast-forward rounds)
bun tools/balance.ts --games 300         # bot strategy tournament (parallel workers)
bun tools/duels.ts [--kits] [--calibrate] [--trace --only "sectopod"]   # price calibration duels
bun tools/player-stats.ts --db data/xcom.sqlite   # real-game balance report
bun tools/render-map.ts out.png URBAN 5 none day  # render a whole map offline
```

## Working practices

- **Server restarts**: client-only changes need just `bun run build` + a browser refresh; anything under
  `server/` or `shared/` that the server runs needs a restart. On Windows there's no `pkill`: stop the process
  on port 3000 via PowerShell (`Get-NetTCPConnection -LocalPort 3000 -State Listen` → `Stop-Process`) and start
  `bun run server/index.ts` again (hidden window / background).
- **Verify in a browser**, not just tests: the Playwright MCP browser can only write screenshots under
  `.playwright-mcp/` (gitignored). Dev login: `http://localhost:3000/auth/dev?name=Alice&next=/m/<id>`. The HUD
  is drawn at 3x on a 1280x860 viewport (panel origin ≈ (160, 692) screen px; button rects in `hud.ts`).
  Test matches persist in `data/xcom.sqlite`; delete lobbies you create (`DELETE /api/matches/<id>`), and never
  act in the user's own matches (their dev/Google user is "evan").
- **Editing files from the shell on Windows**: heredoc'd Python sometimes turns `\r`/`\n` escapes in JS source
  into real control characters, and scripts saved with the Write tool can have CRLF so `in` checks fail on LF
  sources. Prefer the Edit tool for exact multi-line edits; if scripting, normalize `\r\n` first.
- **Bun/JavaScriptCore does proper tail calls**: accidental self-recursion hangs forever instead of throwing a
  stack overflow (this froze the server once via `armorPrice`). Watch for it after search-and-replace edits.
- Co-op lives in the server + `coop.ts`: a battle "player" is a squad; `PlayerState.members` are its people,
  `Unit.controller` who commands a unit. Server-side checks (`mayCommand`) gate commands; "endturn" from a member
  is a lock-in toggle. Updates carry `by` (who acted) so a client only waits for its own; rejected commands reply
  `noUpdate`. Bot and AFK play share `runAI` (`turnSteps(rules, only)` plays a subset without ending the turn).
  `publish` builds one view diff per side (`SentState` is per seat — never extract per socket) plus one for a
  watching GM (`extractView(..., omniscient)`, `h.gmSent`). A scenario battle is seat 0 = the team (all players'
  loadouts merged, `controller` = hirer, GM as `observer` member), seat 1 = `bot:scenario:<id>` with `b.waves`; the
  enemy force is rebuilt deterministically from settings + seed (`buildEnemyForce`) for the match record.
- Engine changes must keep the fog of war intact: clients only get what `extractView` sends; never leak enemy
  positions/inventories. The AI uses the authoritative battle but only "knows" enemies it has seen (OpenXcom
  rules, including its round-20 cheat).
- Balance: prices = `value.ts` model × `calibration.json`. The bots are simple (weak with melee monsters and
  psi — those multipliers are floored at 0.2). Real-player data from `match_records` should drive the next
  rebalance; don't hand-tweak calibration without re-running duels.
- Commit/push/deploy only when the user asks. Git: `master`, remote `origin` = github.com/treefort/xcom-battlescape (**private**). Never commit the
  original game's files: `gamedata/` (incl. rendered music) stays gitignored, as do `data/` and `tools/.cache/`. Deployment (`python deploy/deploy-xcom.py --deploy --credentials <client.json> [--admin-email ...]`,
  target xcom.evanbooth.com, port 4320) has **never been run**: it's waiting on the user's Google OAuth
  web-client JSON and an explicit go-ahead.
- The droplet is shared with other sites: be conservative with nginx/system changes. SSH credentials live in a
  local file referenced by `~/Documents/ai/hosting/AGENTS.md` — treat it as secret; never print or commit it.

## Status (2026-10-22)

Playable end to end locally: lobby (hire/equip shop with drag-and-drop, budget bar, AI squads, settings reuse,
host message, random environment/time), battlescape (original rules, fog of war, reaction fire, psi, explosives,
blaster waypoints, supply drops/crates, minimap, exposure readout on move preview, music + sfx toggles, turn
chime), match statistics + reports, bot tournaments and price calibration, co-op squads (lock-in turns, AFK →
AI, unit hand-over) and per-bot AI settings (branch `feature/coop-squads`), co-op scenario mode with a game master
(branch `feature/coop-scenarios`, built on the former). Optional/not done: HUD rank icons,
alien UFOpaedia portraits, a TFTD-style narrower damage roll (offered, not requested).
