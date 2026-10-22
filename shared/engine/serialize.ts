// Battle (de)serialization for persistence. Typed arrays are stored as base64.
import { Battle, TerrainLib, type FileSource, type Phase } from "./state.ts";
import { RNG } from "./rng.ts";
import { newStats } from "./stats.ts";

function b64(a: ArrayBufferView): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function serializeBattle(b: Battle): string {
  return JSON.stringify({
    v: 1,
    datasets: b.lib.datasetNames,
    sx: b.sx, sy: b.sy, sz: b.sz,
    parts: b64(b.parts), fire: b64(b.fire), smoke: b64(b.smoke), overlaps: b64(b.overlaps),
    explosive: b64(b.explosive), explosiveType: b64(b.explosiveType), doorOpen: b64(b.doorOpen),
    discovered: b.discovered.map(b64),
    units: b.units, items: b.items, players: b.players,
    nextItemId: b.nextItemId, nextUnitId: b.nextUnitId, rng: b.rng.state(),
    round: b.round, current: b.current, phase: b.phase, globalShade: b.globalShade,
    settings: b.settings, supply: b.supply, winner: b.winner, terrainName: b.terrainName,
    hitBy: [...b.hitBy].map(([k, v]) => [k, [...v]]),
    stats: b.stats,
  });
}

export function deserializeBattle(json: string, files: FileSource): Battle {
  const o = JSON.parse(json);
  const lib = new TerrainLib(o.datasets, files);
  const b = new Battle(lib, o.settings, 0);
  b.initMap(o.sx, o.sy, o.sz, o.players.length);
  b.parts = new Int16Array(unb64(o.parts).buffer);
  b.fire = unb64(o.fire);
  b.smoke = unb64(o.smoke);
  b.overlaps = unb64(o.overlaps);
  b.explosive = unb64(o.explosive);
  b.explosiveType = unb64(o.explosiveType);
  b.doorOpen = unb64(o.doorOpen);
  b.discovered = o.discovered.map(unb64);
  b.units = o.units;
  b.items = o.items;
  b.players = o.players;
  b.nextItemId = o.nextItemId;
  b.nextUnitId = o.nextUnitId;
  b.rng = new RNG(o.rng);
  b.round = o.round;
  b.current = o.current;
  b.phase = o.phase as Phase;
  b.globalShade = o.globalShade;
  b.supply = o.supply;
  b.winner = o.winner;
  b.terrainName = o.terrainName;
  b.stats = o.stats ?? newStats();
  b.hitBy = new Map((o.hitBy ?? []).map(([k, v]: [number, number[]]) => [k, new Set(v)]));
  b.rebuildUnitIndex();
  b.rebuildItemIndex();
  return b;
}
