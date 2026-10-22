import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DB_PATH = process.env.DB_PATH ?? "./data/xcom.sqlite";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT,
  name TEXT NOT NULL,
  picture TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id),
  settings TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby',
  seed INTEGER NOT NULL,
  pool TEXT NOT NULL,
  battle TEXT,
  turn_deadline INTEGER,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  seat INTEGER NOT NULL,
  name TEXT NOT NULL,
  loadout TEXT,
  ready INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (match_id, user_id)
);
-- one statistics record per finished match (shared/engine/record.ts), kept even if the match is deleted
CREATE TABLE IF NOT EXISTS match_records (
  match_id TEXT PRIMARY KEY,
  finished INTEGER NOT NULL,
  record TEXT NOT NULL
);
`);

// columns added after the first release
for (const sql of [
  // co-op: user id of the squad leader this player helps (NULL: leads their own squad)
  "ALTER TABLE match_players ADD COLUMN squad_of TEXT",
  // computer squads: AI settings (BotTuning JSON)
  "ALTER TABLE match_players ADD COLUMN ai TEXT",
]) {
  try {
    db.exec(sql);
  } catch {
    /* already there */
  }
}

export interface UserRow { id: string; google_sub: string | null; email: string | null; name: string; picture: string | null; created: number }
export interface MatchRow { id: string; owner: string; settings: string; status: string; seed: number; pool: string; battle: string | Uint8Array | null; turn_deadline: number | null; created: number; updated: number }
export interface PlayerRow { match_id: string; user_id: string; seat: number; name: string; loadout: string | null; ready: number; squad_of: string | null; ai: string | null }

export function randomId(len = 12): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
