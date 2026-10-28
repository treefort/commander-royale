// Custom maps: made in the map editor, stored per author, listed for everyone on the server to play on or copy.
import { db, randomId, type UserRow } from "./db.ts";
import { sanitizeMapDoc, type MapDoc } from "../shared/maps/format.ts";

db.exec(`
CREATE TABLE IF NOT EXISTS maps (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  terrain TEXT NOT NULL,
  -- "<width>x<length>x<levels>"
  size TEXT NOT NULL,
  zones INTEGER NOT NULL,
  doc TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
`);

interface MapRow { id: string; owner: string; name: string; terrain: string; size: string; zones: number; doc: string; created: number; updated: number }

/** A map's document is a few hundred KB at most (the tiles are run-length encoded). */
const MAX_DOC = 4_000_000;

export interface MapSummary { id: string; name: string; terrain: string; size: string; zones: number; author: string; mine: boolean; updated: number; description: string }

function summary(r: MapRow & { author: string }, user: UserRow): MapSummary {
  let description = "";
  try {
    description = (JSON.parse(r.doc) as MapDoc).description ?? "";
  } catch {
    /* listed without it */
  }
  return { id: r.id, name: r.name, terrain: r.terrain, size: r.size, zones: r.zones, author: r.author, mine: r.owner === user.id, updated: r.updated, description };
}

export function listMaps(user: UserRow): MapSummary[] {
  const rows = db.query("SELECT m.*, u.name AS author FROM maps m JOIN users u ON u.id = m.owner ORDER BY m.updated DESC LIMIT 500").all() as (MapRow & { author: string })[];
  return rows.map((r) => summary(r, user)).sort((a, b) => Number(b.mine) - Number(a.mine));
}

export function getMap(id: string): MapDoc | null {
  const r = db.query("SELECT doc FROM maps WHERE id = ?").get(id) as { doc: string } | null;
  return r ? (JSON.parse(r.doc) as MapDoc) : null;
}

export function mapState(id: string, user: UserRow) {
  const r = db.query("SELECT m.*, u.name AS author FROM maps m JOIN users u ON u.id = m.owner WHERE m.id = ?").get(id) as (MapRow & { author: string }) | null;
  if (!r) return null;
  return { ...summary(r, user), doc: JSON.parse(r.doc) as MapDoc };
}

/** Saves a map: a new one (no id), or the author's own. Returns its id, or an error. */
export function saveMap(user: UserRow, id: string | null, raw: unknown): { id?: string; error?: string } {
  let doc: MapDoc;
  try {
    doc = sanitizeMapDoc(raw);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const json = JSON.stringify(doc);
  if (json.length > MAX_DOC) return { error: "That map is too big to save" };
  const now = Date.now();
  const size = doc.size.join("x");
  if (id) {
    const r = db.query("SELECT owner FROM maps WHERE id = ?").get(id) as { owner: string } | null;
    if (!r) return { error: "Map not found" };
    if (r.owner !== user.id) return { error: "Only its author can change this map (make a copy to change it)" };
    db.query("UPDATE maps SET name = ?, terrain = ?, size = ?, zones = ?, doc = ?, updated = ? WHERE id = ?").run(doc.name, doc.terrain, size, doc.zones.length, json, now, id);
    return { id };
  }
  const nid = randomId(10);
  db.query("INSERT INTO maps (id, owner, name, terrain, size, zones, doc, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(nid, user.id, doc.name, doc.terrain, size, doc.zones.length, json, now, now);
  return { id: nid };
}

/** Saves a map built for a play link, or finds the same map the user already has (opening a link twice). */
export function saveOrReuseMap(user: UserRow, raw: unknown): { id?: string; error?: string } {
  let json: string;
  try {
    json = JSON.stringify(sanitizeMapDoc(raw));
  } catch (e) {
    return { error: (e as Error).message };
  }
  const name = (JSON.parse(json) as MapDoc).name;
  const same = (db.query("SELECT id, doc FROM maps WHERE owner = ? AND name = ?").all(user.id, name) as { id: string; doc: string }[]).find((r) => r.doc === json);
  return same ? { id: same.id } : saveMap(user, null, raw);
}

export function deleteMap(user: UserRow, id: string): string | null {
  const r = db.query("SELECT owner FROM maps WHERE id = ?").get(id) as { owner: string } | null;
  if (!r) return "Map not found";
  if (r.owner !== user.id) return "Only its author can delete this map";
  db.query("DELETE FROM maps WHERE id = ?").run(id);
  return null;
}

/** A map's name, for match settings (what the lobby shows); null if there's no such map. */
export function mapName(id: string): string | null {
  const r = db.query("SELECT name FROM maps WHERE id = ?").get(id) as { name: string } | null;
  return r?.name ?? null;
}
