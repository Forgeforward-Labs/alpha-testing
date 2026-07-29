import { db } from './database.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface UserRow {
  telegram_id: string;
  username: string | null;
  enc_key: string;
  address: string;
  created_at: number;
}

export interface UserConfigRow {
  telegram_id: string;
  symbol: string;
  strategy: string;
  execution_mode: string;
  order_amount: string;
  grid_trade_size_quote: number;
  grid_step_bps: number;
  grid_max_spread_bps: number;
  grid_max_long_quote: number;
  dry_run: number;
  updated_at: number;
}

export interface ExecutionRow {
  id: number;
  telegram_id: string;
  symbol: string;
  side: string;
  requested_price: string | null;
  requested_amount: string | null;
  filled_amount: string | null;
  execution_price: string | null;
  tx_hash: string | null;
  timestamp: number;
}

// ── UserRepo ───────────────────────────────────────────────────────────────────

export const UserRepo = {
  findById(telegramId: string): UserRow | undefined {
    return db
      .prepare<[string], UserRow>('SELECT * FROM users WHERE telegram_id = ?')
      .get(telegramId);
  },

  insert(row: UserRow): void {
    db.prepare(
      'INSERT INTO users (telegram_id, username, enc_key, address, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(row.telegram_id, row.username, row.enc_key, row.address, row.created_at);
  },

  updateUsername(telegramId: string, username: string | null): void {
    db.prepare('UPDATE users SET username = ? WHERE telegram_id = ?').run(username, telegramId);
  },
};

// ── ConfigRepo ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: Omit<UserConfigRow, 'telegram_id' | 'updated_at'> = {
  symbol: 'WETH:USDso',
  strategy: 'grid',
  execution_mode: 'http',
  order_amount: '5',
  grid_trade_size_quote: 5,
  grid_step_bps: 8,
  grid_max_spread_bps: 25,
  grid_max_long_quote: 60,
  dry_run: 0,
};

export const ConfigRepo = {
  findById(telegramId: string): UserConfigRow | undefined {
    return db
      .prepare<[string], UserConfigRow>('SELECT * FROM user_configs WHERE telegram_id = ?')
      .get(telegramId);
  },

  upsertDefault(telegramId: string): UserConfigRow {
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO user_configs
        (telegram_id, symbol, strategy, execution_mode, order_amount,
         grid_trade_size_quote, grid_step_bps, grid_max_spread_bps,
         grid_max_long_quote, dry_run, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      telegramId,
      DEFAULT_CONFIG.symbol,
      DEFAULT_CONFIG.strategy,
      DEFAULT_CONFIG.execution_mode,
      DEFAULT_CONFIG.order_amount,
      DEFAULT_CONFIG.grid_trade_size_quote,
      DEFAULT_CONFIG.grid_step_bps,
      DEFAULT_CONFIG.grid_max_spread_bps,
      DEFAULT_CONFIG.grid_max_long_quote,
      DEFAULT_CONFIG.dry_run,
      now,
    );
    return this.findById(telegramId)!;
  },

  updateField(telegramId: string, key: string, value: string | number): boolean {
    const allowed = new Set([
      'symbol',
      'strategy',
      'execution_mode',
      'order_amount',
      'grid_trade_size_quote',
      'grid_step_bps',
      'grid_max_spread_bps',
      'grid_max_long_quote',
      'dry_run',
    ]);
    if (!allowed.has(key)) return false;
    db.prepare(`UPDATE user_configs SET ${key} = ?, updated_at = ? WHERE telegram_id = ?`).run(
      value,
      Date.now(),
      telegramId,
    );
    return true;
  },
};

// ── ExecutionRepo ──────────────────────────────────────────────────────────────

export const ExecutionRepo = {
  insert(row: Omit<ExecutionRow, 'id'>): void {
    db.prepare(
      `INSERT INTO executions
        (telegram_id, symbol, side, requested_price, requested_amount,
         filled_amount, execution_price, tx_hash, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.telegram_id,
      row.symbol,
      row.side,
      row.requested_price,
      row.requested_amount,
      row.filled_amount,
      row.execution_price,
      row.tx_hash,
      row.timestamp,
    );
  },

  findRecent(telegramId: string, limit = 10): ExecutionRow[] {
    return db
      .prepare<[string, number], ExecutionRow>(
        'SELECT * FROM executions WHERE telegram_id = ? ORDER BY timestamp DESC LIMIT ?',
      )
      .all(telegramId, limit);
  },

  getStats(telegramId: string): { totalExecutions: number; netQuote: number } {
    const rows = db
      .prepare<[string], ExecutionRow>('SELECT * FROM executions WHERE telegram_id = ?')
      .all(telegramId);

    let netQuote = 0;
    for (const row of rows) {
      const filled = Number(row.filled_amount ?? 0);
      const price = Number(row.execution_price ?? 0);
      const notional = filled * price;
      if (row.side === 'buy') netQuote -= notional;
      else netQuote += notional;
    }

    return { totalExecutions: rows.length, netQuote };
  },
};
