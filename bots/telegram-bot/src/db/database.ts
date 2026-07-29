import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { globalConfig } from '../config.js';

const DB_PATH = path.join(globalConfig.persistenceDir, 'telegram-bot.db');

mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db: DatabaseType = new Database(DB_PATH);

// Enable WAL for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id TEXT PRIMARY KEY,
    username    TEXT,
    enc_key     TEXT NOT NULL,
    address     TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_configs (
    telegram_id           TEXT PRIMARY KEY,
    symbol                TEXT    DEFAULT 'WETH:USDso',
    strategy              TEXT    DEFAULT 'grid',
    execution_mode        TEXT    DEFAULT 'http',
    order_amount          TEXT    DEFAULT '5',
    grid_trade_size_quote REAL    DEFAULT 5,
    grid_step_bps         INTEGER DEFAULT 8,
    grid_max_spread_bps   INTEGER DEFAULT 25,
    grid_max_long_quote   REAL    DEFAULT 60,
    dry_run               INTEGER DEFAULT 0,
    updated_at            INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS executions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id      TEXT    NOT NULL,
    symbol           TEXT    NOT NULL,
    side             TEXT    NOT NULL,
    requested_price  TEXT,
    requested_amount TEXT,
    filled_amount    TEXT,
    execution_price  TEXT,
    tx_hash          TEXT,
    timestamp        INTEGER NOT NULL
  );
`);

console.log(`[db] Database opened at ${DB_PATH}`);
