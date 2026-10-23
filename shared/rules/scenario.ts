// Co-op scenarios: the enemy force a match creator sets up (unit types, numbers, weapons, where they start,
// reinforcement waves), turned into recruits and loadouts the battle setup understands.
import { itemRule, unitRule, tr, ITEMS } from "./index.ts";
import { ENEMY_UNIT_TYPES, armorsFor, scenarioRecruit, CATALOG } from "./catalog.ts";
import { equip, KITS, type Kit } from "./squads.ts";
import { RNG } from "../engine/rng.ts";
import type { MatchSettings, Recruit, SquadMember, EnemyGroup, TechLevel } from "../protocol.ts";

const SOLDIER_RANKS = ["Rookie", "Squaddie", "Sergeant", "Captain", "Colonel", "Commander"];

/** Everything an enemy group can be, for the scenario editor. */
export function enemyTypeChoices(): { id: string; name: string; group: string }[] {
  const out: { id: string; name: string; group: string }[] = [];
  for (const t of ENEMY_UNIT_TYPES) {
    const u = unitRule(t);
    const group = t.startsWith("STR_TANK") || t.startsWith("STR_HOVERTANK") ? "Tanks" : u.rank === "STR_LIVE_TERRORIST" || /TERRORIST|ZOMBIE/.test(t) ? "Terror units" : tr(u.race);
    out.push({ id: t, name: tr(t), group });
  }
  SOLDIER_RANKS.forEach((r, i) => out.push({ id: `SOLDIER:${i}`, name: `Human soldier (${r})`, group: "Humans" }));
  return out;
}

export function enemyTypeName(type: string): string {
  const s = /^SOLDIER:([0-5])$/.exec(type);
  if (s) return `${SOLDIER_RANKS[Number(s[1])]} soldier`;
  return ITEMS.has(type) || ENEMY_UNIT_TYPES.includes(type) ? tr(type) : type;
}

/** Hand weapons an enemy group can carry (any tech level: the game master decides). */
export function weaponChoices(): { id: string; name: string }[] {
  return [
    { id: "standard", name: "Standard (by rank & tech)" },
    { id: "none", name: "None (claws & psi only)" },
    ...KITS.filter((k) => k.weapon).map((k) => ({ id: k.weapon!, name: tr(k.weapon!) })),
  ];
}

const isLeader = (type: string) => /LEADER|COMMANDER|SOLDIER:[45]/.test(type);
const isRankAndFile = (type: string) => /_SOLDIER$|SOLDIER:[1-3]/.test(type);

/** What a unit of this type carries by default: lighter arms for crew, heavy ones for leaders. */
function standardWeapon(type: string, tech: TechLevel): string {
  const tier = isLeader(type) ? 2 : isRankAndFile(type) ? 1 : 0;
  if (tech === "alien") return ["STR_PLASMA_PISTOL", "STR_PLASMA_RIFLE", "STR_HEAVY_PLASMA"][tier];
  if (tech === "laser") return ["STR_LASER_PISTOL", "STR_LASER_RIFLE", "STR_HEAVY_LASER"][tier];
  return ["STR_PISTOL", "STR_RIFLE", "STR_HEAVY_CANNON"][tier];
}

function kitFor(g: EnemyGroup, tech: TechLevel): Kit | null {
  const weapon = g.weapon === "standard" ? standardWeapon(g.type, tech) : g.weapon === "none" ? null : g.weapon;
  if (!weapon || !ITEMS.has(weapon)) return null;
  const k = KITS.find((x) => x.weapon === weapon);
  const ammo = k?.ammo ?? itemRule(weapon).compatibleAmmo[0];
  // a spare clip, if the weapon takes them
  return { name: weapon, weapon, ammo, extras: ammo ? [ammo] : [] };
}

export interface EnemyForce {
  recruits: Recruit[];
  /** there from the start */
  initial: SquadMember[];
  /** reinforcements: who arrives in which round */
  waves: { round: number; members: SquadMember[] }[];
}

/** The scenario's enemies as recruits and loadouts (deterministic for a match's seed). */
export function buildEnemyForce(settings: MatchSettings, seed: number): EnemyForce {
  const rng = new RNG(seed ^ 0xe4e3);
  const recruits: Recruit[] = [];
  const initial: SquadMember[] = [];
  const waves = new Map<number, SquadMember[]>();
  const armors = new Set([...armorsFor({ ...settings, allowArmor: true }), "STR_NONE_UC"]);
  const grenade = settings.techLevel === "alien" ? "STR_ALIEN_GRENADE" : "STR_GRENADE";
  settings.scenario.enemies.forEach((g, gi) => {
    for (let i = 0; i < g.count; i++) {
      const r = scenarioRecruit(g.type, rng, `e${gi}-${i}`, settings);
      if (!r) break;
      recruits.push(r);
      const armor = r.kind === "soldier" && armors.has(g.armor) ? g.armor : "STR_NONE_UC";
      const m: SquadMember = { ...equip(r, armor, kitFor(g, settings.techLevel), Array(g.grenades).fill(grenade)), deploy: g.placement };
      if (g.round <= 1) initial.push(m);
      else {
        const w = waves.get(g.round) ?? [];
        w.push(m);
        waves.set(g.round, w);
      }
    }
  });
  return { recruits, initial, waves: [...waves].sort((a, b) => a[0] - b[0]).map(([round, members]) => ({ round, members })) };
}

/** One line per enemy group, for the lobby. */
export function forceSummary(settings: MatchSettings): string[] {
  return settings.scenario.enemies.map((g) => {
    const w = g.weapon === "standard" ? "" : g.weapon === "none" ? ", unarmed" : `, ${tr(g.weapon)}`;
    const gr = g.grenades ? `, ${g.grenades} grenade${g.grenades > 1 ? "s" : ""} each` : "";
    const when = g.round > 1 ? ` — arrive in round ${g.round}` : "";
    return `${g.count} × ${enemyTypeName(g.type)}${w}${gr} (${placementShort(g.placement)})${when}`;
  });
}

function placementShort(p: EnemyGroup["placement"]): string {
  return { edge: "far side", ufo: "at the UFO", center: "middle", spread: "scattered" }[p];
}

export { CATALOG };
