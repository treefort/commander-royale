# X-COM: Battlescape (multiplayer)

A browser port of the X-COM: UFO Defense battlescape, rebuilt for free-for-all squad battles and co-op scenarios (a team of people against an enemy a game master sets up), which anyone with the invite link can join, even mid-battle. It uses
the original game's graphics, maps, terrain and sounds (loaded from your copy of the game) and the original rules
(time units, accuracy, reaction fire, voxel line of fire, destructible terrain, fire, smoke, night lighting,
psionics...), with a multiplayer layer on top: Google sign-in, lobbies with invite links, a shared recruit pool
priced by ability, a budget-based armory and supply drops.

## Running locally

Requirements: [Bun](https://bun.sh) 1.3+ and an X-COM: UFO Defense install (GOG/Steam).

```sh
bun install
# copy the game data folders into ./gamedata (or point GAME_DIR at your install)
cp -r "<X-COM install>/"{GEODATA,GEOGRAPH,MAPS,ROUTES,SOUND,TERRAIN,UFOGRAPH,UNITS} gamedata/
bun tools/render-music.ts   # renders the General MIDI battle music to gamedata/MUSIC (needs ffmpeg)
bun run dev          # builds the client and starts http://localhost:3000
```

Browsers can't play MIDI, so `render-music.ts` synthesizes the original battle tracks (GMTACTIC, GMENBASE,
GMMARS, GMWIN, GMLOSE) once with spessasynth_core and the GeneralUser GS soundfont (downloaded to
`tools/.cache` on first run) and encodes them as Ogg Opus. They're served like the other game files and deployed
with the rest of `gamedata`. Music and sound effects can each be switched off, and their volumes set, from the
battlescape's Options screen.

Without Google credentials the server offers a **dev login** (type any name). To test multiplayer locally, open a
second browser profile/incognito window and sign in under another name.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `PUBLIC_URL` | `http://localhost:3000` | External URL (used for the OAuth redirect and secure cookies) |
| `GAME_DIR` | `./gamedata` | Folder with the original game's data directories |
| `DB_PATH` | `./data/xcom.sqlite` | SQLite database (accounts, sessions, matches, battle state) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Enables "Sign in with Google" |
| `DEV_LOGIN` | on when Google isn't configured | `0` disables the dev login (always do this in production) |

### Google sign-in

1. Google Cloud console → APIs & Services → Credentials → *Create OAuth client ID* → *Web application*.
2. Authorized redirect URIs: `https://xcom.evanbooth.com/auth/google/callback` (and
   `http://localhost:3000/auth/google/callback` for local testing).
3. Download the client JSON; pass its `client_id`/`client_secret` as the environment variables above, or give the file
   to the deploy script.

## Deploying (DigitalOcean droplet)

`deploy/deploy-xcom.py` follows the same pattern as gc.evanbooth.com (isolated `xcom` system user, pinned Bun,
`/opt/xcom/releases/<timestamp>` + `current` symlink, hardened systemd unit, nginx proxy with WebSockets, certbot
webroot certificate, state in `/var/lib/xcom/xcom.sqlite`):

```sh
bun run build
python deploy/deploy-xcom.py --deploy --credentials path/to/client_secret.json
```

The first run also uploads the game data (~9 MB) to `/opt/xcom/gamedata`. Back up `/var/lib/xcom/xcom.sqlite` and
`/etc/xcom/environment` along with the rest of the host.

## How a match works

1. **Create a match**: environment (urban, farmland, forest, jungle, desert, mountains,
   polar, Mars, alien base), time of day, optional landed UFO, map size (auto: sized when the battle starts for the
   squads there and the budget; or pick one), budget, seat limit, recruit pool size, technology level,
   alien recruits / tanks / armor / psionics toggles, supply drops (frequency, warning time, loot table, kits per drop) and an
   optional turn timer. The form shows what the budget buys (example squads priced from the real catalog).
2. **Invite**: share the match link. Anyone who opens it signs in with Google and joins the lobby; there's no player
   limit (a battle takes up to 30 sides). The creator
   can also add computer squads ("Add AI squad", with a hiring strategy); they hire automatically, are always
   ready, and play their turns on the server one action at a time so you can watch. Each computer squad has
   **AI settings**: aggression (cautious → reckless), how keen it is on explosives, how many rounds it remembers
   where it saw an enemy, the round after which it knows where everyone is, whether each race plays to type, and
   a **strength** (25–400% of the budget and seats) to handicap it — e.g. a double-strength alien squad against a
   team of people.
3. **Loadout**: every player hires from an identical copy of a randomly generated pool — rookies to veteran
   commanders, every alien race and rank, and tanks. Prices follow ability (time units, health × armor, accuracy,
   reactions, strength, psionics, innate weapons, flight, night vision, special abilities). Buy weapons, ammo,
   explosives, equipment and armor, then kit out each unit on the original inventory screen. Unequipped gear is
   dropped at your deployment zone. Human soldiers can also be put through **training** (Marksmanship, Reflexes,
   Fitness, Toughness, Grenadier, Close combat and, with psionics, Psi training; up to 4 sessions each, never past
   the original stat caps), at $1,000 a session or what the price model says the better stats are worth plus 25%.
4. **Battle**: the creator starts once two squads are ready; squads deploy around the map edge. Players take turns
   in a shuffled order; the game is asynchronous (close the tab and come back) unless a turn timer is set. Last
   squad standing wins.
5. **Joining late**: the invite link works while the battle is on. Latecomers (and anyone who wasn't ready at the
   start) hire and equip as usual and press **Deploy**: their squad lands in a new zone on the map edge, as far from
   everyone else as possible, and takes its turn after the others each round. In a co-op scenario they land with
   the team (or, landing apart, in a zone of their own); joining a shared squad that's already fighting puts you in
   at once, and its people hand you units.

### Setting up a match with an AI assistant

The New Match form has a **"Set up a match with AI"** panel. Copy its prompt into any AI assistant, describe the
match you want ("three of us against a Sectoid crash site, Floaters arriving later, turns end at 8pm"), and it
answers with a link that opens the form filled in (or JSON to paste into the panel). The panel lists anything it
had to adjust, and "Copy settings JSON / link" hands the current form back to the assistant to tweak.

The assistant reads **`/llms.txt`** (public, also at `/docs/match-settings.md`): both game modes, every setting
with its range and default, every enemy unit and weapon id with rough strengths, budget rules of thumb and worked
examples. It's generated from the game's rules (`shared/settings-docs.ts`), and tests check it covers every setting
and states the same ranges the server enforces.

### Co-op scenarios (game mode)

Pick **Game mode: Co-op scenario** when creating a match and you're the **game master**: everyone who joins plays
on one team against an enemy force you design, played by the computer.

- **The team**: its name, how many people (1–10) and how many **Skyranger seats** each fills (soldiers and small
  aliens take 1, tanks and large aliens 4 — so 4 seats is 4 soldiers or one tank; 10 people × 1 seat works too).
  Everyone hires and equips their own units from the budget; in battle each person commands their own. The team
  either **lands together** in one zone, or **apart**, each person in their own zone around the edge of the map
  like squads in a normal battle (their spare equipment lands with them), and the whole team moves at once (the same lock-in / give-unit / AFK controls as co-op squads
  below). Every move a teammate makes — and every enemy in sight — plays out on everyone's screen as it happens.
- **The game master** can play on the team too, or only run the game: then they hire nothing, can't give orders,
  and watch the **whole** battlefield (every unit on both sides, the whole map) live. They can call the mission off
  with Surrender.
- **The enemy**: any number of groups, each with a unit type (every alien race and rank, terror units, tanks, or
  human soldiers of a rank), a count, a weapon ("standard" picks by rank and tech level: plasma pistol / rifle /
  heavy plasma for alien tech, lasers or conventional arms otherwise), grenades, armor for soldiers, where they
  start (far side, at the UFO, the middle, scattered) and the round they arrive — anything after round 1 is a
  reinforcement wave. The enemy isn't beaten while reinforcements are still on the way. Its tactics (aggression,
  explosives, memory, the round it knows where everyone is, races playing to type) are set the same way.
- Plus the usual environment, time of day, landed UFO, map size (recommended from the number of units), budget,
  tech level, supply drops...
- **Turns**: the team moves first. Its turn ends when everyone has locked in (the default — players set the pace),
  or **at a set time every day** in the game master's time zone (or earlier if everyone has locked in; a turn that
  starts less than an hour before that time runs to the next day's), or on the turn timer. Offline players' units
  just stay where they are, unless "AI plays for offline players" is on.

### Co-op squads

With **Co-op: up to N people per squad** (1–10) set, several people can play one squad together. Once every squad
slot is taken, the invite link drops newcomers into the first squad with room; in the lobby anyone can also pick
"Join this squad" or go back to "Field my own squad". The squad's leader hires and equips it and can choose who
plays which unit ("Played by"); the rest are dealt out evenly when the battle starts.

On the squad's turn everyone acts **at the same time**, each on their own units (teammates' moves animate without
holding up your clicks; their units show "BOB'S UNIT" and can't be ordered about). **End Turn locks you in**
(press again to unlock; giving an order also unlocks); the turn ends once everyone has locked in, or — with "turn
ends on the turn timer" — only when the timer runs out. **G** hands the selected unit to the next teammate (your
own units, or any as the leader). Only the leader can surrender. The top right lists the squad with who is still
playing, done, AFK or offline.

**Keeping a game moving**: whenever a turn is waiting on someone, the host (the match creator / game master) gets
an **"AI: play this turn for ..."** button under the waiting banner. The AI plays the rest of that turn for whoever
hasn't moved or locked in, then the game moves on; next turn they're back in charge (or straight away, by switching
AFK off in Options).

**AFK**: Options → "AFK (AI plays)" hands your units to the AI until you switch it off, and it's never waited for.
With "AI plays for offline players" set, anyone offline for more than 30 s (`AWAY_GRACE_MS`) is played by the AI
too, until they reconnect. This also works for a one-person squad.

### Rules notes

- Original mechanics throughout: TU costs, snap/aimed/auto fire, the original accuracy spread, voxel line-of-fire,
  armor facing, fatal wounds, stun, explosions that destroy terrain, fire and smoke spread, doors, UFO doors,
  multi-level maps, flying, grenade fuses (they explode at the end of a turn), proximity grenades, flares, medikits,
  motion scanner, mind probe, blaster bomb waypoints.
- Reaction fire comes from any other squad's units that can see the moving unit.
- Aliens see in the dark; humans see 9 tiles at night beyond lit areas. Each squad's units light the map only for
  their own player.
- Any unit except tanks can carry items (yes, you can give a Chryssalid a grenade). Chryssalid victims rise as
  zombies for the Chryssalid's owner.
- Mind control (Psi-Amp or innate alien psionics) hands a unit to the attacker until their next turn begins.
- Picked-up equipment is usable at once — there's no research.
- **Supply drops**: every N rounds a drop is announced to everyone with its map position and countdown; when it
  lands, the crate's contents lie on the ground like a corpse pile — stand on it and open the inventory to grab gear.
- Removed from the original on purpose: civilians, morale/panic/berserk.

### Controls

The move preview also shows how exposed the destination is: **EXP** is the share of sightlines from 6 and 12 tiles
around (16 directions) that would reach your unit there, **KNEEL** the same if a soldier kneels, and **SEEN BY**
how many enemies in view would have a line of fire. It uses the same voxel line-of-fire test as real shots, on the
terrain you've explored (unexplored ground counts as open).

Left click selects/moves (click a destination twice: the first click previews the path with TU left), fires once
an action is chosen; right click turns the unit (or opens the door it faces) and cancels actions. Click a hand
slot for its actions. Wheel or PgUp/PgDn changes the view level; arrows, WASD, screen edges or middle-drag scroll.
Tab next unit, K kneel, I inventory, C center, M minimap, 1/2 left/right hand, G give the unit to a co-op teammate,
Enter chat, hold Shift to speed up animations.

## Architecture

- `shared/engine` — the battle simulation (port of the original rules via OpenXcom's reference implementation):
  map generation from the original map blocks, pathfinding, vision, voxel tracing, explosions, actions, turns.
  Runs authoritatively on the server; the client uses the same code for rendering helpers and path previews.
- `shared/formats` — decoders for the original PCK/TAB, SPK, SCR, MCD, MAP, LOFTEMPS and font files.
- `shared/rules` — unit/item/armor/terrain data and the multiplayer catalog, pricing and budget guide.
- `server` — Bun HTTP + WebSocket server, Google OAuth, SQLite persistence, lobby and battle hosting. Every action
  is resolved on the server and each player receives only the events and map knowledge their units can see.
- `client` — the lobby (HTML) and the battlescape, rendered in the original 8-bit palette onto a canvas.

`bun test` runs headless random battles in several environments as a regression check.

## Computer players and balance testing

`shared/engine/ai.ts` is a port of OpenXcom's alien AI (patrol / ambush / combat / escape modes, fire-point
search, reaction-aware retreats, psi, grenade and blaster-bomb targeting) adapted to free-for-all. Bots issue the
same commands as players through `GameRules.apply`, so they can't cheat the rules; like OpenXcom's aliens they
remember enemies they've seen for a few turns and, after round 20, know where everyone is. Additions over the
original: no route nodes (our maps are generated), so patrols explore and hunt known enemies; bots reload, ready
weapons from the backpack, pick up guns, and throw flares at night. It is not a strong player: it doesn't spread
out, focus fire, heal, or use cover deliberately, so treat balance numbers as "what a simple, consistent player
gets out of a purchase".

`shared/rules/squads.ts` builds legal squads with a strategy (swarm, elite, balanced, heavy, monster, aliens,
tanks, psi, random), spending leftovers on armor and better guns like a player would.

- `bun tools/balance.ts --games 300 [--budget 400000,1000000] [--strategies a,b] [--biome URBAN] [--time night]`
  plays strategy-vs-strategy tournaments in parallel worker threads and reports win rates, a head-to-head table
  and value for money per hire type and weapon.
- `bun tools/duels.ts [--kits] [--calibrate]` measures prices directly: equal-budget duels between a squad made of
  copies of one hire (or one weapon/armor on the same soldier) and a mixed reference platoon. A fairly priced
  class wins about half the time. `--calibrate` nudges `shared/rules/calibration.json` towards even (damped; run
  it a few times), `--trace` plays one duel per class and summarises what the bots did.

### Match statistics from real games

Every battle records per-unit statistics as it's played (`shared/engine/stats.ts`, saved with the battle):
commands used, TU spent, tiles moved, rounds fired and hits by weapon (hits armor stopped included), damage
dealt and taken, friendly fire, reaction shots, throws, melee, psi attempts and successes, times mind
controlled, and when the unit went down. When a match finishes the server stores a match record
(`shared/engine/record.ts`, table `match_records`): settings, seats, who won and who surrendered, every hire with
its kit, armor, price and gear cost, kills and the value of what it killed, its fate and full statistics, and
what happened to the supply drops. Records are kept even if the match is later deleted. Bot matches produce the
same records, so tournament and real-game numbers compare directly.

- `bun tools/player-stats.ts --db /var/lib/xcom/xcom.sqlite [--since 2026-11-01] [--csv units.csv]` prints the
  real-game balance report: turn-order advantage, budget use, matches by map/time/budget, squad shape vs win
  rate, value for money by hire, armor and weapon, weapon accuracy and damage, tactics (movement, reaction fire,
  psi success, friendly fire, supply-drop looting) and a per-player table. `--csv` writes one row per unit for
  spreadsheets.
- Accounts listed in `ADMIN_EMAILS` (comma separated; `deploy-xcom.py --admin-email you@example.com`) can download
  everything as JSON from `/api/admin/match-records` (optionally `?since=2026-11-01`) and run the report locally
  with `--json match-records.json`.

To rebalance from real data: look for hires and weapons whose exchange rate or win share stands out with enough
games behind it, adjust `shared/rules/calibration.json` (unit multipliers, weapon and armor prices) or the value
model, and re-check with the duels so bot-measured prices and player experience agree.

### How prices are set

Prices come from `shared/rules/value.ts`: a unit's combat value is offense (expected damage per turn) times
durability (health times how much its armor cuts damage from a typical mix of guns). Squad strength grows with
the square of numbers, so price scales with the square root of combat value, anchored at a median rookie with a
rifle. `calibration.json` then holds the per-type corrections and the weapon/armor prices measured by the duels.
