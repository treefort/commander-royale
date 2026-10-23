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
-- sign-ins and passkey attempts (server/access.ts)
CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  user_id TEXT,
  email TEXT,
  name TEXT,
  event TEXT NOT NULL,
  ip TEXT,
  agent TEXT
);
CREATE INDEX IF NOT EXISTS access_log_user ON access_log (user_id, at);
-- one statistics record per finished match (shared/engine/record.ts), kept even if the match is deleted
CREATE TABLE IF NOT EXISTS match_records (
  match_id TEXT PRIMARY KEY,
  finished INTEGER NOT NULL,
  record TEXT NOT NULL
);
-- a battle's starting point shared for others to play from (one side, the rest played by the AI)
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES users(id),
  source TEXT NOT NULL,
  seat INTEGER NOT NULL,
  title TEXT NOT NULL,
  seed INTEGER NOT NULL,
  pool TEXT NOT NULL,
  battle BLOB NOT NULL,
  loadouts TEXT NOT NULL,
  summary TEXT NOT NULL,
  created INTEGER NOT NULL
);
-- each go at a challenge (kept when the match is deleted); finished NULL while it's being played
CREATE TABLE IF NOT EXISTS challenge_attempts (
  match_id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  started INTEGER NOT NULL,
  finished INTEGER,
  won INTEGER,
  rounds INTEGER,
  lost INTEGER,
  kills INTEGER
);
CREATE INDEX IF NOT EXISTS challenge_attempts_challenge ON challenge_attempts (challenge_id);
`);

// columns added after the first release
for (const sql of [
  // co-op: user id of the squad leader this player helps (NULL: leads their own squad)
  "ALTER TABLE match_players ADD COLUMN squad_of TEXT",
  // computer squads: AI settings (BotTuning JSON)
  "ALTER TABLE match_players ADD COLUMN ai TEXT",
  // entered the server's passkey (allowed to play)
  "ALTER TABLE users ADD COLUMN unlocked INTEGER NOT NULL DEFAULT 0",
  // the battle as it began (gzipped) and each side's loadout then, to play it again (retries, challenges)
  "ALTER TABLE matches ADD COLUMN start_battle BLOB",
  "ALTER TABLE matches ADD COLUMN start_loadouts TEXT",
  // played again from a starting point by one person (nobody else can join); and the challenge it's a go at
  "ALTER TABLE matches ADD COLUMN solo INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE matches ADD COLUMN challenge_id TEXT",
  // what each side had last seen out of sight (view.ts SavedMemory[]), kept over a server restart until reloaded
  "ALTER TABLE matches ADD COLUMN view_memory TEXT",
]) {
  try {
    db.exec(sql);
  } catch {
    /* already there */
  }
}

export interface UserRow { id: string; google_sub: string | null; email: string | null; name: string; picture: string | null; created: number; unlocked?: number }
export interface MatchRow { id: string; owner: string; settings: string; status: string; seed: number; pool: string; battle: string | Uint8Array | null; turn_deadline: number | null; created: number; updated: number; start_battle: Uint8Array | null; start_loadouts: string | null; solo: number; challenge_id: string | null; view_memory: string | null }
export interface PlayerRow { match_id: string; user_id: string; seat: number; name: string; loadout: string | null; ready: number; squad_of: string | null; ai: string | null }

export function randomId(len = 12): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
