// The map editor: the map drawn as in battle (isometric, a level at a time), a top-down overview, and tools to
// paint tile parts, draw walls, raise whole buildings and hills, stamp original map blocks and UFOs, scatter trees,
// set landing zones; undo, checks (can every squad reach every other?), save, play. AI assistants' recipes can build
// a map or change the open one (recipe.ts); the tools here run the same operations (shared/maps/ops.ts).
import { api, el } from "../api.ts";
import type { Me } from "./home.ts";
import { pendingMap, setPendingMap, terrainName, parseMapText, assistantPrompt, copyText } from "./maps.ts";
import { preload, getFile, hasFile } from "../files.ts";
import { Assets } from "../render/assets.ts";
import { MapRenderer, type MapViewState, mapToScreen } from "../render/mapview.ts";
import { Surface } from "../render/surface.ts";
import { drawPlan, ZONE_COLORS } from "../render/plan.ts";
import { type Battle, type Rect } from "../../shared/engine/state.ts";
import { TilePart, parseMcd, type MapData } from "../../shared/formats/terrain.ts";
import { RNG } from "../../shared/engine/rng.ts";
import { recalcAllLighting } from "../../shared/engine/tileengine.ts";
import { type MapDoc, MAP_LIMITS, allDatasets, mapFiles, sanitizeMapDoc } from "../../shared/maps/format.ts";
import { mapBattle, battleDoc, checkMap, blockNames, blockInfo, blockFiles, placeBlock, ensureDataset, asciiPlan, type MapIssue } from "../../shared/maps/build.ts";
import { compileRecipe, recipeFiles, runOp, autoZones, type Op } from "../../shared/maps/recipe.ts";
import { MATERIALS, BLOCK_NOTES, partName, type Material } from "../../shared/maps/catalog.ts";
import { type EditCtx, opBuilding, opHill, opScatter, opObject, opWall, opFloor, opUfo, hillStyleFor, putPart, type HillStyle } from "../../shared/maps/ops.ts";
import { TERRAINS, UFO_TERRAINS, tr } from "../../shared/rules/index.ts";

type ToolId = "inspect" | "paint" | "rect" | "line" | "erase" | "fill" | "building" | "hill" | "scatter" | "block" | "ufo" | "copy" | "zone";

const TOOLS: { id: ToolId; key: string; name: string; help: string }[] = [
  { id: "inspect", key: "I", name: "Inspect", help: "Click a tile to see its parts (and pick or remove them). Alt+click with any tool picks the part under the cursor." },
  { id: "paint", key: "B", name: "Paint", help: "Click or drag to place the selected part. Walls go on the tile edge nearest the cursor." },
  { id: "rect", key: "R", name: "Rectangle", help: "Drag a rectangle: floors and objects fill it, walls go round it." },
  { id: "line", key: "L", name: "Wall line", help: "Drag along a grid line to build a straight wall, fence or hedge." },
  { id: "erase", key: "E", name: "Erase", help: "Click or drag to remove parts (choose which below). Shift+drag erases a rectangle." },
  { id: "fill", key: "F", name: "Fill floor", help: "Click a floor: every connected tile of the same floor on this level becomes the selected floor." },
  { id: "building", key: "U", name: "Building", help: "Drag a rectangle to raise a building: walls, windows, doors, floors, stairs and a roof." },
  { id: "hill", key: "H", name: "Hill", help: "Drag a rectangle to raise a hill (3x3 at least; 7x7 for a full level high)." },
  { id: "scatter", key: "S", name: "Scatter", help: "Drag a rectangle to dot the selected object (trees, rocks, crates...) about its open ground." },
  { id: "block", key: "K", name: "Block", help: "Stamp an original map block (choose it below). Snaps to the 10-tile grid unless you hold Shift." },
  { id: "ufo", key: "O", name: "UFO", help: "Land a UFO: click where its north-west corner goes. Co-op enemies placed \"At the UFO\" start round it." },
  { id: "copy", key: "C", name: "Copy", help: "Drag a rectangle to copy it (every level), then click to paste copies. Esc to stop." },
  { id: "zone", key: "Z", name: "Landing zones", help: "Drag a rectangle to add a landing zone; click one to remove it. Squads land in them, spread apart." },
];

interface Snap { sx: number; sy: number; sz: number; parts: Int16Array; zones: Rect[]; ufo: Rect | null }
/** A tool being dragged: where it started (tile and exact position) and what it has painted so far. */
interface ToolDrag { kind: "tool"; x0: number; y0: number; fx0: number; fy0: number; shift: boolean; painted: Set<string> }

/** A part from any part set, as a material (named, or "SET:n" by its own type). */
function rawMaterial(dataset: string, local: number, md: MapData): Material {
  const name = `${dataset}:${local}`;
  const t = md.objectType;
  if (t === TilePart.FLOOR) return { name, kind: "floor", dataset, part: local };
  if (t === TilePart.WESTWALL) return { name, kind: "wall", dataset, west: local };
  if (t === TilePart.NORTHWALL) return { name, kind: "wall", dataset, north: local };
  return { name, kind: "object", dataset, part: local };
}

const KIND_TABS: { id: string; name: string; kinds: Material["kind"][] }[] = [
  { id: "floor", name: "Floors", kinds: ["floor"] },
  { id: "wall", name: "Walls", kinds: ["wall", "window", "door", "fence", "corner"] },
  { id: "object", name: "Objects", kinds: ["object", "multi", "stairs"] },
  { id: "debris", name: "Debris", kinds: ["debris"] },
  { id: "raw", name: "All parts", kinds: [] },
];

export class MapEditor {
  private b!: Battle;
  private assets!: Assets;
  private renderer!: MapRenderer;
  private surf!: Surface;
  private image!: ImageData;
  private canvas = el("canvas", { class: "editor-canvas", tabindex: 0 }) as HTMLCanvasElement;
  private ctx2d = this.canvas.getContext("2d")!;
  private st: MapViewState = {
    player: 0, camera: { x: 0, y: 0, z: 0 }, showAllLayers: false, cursor: { x: 0, y: 0, z: 0, kind: "normal", size: 1, visible: false },
    selected: -1, anims: new Map(), poses: new Map(), projectile: null, explosions: [], flash: false, animFrame: 0, teamColors: [],
    supplyMarkers: [], crates: new Set(), path: null, doorAnim: new Map(),
  };
  private zoom = 2;
  private vw = 320;
  private vh = 200;
  private id: string | null = null;
  private mine = true;
  private author = "";
  private name = "Untitled map";
  private description = "";
  private terrain = "URBAN";
  private zones: Rect[] = [];
  private ufo: Rect | null = null;
  private undoStack: Snap[] = [];
  private redoStack: Snap[] = [];
  private changed = false;
  private tool: ToolId = "paint";
  private brush: Material | null = null;
  private hover: { x: number; y: number; fx: number; fy: number } | null = null;
  private drag: { kind: "pan"; x: number; y: number; cx: number; cy: number } | ToolDrag | null = null;
  private clipboard: { w: number; h: number; parts: Int16Array; sz: number } | null = null;
  private blockChoice = "";
  private ufoChoice = "STR_SMALL_SCOUT";
  private eraseWhat: "all" | "object" | "walls" | "floor" = "all";
  private building = { wall: "", floor: "", storeys: 1, doors: ["south"] as string[], windows: "some" };
  private hill = { height: 2, style: "" as HillStyle | "" };
  private scatter = { density: 0.15, spacing: 1 };
  private lighting: "flat" | "day" | "dusk" | "night" = "flat";
  private grid = true;
  private issues: MapIssue[] = [];
  private dirtyView = true;
  private dirtyPlan = true;
  private raf = 0;
  private destroyed = false;
  private mcds = new Map<string, MapData[]>();
  private nearestCache = new Map<string, number>();
  private warnings: string[] = [];
  // the DOM
  private nameInput = el("input", { class: "editor-name", maxlength: 40 }) as HTMLInputElement;
  private status = el("div", { class: "editor-status" });
  private toolBox = el("div", { class: "editor-tools" });
  private optionsBox = el("div", { class: "editor-options" });
  private paletteBox = el("div", { class: "editor-palette" });
  private infoBox = el("div", { class: "editor-info" });
  private problemsBox = el("div", { class: "editor-problems" });
  private plan = el("canvas", { class: "editor-plan" }) as HTMLCanvasElement;
  private levelLabel = el("span", { class: "editor-level" });
  private saveBtn = el("button", { class: "primary small" }, "Save") as HTMLButtonElement;
  private undoBtn = el("button", { class: "small", title: "Undo (Ctrl+Z)" }, "Undo") as HTMLButtonElement;
  private redoBtn = el("button", { class: "small", title: "Redo (Ctrl+Y)" }, "Redo") as HTMLButtonElement;
  private paletteTab = "floor";
  private paletteSet = "";
  private paletteSearch = "";
  private modal: HTMLElement | null = null;

  constructor(private root: HTMLElement, private me: Me, private go: (path: string) => void, private mapId: string | null) {
    document.body.classList.add("editing");
    root.innerHTML = "";
    root.append(el("div", { class: "boot" }, "LOADING THE MAP EDITOR..."));
    this.start().catch((e) => {
      root.replaceChildren(el("div", { class: "wrap panel err" }, `Can't open the map editor: ${(e as Error).message}`), el("div", { class: "wrap" }, el("a", { href: "/maps" }, "Back to the maps")));
    });
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("beforeunload", this.beforeUnload);
    document.body.classList.remove("editing");
  }

  private beforeUnload = (e: BeforeUnloadEvent) => {
    if (this.changed) e.preventDefault();
  };

  // ------------------------------------------------------------------------------------------
  // loading
  // ------------------------------------------------------------------------------------------

  private async load(paths: string[], what = "GAME DATA") {
    const boot = this.root.querySelector(".boot");
    await preload(paths, (d, t) => {
      if (boot) boot.textContent = `LOADING ${what} ${Math.floor((d / t) * 100)}%`;
    });
  }

  private baseFiles(): string[] {
    return ["GEODATA/PALETTES.DAT", "GEODATA/SMALLSET.DAT", "GEODATA/BIGLETS.DAT", "GEODATA/LOFTEMPS.DAT", "UFOGRAPH/CURSOR.PCK", "UFOGRAPH/CURSOR.TAB",
      "UFOGRAPH/SMOKE.PCK", "UFOGRAPH/SMOKE.TAB", "UNITS/FLOOROB.PCK", "UNITS/FLOOROB.TAB", "UFOGRAPH/X1.PCK", "UFOGRAPH/X1.TAB", "UFOGRAPH/HIT.PCK", "UFOGRAPH/HIT.TAB"];
  }

  private async start() {
    await this.load(this.baseFiles());
    this.assets = new Assets(getFile, hasFile);
    this.renderer = new MapRenderer(this.assets);
    let doc: MapDoc;
    let note = "";
    if (this.mapId) {
      const st = await api<{ doc: MapDoc; mine: boolean; author: string; id: string }>(`/api/maps/${this.mapId}`);
      doc = st.doc;
      this.id = st.id;
      this.mine = st.mine;
      this.author = st.author;
    } else {
      // a recipe or a map to start from: from the maps page, or a link (/maps/new?recipe=...)
      let p = pendingMap;
      setPendingMap(null);
      const linked = new URLSearchParams(location.search).get("recipe");
      if (!p && linked) {
        p = { ...parseMapText(linked), source: "the link" };
        history.replaceState(null, "", "/maps/new");
      }
      if (!p) p = { recipe: { terrain: "URBAN", size: 50, name: "Untitled map" } };
      if (p.doc) doc = sanitizeMapDoc(p.doc);
      else {
        const built = await this.compile(p.recipe);
        doc = built.doc;
        this.warnings = built.warnings;
        if (p.source) note = `Built from ${p.source}'s recipe${built.warnings.length ? ` with ${built.warnings.length} warning${built.warnings.length === 1 ? "" : "s"} (see Problems)` : ""}. Look round it, then Save.`;
      }
      this.changed = true;
    }
    await this.load([...mapFiles(doc.datasets), ...allDatasets().map((d) => `TERRAIN/${d}.MCD`)]);
    this.setDoc(doc);
    this.buildUi();
    if (note) this.flash(note);
    this.check();
    this.centerOn(this.b.sx / 2, this.b.sy / 2);
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Compiles a recipe, fetching what it needs first. */
  private async compile(recipe: unknown) {
    const r = recipe as { terrain?: string };
    if (!r || typeof r !== "object" || !TERRAINS.has(String(r.terrain ?? "").toUpperCase())) throw new Error(`the recipe needs a terrain: one of ${[...TERRAINS.keys()].join(", ")}`);
    await this.load(recipeFiles({ ...(recipe as object), terrain: String(r.terrain).toUpperCase() } as never), "THE RECIPE'S PARTS");
    const out = compileRecipe(recipe, getFile);
    await this.load(mapFiles(out.doc.datasets));
    return out;
  }

  private setDoc(doc: MapDoc) {
    this.b = mapBattle(doc, getFile);
    this.b.discovered[0].fill(7);
    this.name = doc.name;
    this.description = doc.description;
    this.terrain = doc.terrain;
    this.zones = doc.zones.map((z) => ({ ...z }));
    this.ufo = doc.ufo ? { ...doc.ufo } : null;
    this.relight();
    this.st.camera.z = Math.min(this.st.camera.z, this.b.sz - 1);
    if (!this.building.wall) this.pickBuildingDefaults();
    this.dirtyView = this.dirtyPlan = true;
  }

  private doc(): MapDoc {
    return battleDoc(this.b, { name: this.name.trim() || "Untitled map", description: this.description, terrain: this.terrain, zones: this.zones, ufo: this.ufo });
  }

  private pickBuildingDefaults() {
    const sets = TERRAINS.get(this.terrain)?.mapDataSets ?? [];
    const walls = MATERIALS.filter((m) => m.kind === "wall" && m.west !== undefined && m.north !== undefined);
    this.building.wall = (walls.find((m) => sets.includes(m.dataset)) ?? walls.find((m) => m.dataset === "URBAN"))?.name ?? "";
    this.building.floor = "";
  }

  // ------------------------------------------------------------------------------------------
  // the page
  // ------------------------------------------------------------------------------------------

  private buildUi() {
    const r = this.root;
    r.innerHTML = "";
    this.nameInput.value = this.name;
    this.nameInput.disabled = !this.mine;
    this.nameInput.addEventListener("input", () => {
      this.name = this.nameInput.value;
      this.touch(false);
    });
    this.saveBtn.onclick = () => this.save();
    this.undoBtn.onclick = () => this.undo();
    this.redoBtn.onclick = () => this.redo();
    const lighting = el("select", { title: "How the map is lit in the editor" },
      ...[["flat", "Lit evenly"], ["day", "Day"], ["dusk", "Dusk"], ["night", "Night"]].map(([v, n]) => el("option", { value: v }, n))) as HTMLSelectElement;
    lighting.addEventListener("change", () => {
      this.lighting = lighting.value as typeof this.lighting;
      this.relight();
      this.dirtyView = true;
    });
    const zoom = el("select", { title: "Zoom (Ctrl+wheel)" }, ...[1, 2, 3, 4].map((z) => el("option", { value: z, selected: z === this.zoom }, `${z}x`))) as HTMLSelectElement;
    zoom.addEventListener("change", () => this.setZoom(Number(zoom.value)));
    const allLevels = el("input", { type: "checkbox" }) as HTMLInputElement;
    allLevels.addEventListener("change", () => {
      this.st.showAllLayers = allLevels.checked;
      this.dirtyView = true;
    });
    const top = el("div", { class: "editor-top" },
      el("a", { href: "/maps", class: "btn small", onclick: (e: Event) => {
        e.preventDefault();
        if (this.changed && !confirm("Leave without saving your changes?")) return;
        this.changed = false;
        this.go("/maps");
      } }, "Maps"),
      this.nameInput,
      el("span", { class: "muted" }, `${terrainName(this.terrain)} · ${this.b.sx}x${this.b.sy}, ${this.b.sz} levels${this.mine ? "" : ` · by ${this.author}`}`),
      el("span", { class: "grow" }),
      this.undoBtn, this.redoBtn,
      el("button", { class: "small", title: "Up a level (PageUp / wheel up)", onclick: () => this.setLevel(this.st.camera.z + 1) }, "▲"),
      this.levelLabel,
      el("button", { class: "small", title: "Down a level (PageDown / wheel down)", onclick: () => this.setLevel(this.st.camera.z - 1) }, "▼"),
      el("label", { title: "Draw the levels above too" }, allLevels, "all levels"),
      zoom, lighting,
      el("button", { class: "small", onclick: () => this.aiDialog() }, "AI"),
      el("button", { class: "small", onclick: () => this.propertiesDialog() }, "Map"),
      el("button", { class: "small", title: "Check the map for problems", onclick: () => this.check(true) }, "Check"),
      this.mine ? this.saveBtn : el("button", { class: "small primary", onclick: () => this.saveCopy() }, "Save a copy"),
      el("button", { class: "small", title: "Create a match on this map", onclick: () => this.play() }, "Play"),
    );
    for (const t of TOOLS) {
      this.toolBox.append(el("button", { class: "tool", "data-tool": t.id, title: `${t.name} (${t.key}): ${t.help}`, onclick: () => this.setTool(t.id) },
        el("span", { class: "tool-key" }, t.key), t.name));
    }
    this.plan.addEventListener("mousedown", (e) => this.planClick(e));
    this.plan.addEventListener("mousemove", (e) => e.buttons & 1 && this.planClick(e));
    const side = el("div", { class: "editor-side" },
      el("div", { class: "editor-section" }, el("div", { class: "title" }, "OVERVIEW"), this.plan, el("div", { class: "hint" }, "Click to look there. Zones are numbered; the box is what's in view.")),
      el("div", { class: "editor-section" }, this.optionsBox),
      el("div", { class: "editor-section grow-section" }, this.paletteBox),
    );
    const left = el("div", { class: "editor-left" }, this.toolBox, this.infoBox, this.problemsBox);
    const mid = el("div", { class: "editor-mid" }, this.canvas, this.status);
    r.append(el("div", { class: "editor" }, top, el("div", { class: "editor-body" }, left, mid, side)));
    this.bindInput();
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.onKey);
    window.addEventListener("beforeunload", this.beforeUnload);
    this.resize();
    this.setTool(this.mine ? "paint" : "inspect");
    this.renderPalette();
    this.updateButtons();
  }

  private resize = () => {
    const box = this.canvas.parentElement!.getBoundingClientRect();
    const w = Math.max(160, Math.floor(box.width)), h = Math.max(120, Math.floor(box.height - this.status.offsetHeight));
    this.vw = Math.floor(w / this.zoom);
    this.vh = Math.floor(h / this.zoom);
    this.canvas.width = this.vw;
    this.canvas.height = this.vh;
    this.canvas.style.width = `${this.vw * this.zoom}px`;
    this.canvas.style.height = `${this.vh * this.zoom}px`;
    this.surf = new Surface(this.vw, this.vh);
    this.image = this.ctx2d.createImageData(this.vw, this.vh);
    this.dirtyView = this.dirtyPlan = true;
  };

  private setZoom(z: number) {
    const cx = this.vw / 2, cy = this.vh / 2;
    const at = this.screenToTile(cx, cy);
    this.zoom = Math.max(1, Math.min(4, z));
    this.resize();
    this.centerOn(at.fx, at.fy);
    const sel = this.root.querySelector(".editor-top select[title^='Zoom']") as HTMLSelectElement | null;
    if (sel) sel.value = String(this.zoom);
  }

  private setLevel(z: number) {
    this.st.camera.z = Math.max(0, Math.min(this.b.sz - 1, z));
    this.dirtyView = this.dirtyPlan = true;
    this.updateButtons();
  }

  private updateButtons() {
    this.undoBtn.disabled = !this.undoStack.length || !this.mine;
    this.redoBtn.disabled = !this.redoStack.length || !this.mine;
    this.levelLabel.textContent = `LEVEL ${this.st.camera.z}`;
    this.saveBtn.textContent = this.changed ? "Save*" : "Saved";
    this.saveBtn.disabled = !this.changed && !!this.id;
    for (const b of this.toolBox.querySelectorAll("button")) b.classList.toggle("active", b.getAttribute("data-tool") === this.tool);
  }

  private flash(text: string, bad = false) {
    this.status.textContent = text;
    this.status.classList.toggle("bad", bad);
  }

  // ------------------------------------------------------------------------------------------
  // drawing
  // ------------------------------------------------------------------------------------------

  private frame = () => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (this.dirtyView) {
      this.dirtyView = false;
      this.draw();
    }
    if (this.dirtyPlan) {
      this.dirtyPlan = false;
      this.drawPlan();
    }
  };

  private relight() {
    const b = this.b;
    if (this.lighting === "flat") {
      b.globalShade = 0;
      b.light.fill(15);
      return;
    }
    b.globalShade = this.lighting === "night" ? 15 : this.lighting === "dusk" ? 7 : 0;
    b.light.fill(0);
    recalcAllLighting(b);
  }

  /** A palette colour near an RGB one (for the editor's overlays). */
  private color(r: number, g: number, bl: number): number {
    const k = `${r},${g},${bl}`;
    let c = this.nearestCache.get(k);
    if (c === undefined) {
      const pal = this.assets.pal;
      let best = 1, bd = Infinity;
      for (let i = 1; i < 256; i++) {
        const d = (pal[i * 3] - r) ** 2 + (pal[i * 3 + 1] - g) ** 2 + (pal[i * 3 + 2] - bl) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      this.nearestCache.set(k, (c = best));
    }
    return c;
  }

  /** Screen position of a grid corner (between tiles) on a level. */
  private cornerScreen(cx: number, cy: number, z: number) {
    return { x: (cx - cy) * 16 + 16 + this.st.camera.x, y: (cx + cy) * 8 - z * 24 + 20 + this.st.camera.y };
  }

  private line(x0: number, y0: number, x1: number, y1: number, c: number, dotted = false) {
    const s = this.surf;
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) {
      if (dotted && (i >> 1) % 2) continue;
      s.setPixel(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c);
    }
  }

  /** Outlines an area on a level (corners on the grid). */
  private outline(r: Rect, z: number, c: number, dotted = false) {
    const a = this.cornerScreen(r.x, r.y, z), b = this.cornerScreen(r.x + r.w, r.y, z);
    const cc = this.cornerScreen(r.x + r.w, r.y + r.h, z), d = this.cornerScreen(r.x, r.y + r.h, z);
    this.line(a.x, a.y, b.x, b.y, c, dotted);
    this.line(b.x, b.y, cc.x, cc.y, c, dotted);
    this.line(cc.x, cc.y, d.x, d.y, c, dotted);
    this.line(d.x, d.y, a.x, a.y, c, dotted);
  }

  private draw() {
    const s = this.surf;
    s.clear(0);
    const h = this.hover;
    const z = this.st.camera.z;
    // the tile cursor, except for tools that work on grid lines or areas being dragged
    const area = this.drag?.kind === "tool" ? this.dragArea(this.drag) : null;
    this.st.cursor = { x: h?.x ?? 0, y: h?.y ?? 0, z, kind: "normal", size: 1, visible: !!h && !area && this.tool !== "line" && !(this.tool === "paint" && this.isWallBrush()) };
    this.renderer.draw(s, this.b, this.st, this.vh);
    // the 10-tile grid on the ground
    if (this.grid) {
      const g = this.color(70, 90, 140);
      for (let x = 0; x <= this.b.sx; x += 10) {
        const a = this.cornerScreen(x, 0, 0), b = this.cornerScreen(x, this.b.sy, 0);
        this.line(a.x, a.y, b.x, b.y, g, true);
      }
      for (let y = 0; y <= this.b.sy; y += 10) {
        const a = this.cornerScreen(0, y, 0), b = this.cornerScreen(this.b.sx, y, 0);
        this.line(a.x, a.y, b.x, b.y, g, true);
      }
    }
    this.zones.forEach((zn, i) => this.outline(zn, 0, this.color(...ZONE_COLORS[i % ZONE_COLORS.length])));
    if (this.ufo) this.outline(this.ufo, 0, this.color(255, 80, 255), true);
    const yellow = this.color(250, 230, 80);
    if (area) this.outline(area, z, yellow);
    if (h) {
      // what the tool would do, outlined
      if (this.tool === "block" && this.blockChoice) {
        const info = blockInfo(this.blockChoice);
        if (info) this.outline({ ...this.snapped(h), w: info.width, h: info.length }, z, yellow, true);
      } else if (this.tool === "ufo") {
        const blk = UFO_TERRAINS.get(this.ufoChoice)?.mapBlocks[0];
        if (blk) this.outline({ x: h.x, y: h.y, w: blk.width, h: blk.length }, 0, this.color(255, 80, 255));
      } else if (this.tool === "copy" && this.clipboard && !area) {
        this.outline({ x: h.x, y: h.y, w: this.clipboard.w, h: this.clipboard.h }, z, yellow, true);
      } else if (this.tool === "line" && !area) {
        const c = this.cornerScreen(Math.round(h.fx), Math.round(h.fy), z);
        s.fillRect(c.x - 1, c.y - 1, 3, 3, yellow);
      } else if (this.tool === "paint" && this.isWallBrush()) {
        const e = this.edgeAt(h);
        if (e) {
          const a = this.cornerScreen(e.x, e.y, z), b = this.cornerScreen(e.slot === TilePart.WESTWALL ? e.x : e.x + 1, e.slot === TilePart.WESTWALL ? e.y + 1 : e.y, z);
          this.line(a.x, a.y, b.x, b.y, yellow);
          this.line(a.x, a.y - 1, b.x, b.y - 1, yellow);
        }
      }
      if (this.drag?.kind === "tool" && this.tool === "line") {
        const l = this.lineEnds(this.drag, h);
        const a = this.cornerScreen(l.from.x, l.from.y, z), b = this.cornerScreen(l.to.x, l.to.y, z);
        this.line(a.x, a.y, b.x, b.y, yellow);
        this.line(a.x, a.y - 1, b.x, b.y - 1, yellow);
      }
    }
    this.surf.toRGBA(this.assets.pal, this.image.data);
    this.ctx2d.putImageData(this.image, 0, 0);
  }

  private drawPlan() {
    const box = this.plan.parentElement!.getBoundingClientRect();
    const scale = Math.max(1, Math.floor(Math.min(box.width - 4, 300) / Math.max(this.b.sx, this.b.sy)));
    const p = drawPlan(this.b, this.assets, { scale, level: this.st.camera.z, zones: this.zones, ufo: this.ufo, grid: true });
    if (this.plan.width !== p.width || this.plan.height !== p.height) {
      this.plan.width = p.width;
      this.plan.height = p.height;
    }
    const ctx = this.plan.getContext("2d")!;
    ctx.putImageData(new ImageData(p.rgba as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0);
    // what the main view shows
    const corners = [[0, 0], [this.vw, 0], [this.vw, this.vh], [0, this.vh]].map(([x, y]) => this.screenToTile(x, y));
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath();
    corners.forEach((c, i) => (i ? ctx.lineTo(c.fx * scale, c.fy * scale) : ctx.moveTo(c.fx * scale, c.fy * scale)));
    ctx.closePath();
    ctx.stroke();
    (this.plan as HTMLCanvasElement & { scale?: number }).scale = scale;
  }

  private planClick(e: MouseEvent) {
    const scale = (this.plan as HTMLCanvasElement & { scale?: number }).scale ?? 1;
    const r = this.plan.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.plan.width / scale, y = ((e.clientY - r.top) / r.height) * this.plan.height / scale;
    this.centerOn(x, y);
  }

  private centerOn(x: number, y: number) {
    const s = mapToScreen({ x, y, z: this.st.camera.z });
    this.st.camera.x = Math.round(this.vw / 2 - (s.x + 16));
    this.st.camera.y = Math.round(this.vh / 2 - (s.y + 20));
    this.dirtyView = this.dirtyPlan = true;
  }

  // ------------------------------------------------------------------------------------------
  // input
  // ------------------------------------------------------------------------------------------

  /** The map position (fractional, on the current level's floor) under a canvas pixel. */
  private screenToTile(sx: number, sy: number) {
    const a = (sx - this.st.camera.x - 16) / 16, c = (sy - this.st.camera.y - 20 + this.st.camera.z * 24) / 8;
    const fx = (a + c) / 2, fy = (c - a) / 2;
    return { x: Math.floor(fx), y: Math.floor(fy), fx, fy };
  }

  private virt(e: MouseEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.vw, y: ((e.clientY - r.top) / r.height) * this.vh };
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());
    c.addEventListener("mousedown", (e) => {
      c.focus();
      const p = this.virt(e);
      if (e.button === 1 || e.button === 2) {
        this.drag = { kind: "pan", x: p.x, y: p.y, cx: this.st.camera.x, cy: this.st.camera.y };
        return;
      }
      if (e.button !== 0) return;
      const t = this.screenToTile(p.x, p.y);
      if (e.altKey) return this.pick(t.x, t.y);
      if (!this.mine && this.tool !== "inspect") return this.flash("This is someone else's map: Save a copy to change it.", true);
      this.drag = { kind: "tool", x0: t.x, y0: t.y, fx0: t.fx, fy0: t.fy, shift: e.shiftKey, painted: new Set() };
      this.toolDown(t);
    });
    window.addEventListener("mousemove", (e) => {
      if (this.destroyed || !this.surf) return;
      this.shiftHeld = e.shiftKey;
      const p = this.virt(e);
      const inside = e.target === c;
      if (this.drag?.kind === "pan") {
        this.st.camera.x = Math.round(this.drag.cx + (p.x - this.drag.x));
        this.st.camera.y = Math.round(this.drag.cy + (p.y - this.drag.y));
        this.dirtyView = this.dirtyPlan = true;
        return;
      }
      const t = this.screenToTile(p.x, p.y);
      const on = t.x >= 0 && t.y >= 0 && t.x < this.b.sx && t.y < this.b.sy;
      const was = this.hover;
      this.hover = (inside || this.drag) && on ? t : null;
      if (this.drag?.kind === "tool") this.toolMove(t);
      if (!was || !this.hover || was.x !== t.x || was.y !== t.y || this.tool === "line" || this.tool === "paint") {
        this.dirtyView = true;
        if (!was || !this.hover || was.x !== this.hover.x || was.y !== this.hover.y) this.showInfo();
      }
    });
    window.addEventListener("mouseup", () => {
      if (this.destroyed) return;
      const d = this.drag;
      this.drag = null;
      if (d?.kind === "tool" && this.hover) this.toolUp(this.hover, d);
      else if (d?.kind === "tool" && this.tool === "paint") this.flash(TOOLS.find((x) => x.id === "paint")!.help);
      this.dirtyView = true;
    });
    c.addEventListener("mouseleave", () => {
      if (!this.drag) {
        this.hover = null;
        this.dirtyView = true;
      }
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey) this.setZoom(this.zoom + (e.deltaY < 0 ? 1 : -1));
      else this.setLevel(this.st.camera.z + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
  }

  private onKey = (e: KeyboardEvent) => {
    if (this.destroyed || this.modal) return;
    const target = e.target as HTMLElement;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") {
      e.preventDefault();
      return e.shiftKey ? this.redo() : this.undo();
    }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "y") {
      e.preventDefault();
      return this.redo();
    }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "s") {
      e.preventDefault();
      return this.mine ? this.save() : this.saveCopy();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const pan = 48;
    if (k === "PageUp" || k === "+" || k === "=") return this.setLevel(this.st.camera.z + 1);
    if (k === "PageDown" || k === "-") return this.setLevel(this.st.camera.z - 1);
    if (k === "ArrowLeft") this.st.camera.x += pan;
    else if (k === "ArrowRight") this.st.camera.x -= pan;
    else if (k === "ArrowUp") this.st.camera.y += pan;
    else if (k === "ArrowDown") this.st.camera.y -= pan;
    else if (k === "Escape") {
      this.drag = null;
      this.clipboard = null;
      this.renderOptions();
    } else if (k === "g" || k === "G") this.grid = !this.grid;
    else {
      const t = TOOLS.find((x) => x.key === k.toUpperCase());
      if (t) this.setTool(t.id);
      else return;
    }
    e.preventDefault();
    this.dirtyView = this.dirtyPlan = true;
  };

  private dragArea(d: ToolDrag): Rect | null {
    const h = this.hover;
    if (!h) return null;
    const areaTools: ToolId[] = ["rect", "building", "hill", "scatter", "copy", "zone"];
    if (!areaTools.includes(this.tool) && !(this.tool === "erase" && d.shift)) return null;
    if (this.tool === "rect" && this.isWallBrush()) {
      // a room: corners on the grid
      const x0 = Math.round(d.fx0), y0 = Math.round(d.fy0), x1 = Math.round(h.fx), y1 = Math.round(h.fy);
      return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.max(1, Math.abs(x1 - x0)), h: Math.max(1, Math.abs(y1 - y0)) };
    }
    const x0 = Math.max(0, Math.min(d.x0, h.x)), y0 = Math.max(0, Math.min(d.y0, h.y));
    const x1 = Math.min(this.b.sx - 1, Math.max(d.x0, h.x)), y1 = Math.min(this.b.sy - 1, Math.max(d.y0, h.y));
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** A wall line from where the drag started to the cursor, along whichever axis it's longer. */
  private lineEnds(d: ToolDrag, h: { fx: number; fy: number }) {
    const from = { x: Math.round(d.fx0), y: Math.round(d.fy0) };
    const tx = Math.round(h.fx), ty = Math.round(h.fy);
    const to = Math.abs(tx - from.x) >= Math.abs(ty - from.y) ? { x: tx, y: from.y } : { x: from.x, y: ty };
    return { from, to };
  }

  private isWallBrush(): boolean {
    const k = this.brush?.kind;
    return k === "wall" || k === "window" || k === "door" || k === "fence";
  }

  /** The tile edge nearest the cursor that the brush can go on: a west wall of (x, y) or a north wall. */
  private edgeAt(h: { x: number; y: number; fx: number; fy: number }): { x: number; y: number; slot: TilePart } | null {
    const m = this.brush;
    if (!m) return null;
    const dx = h.fx - h.x, dy = h.fy - h.y;
    const options: { d: number; x: number; y: number; slot: TilePart }[] = [];
    if (m.west !== undefined) options.push({ d: dx, x: h.x, y: h.y, slot: TilePart.WESTWALL }, { d: 1 - dx, x: h.x + 1, y: h.y, slot: TilePart.WESTWALL });
    if (m.north !== undefined) options.push({ d: dy, x: h.x, y: h.y, slot: TilePart.NORTHWALL }, { d: 1 - dy, x: h.x, y: h.y + 1, slot: TilePart.NORTHWALL });
    options.sort((a, b) => a.d - b.d);
    const o = options.find((o) => o.x < this.b.sx && o.y < this.b.sy);
    return o ? { x: o.x, y: o.y, slot: o.slot } : null;
  }

  private shiftHeld = false;
  private snapped(h: { x: number; y: number }) {
    if (this.shiftHeld) return { x: h.x, y: h.y };
    return { x: Math.floor(h.x / 10) * 10, y: Math.floor(h.y / 10) * 10 };
  }

  private editCtx(): EditCtx {
    return { b: this.b, files: getFile, rng: new RNG((Math.random() * 2 ** 31) >>> 0), zones: this.zones, ufo: this.ufo, warnings: [] };
  }

  /** Runs an edit (with an undo step); reports what it couldn't do. */
  private edit(what: string, fn: (ctx: EditCtx) => void, snapshot = true) {
    if (snapshot) this.snapshot();
    const ctx = this.editCtx();
    try {
      fn(ctx);
      this.ufo = ctx.ufo;
      if (ctx.warnings.length) this.flash(`${what}: ${ctx.warnings.join("; ")}`, true);
    } catch (e) {
      this.flash(`${what}: ${(e as Error).message}`, true);
    }
    this.touch();
  }

  private needBrush(kinds?: Material["kind"][]): Material | null {
    const m = this.brush;
    if (!m) {
      this.flash("Choose a part or material on the right first.", true);
      return null;
    }
    if (kinds && !kinds.includes(m.kind)) {
      this.flash(`That tool needs ${kinds.join(" / ")}: ${m.name} is a ${m.kind}.`, true);
      return null;
    }
    return m;
  }

  private toolDown(t: { x: number; y: number; fx: number; fy: number }) {
    const z = this.st.camera.z;
    switch (this.tool) {
      case "inspect":
        return this.inspect(t.x, t.y);
      case "paint":
        if (!this.needBrush()) return;
        this.snapshot();
        return this.paintAt(t);
      case "erase":
        if (this.drag?.kind === "tool" && this.drag.shift) return;
        this.snapshot();
        return this.eraseAt(t.x, t.y);
      case "fill": {
        const m = this.needBrush(["floor"]);
        if (m) this.edit("Fill", (ctx) => this.floodFill(ctx, m, t.x, t.y, z));
        return;
      }
      case "block": {
        if (!this.blockChoice) return this.flash("Choose a block on the right first.", true);
        const at = this.snapped(t);
        return this.edit("Block", (ctx) => placeBlock(ctx.b, this.blockChoice, at.x, at.y, z, getFile));
      }
      case "ufo":
        return this.edit("UFO", (ctx) => opUfo(ctx, this.ufoChoice, { x: t.x, y: t.y }));
      case "copy":
        if (this.clipboard) {
          const clip = this.clipboard;
          this.edit("Paste", (ctx) => this.paste(ctx, clip, t.x, t.y));
          this.drag = null;
        }
        return;
      case "zone": {
        const i = this.zones.findIndex((r) => t.x >= r.x && t.y >= r.y && t.x < r.x + r.w && t.y < r.y + r.h);
        if (i >= 0) {
          this.snapshot();
          this.zones.splice(i, 1);
          this.drag = null;
          this.touch();
        }
        return;
      }
    }
  }

  private toolMove(t: { x: number; y: number; fx: number; fy: number }) {
    if (this.drag?.kind !== "tool" || t.x < 0 || t.y < 0 || t.x >= this.b.sx || t.y >= this.b.sy) return;
    if (this.tool === "paint" && !this.brushIsBig()) this.paintAt(t);
    else if (this.tool === "erase" && !this.drag.shift) this.eraseAt(t.x, t.y);
  }

  private toolUp(t: { x: number; y: number; fx: number; fy: number }, d: ToolDrag) {
    const area = this.dragArea(d);
    const z = this.st.camera.z;
    switch (this.tool) {
      case "rect": {
        const m = this.needBrush();
        if (!m || !area) return;
        if (this.isWallBrush()) {
          this.edit("Walls", (ctx) => {
            const mats = [m];
            if (m.north !== undefined) {
              opWall(ctx, mats, { x: area.x, y: area.y }, { x: area.x + area.w, y: area.y }, z);
              opWall(ctx, mats, { x: area.x, y: area.y + area.h }, { x: area.x + area.w, y: area.y + area.h }, z);
            }
            if (m.west !== undefined) {
              opWall(ctx, mats, { x: area.x, y: area.y }, { x: area.x, y: area.y + area.h }, z);
              opWall(ctx, mats, { x: area.x + area.w, y: area.y }, { x: area.x + area.w, y: area.y + area.h }, z);
            }
          });
        } else if (m.kind === "floor" || (m.kind === "debris" && this.slotOf(m) === TilePart.FLOOR)) this.edit("Floor", (ctx) => opFloor(ctx, m, area, z));
        else this.edit("Fill", (ctx) => {
          for (let x = area.x; x < area.x + area.w; x++) for (let y = area.y; y < area.y + area.h; y++) opObject(ctx, m, { x, y, z });
        });
        return;
      }
      case "line": {
        const m = this.needBrush(["wall", "window", "door", "fence"]);
        if (!m) return;
        const l = this.lineEnds(d, t);
        if (l.from.x === l.to.x && l.from.y === l.to.y) return;
        if ((l.from.y === l.to.y && m.north === undefined) || (l.from.x === l.to.x && m.west === undefined))
          return this.flash(`${m.name} only stands ${m.north === undefined ? "north-south" : "west-east"}.`, true);
        return this.edit("Wall", (ctx) => opWall(ctx, [m], l.from, l.to, z));
      }
      case "erase":
        if (d.shift && area) this.edit("Erase", () => {
          for (let x = area.x; x < area.x + area.w; x++) for (let y = area.y; y < area.y + area.h; y++) this.eraseAt(x, y);
        });
        return;
      case "building": {
        if (!area) return;
        const b = this.building;
        return this.edit("Building", (ctx) => {
          const mat = (n: string) => (n ? (MATERIALS.find((m) => m.name === n) ?? null) : undefined);
          const wall = mat(b.wall);
          if (!wall) throw new Error("choose its walls");
          opBuilding(ctx, area, { wall, floor: mat(b.floor), storeys: b.storeys, z, doors: b.doors as never, windows: b.windows as never });
        });
      }
      case "hill":
        if (!area) return;
        return this.edit("Hill", (ctx) => opHill(ctx, area, this.hill.height, (this.hill.style || hillStyleFor(this.terrain)) as HillStyle, z));
      case "scatter": {
        const m = this.needBrush(["object", "multi", "debris"]);
        if (!m || !area) return;
        return this.edit("Scatter", (ctx) => opScatter(ctx, [m], area, { density: this.scatter.density, spacing: this.scatter.spacing, z, anywhere: true, indoors: true }));
      }
      case "copy": {
        if (!area || this.clipboard) return;
        const b = this.b;
        const parts = new Int16Array(area.w * area.h * b.sz * 4);
        let i = 0;
        for (let k = 0; k < b.sz; k++)
          for (let y = area.y; y < area.y + area.h; y++)
            for (let x = area.x; x < area.x + area.w; x++) for (let p = 0; p < 4; p++) parts[i++] = b.parts[b.idx(x, y, k) * 4 + p];
        this.clipboard = { w: area.w, h: area.h, parts, sz: b.sz };
        this.flash(`Copied ${area.w}x${area.h}: click to paste it (Esc to stop).`);
        this.renderOptions();
        return;
      }
      case "zone":
        if (!area || area.w * area.h < 4) return;
        if (this.zones.length >= MAP_LIMITS.maxZones) return this.flash(`${MAP_LIMITS.maxZones} landing zones at most.`, true);
        this.snapshot();
        this.zones.push(area);
        this.touch();
        return;
    }
  }

  private brushIsBig() {
    return this.brush?.kind === "multi" || this.brush?.kind === "stairs";
  }

  private slotOf(m: Material): TilePart {
    const local = m.part ?? m.west ?? m.north ?? m.low ?? 0;
    const md = this.mcd(m.dataset)[local];
    const t = md?.objectType ?? TilePart.OBJECT;
    return t >= 0 && t <= 3 ? t : TilePart.OBJECT;
  }

  private paintAt(t: { x: number; y: number; fx: number; fy: number }) {
    const m = this.brush!;
    const z = this.st.camera.z;
    const d = this.drag?.kind === "tool" ? this.drag : null;
    if (this.isWallBrush()) {
      const e = this.edgeAt(t);
      if (!e) return;
      const key = `${e.x},${e.y},${e.slot}`;
      if (d?.painted.has(key)) return;
      d?.painted.add(key);
      this.edit("Paint", (ctx) => {
        const id = ensureDataset(ctx.b, m.dataset, getFile) + (e.slot === TilePart.WESTWALL ? m.west! : m.north!);
        putPart(ctx.b, e.x, e.y, z, id, e.slot);
      }, false);
      return;
    }
    const key = `${t.x},${t.y}`;
    if (d?.painted.has(key)) return;
    d?.painted.add(key);
    this.edit("Paint", (ctx) => opObject(ctx, m.kind === "floor" ? { ...m, kind: "object" } : m, { x: t.x, y: t.y, z }), false);
  }

  private eraseAt(x: number, y: number) {
    const t = this.b.idx(x, y, this.st.camera.z);
    if (t < 0) return;
    const slots = this.eraseWhat === "all" ? [0, 1, 2, 3] : this.eraseWhat === "object" ? [3] : this.eraseWhat === "walls" ? [1, 2] : [0];
    for (const s of slots) this.b.setPart(t, s as TilePart, -1);
    this.touch();
  }

  private floodFill(ctx: EditCtx, m: Material, x: number, y: number, z: number) {
    const b = ctx.b;
    const start = b.idx(x, y, z);
    if (start < 0) return;
    const from = b.parts[start * 4];
    const id = ensureDataset(b, m.dataset, getFile) + m.part!;
    if (from === id) return;
    const stack = [[x, y]];
    const seen = new Set<number>();
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      const t = b.idx(cx, cy, z);
      if (t < 0 || seen.has(t) || b.parts[t * 4] !== from) continue;
      seen.add(t);
      b.parts[t * 4] = id;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  private paste(ctx: EditCtx, clip: { w: number; h: number; parts: Int16Array; sz: number }, x0: number, y0: number) {
    const b = ctx.b;
    let i = 0;
    for (let k = 0; k < clip.sz; k++)
      for (let y = 0; y < clip.h; y++)
        for (let x = 0; x < clip.w; x++)
          for (let p = 0; p < 4; p++) {
            const v = clip.parts[i++];
            const t = b.idx(x0 + x, y0 + y, k);
            if (t >= 0) b.setPart(t, p as TilePart, v);
          }
  }

  /** Alt+click: the topmost part on the tile at this level becomes the brush. */
  private pick(x: number, y: number) {
    const t = this.b.idx(x, y, this.st.camera.z);
    if (t < 0) return;
    for (const p of [TilePart.OBJECT, TilePart.NORTHWALL, TilePart.WESTWALL, TilePart.FLOOR]) {
      const id = this.b.parts[t * 4 + p];
      if (id >= 0) return this.useBrush(this.materialFor(id));
    }
  }

  /** The named material a battle part belongs to (or the raw part). */
  private materialFor(id: number): Material {
    const md = this.b.lib.mapData[id];
    const ds = this.b.lib.datasetNames[md.set];
    const local = md.local;
    return MATERIALS.find((m) => m.dataset === ds && (m.part === local || m.west === local || m.north === local) && m.kind !== "multi") ?? rawMaterial(ds, local, md);
  }

  private useBrush(m: Material) {
    this.brush = m;
    if (this.tool === "inspect" || this.tool === "zone" || this.tool === "block" || this.tool === "ufo" || this.tool === "copy") this.setTool("paint");
    this.renderPalette();
    this.renderOptions();
    this.flash(`Brush: ${m.name}${m.label ? ` — ${m.label}` : ""}`);
  }

  // ------------------------------------------------------------------------------------------
  // undo, changes
  // ------------------------------------------------------------------------------------------

  private snapshot() {
    const b = this.b;
    this.undoStack.push({ sx: b.sx, sy: b.sy, sz: b.sz, parts: b.parts.slice(), zones: this.zones.map((z) => ({ ...z })), ufo: this.ufo ? { ...this.ufo } : null });
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
  }

  private restore(s: Snap) {
    const b = this.b;
    if (s.sx !== b.sx || s.sy !== b.sy || s.sz !== b.sz) {
      const doc = this.doc();
      this.setDoc({ ...doc, size: [s.sx, s.sy, s.sz], parts: "" });
    }
    this.b.parts = s.parts.slice();
    this.zones = s.zones.map((z) => ({ ...z }));
    this.ufo = s.ufo ? { ...s.ufo } : null;
    this.touch();
  }

  private current(): Snap {
    const b = this.b;
    return { sx: b.sx, sy: b.sy, sz: b.sz, parts: b.parts.slice(), zones: this.zones.map((z) => ({ ...z })), ufo: this.ufo ? { ...this.ufo } : null };
  }

  private undo() {
    const s = this.undoStack.pop();
    if (!s || !this.mine) return;
    this.redoStack.push(this.current());
    this.restore(s);
  }

  private redo() {
    const s = this.redoStack.pop();
    if (!s || !this.mine) return;
    this.undoStack.push(this.current());
    this.restore(s);
  }

  private touch(geometry = true) {
    this.changed = true;
    if (geometry) {
      if (this.lighting !== "flat") this.relight();
      this.dirtyView = this.dirtyPlan = true;
      this.issues = [];
      this.renderProblems();
    }
    this.updateButtons();
  }

  // ------------------------------------------------------------------------------------------
  // panels
  // ------------------------------------------------------------------------------------------

  private setTool(t: ToolId) {
    this.tool = t;
    if (t !== "copy") this.clipboard = null;
    const info = TOOLS.find((x) => x.id === t)!;
    this.flash(info.help);
    this.renderOptions();
    this.updateButtons();
    this.dirtyView = true;
    if (t === "block" && !this.blocksLoaded) this.loadBlocks();
  }

  private blocksLoaded = false;
  private async loadBlocks() {
    this.blocksLoaded = true;
    const files = new Set<string>();
    for (const n of blockNames()) for (const f of blockFiles(n)) files.add(f);
    for (const d of allDatasets()) for (const f of mapFiles([d])) files.add(f);
    this.flash("Loading the original map blocks...");
    await preload([...files]);
    this.flash(TOOLS.find((x) => x.id === "block")!.help);
    this.renderOptions();
  }

  private renderOptions() {
    const box = this.optionsBox;
    const info = TOOLS.find((x) => x.id === this.tool)!;
    box.replaceChildren(el("div", { class: "title" }, info.name.toUpperCase()), el("div", { class: "hint" }, info.help));
    const sel = (opts: [string, string][], value: string, set: (v: string) => void) => {
      const s = el("select", {}, ...opts.map(([v, n]) => el("option", { value: v, selected: v === value }, n))) as HTMLSelectElement;
      s.addEventListener("change", () => set(s.value));
      return s;
    };
    const brushLine = () => el("div", { class: "row" }, el("span", {}, "Brush:"), this.brush ? el("b", {}, this.brush.name) : el("span", { class: "muted" }, "choose one below"));
    switch (this.tool) {
      case "paint":
      case "rect":
      case "line":
      case "fill":
        box.append(brushLine());
        break;
      case "erase":
        box.append(el("div", { class: "row" }, el("span", {}, "Remove"), sel([["all", "everything"], ["object", "objects"], ["walls", "walls"], ["floor", "floors"]], this.eraseWhat, (v) => (this.eraseWhat = v as typeof this.eraseWhat))));
        break;
      case "scatter":
        box.append(brushLine(), el("div", { class: "row" },
          el("span", {}, "Density"), sel([["0.05", "sparse"], ["0.15", "some"], ["0.3", "dense"], ["0.6", "thick"]], String(this.scatter.density), (v) => (this.scatter.density = Number(v))),
          el("span", {}, "spacing"), sel([["0", "any"], ["1", "1"], ["2", "2"], ["3", "3"]], String(this.scatter.spacing), (v) => (this.scatter.spacing = Number(v)))));
        break;
      case "building": {
        const walls = MATERIALS.filter((m) => m.kind === "wall" && m.west !== undefined && m.north !== undefined);
        const floors = MATERIALS.filter((m) => m.kind === "floor" && !m.roof);
        const b = this.building;
        const doorBoxes = (["north", "south", "east", "west"] as const).map((side) => {
          const c = el("input", { type: "checkbox", checked: b.doors.includes(side) }) as HTMLInputElement;
          c.addEventListener("change", () => (b.doors = c.checked ? [...b.doors, side] : b.doors.filter((x) => x !== side)));
          return el("label", {}, c, side);
        });
        box.append(
          el("div", { class: "row" }, el("span", {}, "Walls"), sel(walls.map((m) => [m.name, `${m.name} (${m.dataset})`]), b.wall, (v) => (b.wall = v))),
          el("div", { class: "row" }, el("span", {}, "Floor"), sel([["", "keep the ground (upper storeys: matching)"], ...floors.map((m) => [m.name, `${m.name} (${m.dataset})`] as [string, string])], b.floor, (v) => (b.floor = v))),
          el("div", { class: "row" }, el("span", {}, "Storeys"), sel([["1", "1"], ["2", "2"], ["3", "3"]], String(b.storeys), (v) => (b.storeys = Number(v))),
            el("span", {}, "windows"), sel([["none", "none"], ["few", "few"], ["some", "some"], ["many", "many"]], b.windows, (v) => (b.windows = v))),
          el("div", { class: "row" }, el("span", {}, "Doors:"), ...doorBoxes),
        );
        break;
      }
      case "hill":
        box.append(el("div", { class: "row" },
          el("span", {}, "Height"), sel([["1", "low (8)"], ["2", "medium (16)"], ["3", "a full level (24)"]], String(this.hill.height), (v) => (this.hill.height = Number(v))),
          el("span", {}, "style"), sel([["", `terrain's own (${hillStyleFor(this.terrain)})`], ["grass", "grass"], ["rock", "rock"], ["sand", "sand"], ["snow", "snow (low only)"]], this.hill.style, (v) => (this.hill.style = v as HillStyle | ""))));
        break;
      case "block": {
        if (!hasFile("MAPS/URBAN00.MAP")) {
          box.append(el("div", { class: "muted" }, "Loading the blocks..."));
          break;
        }
        const list = el("div", { class: "block-list" });
        for (const t of [this.terrain, ...[...TERRAINS.keys()].filter((x) => x !== this.terrain), "UFO", "CRAFT"]) {
          const names = blockNames().filter((n) => {
            const r = blockInfo(n)!.rule;
            if (t === "UFO") return [...UFO_TERRAINS.values()].includes(r);
            if (t === "CRAFT") return !TERRAINS.has(r.name) && ![...UFO_TERRAINS.values()].includes(r);
            return r.name === t;
          });
          if (!names.length) continue;
          list.append(el("div", { class: "block-group" }, t === "UFO" ? "UFOs" : t === "CRAFT" ? "Craft" : terrainName(t)));
          for (const n of names) {
            const info = blockInfo(n)!;
            list.append(el("button", { class: "block-item" + (n === this.blockChoice ? " active" : ""), title: BLOCK_NOTES[n] ?? "", onclick: () => {
              this.blockChoice = n;
              this.renderOptions();
            } }, `${n} ${info.width}x${info.length}`));
          }
        }
        box.append(this.blockChoice ? el("div", { class: "hint" }, BLOCK_NOTES[this.blockChoice] ?? "") : "", list);
        break;
      }
      case "ufo":
        box.append(el("div", { class: "row" }, sel([...UFO_TERRAINS.keys()].map((u) => [u, `${tr(u)} (${UFO_TERRAINS.get(u)!.mapBlocks[0].width}x${UFO_TERRAINS.get(u)!.mapBlocks[0].length})`]), this.ufoChoice, (v) => (this.ufoChoice = v)),
          this.ufo ? el("button", { class: "small", onclick: () => {
            this.snapshot();
            this.ufo = null;
            this.touch();
            this.renderOptions();
          } }, "Forget the UFO area") : null));
        break;
      case "copy":
        box.append(el("div", { class: "muted" }, this.clipboard ? `Holding ${this.clipboard.w}x${this.clipboard.h}: click to paste, Esc to drop it.` : "Nothing copied yet."));
        break;
      case "zone": {
        const list = el("div", {});
        this.zones.forEach((z, i) => list.append(el("div", { class: "row" },
          el("span", { style: { color: `rgb(${ZONE_COLORS[i % ZONE_COLORS.length].join(",")})` } }, `Zone ${i + 1}`),
          el("span", { class: "muted" }, `${z.x},${z.y} ${z.w}x${z.h}`),
          el("button", { class: "small", onclick: () => this.centerOn(z.x + z.w / 2, z.y + z.h / 2) }, "Show"),
          this.mine ? el("button", { class: "small danger", onclick: () => {
            this.snapshot();
            this.zones.splice(i, 1);
            this.touch();
            this.renderOptions();
          } }, "Remove") : null)));
        box.append(list, this.mine ? el("button", { class: "small", onclick: () => {
          this.snapshot();
          this.zones = autoZones(this.b, 4, [], this.ufo);
          this.touch();
          this.renderOptions();
        } }, "Place 4 automatically") : "");
        break;
      }
    }
  }

  private mcd(ds: string): MapData[] {
    let m = this.mcds.get(ds);
    if (!m) this.mcds.set(ds, (m = hasFile(`TERRAIN/${ds}.MCD`) ? parseMcd(getFile(`TERRAIN/${ds}.MCD`), 0) : []));
    return m;
  }

  /** A little picture of a material (its parts as they'd stand on the map). */
  private thumb(m: Material): HTMLCanvasElement {
    const defs = this.mcd(m.dataset);
    const sheet = hasFile(`TERRAIN/${m.dataset}.PCK`) ? this.assets.terrain(m.dataset) : [];
    const parts: [number, number, number, number][] = [];
    if (m.kind === "multi") for (const [dx, dy, p, dz] of m.parts ?? []) parts.push([dx, dy, dz ?? 0, p]);
    else if (m.kind === "stairs") {
      const d = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[m.dir ?? "north"]!;
      parts.push([0, 0, 0, m.low!], [d[0], d[1], 0, m.high!]);
    } else for (const p of [m.part, m.west, m.north]) if (p !== undefined) parts.push([0, 0, 0, p]);
    const minX = Math.min(...parts.map((p) => p[0])), minY = Math.min(...parts.map((p) => p[1]));
    const pos = parts.map(([dx, dy, dz, p]) => ({ s: mapToScreen({ x: dx - minX, y: dy - minY, z: dz }), p }));
    const x0 = Math.min(...pos.map((q) => q.s.x)), y0 = Math.min(...pos.map((q) => q.s.y));
    const W = Math.max(...pos.map((q) => q.s.x)) - x0 + 32, H = Math.max(...pos.map((q) => q.s.y)) - y0 + 40;
    const s = new Surface(W, H);
    pos.sort((a, b) => a.s.y - b.s.y);
    for (const q of pos) {
      const md = defs[q.p];
      const img = md && sheet[md.sprites[0]];
      if (img) s.blit(img, q.s.x - x0, q.s.y - y0 - md.yOffset);
    }
    const c = el("canvas", { width: W, height: H, class: "thumb" }) as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    s.toRGBA(this.assets.pal, img.data, true);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  private renderPalette() {
    const box = this.paletteBox;
    const sets = this.b.lib.datasetNames.filter((d) => d !== "BLANKS" || this.paletteTab === "raw");
    const tabs = el("div", { class: "palette-tabs" }, ...KIND_TABS.map((t) => el("button", { class: "small" + (t.id === this.paletteTab ? " active" : ""), onclick: () => {
      this.paletteTab = t.id;
      this.renderPalette();
    } }, t.name)));
    const setSel = el("select", {},
      el("option", { value: "" }, "this map's part sets"),
      ...allDatasets().map((d) => el("option", { value: d, selected: d === this.paletteSet }, `${d}${this.b.lib.datasetNames.includes(d) ? "" : " (adds it)"}`))) as HTMLSelectElement;
    setSel.addEventListener("change", async () => {
      this.paletteSet = setSel.value;
      if (this.paletteSet) await preload(mapFiles([this.paletteSet]));
      this.renderPalette();
    });
    const search = el("input", { placeholder: "search", value: this.paletteSearch, style: { width: "110px" } }) as HTMLInputElement;
    search.addEventListener("input", () => {
      this.paletteSearch = search.value;
      fill();
    });
    const grid = el("div", { class: "palette-grid" });
    const fill = () => {
      grid.innerHTML = "";
      const shown = this.paletteSet ? [this.paletteSet] : sets;
      const q = this.paletteSearch.trim().toLowerCase();
      let items: Material[];
      if (this.paletteTab === "raw") {
        items = [];
        for (const ds of shown) this.mcd(ds).forEach((md, i) => items.push(rawMaterial(ds, i, md)));
      } else {
        const kinds = KIND_TABS.find((t) => t.id === this.paletteTab)!.kinds;
        items = MATERIALS.filter((m) => shown.includes(m.dataset) && kinds.includes(m.kind));
      }
      if (q) items = items.filter((m) => m.name.toLowerCase().includes(q) || (m.label ?? "").toLowerCase().includes(q));
      for (const m of items.slice(0, 400)) {
        const named = this.paletteTab === "raw" ? partName(m.dataset, m.part ?? m.west ?? m.north ?? 0) : null;
        const active = this.brush && this.brush.name === m.name && this.brush.dataset === m.dataset;
        grid.append(el("button", { class: "palette-item" + (active ? " active" : ""), title: `${named?.name ?? m.name}${m.label ? ` — ${m.label}` : ""} (${m.dataset}, ${m.kind})`, onclick: () => this.useBrush(m) },
          this.thumb(m), el("span", {}, named?.name ?? m.name)));
      }
      if (!items.length) grid.append(el("div", { class: "muted" }, "Nothing here: try another part set."));
    };
    fill();
    box.replaceChildren(el("div", { class: "title" }, "PARTS"), tabs, el("div", { class: "row" }, setSel, search), grid);
  }

  private inspect(x: number, y: number) {
    const t = this.b.idx(x, y, this.st.camera.z);
    if (t < 0) return;
    const names = ["Floor", "West wall", "North wall", "Object"];
    const rows = [0, 1, 2, 3].map((p) => {
      const id = this.b.parts[t * 4 + p];
      if (id < 0) return el("div", { class: "muted" }, `${names[p]}: none`);
      const m = this.materialFor(id);
      return el("div", { class: "row" }, el("span", {}, `${names[p]}: ${m.name}`),
        el("button", { class: "small", onclick: () => this.useBrush(m) }, "Use"),
        this.mine ? el("button", { class: "small danger", onclick: () => {
          this.snapshot();
          this.b.setPart(t, p as TilePart, -1);
          this.touch();
          this.inspect(x, y);
        } }, "Remove") : null);
    });
    this.optionsBox.replaceChildren(el("div", { class: "title" }, `TILE ${x}, ${y}, LEVEL ${this.st.camera.z}`), ...rows);
  }

  private showInfo() {
    const h = this.hover;
    if (!h) return void (this.infoBox.textContent = "");
    const t = this.b.idx(h.x, h.y, this.st.camera.z);
    const parts = [0, 3, 1, 2].map((p) => this.b.parts[t * 4 + p]).filter((id) => id >= 0).map((id) => this.materialFor(id).name);
    const zone = this.zones.findIndex((r) => h.x >= r.x && h.y >= r.y && h.x < r.x + r.w && h.y < r.y + r.h);
    this.infoBox.replaceChildren(
      el("div", { class: "title" }, `${h.x}, ${h.y} · LEVEL ${this.st.camera.z}`),
      el("div", {}, parts.length ? parts.join(", ") : "nothing"),
      zone >= 0 ? el("div", { class: "good" }, `landing zone ${zone + 1}`) : "",
    );
  }

  private renderProblems() {
    const box = this.problemsBox;
    if (!this.issues.length && !this.warnings.length) return void box.replaceChildren();
    box.replaceChildren(el("div", { class: "title" }, "PROBLEMS"),
      ...this.issues.map((i) => el("div", { class: i.level === "error" ? "bad" : "warn" }, i.text)),
      ...this.warnings.map((w) => el("div", { class: "warn" }, w)),
      this.warnings.length ? el("button", { class: "small", onclick: () => {
        this.warnings = [];
        this.renderProblems();
      } }, "Clear recipe warnings") : "");
  }

  private check(report = false) {
    this.issues = checkMap(this.b, this.zones, this.ufo);
    this.renderProblems();
    if (report) this.flash(this.issues.length ? `${this.issues.length} problem${this.issues.length === 1 ? "" : "s"}: see the left.` : "No problems: every landing zone has room and squads can walk between them.", !!this.issues.length);
    return this.issues;
  }

  // ------------------------------------------------------------------------------------------
  // save, play, dialogs
  // ------------------------------------------------------------------------------------------

  private async save(): Promise<boolean> {
    if (!this.mine) return false;
    this.saveBtn.disabled = true;
    try {
      const doc = this.doc();
      const r = await api<{ id: string }>(this.id ? `/api/maps/${this.id}` : "/api/maps", { body: { doc } });
      if (!this.id) history.replaceState(null, "", `/maps/${r.id}`);
      this.id = r.id;
      this.changed = false;
      const issues = this.check();
      this.flash(issues.length ? `Saved, but it has ${issues.length} problem${issues.length === 1 ? "" : "s"} (left).` : "Saved.", !!issues.length);
      return true;
    } catch (e) {
      this.flash(`Couldn't save: ${(e as Error).message}`, true);
      return false;
    } finally {
      this.updateButtons();
    }
  }

  private async saveCopy() {
    try {
      const doc = { ...this.doc(), name: `${this.name} (copy)`.slice(0, 40) };
      const r = await api<{ id: string }>("/api/maps", { body: { doc } });
      this.changed = false;
      this.go(`/maps/${r.id}`);
    } catch (e) {
      this.flash(`Couldn't save: ${(e as Error).message}`, true);
    }
  }

  private async play() {
    if (this.check().some((i) => i.level === "error")) return this.flash("Fix the problems on the left first.", true);
    if ((this.changed || !this.id) && this.mine && !(await this.save())) return;
    if (!this.id) return;
    this.go(`/?settings=${encodeURIComponent(JSON.stringify({ map: this.id, name: this.name }))}`);
  }

  private dialog(title: string, ...content: (HTMLElement | null)[]) {
    this.closeDialog();
    const close = el("button", { class: "small", onclick: () => this.closeDialog() }, "Close");
    this.modal = el("div", { class: "modal-bg", onclick: (e: Event) => e.target === this.modal && this.closeDialog() },
      el("div", { class: "panel editor-dialog" }, el("div", { class: "row" }, el("h2", { class: "grow" }, title), close), ...content));
    document.body.append(this.modal);
  }

  private closeDialog() {
    this.modal?.remove();
    this.modal = null;
  }

  private propertiesDialog() {
    const desc = el("textarea", { rows: 4, maxlength: 1000, class: "notes-input", disabled: !this.mine }) as HTMLTextAreaElement;
    desc.value = this.description;
    desc.addEventListener("input", () => {
      this.description = desc.value;
      this.touch(false);
    });
    const num = (v: number, min: number, max: number) => el("input", { type: "number", value: v, min, max, style: { width: "80px" }, disabled: !this.mine }) as HTMLInputElement;
    const w = num(this.b.sx, MAP_LIMITS.minSide, MAP_LIMITS.maxSide), l = num(this.b.sy, MAP_LIMITS.minSide, MAP_LIMITS.maxSide), z = num(this.b.sz, 1, MAP_LIMITS.maxLevels);
    const file = el("input", { type: "file", accept: ".json,application/json", style: { display: "none" } }) as HTMLInputElement;
    file.addEventListener("change", async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        await this.replaceWith(parseMapText(await f.text()), f.name);
        this.closeDialog();
      } catch (e) {
        this.flash(`Couldn't import ${f.name}: ${(e as Error).message}`, true);
      }
    });
    this.dialog("MAP",
      el("div", { class: "form" },
        el("div", {}, "Description"), desc,
        el("div", {}, "Terrain"), el("div", {}, terrainName(this.terrain), el("span", { class: "hint" }, ` — part sets: ${this.b.lib.datasetNames.join(", ")}`)),
        el("div", {}, "Size"), el("div", { class: "row" }, w, el("span", {}, "x"), l, el("span", {}, "tiles,"), z, el("span", {}, "levels"),
          this.mine ? el("button", { class: "small", onclick: () => {
            this.resizeMap(Number(w.value), Number(l.value), Number(z.value));
            this.closeDialog();
          } }, "Resize") : null,
          el("span", { class: "hint" }, "keeps the north-west corner where it is")),
        el("div", {}, "File"), el("div", { class: "row" },
          el("button", { class: "small", onclick: () => this.download() }, "Export"),
          this.mine ? el("button", { class: "small", onclick: () => file.click() }, "Import...") : null, file,
          el("span", { class: "hint" }, "a map exported from here, or a recipe")),
        this.mine && this.id ? el("div", {}, "") : null,
        this.mine && this.id ? el("div", {}, el("button", { class: "small danger", onclick: async () => {
          if (!confirm(`Delete "${this.name}"? Matches already played on it keep their map.`)) return;
          await api(`/api/maps/${this.id}`, { method: "DELETE" });
          this.changed = false;
          this.closeDialog();
          this.go("/maps");
        } }, "Delete this map")) : null,
      ),
      el("div", { class: "hint", style: { marginTop: "10px" } }, "Mouse: left uses the tool, right or middle drag pans, wheel changes level, Ctrl+wheel zooms, Alt+click picks a part. Keys: tool letters, PageUp/PageDown for levels, arrows pan, G grid, Ctrl+Z / Ctrl+Y undo and redo, Ctrl+S save."),
    );
  }

  private resizeMap(sx: number, sy: number, sz: number) {
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v) || lo));
    sx = clamp(sx, MAP_LIMITS.minSide, MAP_LIMITS.maxSide);
    sy = clamp(sy, MAP_LIMITS.minSide, MAP_LIMITS.maxSide);
    sz = clamp(sz, 1, MAP_LIMITS.maxLevels);
    this.snapshot();
    const old = this.b;
    const doc = this.doc();
    this.setDoc({ ...doc, size: [sx, sy, sz], parts: "", zones: [] });
    // the ground carries on where the map grew (the commonest floor at ground level)
    const counts = new Map<number, number>();
    for (let i = 0; i < old.sx * old.sy; i++) if (old.parts[i * 4] >= 0) counts.set(old.parts[i * 4], (counts.get(old.parts[i * 4]) ?? 0) + 1);
    const ground = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
    for (let z = 0; z < sz; z++)
      for (let y = 0; y < sy; y++)
        for (let x = 0; x < sx; x++) {
          const t = this.b.idx(x, y, z);
          if (x < old.sx && y < old.sy && z < old.sz) for (let p = 0; p < 4; p++) this.b.parts[t * 4 + p] = old.parts[old.idx(x, y, z) * 4 + p];
          else if (z === 0) this.b.parts[t * 4] = ground;
        }
    this.zones = doc.zones.filter((r) => r.x + r.w <= sx && r.y + r.h <= sy);
    this.ufo = doc.ufo && doc.ufo.x + doc.ufo.w <= sx && doc.ufo.y + doc.ufo.h <= sy ? doc.ufo : null;
    this.setLevel(this.st.camera.z);
    this.touch();
    this.buildUi();
  }

  private download() {
    const blob = new Blob([JSON.stringify(this.doc())], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${(this.name || "map").replace(/[^\w-]+/g, "_")}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** A whole new map in place of this one (a recipe or a map document), as one undoable change. */
  private async replaceWith(p: { recipe?: unknown; doc?: MapDoc }, source: string) {
    let doc: MapDoc;
    if (p.doc) doc = sanitizeMapDoc(p.doc);
    else {
      const built = await this.compile(p.recipe);
      doc = built.doc;
      this.warnings = built.warnings;
    }
    await preload(mapFiles(doc.datasets));
    this.snapshot();
    const keepName = this.name;
    this.setDoc(doc);
    if (this.id) this.name = doc.name === "AI map" ? keepName : doc.name;
    this.touch();
    this.buildUi();
    this.check();
    this.flash(`Replaced with the map from ${source}${this.warnings.length ? ` (${this.warnings.length} warnings: see Problems)` : ""}. Undo brings the old one back.`);
  }

  private aiDialog() {
    const ask = el("textarea", { rows: 3, class: "notes-input", placeholder: "What should change? e.g. \"add a walled garden with an apple orchard south of the big house, and more cover near zone 2\"" }) as HTMLTextAreaElement;
    const paste = el("textarea", { rows: 6, class: "notes-input", placeholder: "Paste what your assistant answers: a recipe (or just {\"ops\": [...]}), or its link" }) as HTMLTextAreaElement;
    const out = el("div", {});
    const describe = () => {
      const b = this.b;
      return `my map "${this.name}" (terrain ${this.terrain}, ${b.sx}x${b.sy} tiles, ${b.sz} levels, landing zones ${this.zones.map((z, i) => `${i + 1}: [${z.x}, ${z.y}, ${z.w}, ${z.h}]`).join(", ") || "none"}${this.ufo ? `, a UFO at [${this.ufo.x}, ${this.ufo.y}, ${this.ufo.w}, ${this.ufo.h}]` : ""}). Here is its ground level as text (legend: . open ground, , indoors, o object you can walk through, # one you can't or raised ground, | a wall on the tile's west or north edge, D a door, ~ water, digits = landing zones):\n\n\`\`\`\n${asciiPlan(b, this.zones, 0)}\n\`\`\`\n`;
    };
    const run = async (mode: "ops" | "replace") => {
      try {
        const p = parseMapText(paste.value);
        if (mode === "replace") {
          await this.replaceWith(p, "your assistant");
          this.closeDialog();
          return;
        }
        const r = (p.recipe ?? {}) as { ops?: Op[] };
        if (!Array.isArray(r.ops) || !r.ops.length) throw new Error("there are no ops in that");
        const ops = r.ops;
        await preload(recipeFiles({ terrain: this.terrain, ops } as never));
        const warnings: string[] = [];
        this.edit("AI", (ctx) => {
          ops.forEach((op, i) => {
            try {
              runOp(ctx, op);
            } catch (e) {
              warnings.push(`ops[${i}] (${op?.op ?? "?"}): ${(e as Error).message}`);
            }
          });
          warnings.push(...ctx.warnings);
          ctx.warnings = [];
        });
        await preload(mapFiles(this.b.lib.datasetNames));
        this.warnings = warnings;
        this.renderPalette();
        this.check();
        out.replaceChildren(el("div", { class: warnings.length ? "warn" : "good" }, warnings.length ? `Done, with ${warnings.length} warnings (see Problems; Undo takes it back).` : `Done: ${ops.length} op${ops.length === 1 ? "" : "s"} (Undo takes it back).`));
      } catch (e) {
        out.replaceChildren(el("div", { class: "err" }, `Couldn't use that: ${(e as Error).message}`));
      }
    };
    this.dialog("CHANGE THIS MAP WITH AI",
      el("div", { class: "hint" }, "Describe the change, copy the prompt into any AI assistant (it gets a text plan of this map), and paste back what it answers."),
      ask,
      el("div", { class: "row", style: { margin: "4px 0 10px" } },
        el("button", { class: "small", onclick: async (e: Event) => copyText(await assistantPrompt(`change ${describe()}\nGive me a recipe with just the ops that make this change (they run on the map as it is): ${ask.value.trim() || "<describe the change>"}`), e.target as HTMLButtonElement) }, "Copy prompt"),
        el("a", { href: "/maps.txt", target: "_blank", class: "hint" }, "what the assistant reads")),
      paste,
      el("div", { class: "row", style: { marginTop: "4px" } },
        el("button", { class: "small primary", disabled: !this.mine, onclick: () => run("ops") }, "Apply its ops to this map"),
        el("button", { class: "small", disabled: !this.mine, onclick: () => run("replace") }, "Replace the map with it")),
      out,
    );
  }
}
