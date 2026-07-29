import type { CommandContext, Context } from 'grammy';
import { UserRepo, ConfigRepo } from '../db/repos.js';

// Maps user-facing key names to DB column names
const KEY_MAP: Record<string, string> = {
  symbol: 'symbol',
  strategy: 'strategy',
  execution_mode: 'execution_mode',
  order_amount: 'order_amount',
  grid_trade_size_quote: 'grid_trade_size_quote',
  grid_step_bps: 'grid_step_bps',
  grid_max_spread_bps: 'grid_max_spread_bps',
  grid_max_long_quote: 'grid_max_long_quote',
  dry_run: 'dry_run',
  dryRun: 'dry_run',
  gridTradeSizeQuote: 'grid_trade_size_quote',
  gridStepBps: 'grid_step_bps',
  gridMaxSpreadBps: 'grid_max_spread_bps',
  gridMaxLongQuote: 'grid_max_long_quote',
  executionMode: 'execution_mode',
  orderAmount: 'order_amount',
};

const NUMERIC_KEYS = new Set([
  'grid_trade_size_quote',
  'grid_step_bps',
  'grid_max_spread_bps',
  'grid_max_long_quote',
  'dry_run',
]);

export async function handleConfig(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const user = UserRepo.findById(telegramId);

  if (!user) {
    await ctx.reply('Please use /start first.');
    return;
  }

  const cfg = ConfigRepo.findById(telegramId) ?? ConfigRepo.upsertDefault(telegramId);
  const parts = ctx.message?.text?.split(' ').slice(1) ?? [];

  // /config with no args → show current config
  if (parts.length === 0) {
    const dryRunLabel = cfg.dry_run === 1 ? 'true' : 'false';
    await ctx.reply(
      `*Current Configuration:*\n` +
      `• symbol: ${cfg.symbol}\n` +
      `• strategy: ${cfg.strategy}\n` +
      `• execution\\_mode: ${cfg.execution_mode}\n` +
      `• order\\_amount: ${cfg.order_amount}\n` +
      `• grid\\_trade\\_size\\_quote: ${cfg.grid_trade_size_quote}\n` +
      `• grid\\_step\\_bps: ${cfg.grid_step_bps}\n` +
      `• grid\\_max\\_spread\\_bps: ${cfg.grid_max_spread_bps}\n` +
      `• grid\\_max\\_long\\_quote: ${cfg.grid_max_long_quote}\n` +
      `• dry\\_run: ${dryRunLabel}`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // /config <key> <value>
  const [rawKey, ...valueParts] = parts;
  const value = valueParts.join(' ');

  if (!value) {
    await ctx.reply('Usage: /config <key> <value>\nExample: /config symbol SOMI:USDso');
    return;
  }

  const dbKey = KEY_MAP[rawKey];
  if (!dbKey) {
    await ctx.reply(`Unknown config key: ${rawKey}\nValid keys: ${Object.keys(KEY_MAP).join(', ')}`);
    return;
  }

  let storedValue: string | number = value;
  if (NUMERIC_KEYS.has(dbKey)) {
    // Handle boolean-like dry_run
    if (dbKey === 'dry_run') {
      storedValue = value === 'true' || value === '1' ? 1 : 0;
    } else {
      storedValue = Number(value);
      if (isNaN(storedValue)) {
        await ctx.reply(`Value for ${rawKey} must be a number.`);
        return;
      }
    }
  }

  const ok = ConfigRepo.updateField(telegramId, dbKey, storedValue);
  if (!ok) {
    await ctx.reply(`Failed to update ${rawKey}.`);
    return;
  }

  await ctx.reply(`Updated ${rawKey} = ${value}`);
}
