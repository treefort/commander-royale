// Turning a configured match (settings, players, loadouts) into a running battle.
import { type Battle, type FileSource, Phase } from "./state.ts";
import { generateMap, canStand } from "./mapgen.ts";
import { createUnit, giveItem, spawnGroundItem } from "./units.ts";
import { directionTo, type Pos } from "./defs.ts";
import { recalcAllLighting, recalculateAllFOV } from "./tileengine.ts";
import { GameRules } from "./actions.ts";
import { BattleEvents } from "./events.ts";
import { armorRule, unitRule, itemRule, fitsSlot, livingWeaponFor, type PlacedItem } from "../rules/index.ts";
import type { MatchSettings, Recruit, Loadout } from "../protocol.ts";

export interface SetupPlayer {
  userId: string;
  name: string;
  loadout: Loadout;
}

function standZ(b: Battle, x: number, y: number, size: number): number {
  for (let z = 0; z < b.sz; z++) if (canStand(b, { x, y, z }, size)) return z;
  return -1;
}

export function createBattle(settings: MatchSettings, players: SetupPlayer[], pool: Recruit[], seed: number, files: FileSource): Battle {
  const { battle: b, zones } = generateMap(settings, players.length, seed, files);
  b.players = players.map((p, i) => ({ index: i, userId: p.userId, name: p.name, eliminated: false, surrendered: false, endedTurnCount: 0 }));
  const center = { x: b.sx / 2, y: b.sy / 2, z: 0 };
  players.forEach((p, pi) => {
    const zone = zones[pi];
    const zc = { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 };
    // candidate spots ordered outward from the zone centre (expanding beyond the zone if crowded)
    const spots: Pos[] = [];
    for (let r = 0; r < 18; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = Math.floor(zc.x + dx), y = Math.floor(zc.y + dy);
          if (x < 0 || y < 0 || x >= b.sx || y >= b.sy) continue;
          spots.push({ x, y, z: 0 });
        }
    const members = [...p.loadout.squad].map((m) => ({ m, r: pool.find((x) => x.id === m.recruitId)! })).filter((e) => e.r);
    // big units first so they find room
    members.sort((a, c) => sizeOf(c.r) - sizeOf(a.r));
    let first: Pos | null = null;
    for (const { m, r } of members) {
      const size = sizeOf(r);
      let placed: Pos | null = null;
      for (const s of spots) {
        const z = standZ(b, s.x, s.y, size);
        if (z < 0) continue;
        placed = { x: s.x, y: s.y, z };
        break;
      }
      if (!placed) continue;
      const u = createUnit(b, r, m.armor, pi, placed, directionTo(placed, center));
      if (!first) first = placed;
      if (u.hasInventory) {
        const innate = r.kind === "alien" ? livingWeaponFor(unitRule(r.type)) : null;
        const placed: PlacedItem[] = innate ? [{ type: innate, slot: "STR_RIGHT_HAND", x: 0, y: 0 }] : [];
        for (const it of m.items) {
          // only items that really fit are carried (the loadout check already rejects the rest)
          if (it.slot === "STR_GROUND" || !fitsSlot(placed, it.type, it.slot, it.x, it.y)) continue;
          if (it.ammo && !itemRule(it.type).compatibleAmmo.includes(it.ammo)) continue;
          placed.push(it);
          giveItem(b, u, it.type, it.slot, it.x, it.y, it.ammo);
        }
      }
    }
    // spare equipment lies on the ground where the squad lands
    if (first) {
      const t = b.idxP(first);
      for (const type of p.loadout.stash) spawnGroundItem(b, type, t);
    }
  });
  b.rebuildUnitIndex();
  recalcAllLighting(b);
  recalculateAllFOV(b);
  b.phase = Phase.PLAYING;
  const rules = new GameRules(b);
  const ev = new BattleEvents(b);
  rules.beginTurn(0, ev);
  return b;
}

function sizeOf(r: Recruit): number {
  if (r.kind === "soldier") return 1;
  return armorRule(unitRule(r.type).armor).size;
}

export { itemRule };
