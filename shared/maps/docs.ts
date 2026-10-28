// The map recipe reference for AI assistants (served as /maps.txt, printed by `bun tools/map.ts reference`): how to
// describe a battle map as a recipe (recipe.ts), every op, every terrain with its original blocks and named
// materials (catalog.ts), what makes a map play well, and worked examples (tests compile them without warnings).
import { TERRAINS, UFO_TERRAINS, tr } from "../rules/index.ts";
import { BIOMES } from "../protocol.ts";
import { MAP_LIMITS } from "./format.ts";
import { BLOCK_NOTES, MATERIALS, type Material, type MaterialKind } from "./catalog.ts";
import { blockInfo } from "./build.ts";
import { defaultGround, OPS, type Recipe } from "./recipe.ts";
import { hillStyleFor } from "./ops.ts";

export const RECIPE_EXAMPLES: { ask: string; recipe: Recipe }[] = [
  {
    ask: "A small town crossroads for 2-4 squads: shops and houses, a two-storey building in the middle to fight over, and a park",
    recipe: {
      name: "Crossroads", description: "Two streets cross in the middle of town; the tall house on the corner overlooks everything.",
      terrain: "URBAN", size: 50, seed: 7, ground: "grass",
      ops: [
        { op: "path", material: "asphalt", points: [[24, 0], [24, 49]], width: 4 },
        { op: "path", material: "asphalt", points: [[0, 24], [49, 24]], width: 4 },
        { op: "building", area: [27, 27, 8, 7], wall: "blue-brick-wall", floor: "wood-floor", storeys: 2, doors: ["north", "west"], windows: "some" },
        { op: "building", area: [12, 12, 8, 6], wall: "white-wood-wall", floor: "wood-floor", doors: ["south", "east"] },
        { op: "building", area: [30, 12, 9, 7], wall: "warehouse-wall", floor: "grey-tile-floor", doors: [{ side: "west", at: 3 }], windows: "few" },
        { op: "building", area: [12, 30, 7, 6], wall: "plaster-wall", floor: "pink-tile-floor", doors: ["north"] },
        { op: "object", material: "shop-counter-ew", at: [[31, 14], [32, 14], [33, 14]] },
        { op: "scatter", material: "big-crate", area: [30, 12, 9, 7], count: 4, indoors: true },
        { op: "wall", material: "picket-fence", from: [36, 36], to: [46, 36] },
        { op: "scatter", materials: ["apple-tree", "flowerbed-red", "hedge-stump"], area: [36, 37, 12, 11], count: 8, spacing: 2 },
        { op: "scatter", materials: ["mailbox", "street-bin", "fire-hydrant", "phone-booth"], area: [20, 20, 10, 10], count: 5 },
      ],
      zones: [[0, 0, 10, 10], [40, 0, 10, 10], [0, 40, 10, 10], [40, 40, 10, 10]],
    },
  },
  {
    ask: "A farm where a UFO came down in the night, the barn half wrecked; 2 squads",
    recipe: {
      name: "Crash at the Farm", terrain: "CULTA", size: 50, seed: 3, base: "generated",
      ops: [
        { op: "clear", area: [18, 18, 14, 14] },
        { op: "ufo", type: "STR_MEDIUM_SCOUT", at: [20, 20] },
        { op: "ruin", area: [16, 16, 18, 18], amount: 0.3 },
        { op: "scatter", material: "scorched-dirt", area: [16, 16, 18, 18], count: 20, anywhere: true },
      ],
      zones: 2,
    },
  },
  {
    ask: "A wooded hill with a forest round it: whoever holds the top sees everything",
    recipe: {
      name: "King of the Hill", terrain: "FOREST", size: 40, seed: 11,
      ops: [
        { op: "hill", area: [13, 13, 14, 14], height: 3 },
        { op: "scatter", materials: ["tall-pine", "broad-fir", "small-bush", "brambles", "log"], count: 70, spacing: 2 },
        { op: "clear", area: [0, 0, 8, 8] },
        { op: "clear", area: [32, 32, 8, 8] },
      ],
      zones: [[0, 0, 8, 8], [32, 32, 8, 8]],
    },
  },
];

const KINDS: { kind: MaterialKind; title: string }[] = [
  { kind: "floor", title: "floors" }, { kind: "wall", title: "walls" }, { kind: "window", title: "windows" }, { kind: "door", title: "doors" },
  { kind: "fence", title: "fences" }, { kind: "corner", title: "corner posts" }, { kind: "stairs", title: "stairs" },
  { kind: "object", title: "objects" }, { kind: "multi", title: "multi-tile objects" }, { kind: "debris", title: "debris" },
];

function describe(m: Material): string {
  if (m.kind === "stairs") return `${m.name} (climbs ${m.dir})`;
  if (m.kind === "multi" && m.parts?.length) {
    const w = Math.max(...m.parts.map((p) => p[0])) + 1, h = Math.max(...m.parts.map((p) => p[1])) + 1;
    return `${m.name} (${w}x${h})`;
  }
  if (m.kind === "floor" && m.roof) return `${m.name} (roof)`;
  return m.name;
}

function terrainSection(name: string): string {
  const t = TERRAINS.get(name)!;
  const biome = BIOMES.find((b) => b.id === name);
  const blocks = t.mapBlocks.map((b) => {
    const info = blockInfo(b.name);
    return `- \`${b.name}\` (${info?.width ?? b.width}x${info?.length ?? b.length}): ${BLOCK_NOTES[b.name] ?? ""}`;
  });
  const mats = MATERIALS.filter((m) => t.mapDataSets.includes(m.dataset));
  const kinds = KINDS.map(({ kind, title }) => {
    const list = mats.filter((m) => m.kind === kind);
    return list.length ? `- ${title}: ${list.map(describe).join(", ")}` : "";
  }).filter(Boolean);
  return [
    `### ${name}: ${biome ? biome.name : "X-COM base"}`,
    "",
    `Part sets: ${t.mapDataSets.join(", ")}. Flat ground: \`${defaultGround(name)}\`. Hill style: ${hillStyleFor(name)}.${biome ? ` \`"base": "generated"\` works.` : " (No generator: start flat.)"}`,
    "",
    "Original blocks:",
    ...blocks,
    "",
    "Materials:",
    ...kinds,
    "",
  ].join("\n");
}

/** Materials in part sets no terrain uses (craft, UFO interiors). */
function extraSection(): string {
  const used = new Set([...TERRAINS.values()].flatMap((t) => t.mapDataSets));
  const sets = [...new Set(MATERIALS.map((m) => m.dataset))].filter((d) => !used.has(d));
  return sets.map((d) => {
    const mats = MATERIALS.filter((m) => m.dataset === d);
    return `- ${d}: ${KINDS.map(({ kind }) => mats.filter((m) => m.kind === kind).map(describe)).flat().join(", ")}`;
  }).join("\n");
}

export function mapsReference(origin: string, only?: string): string {
  const terrains = only && TERRAINS.has(only) ? [only] : [...TERRAINS.keys()];
  const ex = (r: Recipe) => "```json\n" + JSON.stringify(r, null, 1).replace(/\n\s+(?=[\]\d"-])/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]") + "\n```";
  return `# Commander Royale: map recipes

Commander Royale (${origin}) is a multiplayer remake of the X-COM: UFO Defense battlescape. Besides maps generated from
a match's settings, people play on **custom maps** made in its map editor. This reference is for AI assistants making
those maps: describe a battle map as a **recipe** (JSON), and the game builds it from the original game's terrain.
The match settings reference is ${origin}/llms.txt (a custom map is chosen there with \`"map": "<map id>"\`).

## Handing a map over

1. Write a recipe (format below). Keep it to what was asked; let the defaults do the rest.
2. Give the person this link: \`${origin}/maps/new?recipe=<the recipe JSON, URL-encoded>\`. It opens the map editor
   with the map built (signed in), where they look round it, change anything, and Save. Or give them the JSON: in the
   map editor, "New map" then "From a recipe" (or the Recipe panel of any map) takes it pasted in.
3. An agent with a shell in the game's folder can check its work first: \`bun tools/map.ts build recipe.json
   --plan plan.png --iso iso.png --server ${origin}\` prints the warnings and playability problems, draws a top-down plan
   (8 pixels a tile, a line every 10 tiles, landing zones numbered) and the in-game isometric view, and prints the link.
   Look at the pictures and fix the recipe until there are no warnings.
4. To fight on it, the saved map is picked under "Map" in the New Match form. Or skip the saving and the form: a
   play link (${origin}/llms.txt, "Play links") takes the recipe along with the match settings and computer
   opponents, builds and saves the map, and creates the match, with the squad auto-configured or left for the
   player to equip. When the person wants to play on the map rather than keep working on it, give them play links.

## Coordinates

Everything is in tiles. **x** runs west to east (0 to width-1), **y** north to south (0 to length-1), **z** is the
level (0 = ground, up to ${MAP_LIMITS.maxLevels - 1}). (0, 0) is the north-west corner: the top-left of a top-down plan, and the top corner
of the game's isometric view (x runs down-right on screen, y down-left).
- An **area** is \`[x, y, width, length]\`: \`[10, 20, 5, 3]\` covers x 10-14, y 20-22.
- A **position** is \`[x, y]\` or \`[x, y, z]\`.
- Walls stand on tile **edges**, between grid corners: a wall \`from [x, y] to [x2, y]\` runs west-east along the
  north edge of row y (tiles x to x2-1); \`from [x, y] to [x, y2]\` runs north-south along the west edge of column x.
  So the walls round an area \`[x, y, w, l]\` are at y, y+l (west-east) and x, x+w (north-south).
- A level is 24 "height units"; slopes and stairs climb 8 at a time. Soldiers see up to 20 tiles.

## Recipe

| field | type | what |
|---|---|---|
| \`terrain\` | ${[...TERRAINS.keys()].map((t) => `"${t}"`).join(" \\| ")} | the environment: its ground, music and original blocks (required) |
| \`name\` | string, ≤ 40 | the map's name |
| \`description\` | string, ≤ 1000 | shown to players choosing a map |
| \`size\` | number or [width, length] | in tiles, ${MAP_LIMITS.minSide}-${MAP_LIMITS.maxSide} each way (default 50). Multiples of 10 fit the original blocks. |
| \`levels\` | 1-${MAP_LIMITS.maxLevels} | height in levels (default 4, more when blocks or buildings need it) |
| \`seed\` | integer | the dice for scatter, ruin and the generator (same seed, same map) |
| \`base\` | "flat" \\| "generated" | flat ground (default), or the terrain's own random map (as a normal match gets) to change |
| \`ground\` | material | a flat base's floor (default: the terrain's usual ground) |
| \`ufo\` | UFO type \\| "random" | with a generated base: a landed UFO in the middle (or place one with the \`ufo\` op) |
| \`blocks\` | array of strings | rows of 10x10 cells, north to south; each row lists cells west to east separated by spaces: an original block's name, or \`.\` to leave the cell. A 20x20 block takes 2x2 cells: write its name in its north-west cell and \`.\` in the other three. |
| \`ops\` | array | edits, run in order after the base and the blocks (below) |
| \`zones\` | array of areas, or a number | where squads land: each at the map's edge, open ground, at least 14 tiles a soldier can stand on, far apart. A number (default 4) places that many automatically. A battle uses as many as it has squads, spread out, and makes more at the edge if it needs them. Co-op scenarios: the team lands in one, the enemy's "far side" groups in another. |

## Ops

Each op is an object with \`"op"\` and its fields. Unless said otherwise \`z\` (the level) defaults to 0. Materials
are named in the terrain lists below; any terrain's materials work on any map (their part set is added, up to
${MAP_LIMITS.maxDatasets} sets a map), and \`"DATASET:<number>"\` is a raw part.

| op | fields | does |
|---|---|---|
| \`floor\` | material, area, z | lays a floor over the area |
| \`path\` | material (a floor), points: [[x, y], ...], width (1), z | a road, track, river bed...: floor along straight lines through the points, clearing objects and the walls across it |
| \`building\` | area, wall, storeys (1), floor, roof, door, window, doors, windows, stairs, z | a building filling the area: outer walls on every storey (a corner post where the terrain has one), \`doors\` on the ground storey (a list of sides "north", "south", "east", "west", each centred, or {"side": "west", "at": 3} for 3 tiles along it; default ["south"]), \`windows\` "none" \\| "few" \\| "some" (default) \\| "many", \`floor\` on every storey (the ground storey keeps the ground if omitted), a flat \`roof\` on top (false for none), and stairs between storeys. door, window, roof and stairs default to ones that match the wall. Inside is cleared. |
| \`wall\` | material or materials: [...], from, to, z, storeys (1) | a straight wall, fence or hedge along a grid line (see Coordinates); several materials take turns along it |
| \`object\` | material, at (a position, or a list of them), z | an object, a multi-tile object (from its north-west tile), stairs (low step at "at", climbing its way) or a corner post |
| \`scatter\` | material or materials: [...], area (whole map), count or density (0-1 of the free tiles), spacing (min tiles apart), indoors (false), anywhere (false), z | dots objects about on open ground (outdoors, nothing on the tile); landing zones and the UFO stay clear unless \`anywhere\` |
| \`hill\` | area, height (1-3), style ("sand", "rock", "snow", "grass"; default: the terrain's), z | a hill filling the area: rings of slopes up to a flat top 8, 16 or a full level (24) high; each step of height needs 2 more tiles each way (height 3: at least 7x7). Snow only goes to 1. |
| \`clear\` | area, z | without z: everything on every level but the ground floor (open ground); with z: that level's walls and objects |
| \`erase\` | area, z, parts (["floor", "west", "north", "object"]) | removes exactly those parts |
| \`block\` | name, at, z | an original block with its north-west corner at "at" (any position, not just the 10x10 grid) |
| \`ufo\` | type, at | a landed UFO (${[...UFO_TERRAINS.keys()].map((u) => `\`${u}\` ${tr(u).toLowerCase()} ${UFO_TERRAINS.get(u)!.mapBlocks[0].width}x${UFO_TERRAINS.get(u)!.mapBlocks[0].length}`).join(", ")}) with its north-west corner at "at"; whatever was there is flattened. Co-op enemies placed "At the UFO" start round it. |
| \`ruin\` | area (whole map), amount (0.4), z | battle damage: that share of walls, objects and upper floors wrecked or gone |
| \`copy\` | area, to | copies an area (every level) to another place, e.g. to give the other side the same cover |
| \`part\` | at, slot ("floor", "west", "north", "object"), material (or null to empty it) | one part of one tile |
| \`zone\` | area | a landing zone (as in \`zones\`) |

Ops that can't do what they're asked still do what they can and say why (the editor and \`tools/map.ts\` show
these warnings: fix them). All ops: ${OPS.join(", ")}.

## Making a map that plays well

- **Size**: 2 squads: 40-50 tiles; 3-4: 60; 5-6: 70; more: 80+. Big empty maps make long walks; small cramped
  ones are decided by grenades.
- **Landing zones** at the edges, on open ground, as far apart as possible, with room for 14 soldiers each. For
  fairness give every zone similar cover nearby (\`copy\` helps) and a similar distance to the middle.
- **Cover everywhere**: nobody should cross 10+ open tiles to reach cover, and no open sightline should run from
  zone to zone (soldiers see 20 tiles). Mix hard cover (walls, buildings, rocks, crates) with soft (bushes, hedges,
  fences: they hide but don't stop shots well). Something worth taking in the middle: a UFO, a tall building, a hill.
- **Several routes** between the zones, through buildings and round them; doors on more than one side of big
  buildings. A two-storey building or a hill gives a vantage point; give it a weakness (open approach, windows).
- **Check it**: playability problems (zones nobody can walk between, zones without room) come back with the map.
- Original blocks are a quick way to get detailed buildings; ops add the story (a crashed UFO, a fence line, ruins).

## Terrains

Each original block is listed with its size and what's in it. Materials are named by kind; "multi-tile" ones give
their size (place them by their north-west tile), stairs the way they climb.

${terrains.map(terrainSection).join("\n")}
${only ? "" : `### Other part sets (craft and UFO interiors)\n\n${extraSection()}\n`}
## Examples

${RECIPE_EXAMPLES.map((e) => `**"${e.ask}"**\n\n${ex(e.recipe)}\n\nLink: ${origin}/maps/new?recipe=${encodeURIComponent(JSON.stringify(e.recipe)).slice(0, 60)}...`).join("\n\n")}
`;
}
