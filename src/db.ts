import Database from "better-sqlite3";
import path from "path";

// Resolves to the project root whether compiled in build/ (CommonJS) or run via tsx in src/
const DB_PATH = path.resolve(__dirname, "../grid.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL"); // Better concurrent read performance
    _db.pragma("foreign_keys = ON");
  }
  return _db;
}

export function initDb(): void {
  const db = getDb();

  db.exec(`
    -- ─────────────────────────────────────────────
    -- ZONES
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS zones (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      type             TEXT    NOT NULL CHECK(type IN ('indoor', 'outdoor')),
      capacity         INTEGER NOT NULL,
      current_headcount INTEGER NOT NULL DEFAULT 0,
      min_volunteers   INTEGER NOT NULL DEFAULT 2
    );

    -- ─────────────────────────────────────────────
    -- VENDORS
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS vendors (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT    NOT NULL,
      category         TEXT    NOT NULL CHECK(category IN ('food','sound','security','logistics')),
      phone            TEXT    NOT NULL,
      expected_checkin INTEGER NOT NULL,         -- Unix timestamp
      status           TEXT    NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending','checked_in','late','delay_acknowledged','no_show')),
      assigned_zone    TEXT,
      delay_until      INTEGER,                  -- Unix timestamp, nullable
      notes            TEXT
    );

    -- ─────────────────────────────────────────────
    -- VOLUNTEERS
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS volunteers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      phone        TEXT    NOT NULL,
      role         TEXT    NOT NULL,
      current_zone TEXT,
      shift_start  INTEGER NOT NULL,             -- Unix timestamp
      shift_end    INTEGER NOT NULL,             -- Unix timestamp
      status       TEXT    NOT NULL DEFAULT 'active'
                     CHECK(status IN ('active','absent','reassigned'))
    );

    -- ─────────────────────────────────────────────
    -- INCIDENTS
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS incidents (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      description     TEXT    NOT NULL,
      zone_id         INTEGER REFERENCES zones(id),
      severity        TEXT    NOT NULL CHECK(severity IN ('low','medium','high')),
      status          TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')),
      created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at     INTEGER,
      resolution_note TEXT
    );

    -- ─────────────────────────────────────────────
    -- SMS LOG
    -- ─────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sms_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      phone      TEXT    NOT NULL,
      direction  TEXT    NOT NULL CHECK(direction IN ('inbound','outbound')),
      body       TEXT    NOT NULL,
      intent     TEXT,                           -- filled for inbound after classification
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  console.error(`[db] Initialised — ${DB_PATH}`);
}
