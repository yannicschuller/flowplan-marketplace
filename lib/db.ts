// One SQLite file in the data directory (node:sqlite, like Flowplan). The
// schema is built by numbered migrations; PRAGMA user_version holds the last
// one applied.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";

const MIGRATIONS: string[] = [
  // 1: accounts, sessions, sign-in links
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     handle TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     email TEXT UNIQUE,
     github_id TEXT UNIQUE,
     github_login TEXT,
     created_at INTEGER NOT NULL,
     blocked_at INTEGER
   );
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE magic_links (
     token_hash TEXT PRIMARY KEY,
     email TEXT NOT NULL,
     next TEXT NOT NULL DEFAULT '/',
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     used_at INTEGER
   );`,
  // 2: templates and their versions (each version is one submission)
  `CREATE TABLE templates (
     id TEXT PRIMARY KEY,
     slug TEXT NOT NULL UNIQUE,
     author_id TEXT NOT NULL REFERENCES users(id),
     kind TEXT NOT NULL,
     published_version_id TEXT,
     published_at INTEGER,
     unpublished_at INTEGER,
     unpublish_reason TEXT,
     withdrawn_at INTEGER,
     featured_rank INTEGER,
     downloads INTEGER NOT NULL DEFAULT 0,
     opens INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX templates_author ON templates(author_id);
   CREATE TABLE versions (
     id TEXT PRIMARY KEY,
     template_id TEXT NOT NULL REFERENCES templates(id),
     number INTEGER NOT NULL,
     status TEXT NOT NULL,
     title TEXT NOT NULL,
     summary_de TEXT NOT NULL DEFAULT '',
     summary_en TEXT NOT NULL DEFAULT '',
     description_de TEXT NOT NULL DEFAULT '',
     description_en TEXT NOT NULL DEFAULT '',
     category TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '[]',
     min_version TEXT NOT NULL,
     language TEXT NOT NULL,
     license TEXT NOT NULL,
     changelog TEXT NOT NULL DEFAULT '',
     manifest TEXT NOT NULL,
     findings TEXT NOT NULL DEFAULT '[]',
     analysis TEXT NOT NULL DEFAULT '{}',
     previews TEXT NOT NULL DEFAULT '[]',
     size INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     review_message TEXT NOT NULL DEFAULT '',
     downloads INTEGER NOT NULL DEFAULT 0,
     submitted_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     decided_at INTEGER,
     published_at INTEGER,
     UNIQUE(template_id, number)
   );
   CREATE INDEX versions_status ON versions(status);`,
  // 3: reports, audit log, rate limits
  `CREATE TABLE reports (
     id TEXT PRIMARY KEY,
     template_id TEXT NOT NULL REFERENCES templates(id),
     version_id TEXT,
     reason TEXT NOT NULL,
     text TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     resolved_at INTEGER,
     resolution TEXT NOT NULL DEFAULT '',
     resolved_by TEXT
   );
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT NOT NULL DEFAULT '',
     details TEXT NOT NULL DEFAULT '{}'
   );
   CREATE TABLE rate_limits (
     key TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL
   );`,
];
export const SCHEMA_VERSION = MIGRATIONS.length;

const holder = globalThis as unknown as { marketplaceDb?: { db: DatabaseSync; dir: string } };

export function migrate(db: DatabaseSync) {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (current > SCHEMA_VERSION) throw new Error(`Database schema ${current} is newer than this version (${SCHEMA_VERSION}).`);
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

// The connection for the current data directory (a new one when it changed,
// which only tests do).
export function db(): DatabaseSync {
  const dir = config.dataDir();
  if (holder.marketplaceDb?.dir === dir) return holder.marketplaceDb.db;
  holder.marketplaceDb?.db.close();
  mkdirSync(dir, { recursive: true });
  const conn = new DatabaseSync(join(/*turbopackIgnore: true*/ dir, "marketplace.db"));
  conn.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(conn);
  holder.marketplaceDb = { db: conn, dir };
  return conn;
}
export function closeDb() {
  holder.marketplaceDb?.db.close();
  holder.marketplaceDb = undefined;
}

export const all = <T>(sql: string, ...params: SQLInputValue[]) => db().prepare(sql).all(...params) as T[];
export const one = <T>(sql: string, ...params: SQLInputValue[]) => db().prepare(sql).get(...params) as T | undefined;
export const run = (sql: string, ...params: SQLInputValue[]) => db().prepare(sql).run(...params);
export function transaction<T>(fn: () => T): T {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (error) {
    conn.exec("ROLLBACK");
    throw error;
  }
}
export const newId = () => randomUUID();
export const now = () => Date.now();
