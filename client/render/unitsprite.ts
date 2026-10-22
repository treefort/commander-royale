// Composes a unit's battlescape sprite from its sheet (port of the original drawing routines).
// Output frames are 64x40 (double width so weapons fit); draw them 16px left of the tile.
import type { IndexedImage } from "../../shared/formats/images.ts";
import { Surface } from "./surface.ts";
import type { Assets } from "./assets.ts";
import { armorRule, itemRule } from "../../shared/rules/index.ts";
import { UnitStatus } from "../../shared/engine/defs.ts";

export interface UnitLook {
  armor: string;
  dir: number;
  turretDir: number;
  turretType: number;
  status: UnitStatus; // WALKING / AIMING / COLLAPSING / STANDING
  walkPhase: number; // 0..7
  fallPhase: number;
  kneeled: boolean;
  floating: boolean;
  fly: boolean;
  gender: number;
  look: number;
  standHeight: number;
  rightItem: string | null; // item types in hands (fixed weapons excluded)
  leftItem: string | null;
  activeHand: string;
  animFrame: number; // 0..7 for constantly animated units
}

const FACE_COLOR = [96, 96, 96, 96, 160, 160, 163, 163];
const HAIR_COLOR = [144, 144, 164, 164, 245, 245, 166, 166];

function recolorFor(armor: string, gender: number, look: number): Uint8Array | null {
  if (armor !== "STR_NONE_UC" && armor !== "STR_PERSONAL_ARMOR_UC") return null;
  const idx = gender + 2 * look;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = i;
  const face = FACE_COLOR[idx], hair = HAIR_COLOR[idx];
  for (let s = 0; s < 16; s++) {
    lut[(6 << 4) + s] = face + s;
    lut[(9 << 4) + s] = hair + s;
  }
  return lut;
}

export class UnitSpriteBuilder {
  constructor(private assets: Assets) {}

  /** Returns `size*size` frames (one per tile part) for the unit's current pose. */
  build(l: UnitLook, size: number): IndexedImage[] {
    const ar = armorRule(l.armor);
    const sheet = this.assets.unitSheet(ar.spriteSheet);
    const hand = this.assets.unitSheet("HANDOB.PCK");
    const recolor = recolorFor(l.armor, l.gender, l.look);
    const out: IndexedImage[] = [];
    for (let part = 0; part < size * size; part++) {
      const s = new Surface(64, 40);
      const ctx = new Ctx(s, sheet, hand, recolor);
      switch (ar.drawingRoutine) {
        case 0: case 10: routine0(ctx, l, ar.drawingRoutine, ar.forcedTorso); break;
        case 1: routine1(ctx, l); break;
        case 2: routine2(ctx, l, part); break;
        case 3: routine3(ctx, l, part); break;
        case 4: routine4(ctx, l); break;
        case 5: routine5(ctx, l, part); break;
        case 6: routine6(ctx, l); break;
        case 7: routine7(ctx, l); break;
        case 8: routine8(ctx, l); break;
        case 9: routine9(ctx, l); break;
        default: routine0(ctx, l, 0, 0);
      }
      out.push(s.asImage());
    }
    return out;
  }
}

class Ctx {
  constructor(public s: Surface, public sheet: IndexedImage[], public hand: IndexedImage[], public recolor: Uint8Array | null) {}
  draw(frame: number, x: number, y: number, recolored = true) {
    const f = this.sheet[frame];
    if (f) this.s.blitShade(f, x, y, 0, recolored ? this.recolor : null);
  }
  item(frame: number, x: number, y: number) {
    const f = this.hand[frame];
    if (f) this.s.blitShade(f, x, y, 0, null);
  }
}

interface Part { f: number; x: number; y: number; item?: boolean }

function handInfo(l: UnitLook) {
  let r = l.rightItem ? itemRule(l.rightItem) : null;
  let lt = l.leftItem ? itemRule(l.leftItem) : null;
  if (r && r.fixedWeapon) r = null;
  if (lt && lt.fixedWeapon) lt = null;
  // sortRifles: show only one two-hander
  if (r && r.twoHanded) {
    if (lt && lt.twoHanded) {
      if (l.activeHand === "STR_LEFT_HAND") r = lt;
      lt = null;
    } else if (l.status !== UnitStatus.AIMING) lt = null;
  } else if (lt && lt.twoHanded) {
    if (l.status !== UnitStatus.AIMING) r = null;
  }
  return { r, lt };
}

const OFF_X = [8, 10, 7, 4, -9, -11, -7, -3], OFF_Y = [-6, -3, 0, 2, 0, -4, -7, -9];
const OFF_X2 = [-8, 3, 5, 12, 6, -1, -5, -13], OFF_Y2 = [1, -4, -2, 0, 3, 3, 5, 0];
const OFF_X3 = [0, 0, 2, 2, 0, 0, 0, 0], OFF_Y3 = [-3, -3, -1, -1, -1, -3, -3, -2];
const OFF_X4 = [-8, 2, 7, 14, 7, -2, -4, -8], OFF_Y4 = [-3, -3, -1, 0, 3, 3, 0, 1];
const OFF_X5 = [-1, 1, 1, 2, 0, -1, 0, 0], OFF_Y5 = [1, -1, -1, -1, -1, -1, -3, 0];
const OFF_X6 = [0, 6, 6, 12, -4, -5, -5, -13], OFF_Y6 = [-4, -4, -1, 0, 5, 0, 1, 0];
const OFF_X7 = [0, 6, 8, 12, 2, -5, -5, -13], OFF_Y7 = [-4, -6, -1, 0, 3, 0, 1, 0];

/** Soldiers, sectoids (0) and mutons (10). */
function routine0(c: Ctx, l: UnitLook, routine: number, forcedTorso: number) {
  const X = 16;
  const die = 264, maleTorso = 32, femaleTorso = 267, rarm1H = 232, larm2H = 240, rarm2H = 248, rarmShoot = 256, legsFloat = 275;
  const legsStand = 16, legsKneel = 24, larmStand = 0, rarmStand = 8;
  const dir = l.dir, wp = l.walkPhase;
  if (l.status === UnitStatus.COLLAPSING) {
    c.draw(die + l.fallPhase, X, 0);
    return;
  }
  const female = (l.gender === 1 && forcedTorso !== 1) || forcedTorso === 2;
  const torso: Part = { f: (female ? femaleTorso : maleTorso) + dir, x: X, y: 0 };
  let legs: Part, leftArm: Part, rightArm: Part;
  const yoffWalk = [1, 0, -1, 0, 1, 0, -1, 0];
  const mutonYoff = [1, 1, 0, 0, 1, 1, 0, 0];
  let bob = 0;
  if (l.status === UnitStatus.WALKING) {
    bob = routine === 10 ? mutonYoff[wp] : yoffWalk[wp];
    torso.y = bob;
    legs = { f: 56 + 24 * dir + wp, x: X, y: 0 };
    leftArm = { f: 40 + 24 * dir + wp, x: X, y: 0 };
    rightArm = { f: 48 + 24 * dir + wp, x: X, y: 0 };
    if (routine === 10 && dir === 3) leftArm.y = -1;
  } else {
    legs = { f: (l.kneeled ? legsKneel : l.floating && l.fly ? legsFloat : legsStand) + dir, x: X, y: 0 };
    leftArm = { f: larmStand + dir, x: X, y: 0 };
    rightArm = { f: rarmStand + dir, x: X, y: 0 };
  }
  const { r, lt } = handInfo(l);
  let itemR: Part | null = null, itemL: Part | null = null;
  if (r) {
    if (l.status === UnitStatus.AIMING && r.twoHanded) itemR = { f: r.handSprite + ((dir + 2) % 8), x: OFF_X[dir], y: OFF_Y[dir], item: true };
    else {
      itemR = { f: r.handSprite + dir, x: 0, y: 0, item: true };
      if (routine === 10) {
        if (r.twoHanded) { itemR.x = OFF_X3[dir]; itemR.y = OFF_Y3[dir]; }
        else { itemR.x = OFF_X5[dir]; itemR.y = OFF_Y5[dir]; }
      }
    }
    if (r.twoHanded) {
      leftArm = { f: larm2H + dir, x: X, y: 0 };
      rightArm = { f: (l.status === UnitStatus.AIMING ? rarmShoot : rarm2H) + dir, x: X, y: 0 };
    } else rightArm = { f: (routine === 10 ? rarm2H : rarm1H) + dir, x: X, y: 0 };
    if (l.status === UnitStatus.WALKING) {
      itemR.y += bob;
      rightArm.y = bob;
      if (r.twoHanded) leftArm.y = bob;
    }
  }
  if (lt) {
    leftArm = { f: larm2H + dir, x: X, y: 0 };
    itemL = { f: lt.handSprite + dir, x: 0, y: 0, item: true };
    if (!lt.twoHanded) {
      if (routine === 10) { itemL.x = OFF_X4[dir]; itemL.y = OFF_Y4[dir]; }
      else { itemL.x = OFF_X2[dir]; itemL.y = OFF_Y2[dir]; }
    } else rightArm = { f: rarm2H + dir, x: X, y: 0 };
    if (l.status === UnitStatus.AIMING && lt.twoHanded) {
      itemL = { f: lt.handSprite + ((dir + 2) % 8), x: routine === 10 ? OFF_X7[dir] : OFF_X6[dir], y: routine === 10 ? OFF_Y7[dir] : OFF_Y6[dir], item: true };
      rightArm = { f: rarmShoot + dir, x: X, y: 0 };
    }
    if (l.status === UnitStatus.WALKING) {
      itemL.y += bob;
      leftArm.y = bob;
      if (lt.twoHanded) rightArm.y = bob;
    }
  }
  if (l.kneeled) {
    leftArm.y = 4;
    rightArm.y = 4;
    torso.y = 4;
    if (itemR) itemR.y += 4;
    if (itemL) itemL.y += 4;
  } else if (l.status !== UnitStatus.WALKING) {
    leftArm.y = 0;
    rightArm.y = 0;
    torso.y = 0;
  }
  if (itemR) { itemR.y += 22 - l.standHeight; itemR.x += X; }
  if (itemL) { itemL.y += 22 - l.standHeight; itemL.x += X; }
  if (!itemR && routine === 10 && l.status === UnitStatus.WALKING && dir === 2) rightArm.x = 10;
  const twoH = (r && r.twoHanded) || (lt && lt.twoHanded);
  const aiming = l.status === UnitStatus.AIMING;
  let order: (Part | null)[];
  switch (dir) {
    case 0: order = [itemR, itemL, leftArm, legs, torso, rightArm]; break;
    case 1: order = [leftArm, legs, itemL, torso, itemR, rightArm]; break;
    case 2: order = [leftArm, legs, torso, itemL, itemR, rightArm]; break;
    case 3: order = !aiming && twoH ? [legs, torso, leftArm, itemR, itemL, rightArm] : [legs, torso, leftArm, rightArm, itemR, itemL]; break;
    case 4: order = [legs, rightArm, torso, leftArm, itemR, itemL]; break;
    case 5: order = !aiming && twoH ? [rightArm, legs, torso, leftArm, itemR, itemL] : [rightArm, legs, itemR, itemL, torso, leftArm]; break;
    case 6: order = [rightArm, itemR, itemL, legs, torso, leftArm]; break;
    default: order = !aiming && twoH ? [rightArm, itemR, itemL, leftArm, legs, torso] : [itemR, itemL, leftArm, rightArm, legs, torso];
  }
  for (const p of order) if (p) p.item ? c.item(p.f, p.x, p.y) : c.draw(p.f, p.x, p.y);
}

/** Floaters. */
function routine1(c: Ctx, l: UnitLook) {
  const X = 16;
  const stand = 16, walk = 24, die = 64, larm = 8, rarm = 0, larm2H = 67, rarm2H = 75, rarmShoot = 83, rarm1H = 91;
  const dir = l.dir;
  if (l.status === UnitStatus.COLLAPSING) {
    c.draw(die + l.fallPhase, X, 0);
    return;
  }
  let leftArm: Part = { f: larm + dir, x: X, y: 0 };
  let rightArm: Part = { f: rarm + dir, x: X, y: 0 };
  const torso: Part = { f: l.status === UnitStatus.WALKING ? walk + 5 * dir + Math.floor(l.walkPhase / 1.6) : stand + dir, x: X, y: 0 };
  const { r, lt } = handInfo(l);
  let itemR: Part | null = null, itemL: Part | null = null;
  if (r) {
    itemR = l.status === UnitStatus.AIMING && r.twoHanded ? { f: r.handSprite + ((dir + 2) % 8), x: OFF_X[dir], y: OFF_Y[dir], item: true } : { f: r.handSprite + dir, x: 0, y: 0, item: true };
    if (r.twoHanded) {
      leftArm = { f: larm2H + dir, x: X, y: 0 };
      rightArm = { f: (l.status === UnitStatus.AIMING ? rarmShoot : rarm2H) + dir, x: X, y: 0 };
    } else rightArm = { f: rarm1H + dir, x: X, y: 0 };
  }
  if (lt) {
    leftArm = { f: larm2H + dir, x: X, y: 0 };
    itemL = { f: lt.handSprite + dir, x: 0, y: 0, item: true };
    const ox2 = [-8, 3, 7, 13, 6, -3, -5, -13], oy2 = [1, -4, -1, 0, 3, 3, 5, 0];
    if (!lt.twoHanded) { itemL.x = ox2[dir]; itemL.y = oy2[dir]; }
    else rightArm = { f: rarm2H + dir, x: X, y: 0 };
    if (l.status === UnitStatus.AIMING && lt.twoHanded) {
      itemL = { f: lt.handSprite + ((dir + 2) % 8), x: OFF_X6[dir], y: OFF_Y6[dir], item: true };
      rightArm = { f: rarmShoot + dir, x: X, y: 0 };
    }
  }
  if (itemR) itemR.x += X;
  if (itemL) itemL.x += X;
  const orders: (Part | null)[][] = [
    [itemR, itemL, leftArm, torso, rightArm],
    [leftArm, torso, rightArm, itemR, itemL],
    [leftArm, torso, rightArm, itemR, itemL],
    [torso, leftArm, rightArm, itemR, itemL],
    [torso, leftArm, rightArm, itemR, itemL],
    [rightArm, torso, leftArm, itemR, itemL],
    [rightArm, itemR, itemL, torso, leftArm],
    [rightArm, itemR, itemL, leftArm, torso],
  ];
  for (const p of orders[dir]) if (p) p.item ? c.item(p.f, p.x, p.y) : c.draw(p.f, p.x, p.y);
}

/** X-COM tanks (and hovertanks). */
function routine2(c: Ctx, l: UnitLook, part: number) {
  const X = 16;
  const offX = [-2, -7, -5, 0, 5, 7, 2, 0], offY = [-1, -3, -4, -5, -4, -3, -1, -1];
  const hover = l.fly ? 32 : 0;
  if (part > 0 && hover) c.draw(104 + (part - 1) * 8 + l.animFrame, X, 0);
  c.draw(hover + part * 8 + l.dir, X, 0);
  if (part === 3 && l.turretType !== -1) {
    let tx = 0, ty = -4;
    if (hover) { tx += offX[l.dir]; ty += offY[l.dir]; }
    c.draw(64 + l.turretType * 8 + l.turretDir, tx + X, ty);
  }
}

/** Cyberdiscs. */
function routine3(c: Ctx, l: UnitLook, part: number) {
  const X = 16;
  if (part > 0) c.draw(32 + (part - 1) * 8 + l.animFrame, X, 0);
  c.draw(part * 8 + l.dir, X, 0);
}

/** Civilians, ethereals, zombies: 8 standing frames, 8x8 walking, then death. */
function routine4(c: Ctx, l: UnitLook) {
  const X = 16;
  const stand = 0, walk = 8, die = 72;
  const dir = l.dir;
  if (l.status === UnitStatus.COLLAPSING) {
    c.draw(die + l.fallPhase, X, 0);
    return;
  }
  const body: Part = { f: l.status === UnitStatus.WALKING ? walk + 8 * dir + l.walkPhase : stand + dir, x: X, y: 0 };
  const { r, lt } = handInfo(l);
  let itemR: Part | null = null, itemL: Part | null = null;
  if (r) itemR = l.status === UnitStatus.AIMING && r.twoHanded ? { f: r.handSprite + ((dir + 2) % 8), x: OFF_X[dir], y: OFF_Y[dir], item: true } : { f: r.handSprite + dir, x: 0, y: 0, item: true };
  if (lt) {
    itemL = { f: lt.handSprite + dir, x: lt.twoHanded ? 0 : OFF_X2[dir], y: lt.twoHanded ? 0 : OFF_Y2[dir], item: true };
    if (l.status === UnitStatus.AIMING && lt.twoHanded) itemL = { f: lt.handSprite + ((dir + 2) % 8), x: OFF_X6[dir], y: OFF_Y6[dir], item: true };
  }
  if (itemR) itemR.x += X;
  if (itemL) itemL.x += X;
  const orders: (Part | null)[][] = [
    [itemL, itemR, body], [itemL, body, itemR], [body, itemL, itemR], [body, itemR, itemL],
    [body, itemR, itemL], [itemR, body, itemL], [itemR, body, itemL], [itemR, itemL, body],
  ];
  for (const p of orders[dir]) if (p) p.item ? c.item(p.f, p.x, p.y) : c.draw(p.f, p.x, p.y);
}

/** Sectopods and reapers. */
function routine5(c: Ctx, l: UnitLook, part: number) {
  const X = 16;
  if (l.status === UnitStatus.WALKING) c.draw(32 + l.dir * 16 + part * 4 + (Math.floor(l.walkPhase / 2) % 4), X, 0);
  else c.draw(part * 8 + l.dir, X, 0);
}

/** Snakemen. */
function routine6(c: Ctx, l: UnitLook) {
  const X = 16;
  const Torso = 24, legsStand = 16, die = 96, larmStand = 0, rarmStand = 8, rarm1H = 99, larm2H = 107, rarm2H = 115, rarmShoot = 123;
  const yoffWalk = [3, 3, 2, 1, 0, 0, 1, 2], xoffA = [0, 0, 1, 2, 3, 3, 2, 1], xoffB = [0, 0, -1, -2, -3, -3, -2, -1], yoffStand = [2, 1, 1, 0, 0, 0, 0, 0];
  const offX = [8, 10, 5, 2, -8, -10, -5, -2], offY = [-6, -3, 0, 0, 2, -3, -7, -9];
  const offX2 = [-8, 2, 7, 13, 7, 0, -3, -15], offY2 = [1, -4, -2, 0, 3, 3, 5, 0];
  const dir = l.dir, wp = l.walkPhase;
  if (l.status === UnitStatus.COLLAPSING) {
    c.draw(die + l.fallPhase, X, 0);
    return;
  }
  const torso: Part = { f: Torso + dir, x: X, y: 0 };
  let leftArm: Part = { f: larmStand + dir, x: X, y: 0 }, rightArm: Part = { f: rarmStand + dir, x: X, y: 0 };
  let legs: Part;
  let xw = 0, yw = 0;
  if (l.status === UnitStatus.WALKING) {
    if (dir < 3) xw = xoffA[wp];
    if (dir < 7 && dir > 3) xw = xoffB[wp];
    yw = yoffWalk[wp];
    torso.y = yw;
    torso.x = X + xw;
    legs = { f: 32 + dir * 8 + wp, x: X, y: 0 };
    rightArm.y = leftArm.y = yw;
    rightArm.x = leftArm.x = X + xw;
  } else legs = { f: legsStand + dir, x: X, y: 0 };
  const { r, lt } = handInfo(l);
  let itemR: Part | null = null, itemL: Part | null = null;
  if (r) {
    if (l.status === UnitStatus.AIMING && r.twoHanded) itemR = { f: r.handSprite + ((dir + 2) % 8), x: offX[dir], y: offY[dir], item: true };
    else itemR = { f: r.handSprite + dir, x: 0, y: r.twoHanded ? 0 : yoffStand[dir], item: true };
    if (r.twoHanded) {
      leftArm = { f: larm2H + dir, x: leftArm.x, y: leftArm.y };
      rightArm = { f: (l.status === UnitStatus.AIMING ? rarmShoot : rarm2H) + dir, x: rightArm.x, y: rightArm.y };
    } else rightArm = { f: rarm1H + dir, x: rightArm.x, y: rightArm.y };
    if (l.status === UnitStatus.WALKING) itemR.y = yw;
  }
  if (lt) {
    leftArm = { f: larm2H + dir, x: leftArm.x, y: leftArm.y };
    itemL = { f: lt.handSprite + dir, x: lt.twoHanded ? 0 : offX2[dir], y: lt.twoHanded ? 0 : offY2[dir], item: true };
    if (lt.twoHanded) rightArm = { f: rarm2H + dir, x: rightArm.x, y: rightArm.y };
    if (l.status === UnitStatus.AIMING && lt.twoHanded) {
      itemL = { f: lt.handSprite + ((dir + 2) % 8), x: OFF_X6[dir], y: OFF_Y6[dir], item: true };
      rightArm = { f: rarmShoot + dir, x: rightArm.x, y: rightArm.y };
    }
    if (l.status === UnitStatus.WALKING) itemL.y = offY2[dir] + yw;
  }
  if (l.status !== UnitStatus.WALKING) {
    leftArm.y = 0;
    rightArm.y = 0;
    torso.y = 0;
  }
  if (itemR) itemR.x += X;
  if (itemL) itemL.x += X;
  const orders: (Part | null)[][] = [
    [itemR, itemL, leftArm, legs, torso, rightArm],
    [leftArm, legs, itemL, torso, itemR, rightArm],
    [leftArm, legs, torso, rightArm, itemR, itemL],
    [legs, torso, leftArm, rightArm, itemR, itemL],
    [rightArm, legs, torso, leftArm, itemR, itemL],
    [rightArm, legs, torso, leftArm, itemR, itemL],
    [rightArm, legs, itemR, itemL, torso, leftArm],
    [itemR, itemL, leftArm, rightArm, legs, torso],
  ];
  for (const p of orders[dir]) if (p) p.item ? c.item(p.f, p.x, p.y) : c.draw(p.f, p.x, p.y);
}

/** Chryssalids. */
function routine7(c: Ctx, l: UnitLook) {
  const X = 16;
  const Torso = 24, legsStand = 16, die = 224, larmStand = 0, rarmStand = 8;
  const dir = l.dir, wp = l.walkPhase;
  if (l.status === UnitStatus.COLLAPSING) {
    c.draw(die + l.fallPhase, X, 0);
    return;
  }
  const yoffWalk = [1, 0, -1, 0, 1, 0, -1, 0];
  let torso: Part, legs: Part, leftArm: Part, rightArm: Part;
  if (l.status === UnitStatus.WALKING) {
    torso = { f: Torso + dir, x: X, y: yoffWalk[wp] };
    legs = { f: 48 + 24 * dir + wp, x: X, y: 0 };
    leftArm = { f: 32 + 24 * dir + wp, x: X, y: 0 };
    rightArm = { f: 40 + 24 * dir + wp, x: X, y: 0 };
  } else {
    torso = { f: Torso + dir, x: X, y: 0 };
    legs = { f: legsStand + dir, x: X, y: 0 };
    leftArm = { f: larmStand + dir, x: X, y: 0 };
    rightArm = { f: rarmStand + dir, x: X, y: 0 };
  }
  const orders: Part[][] = [
    [leftArm, legs, torso, rightArm], [leftArm, legs, torso, rightArm], [leftArm, legs, torso, rightArm],
    [legs, torso, leftArm, rightArm], [rightArm, legs, torso, leftArm], [rightArm, legs, torso, leftArm],
    [rightArm, legs, torso, leftArm], [leftArm, rightArm, legs, torso],
  ];
  for (const p of orders[dir]) c.draw(p.f, p.x, p.y);
}

/** Silacoids. */
function routine8(c: Ctx, l: UnitLook) {
  const pulsate = [0, 1, 2, 3, 4, 3, 2, 1];
  let f = pulsate[l.animFrame % 8];
  if (l.status === UnitStatus.COLLAPSING) f = 6 + l.fallPhase;
  else if (l.status === UnitStatus.AIMING) f = 5;
  c.draw(f, 16, 0);
}

/** Celatids. */
function routine9(c: Ctx, l: UnitLook) {
  let f = l.animFrame % 8;
  if (l.status === UnitStatus.COLLAPSING) f = 25 + l.fallPhase;
  c.draw(f, 16, 0);
}
