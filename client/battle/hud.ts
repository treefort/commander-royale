// The bottom icon panel (ICONS.PCK) with unit stats, hand items and buttons, at original positions.
import type { Surface } from "../render/surface.ts";
import type { Assets } from "../render/assets.ts";
import { drawText } from "../render/text.ts";
import { drawTinyNumber, drawTinyText } from "../render/mapview.ts";
import type { Battle, Unit } from "../../shared/engine/state.ts";
import { itemRule } from "../../shared/rules/index.ts";
import { roundsLeft } from "../../shared/engine/unitops.ts";

export const ICONS_W = 320, ICONS_H = 56;

export type HudButton =
  | "unitUp" | "unitDown" | "mapUp" | "mapDown" | "map" | "kneel" | "inventory" | "center" | "next" | "nextStop"
  | "layers" | "options" | "endTurn" | "abort" | "stats" | "reserveNone" | "reserveSnap" | "reserveAimed" | "reserveAuto"
  | "reserveKneel" | "zeroTU" | "leftHand" | "rightHand";

export const HUD_RECTS: [HudButton, number, number, number, number][] = [
  ["unitUp", 48, 0, 32, 16], ["unitDown", 48, 16, 32, 16], ["mapUp", 80, 0, 32, 16], ["mapDown", 80, 16, 32, 16],
  ["map", 112, 0, 32, 16], ["kneel", 112, 16, 32, 16], ["inventory", 144, 0, 32, 16], ["center", 144, 16, 32, 16],
  ["next", 176, 0, 32, 16], ["nextStop", 176, 16, 32, 16], ["layers", 208, 0, 32, 16], ["options", 208, 16, 32, 16],
  ["endTurn", 240, 0, 32, 16], ["abort", 240, 16, 32, 16], ["stats", 107, 33, 164, 23],
  // UFO's panel has four wide reserve buttons (the kneel-reserve and zero-TU buttons are TFTD's)
  ["reserveNone", 49, 33, 28, 11], ["reserveSnap", 78, 33, 28, 11], ["reserveAimed", 49, 45, 28, 11], ["reserveAuto", 78, 45, 28, 11],
  ["leftHand", 8, 4, 32, 48], ["rightHand", 280, 4, 32, 48],
];

export const TOOLTIPS: Record<HudButton, string> = {
  unitUp: "UNIT LEVEL ABOVE", unitDown: "UNIT LEVEL BELOW", mapUp: "VIEW LEVEL ABOVE", mapDown: "VIEW LEVEL BELOW", map: "MINIMAP",
  kneel: "KNEEL/STAND", inventory: "INVENTORY", center: "CENTER ON SELECTED UNIT", next: "NEXT UNIT", nextStop: "DESELECT UNIT (DONE)",
  layers: "MULTI-LEVEL VIEW", options: "OPTIONS", endTurn: "END TURN", abort: "SURRENDER", stats: "UNIT STATS",
  reserveNone: "DON'T RESERVE TIME UNITS", reserveSnap: "RESERVE TUs FOR SNAP SHOT", reserveAimed: "RESERVE TUs FOR AIMED SHOT",
  reserveAuto: "RESERVE TUs FOR AUTO SHOT", reserveKneel: "RESERVE TUs FOR KNEEL", zeroTU: "EXPEND ALL TIME UNITS (RIGHT CLICK)",
  leftHand: "USE LEFT HAND", rightHand: "USE RIGHT HAND",
};

const INNATE_LABEL: Record<string, string> = {
  CHRYSSALID_WEAPON: "CLAWS", REAPER_WEAPON: "BITE", ZOMBIE_WEAPON: "CLAWS", SILACOID_WEAPON: "BURN",
  CYBERDISC_WEAPON: "PLASMA", SECTOPOD_WEAPON: "PLASMA", CELATID_WEAPON: "ACID",
};

/** Base colours of the reserve buttons (xcom1 interfaces.rul). */
const BUTTON_COLOR: Partial<Record<HudButton, number>> = { reserveNone: 67, reserveSnap: 35, reserveAimed: 35, reserveAuto: 35, reserveKneel: 35, zeroTU: 35 };

export function hudHit(px: number, py: number): HudButton | null {
  for (const [id, x, y, w, h] of HUD_RECTS) if (px >= x && py >= y && px < x + w && py < y + h) return id;
  return null;
}

function bar(s: Surface, x: number, y: number, value: number, max: number, color: number) {
  // the original bar: a dark "max" track with the current value drawn over it, 1px per point
  const w = Math.min(102, Math.max(0, max));
  const v = Math.min(w, Math.max(0, value));
  s.fillRect(x, y, w, 3, color + 12);
  s.fillRect(x, y, v, 3, color + 4);
  s.fillRect(x, y + 1, v, 1, color + 2);
}

export interface HudState {
  reserve: "none" | "snap" | "aimed" | "auto";
  reserveKneel: boolean;
  pressed: HudButton | null;
  showLayers: boolean;
  warning: string;
  warningTime: number;
  tooltip: string;
}

export function drawHud(s: Surface, ox: number, oy: number, A: Assets, b: Battle, unit: Unit | null, st: HudState, viewLevel: number, myTurn: boolean) {
  const icons = A.spk("UFOGRAPH/ICONS.PCK");
  // only the bottom 56 rows of ICONS.PCK are the panel
  s.blitShade({ width: 320, height: ICONS_H, pixels: icons.pixels.subarray(320 * (200 - ICONS_H)) }, ox, oy);
  // highlight toggled buttons the way the original inverts them: the reserve buttons mirror each colour
  // around their base colour (BattlescapeButton::initSurfaces), the rest flip shade within their ramp
  const hl = (id: HudButton) => {
    const r = HUD_RECTS.find((x) => x[0] === id)!;
    const base = BUTTON_COLOR[id];
    for (let y = r[2]; y < r[2] + r[4]; y++)
      for (let x = r[1]; x < r[1] + r[3]; x++) {
        const i = (oy + y) * s.width + ox + x;
        const c = s.pixels[i];
        if (!c) continue;
        s.pixels[i] = base !== undefined ? (c + 2 * (base + 3 - c)) & 0xff : (c & 0xf0) | (15 - (c & 15));
      }
  };
  const reserveMap = { none: "reserveNone", snap: "reserveSnap", aimed: "reserveAimed", auto: "reserveAuto" } as const;
  hl(reserveMap[st.reserve]);
  if (st.showLayers) hl("layers");
  if (unit?.kneeled) hl("kneel");
  if (st.pressed) hl(st.pressed);
  drawTinyNumber(s, viewLevel + 1, ox + 232 + 2, oy + 6, 15);
  if (!unit) return;
  // rank / name / stats
  drawText(s, A.small, unit.name.toUpperCase(), ox + 135, oy + 32, 128 - 1);
  drawTinyNumber(s, unit.tu, ox + 136 + 6, oy + 42, 64 + 3);
  drawTinyNumber(s, unit.energy, ox + 154 + 6, oy + 42, 16 + 3);
  drawTinyNumber(s, unit.health, ox + 136 + 6, oy + 50, 32 + 3);
  drawTinyNumber(s, unit.morale, ox + 154 + 6, oy + 50, 192 + 3);
  bar(s, ox + 170, oy + 41, unit.tu, unit.stats.tu, 64);
  bar(s, ox + 170, oy + 45, unit.energy, unit.stats.stamina, 16);
  bar(s, ox + 170, oy + 49, unit.health, unit.stats.health, 32);
  if (unit.stun) s.fillRect(ox + 170, oy + 50, Math.min(102, unit.stun), 1, 82);
  bar(s, ox + 170, oy + 53, unit.morale, 100, 192);
  // hand items
  const bigobs = A.unitSheet("BIGOBS.PCK");
  for (const [slot, x] of [["STR_LEFT_HAND", 8], ["STR_RIGHT_HAND", 280]] as const) {
    const it = b.itemInSlot(unit, slot);
    if (!it) continue;
    const r = itemRule(it.type);
    const spr = bigobs[r.bigSprite];
    if (spr) s.blit(spr, ox + x + (32 - spr.width) / 2, oy + 4 + (48 - spr.height) / 2);
    else {
      // terror units' built-in attacks have no inventory picture in UFO: label the slot so it's clear what to click
      const label = INNATE_LABEL[it.type] ?? (r.battleType === 3 ? "ATTACK" : "WEAPON");
      drawText(s, A.small, label, ox + x, oy + 20, 16 * 4 - 1, { align: "center", width: 32, contrast: true });
      drawText(s, A.small, "(CLICK)", ox + x, oy + 30, 16 * 7 + 6, { align: "center", width: 32, contrast: true });
    }
    const rounds = roundsLeft(b, it);
    if (r.battleType === 1 && rounds !== Infinity) drawTinyText(s, String(rounds), ox + x + 6, oy + 6, 2);
    if (it.fuse >= 0) drawTinyText(s, String(it.fuse), ox + x + 22, oy + 6, 32 + 2);
  }

}
