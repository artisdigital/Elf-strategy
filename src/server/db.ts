// SQLite persistence (Node's built-in node:sqlite — no native add-ons).
// Schema changes are applied through numbered, append-only migrations.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import path from 'node:path';

// Loaded via require so test tooling cannot rewrite the 'node:' prefix (sqlite exists only as node:sqlite).
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Db = DatabaseSyncType;

const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE config_versions (
        hash TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE provider_settings (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 1,
        credentials_enc TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE candles (
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        tf TEXT NOT NULL,
        time INTEGER NOT NULL,
        open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
        PRIMARY KEY (provider, symbol, tf, time)
      ) WITHOUT ROWID;
      CREATE TABLE candle_ranges (
        provider TEXT NOT NULL,
        symbol TEXT NOT NULL,
        tf TEXT NOT NULL,
        from_time INTEGER NOT NULL,
        to_time INTEGER NOT NULL
      );
      CREATE INDEX idx_candle_ranges ON candle_ranges(provider, symbol, tf);
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        provider TEXT, symbol TEXT, timeframe TEXT,
        direction TEXT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT,
        candle_time INTEGER,
        created_at INTEGER NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_alerts_created ON alerts(created_at);
      CREATE TABLE journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('actual','hypothetical')),
        source TEXT NOT NULL,
        trade_time INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        provider TEXT,
        direction TEXT NOT NULL CHECK (direction IN ('long','short')),
        session TEXT, timeframe TEXT,
        entry REAL, stop REAL, target REAL, exit_price REAL,
        position_size REAL, planned_rr REAL, result_r REAL, fees REAL,
        outcome TEXT,
        rule_compliant INTEGER,
        setup_type TEXT,
        emotion_rating INTEGER,
        mistakes TEXT, improvements TEXT, notes TEXT, lessons TEXT,
        screenshot TEXT,
        signal_id TEXT, plan_id INTEGER,
        config_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_journal_time ON journal(trade_time);
      CREATE TABLE plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry REAL NOT NULL, stop REAL NOT NULL, tp1 REAL, tp2 REAL,
        status TEXT NOT NULL CHECK (status IN ('planned','active','closed','cancelled')),
        source TEXT NOT NULL,
        signal_id TEXT,
        position_size REAL,
        tp1_hit INTEGER NOT NULL DEFAULT 0,
        outcome TEXT, exit_price REAL, exit_time INTEGER, result_r REAL,
        last_checked_time INTEGER,
        notes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE backtests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        input TEXT NOT NULL,
        result TEXT NOT NULL,
        data_hash TEXT NOT NULL,
        result_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE replays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
        from_time INTEGER NOT NULL, to_time INTEGER NOT NULL,
        cursor_time INTEGER,
        config TEXT NOT NULL,
        notes TEXT,
        trades TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: 2,
    name: 'journal ELF checklist',
    sql: `ALTER TABLE journal ADD COLUMN checklist TEXT;`,
  },
  {
    id: 3,
    name: 'web push subscriptions',
    sql: `CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, keys TEXT NOT NULL, user_agent TEXT, created_at INTEGER NOT NULL);`,
  },
];

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'elf.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function openMemoryDb(): Db {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

export function migrate(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const applied = new Set((db.prepare('SELECT id FROM migrations').all() as { id: number }[]).map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function getSetting<T>(db: Db, key: string): T | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function putSetting(db: Db, key: string, value: unknown) {
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
    key,
    JSON.stringify(value),
    Date.now(),
  );
}
