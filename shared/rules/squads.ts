// Automatic hiring and equipping: squad-building strategies for computer players and the balance
// harness. Every squad passes checkLoadout, exactly like one put together in the lobby.
import { itemRule, unitRule, livingWeaponFor, fitsSlot, INVENTORY_SLOTS, type PlacedItem, type SlotId } from "./index.ts";
import { catalogFor, armorsFor, itemPrice, armorPrice, seatsFor, checkLoadout } from "./catalog.ts";
import type { MatchSettings, Recruit, Loadout, SquadMember } from "../protocol.ts";
import { RNG } from "../engine/rng.ts";

export const STRATEGIES = ["swarm", "elite", "balanced", "heavy", "monster", "aliens", "tanks", "psi", "random"] as const;
export type Strategy = (typeof STRATEGIES)[number];

export interface Kit {
  name: string;
  weapon?: string;
  ammo?: string;
  extras: string[];
}

/** Weapon kits, roughly weakest to strongest. */
export const KITS: Kit[] = [
  { name: "pistol", weapon: "STR_PISTOL", ammo: "STR_PISTOL_CLIP", extras: ["STR_PISTOL_CLIP", "STR_GRENADE"] },
  { name: "rifle", weapon: "STR_RIFLE", ammo: "STR_RIFLE_CLIP", extras: ["STR_RIFLE_CLIP", "STR_GRENADE", "STR_GRENADE"] },
  { name: "stun rod", weapon: "STR_STUN_ROD", extras: ["STR_GRENADE", "STR_GRENADE"] },
  { name: "rocket launcher", weapon: "STR_ROCKET_LAUNCHER", ammo: "STR_SMALL_ROCKET", extras: ["STR_LARGE_ROCKET", "STR_SMALL_ROCKET"] },
  { name: "heavy cannon", weapon: "STR_HEAVY_CANNON", ammo: "STR_HC_AP_AMMO", extras: ["STR_HC_HE_AMMO", "STR_GRENADE"] },
  { name: "auto-cannon", weapon: "STR_AUTO_CANNON", ammo: "STR_AC_AP_AMMO", extras: ["STR_AC_HE_AMMO"] },
  { name: "laser pistol", weapon: "STR_LASER_PISTOL", extras: ["STR_GRENADE", "STR_GRENADE"] },
  { name: "laser rifle", weapon: "STR_LASER_RIFLE", extras: ["STR_GRENADE", "STR_GRENADE"] },
  { name: "heavy laser", weapon: "STR_HEAVY_LASER", extras: ["STR_GRENADE"] },
  { name: "plasma pistol", weapon: "STR_PLASMA_PISTOL", ammo: "STR_PLASMA_PISTOL_CLIP", extras: ["STR_PLASMA_PISTOL_CLIP", "STR_ALIEN_GRENADE"] },
  { name: "plasma rifle", weapon: "STR_PLASMA_RIFLE", ammo: "STR_PLASMA_RIFLE_CLIP", extras: ["STR_PLASMA_RIFLE_CLIP", "STR_ALIEN_GRENADE"] },
  { name: "heavy plasma", weapon: "STR_HEAVY_PLASMA", ammo: "STR_HEAVY_PLASMA_CLIP", extras: ["STR_HEAVY_PLASMA_CLIP", "STR_ALIEN_GRENADE"] },
  { name: "blaster launcher", weapon: "STR_BLASTER_LAUNCHER", ammo: "STR_BLASTER_BOMB", extras: ["STR_BLASTER_BOMB"] },
  { name: "grenades", extras: ["STR_GRENADE", "STR_GRENADE", "STR_GRENADE"] },
];

export function kitPrice(k: Kit): number {
  return [k.weapon, k.ammo, ...k.extras].reduce((a, t) => a + (t ? itemPrice(t) : 0), 0);
}

export function kitsFor(s: MatchSettings): Kit[] {
  const ok = new Set(catalogFor(s).map((c) => c.type));
  return KITS.filter((k) => [k.weapon, k.ammo, ...k.extras].every((t) => !t || ok.has(t)));
}

function innateWeapon(r: Recruit): string | null {
  return r.kind === "alien" ? livingWeaponFor(unitRule(r.type)) : null;
}

const STORAGE: SlotId[] = ["STR_BELT", "STR_RIGHT_LEG", "STR_LEFT_LEG", "STR_RIGHT_SHOULDER", "STR_LEFT_SHOULDER", "STR_BACK_PACK"];

/** The first place in `slots` where `type` fits next to what's already placed. */
function freeSpot(placed: PlacedItem[], type: string, slots: SlotId[]): PlacedItem | null {
  for (const slot of slots) {
    const def = INVENTORY_SLOTS[slot];
    const cells = def.type === 1 ? [[0, 0]] : def.cells;
    for (const [x, y] of cells) if (fitsSlot(placed, type, slot, x, y)) return { type, slot, x, y };
  }
  return null;
}

/** Packs a kit onto a recruit: weapon in a free hand, the rest wherever it fits. Returns what was carried. */
export function equip(r: Recruit, armor: string, kit: Kit | null, extra: string[] = []): SquadMember {
  const m: SquadMember = { recruitId: r.id, armor, items: [] };
  if (r.kind === "hwp") return m;
  const innate = innateWeapon(r);
  const placed: PlacedItem[] = innate ? [{ type: innate, slot: "STR_RIGHT_HAND", x: 0, y: 0 }] : [];
  let weight = 0;
  const put = (type: string, ammo: string | undefined, hand: boolean): boolean => {
    const w = itemRule(type).weight + (ammo ? itemRule(ammo).weight : 0);
    // don't overload: a soldier carrying more than their strength loses time units
    if (weight + w > r.stats.strength && placed.length > (innate ? 1 : 0)) return false;
    const spot = freeSpot(placed, type, hand ? ["STR_RIGHT_HAND", "STR_LEFT_HAND", ...STORAGE] : [...STORAGE, "STR_LEFT_HAND"]);
    if (!spot) return false;
    const it = { ...spot, ...(ammo ? { ammo } : {}) };
    placed.push(it);
    m.items.push(it);
    weight += w;
    return true;
  };
  if (kit?.weapon) put(kit.weapon, kit.ammo, true);
  for (const t of [...(kit?.extras ?? []), ...extra]) put(t, undefined, itemRule(t).battleType === 9);
  return m;
}

export function memberCost(r: Recruit, m: SquadMember): number {
  let c = r.price + (r.kind === "soldier" ? armorPrice(m.armor || "STR_NONE_UC") : 0);
  for (const it of m.items) c += itemPrice(it.type) + (it.ammo ? itemPrice(it.ammo) : 0);
  return c;
}

class Builder {
  squad: SquadMember[] = [];
  gear = new Map<string, { kit: Kit | null; extra: string[] }>();
  used = new Set<string>();
  cost = 0;
  seats = 0;
  constructor(public s: MatchSettings, public pool: Recruit[]) {}
  get left() {
    return this.s.budget - this.cost;
  }
  /** Hires `r` with the first kit (and armor) that fits the remaining money; false if none does. */
  tryAdd(r: Recruit, kits: (Kit | null)[], armors: string[] = ["STR_NONE_UC"], extra: string[] = []): boolean {
    if (this.used.has(r.id) || this.seats + seatsFor(r) > this.s.squadLimit) return false;
    for (const armor of r.kind === "soldier" ? armors : ["STR_NONE_UC"])
      for (const kit of kits) {
        const m = equip(r, r.kind === "soldier" ? armor : "STR_NONE_UC", kit, extra);
        const c = memberCost(r, m);
        if (c > this.left) continue;
        this.squad.push(m);
        this.gear.set(r.id, { kit, extra });
        this.used.add(r.id);
        this.cost += c;
        this.seats += seatsFor(r);
        return true;
      }
    return false;
  }
  /** Spends what's left like a player would: better armor first, then better guns, best hires first. */
  upgrade(kits: Kit[], armors: string[]) {
    const ranked = [...this.squad].sort((a, c) => this.recruit(c).price - this.recruit(a).price).map((m) => m.recruitId);
    for (const pass of ["armor", "weapon"] as const)
      for (const id of ranked) {
        const i = this.squad.findIndex((x) => x.recruitId === id);
        const m = this.squad[i];
        const r = this.recruit(m);
        if (r.kind === "hwp" || (pass === "armor" && r.kind !== "soldier")) continue;
        const g = this.gear.get(r.id)!;
        const current = memberCost(r, m);
        const options = pass === "armor" ? armors.map((a) => ({ armor: a, kit: g.kit })) : kits.map((k) => ({ armor: m.armor, kit: k }));
        for (const o of options) {
          // only real upgrades: dearer armor, or a dearer weapon (aliens with claws keep them)
          if (pass === "armor" && armorPrice(o.armor) <= armorPrice(m.armor)) continue;
          if (pass === "weapon" && (innateWeapon(r) || !o.kit?.weapon || kitPrice(o.kit) <= (g.kit ? kitPrice(g.kit) : 0))) continue;
          const n = equip(r, o.armor, o.kit, g.extra);
          const c = memberCost(r, n);
          // the upgrade has to actually be carried, without dropping anything (a Psi-Amp, say)
          const carried = n.items.map((it) => it.type);
          if (c - current > this.left || (o.kit?.weapon && !carried.includes(o.kit.weapon)) || !g.extra.every((t) => carried.includes(t))) continue;
          this.squad[i] = n;
          this.gear.set(r.id, { kit: o.kit, extra: g.extra });
          this.cost += c - current;
          break;
        }
      }
  }
  private recruit(m: SquadMember): Recruit {
    return this.pool.find((p) => p.id === m.recruitId)!;
  }
  loadout(): Loadout {
    return { squad: this.squad, stash: [] };
  }
}

const byPrice = (a: Recruit, b: Recruit) => a.price - b.price;

/**
 * The "auto-configure" button: the strongest squad the hiring strategies can put together for this match (pool,
 * budget, seats, tech, time of day), trying them in the order they fare in bot tournaments, plus a medikit or two
 * for a person to use. A co-op scenario fills the player's own Skyranger seats.
 */
export function autoSquad(s: MatchSettings, pool: Recruit[]): { loadout: Loadout; strategy: Strategy } {
  const settings: MatchSettings = s.mode === "coop" ? { ...s, mode: "ffa", squadLimit: s.scenario.seatsPerPlayer } : s;
  // the first strategy, in tournament order, that makes real use of the money here (the others may not be
  // possible with these settings: no soldiers in the pool, aliens or tanks off, a tiny budget...)
  // ...with enough bodies that one lucky shot doesn't end the match
  const minUnits = Math.min(4, settings.squadLimit);
  let pick: { loadout: Loadout; strategy: Strategy; spent: number } | null = null;
  const enough = (l: Loadout) => l.squad.length >= minUnits;
  const better = (l: Loadout, spent: number) => {
    if (!pick) return true;
    if (enough(l) !== enough(pick.loadout)) return enough(l);
    // short of bodies either way: the most bodies
    if (!enough(l) && l.squad.length !== pick.loadout.squad.length) return l.squad.length > pick.loadout.squad.length;
    return spent > pick.spent;
  };
  for (const [rank, strategy] of AUTO_ORDER.entries()) {
    if (strategy === "tanks" && !s.allowHWP) continue;
    if (strategy === "aliens" && !s.allowAliens) continue;
    let l: Loadout;
    try {
      l = buildSquad(strategy, settings, pool, new RNG(pool.length * 31 + rank));
    } catch {
      continue;
    }
    const chk = checkLoadout(settings, pool, l);
    const spent = chk.cost / settings.budget;
    if (better(l, spent)) pick = { loadout: l, strategy, spent };
    if ((spent >= 0.8 || chk.seats >= settings.squadLimit) && l.squad.length >= minUnits) break;
  }
  if (!pick) return { loadout: buildSquad("swarm", settings, pool, new RNG(1)), strategy: "swarm" };
  // the strategies spend everything: build again with the medikits' money set aside, then hand them out
  const soldiers = pick.loadout.squad.filter((m) => pool.find((p) => p.id === m.recruitId)?.kind === "soldier").length;
  const kits = catalogFor(settings).some((c) => c.type === "STR_MEDI_KIT") ? Math.ceil(soldiers / 5) : 0;
  let loadout = pick.loadout;
  if (kits) {
    try {
      const rank = AUTO_ORDER.indexOf(pick.strategy);
      const lighter = buildSquad(pick.strategy, { ...settings, budget: settings.budget - kits * itemPrice("STR_MEDI_KIT") }, pool, new RNG(pool.length * 31 + rank));
      // a medikit isn't worth a soldier
      if (lighter.squad.length >= loadout.squad.length) loadout = lighter;
    } catch {
      /* keep the squad as it was */
    }
    addMedikits(settings, pool, loadout, kits);
  }
  return { loadout, strategy: pick.strategy };
}

/**
 * Strategies best first, from a `tools/balance.ts --games 300 --budget 200000,400000,1000000` tournament (2026-10-22):
 * elite won 71% / 76% / 70% at the three budgets, balanced 71 / 40 / 56, aliens 65 / 70 / 83 (strong but
 * erratic, and a hard squad for a newcomer to play), heavy 33 / 44 / 65, tanks 46 / 34 / 54, swarm 18 / 29 / 13.
 */
export const AUTO_ORDER: Strategy[] = ["elite", "balanced", "heavy", "aliens", "tanks", "swarm"];

/** `want` medikits (one for every five soldiers), carried by the best-protected soldiers with room for one. */
function addMedikits(s: MatchSettings, pool: Recruit[], l: Loadout, want: number) {
  const soldiers = l.squad.filter((m) => pool.find((p) => p.id === m.recruitId)?.kind === "soldier");
  let left = s.budget - checkLoadout(s, pool, l).cost;
  for (const m of [...soldiers].sort((a, b) => armorPrice(b.armor) - armorPrice(a.armor))) {
    if (want <= 0 || left < itemPrice("STR_MEDI_KIT")) break;
    const spot = freeSpot([...m.items], "STR_MEDI_KIT", STORAGE);
    if (!spot) continue;
    m.items.push(spot);
    left -= itemPrice("STR_MEDI_KIT");
    want--;
  }
}

/** Builds a squad for `strategy` from the shared pool within the match's budget and seat limit. */
export function buildSquad(strategy: Strategy, s: MatchSettings, pool: Recruit[], rng: RNG): Loadout {
  const kits = kitsFor(s);
  const kit = (name: string) => kits.find((k) => k.name === name) ?? null;
  const pick = (...names: string[]) => names.map(kit).filter((k): k is Kit => !!k);
  const basic = pick("rifle", "pistol", "grenades");
  const best = pick("plasma rifle", "laser rifle", "heavy plasma", "auto-cannon", "heavy cannon", "rifle", "pistol");
  const armors = armorsFor(s);
  const bestArmor = ["STR_POWER_SUIT_UC", "STR_PERSONAL_ARMOR_UC", "STR_NONE_UC"].filter((a) => armors.includes(a));
  const soldiers = pool.filter((p) => p.kind === "soldier");
  const aliens = pool.filter((p) => p.kind === "alien");
  const hwps = pool.filter((p) => p.kind === "hwp");
  const b = new Builder(s, pool);
  const armed = (r: Recruit): (Kit | null)[] => {
    // aliens with claws/spit fight with those; give the rest a gun
    if (innateWeapon(r)) return [kit("grenades"), null];
    return r.kind === "alien" ? [...pick("plasma rifle", "plasma pistol", "laser rifle", "rifle", "pistol"), null] : basic;
  };
  const fillSwarm = () => {
    for (const r of [...soldiers].sort(byPrice)) b.tryAdd(r, basic);
  };

  switch (strategy) {
    case "swarm":
      fillSwarm();
      break;
    case "elite":
      for (const r of [...soldiers].sort((a, c) => c.price - a.price)) b.tryAdd(r, best, bestArmor);
      fillSwarm();
      break;
    case "balanced": {
      // mid-priced soldiers, mixed weapons, personal armor where affordable
      const mid = [...soldiers].sort(byPrice);
      const order = [...mid.slice(Math.floor(mid.length / 3)), ...mid.slice(0, Math.floor(mid.length / 3))];
      const roles = [pick("laser rifle", "plasma rifle", "rifle"), pick("heavy cannon", "rocket launcher", "rifle"), pick("rifle", "pistol")];
      const arm = ["STR_PERSONAL_ARMOR_UC", "STR_NONE_UC"].filter((a) => armors.includes(a));
      order.forEach((r, i) => b.tryAdd(r, [...roles[i % roles.length], ...basic], arm));
      break;
    }
    case "heavy": {
      // explosives everywhere: launchers, cannons with HE, extra grenades
      const heavy = pick("blaster launcher", "rocket launcher", "heavy cannon", "auto-cannon", "rifle");
      for (const r of [...soldiers].sort((a, c) => c.stats.strength - a.stats.strength)) b.tryAdd(r, heavy, ["STR_NONE_UC"], ["STR_GRENADE"]);
      break;
    }
    case "monster": {
      const big = [...aliens, ...hwps].filter((r) => r.price <= s.budget * 0.7).sort((a, c) => c.price - a.price);
      if (big.length) b.tryAdd(big[0], armed(big[0]));
      fillSwarm();
      break;
    }
    case "aliens":
      for (const r of rng.shuffle([...aliens])) b.tryAdd(r, armed(r));
      break;
    case "tanks": {
      for (const r of [...hwps].sort((a, c) => c.price - a.price)) if (r.price <= b.left * 0.6) b.tryAdd(r, [null]);
      fillSwarm();
      break;
    }
    case "psi": {
      if (s.psionics) {
        const amp = catalogFor(s).some((c) => c.type === "STR_PSI_AMP");
        const psychics = pool.filter((p) => p.stats.psiSkill > 0).sort((a, c) => c.stats.psiSkill * c.stats.psiStrength - a.stats.psiSkill * a.stats.psiStrength);
        for (const r of psychics) {
          if (r.kind === "soldier") {
            if (amp) b.tryAdd(r, pick("rifle", "pistol"), bestArmor, ["STR_PSI_AMP"]);
          } else b.tryAdd(r, armed(r));
        }
      }
      fillSwarm();
      break;
    }
    case "random": {
      for (const r of rng.shuffle([...pool])) {
        if (b.left < 10000) break;
        const k = r.kind === "alien" && innateWeapon(r) ? [null] : rng.shuffle([...kits]);
        b.tryAdd(r, [...k, null], rng.shuffle([...armors]));
      }
      break;
    }
  }
  // money left over (seat limit reached, or an expensive centrepiece): upgrade armor, then guns
  if (strategy !== "random") b.upgrade(pick("heavy plasma", "plasma rifle", "heavy laser", "laser rifle", "auto-cannon", "heavy cannon", "rifle"), [...bestArmor]);
  // after dark, every other soldier carries a couple of flares (aliens see in the dark)
  if (s.timeOfDay !== "day" && catalogFor(s).some((c) => c.type === "STR_ELECTRO_FLARE")) {
    b.squad.forEach((m, i) => {
      const r = pool.find((p) => p.id === m.recruitId)!;
      if (r.kind !== "soldier" || i % 2) return;
      for (let k = 0; k < 2 && b.left >= itemPrice("STR_ELECTRO_FLARE"); k++) {
        const spot = freeSpot([...m.items], "STR_ELECTRO_FLARE", STORAGE);
        if (!spot) break;
        m.items.push(spot);
        b.cost += itemPrice("STR_ELECTRO_FLARE");
      }
    });
  }
  if (!b.squad.length) {
    // nothing affordable with gear: hire the cheapest unit bare-handed
    const cheapest = [...pool].sort(byPrice)[0];
    if (cheapest) b.tryAdd(cheapest, [null]);
  }
  const l = b.loadout();
  const chk = checkLoadout(s, pool, l);
  if (!chk.ok) throw new Error(`${strategy} squad invalid: ${chk.errors.join("; ")}`);
  return l;
}
