// The original inventory screen (TAC01.SCR). Works through an adapter so it serves both the
// pre-battle loadout editor and the in-battle inventory.
import { Surface } from "../render/surface.ts";
import type { Assets } from "../render/assets.ts";
import { drawText, drawFrame } from "../render/text.ts";
import { drawTinyNumber } from "../render/mapview.ts";
import { INVENTORY_SLOTS, itemRule, tr, HAND_W, HAND_H, type SlotId, armorRule, BattleType } from "../../shared/rules/index.ts";
import { UnitSpriteBuilder } from "../render/unitsprite.ts";
import { UnitStatus } from "../../shared/engine/defs.ts";

export interface InvItem {
  id: number;
  type: string;
  slot: SlotId;
  x: number;
  y: number;
  ammoType?: string;
  ammoQty?: number;
  selfPowered?: boolean;
  fuse?: number;
  isBody?: boolean;
}

export interface InvUnit {
  name: string;
  rank: string;
  armor: string;
  gender: number;
  look: number;
  standHeight: number;
  tu: number | null; // null = setup mode (no TU costs)
  weight: number;
  strength: number;
  firing: number;
  reactions: number;
  psiSkill: number;
  psiStrength: number;
  hasInventory: boolean;
}

export interface InvAdapter {
  unit(): InvUnit;
  items(): InvItem[]; // carried + ground (slot STR_GROUND, x/y ignored)
  move(item: InvItem, slot: SlotId, x: number, y: number): Promise<string | null> | string | null;
  load(weapon: InvItem, ammo: InvItem): Promise<string | null> | string | null;
  unload(weapon: InvItem): Promise<string | null> | string | null;
  prev(): void;
  next(): void;
  close(): void;
  groundLabel?(): string;
  /** loadout editor only: buy an item from the shop straight into a slot (STR_GROUND = stores) */
  buy?(type: string, slot: SlotId, x: number, y: number): Promise<string | null> | string | null;
  /** loadout editor only: buy a clip and load it into a carried weapon */
  buyLoad?(weapon: InvItem, ammoType: string): Promise<string | null> | string | null;
  /** loadout editor only: sell an item back (right-click) */
  remove?(item: InvItem): Promise<string | null> | string | null;
}

const GROUND_X = 0, GROUND_Y = 152, GROUND_COLS = 20;

export class InventoryScreen {
  surf = new Surface(320, 200);
  selected: InvItem | null = null;
  /** a shop item being dragged in (loadout editor) */
  held: string | null = null;
  groundOffset = 0;
  mouse = { x: 0, y: 0 };
  message = "";
  messageTime = 0;
  busy = false;
  private groundLayout = new Map<number, { x: number; y: number; count: number }>();

  constructor(private assets: Assets, public adapter: InvAdapter) {}

  private warn(msg: string) {
    this.message = tr(msg);
    this.messageTime = performance.now();
  }

  /** Packs ground items into 3-row columns like the original. */
  private arrangeGround(items: InvItem[]) {
    this.groundLayout.clear();
    const occupied = new Set<string>();
    const stacks = new Map<string, { x: number; y: number; count: number; first: number }>();
    const ground = items.filter((i) => i.slot === "STR_GROUND").sort((a, b) => a.type.localeCompare(b.type));
    for (const it of ground) {
      const r = itemRule(it.type);
      const key = it.type + "|" + (it.ammoType ?? "") + "|" + (it.ammoQty ?? "") + "|" + (it.fuse ?? -1) + (it.isBody ? "|b" + it.id : "");
      const st = stacks.get(key);
      if (st) {
        st.count++;
        this.groundLayout.set(it.id, { x: st.x, y: st.y, count: 0 });
        const f = this.groundLayout.get(st.first)!;
        f.count = st.count;
        continue;
      }
      let placed = false;
      for (let x = 0; !placed && x < 400; x++)
        for (let y = 0; y + r.invHeight <= 3 && !placed; y++) {
          let ok = true;
          for (let i = 0; i < r.invWidth && ok; i++) for (let j = 0; j < r.invHeight && ok; j++) if (occupied.has(`${x + i},${y + j}`)) ok = false;
          if (!ok) continue;
          for (let i = 0; i < r.invWidth; i++) for (let j = 0; j < r.invHeight; j++) occupied.add(`${x + i},${y + j}`);
          this.groundLayout.set(it.id, { x, y, count: 1 });
          stacks.set(key, { x, y, count: 1, first: it.id });
          placed = true;
        }
    }
  }

  private slotAt(px: number, py: number): { slot: SlotId; x: number; y: number } | null {
    for (const [id, def] of Object.entries(INVENTORY_SLOTS) as [SlotId, (typeof INVENTORY_SLOTS)[SlotId]][]) {
      if (def.type === 2) {
        if (py >= GROUND_Y && py < GROUND_Y + 48 && px >= GROUND_X && px < GROUND_X + 16 * GROUND_COLS) return { slot: id, x: Math.floor((px - GROUND_X) / 16) + this.groundOffset, y: Math.floor((py - GROUND_Y) / 16) };
        continue;
      }
      if (def.type === 1) {
        if (px >= def.x && px < def.x + HAND_W * 16 && py >= def.y && py < def.y + HAND_H * 16) return { slot: id, x: 0, y: 0 };
        continue;
      }
      for (const [cx, cy] of def.cells) {
        const x0 = def.x + cx * 16, y0 = def.y + cy * 16;
        if (px >= x0 && px < x0 + 16 && py >= y0 && py < y0 + 16) return { slot: id, x: cx, y: cy };
      }
    }
    return null;
  }

  private itemAt(items: InvItem[], s: { slot: SlotId; x: number; y: number }): InvItem | null {
    const def = INVENTORY_SLOTS[s.slot];
    if (def.type === 1) return items.find((i) => i.slot === s.slot) ?? null;
    if (def.type === 2) {
      for (const it of items) {
        if (it.slot !== "STR_GROUND") continue;
        const g = this.groundLayout.get(it.id);
        if (!g || g.count === 0) continue;
        const r = itemRule(it.type);
        if (s.x >= g.x && s.x < g.x + r.invWidth && s.y >= g.y && s.y < g.y + r.invHeight) return it;
      }
      return null;
    }
    for (const it of items) {
      if (it.slot !== s.slot) continue;
      const r = itemRule(it.type);
      if (s.x >= it.x && s.x < it.x + r.invWidth && s.y >= it.y && s.y < it.y + r.invHeight) return it;
    }
    return null;
  }

  async click(px: number, py: number, right: boolean) {
    if (this.busy) return;
    const a = this.adapter;
    if (right) {
      // right-click cancels what's in hand, or sells the item under the cursor back (loadout editor)
      if (this.selected || this.held) {
        this.selected = null;
        this.held = null;
        return;
      }
      const s = this.slotAt(px, py);
      const under = s ? this.itemAt(a.items(), s) : null;
      if (under && a.remove && !itemRule(under.type).fixedWeapon) await this.run(a.remove(under));
      return;
    }
    if (this.held) return this.dropHeld(px, py);
    // buttons
    // switching units drops whatever was picked up (item ids are per unit)
    if (inRect(px, py, 237, 1, 35, 22)) { this.selected = null; return a.close(); }
    if (inRect(px, py, 273, 1, 23, 22)) { this.selected = null; return a.prev(); }
    if (inRect(px, py, 297, 1, 23, 22)) { this.selected = null; return a.next(); }
    if (inRect(px, py, 288, 32, 32, 25)) {
      if (!this.selected) return;
      await this.run(a.unload(this.selected));
      this.selected = null;
      return;
    }
    if (inRect(px, py, 289, 137, 32, 15)) {
      this.groundOffset += GROUND_COLS - 2;
      const maxX = Math.max(0, ...[...this.groundLayout.values()].map((g) => g.x + 2));
      if (this.groundOffset >= maxX) this.groundOffset = 0;
      return;
    }
    const items = a.items();
    const s = this.slotAt(px, py);
    if (!s) return;
    if (!a.unit().hasInventory && s.slot !== "STR_GROUND") return this.warn("STR_NO_INVENTORY");
    const under = this.itemAt(items, s);
    if (!this.selected) {
      if (under && !itemRule(under.type).fixedWeapon) this.selected = under;
      return;
    }
    const sel = this.selected;
    if (under && under.id !== sel.id) {
      // dropping a clip onto a weapon loads it
      const wr = itemRule(under.type);
      if (wr.compatibleAmmo.includes(sel.type)) {
        if (under.ammoType || under.selfPowered) return this.warn("STR_WEAPON_IS_ALREADY_LOADED");
        await this.run(a.load(under, sel));
        this.selected = null;
        return;
      }
      if (s.slot === "STR_GROUND") {
        await this.run(a.move(sel, "STR_GROUND", 0, 0));
        this.selected = null;
        return;
      }
      if (wr.compatibleAmmo.length && itemRule(sel.type).battleType === BattleType.AMMO) return this.warn("STR_WRONG_AMMUNITION_FOR_THIS_WEAPON");
      return;
    }
    const { x, y } = this.dropAt(s, sel.type, px, py, items, sel.id);
    if (s.slot === sel.slot && x === sel.x && y === sel.y) {
      this.selected = null;
      return;
    }
    await this.run(a.move(sel, s.slot, x, y));
    this.selected = null;
  }

  /** Places the shop item being held: into a slot, the stores, or as a clip into a weapon. */
  private async dropHeld(px: number, py: number) {
    const a = this.adapter;
    const type = this.held!;
    const s = this.slotAt(px, py);
    if (!s) return;
    if (!a.unit().hasInventory && s.slot !== "STR_GROUND") return this.warn("STR_NO_INVENTORY");
    const under = this.itemAt(a.items(), s);
    if (under) {
      const wr = itemRule(under.type);
      if (wr.compatibleAmmo.includes(type) && a.buyLoad) {
        if (under.ammoType || under.selfPowered) return this.warn("STR_WEAPON_IS_ALREADY_LOADED");
        await this.run(a.buyLoad(under, type));
        this.held = null;
        return;
      }
      if (s.slot !== "STR_GROUND") return this.warn("STR_NOT_ENOUGH_SPACE");
    }
    const { x, y } = this.dropAt(s, type, px, py, a.items(), -1);
    if (a.buy) await this.run(a.buy(type, s.slot, x, y));
    this.held = null;
  }

  /**
   * Where an item dropped into a grid slot (belt, legs, backpack...) goes: of the free spots in that slot it fits
   * in whole, the one nearest to where it's drawn under the cursor, so it needn't be lined up to the pixel.
   */
  private dropAt(s: { slot: SlotId; x: number; y: number }, type: string, px: number, py: number, items: InvItem[], ignore: number): { x: number; y: number } {
    const def = INVENTORY_SLOTS[s.slot];
    if (def.type !== 0) return { x: s.x, y: s.y };
    const r = itemRule(type);
    const inSlot = new Set(def.cells.map(([cx, cy]) => `${cx},${cy}`));
    const taken = new Set<string>();
    for (const it of items) {
      if (it.slot !== s.slot || it.id === ignore) continue;
      const o = itemRule(it.type);
      for (let i = 0; i < o.invWidth; i++) for (let j = 0; j < o.invHeight; j++) taken.add(`${it.x + i},${it.y + j}`);
    }
    // the item is drawn centred on the cursor: its top-left corner is half its size up and left
    const left = px - r.invWidth * 8, top = py - r.invHeight * 8;
    let best: { x: number; y: number } | null = null, bestD = Infinity;
    for (const [cx, cy] of def.cells) {
      let ok = true;
      for (let i = 0; i < r.invWidth && ok; i++)
        for (let j = 0; j < r.invHeight && ok; j++) {
          const k = `${cx + i},${cy + j}`;
          if (!inSlot.has(k) || taken.has(k)) ok = false;
        }
      if (!ok) continue;
      const d = (def.x + cx * 16 - left) ** 2 + (def.y + cy * 16 - top) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: cx, y: cy };
      }
    }
    // nowhere it fits: aim where the cursor is (the move is refused with "not enough space")
    return best ?? { x: Math.max(0, s.x - Math.floor((r.invWidth - 1) / 2)), y: Math.max(0, s.y - Math.floor((r.invHeight - 1) / 2)) };
  }

  private async run(p: Promise<string | null> | string | null) {
    this.busy = true;
    try {
      const e = await p;
      if (e) this.warn(e);
    } finally {
      this.busy = false;
    }
  }

  draw(): Surface {
    const s = this.surf;
    const A = this.assets;
    const u = this.adapter.unit();
    const items = this.adapter.items();
    this.arrangeGround(items);
    s.clear(0);
    s.blit(A.spk("UFOGRAPH/TAC01.SCR"), 0, 0);
    // paper doll
    const ar = armorRule(u.armor);
    if (ar.spriteInv) {
      const name = ar.spriteInv === "MAN_0" || ar.spriteInv === "MAN_1" ? `UFOGRAPH/${ar.spriteInv}${u.gender ? "F" : "M"}${u.look}.SPK` : `UFOGRAPH/${ar.spriteInv}.SPK`;
      if (A.has(name)) s.blit(A.spk(name), 0, 0);
    } else {
      // aliens have no paper doll: show their battlescape sprite blown up
      const spr = new UnitSpriteBuilder(A).build({
        armor: u.armor, dir: 2, turretDir: 2, turretType: -1, status: UnitStatus.STANDING, walkPhase: 0, fallPhase: 0, kneeled: false, floating: false,
        fly: false, gender: u.gender, look: u.look, standHeight: u.standHeight, rightItem: null, leftItem: null, activeHand: "STR_RIGHT_HAND", animFrame: 0,
      }, ar.size);
      for (let p = 0; p < spr.length; p++) {
        const img = spr[p];
        const ox = ar.size > 1 ? (p % 2 ? 16 : -16) + (p >= 2 ? -16 : 0) : 0;
        const oy = ar.size > 1 ? ((p % 2) + (p >= 2 ? 1 : 0)) * 8 : 0;
        for (let yy = 0; yy < img.height; yy++)
          for (let xx = 0; xx < img.width; xx++) {
            const c = img.pixels[yy * img.width + xx];
            if (!c) continue;
            for (let k = 0; k < 4; k++) s.setPixel(32 + (xx + ox) * 2 + (k & 1), 28 + (yy + oy) * 2 + (k >> 1), c);
          }
      }
    }
    // slot grids and labels
    for (const [id, def] of Object.entries(INVENTORY_SLOTS) as [SlotId, (typeof INVENTORY_SLOTS)[SlotId]][]) {
      if (def.type === 2) {
        for (let x = 0; x < GROUND_COLS; x++) for (let y = 0; y < 3; y++) s.rect(GROUND_X + x * 16, GROUND_Y + y * 16, 17, 17, 8);
        continue;
      }
      if (def.type === 1) s.rect(def.x, def.y, HAND_W * 16 + 1, HAND_H * 16 + 1, 8);
      else for (const [cx, cy] of def.cells) s.rect(def.x + cx * 16, def.y + cy * 16, 17, 17, 8);
      drawText(s, A.small, tr(id), def.x, def.y - 7, 63 - 1);
    }
    const label = this.adapter.groundLabel?.() ?? tr("STR_GROUND");
    drawText(s, A.small, label, 0, GROUND_Y - 7, 62);
    // items
    const bigobs = A.unitSheet("BIGOBS.PCK");
    for (const it of items) {
      if (it === this.selected) continue;
      const r = itemRule(it.type);
      const spr = bigobs[r.bigSprite];
      let x: number, y: number;
      if (it.slot === "STR_GROUND") {
        const g = this.groundLayout.get(it.id);
        if (!g || g.count === 0) continue;
        const gx = g.x - this.groundOffset;
        if (gx < 0 || gx + r.invWidth > GROUND_COLS) continue;
        x = GROUND_X + gx * 16;
        y = GROUND_Y + g.y * 16;
        if (spr) s.blit(spr, x, y);
        if (g.count > 1) drawTinyNumber(s, g.count, x + r.invWidth * 16 - 4, y + r.invHeight * 16 - 7, 66);
        continue;
      }
      const def = INVENTORY_SLOTS[it.slot];
      if (!def) continue;
      if (def.type === 1) {
        x = def.x + (HAND_W * 16 - r.invWidth * 16) / 2;
        y = def.y + (HAND_H * 16 - r.invHeight * 16) / 2;
      } else {
        x = def.x + it.x * 16;
        y = def.y + it.y * 16;
      }
      if (spr) s.blit(spr, x, y);
      if (it.fuse !== undefined && it.fuse >= 0) drawTinyNumber(s, it.fuse, x + 4, y + 2, 32);
    }
    // texts
    drawText(s, A.big, u.name, 28, 6, 64, { contrast: true });
    let ty = 24;
    if (u.tu !== null) {
      drawText(s, A.small, `TUs>\x01${u.tu}`, 245, ty, 64, { contrast: true, color2: 16 });
      ty += 8;
    }
    drawText(s, A.small, `Weight>\x01${u.weight}/${u.strength}`, 245, ty, 64, { contrast: true, color2: u.weight > u.strength ? 32 : 16 });
    ty += 8;
    drawText(s, A.small, `FACC>\x01${u.firing}`, 245, ty, 64, { contrast: true, color2: 16 });
    ty += 8;
    drawText(s, A.small, `React>\x01${u.reactions}`, 245, ty, 64, { contrast: true, color2: 16 });
    if (u.psiSkill > 0) {
      ty += 8;
      drawText(s, A.small, `PSkill>\x01${u.psiSkill}`, 245, ty, 64, { contrast: true, color2: 16 });
      ty += 8;
      drawText(s, A.small, `PStr>\x01${u.psiStrength}`, 245, ty, 64, { contrast: true, color2: 16 });
    }
    // hovered / selected item info
    const heldItem: InvItem | null = this.held ? { id: -1, type: this.held, slot: "STR_GROUND", x: 0, y: 0 } : null;
    const hov = this.selected ?? heldItem ?? (() => {
      const sl = this.slotAt(this.mouse.x, this.mouse.y);
      return sl ? this.itemAt(items, sl) : null;
    })();
    if (hov) {
      const r = itemRule(hov.type);
      drawText(s, A.small, tr(r.name), 128, 140, 48, { contrast: true });
      if (hov.ammoType) {
        drawText(s, A.small, `AMMO: ${tr(hov.ammoType)}`, 254 - 60, 72, 64, { contrast: true, align: "right", width: 126 });
        drawText(s, A.small, `ROUNDS LEFT=${hov.ammoQty ?? 0}`, 254 - 60, 80, 64, { contrast: true, align: "right", width: 126 });
        const a = bigobs[itemRule(hov.ammoType).bigSprite];
        if (a) s.blit(a, 272, 88);
      } else if (r.battleType === BattleType.AMMO) {
        drawText(s, A.small, `ROUNDS LEFT=${hov.ammoQty ?? r.clipSize}`, 254 - 60, 72, 64, { contrast: true, align: "right", width: 126 });
      } else if (r.compatibleAmmo.length && !hov.selfPowered) {
        drawText(s, A.small, tr("STR_NO_AMMUNITION_LOADED"), 194, 72, 64, { contrast: true, align: "right", width: 126 });
      }
    }
    // the picked-up item follows the mouse
    const inHand = this.selected?.type ?? this.held;
    if (inHand) {
      const r = itemRule(inHand);
      const spr = bigobs[r.bigSprite];
      if (spr) s.blit(spr, this.mouse.x - r.invWidth * 8, this.mouse.y - r.invHeight * 8);
    }
    if (this.message && performance.now() - this.messageTime < 2000) {
      drawFrame(s, 40, 86, 240, 24, 16 * 2, 3, 15);
      drawText(s, A.small, this.message.toUpperCase(), 40, 94, 16 * 2 - 1, { align: "center", width: 240, contrast: true });
    }
    return s;
  }
}

function inRect(x: number, y: number, rx: number, ry: number, w: number, h: number) {
  return x >= rx && y >= ry && x < rx + w && y < ry + h;
}
