import type { CommandContext, Context } from 'grammy';
import type { BotInstanceManager } from '../runner/manager.js';
import { UserRepo, ConfigRepo } from '../db/repos.js';
import { decrypt } from '../crypto.js';
import type { StrategyMode } from '../runner/types.js';

const VALID_STRATEGIES: StrategyMode[] = ['grid', 'marketMaker', 'minuteRebalance', 'threshold'];

export function makeStartBot(manager: BotInstanceManager) {
  return async function handleStartBot(ctx: CommandContext<Context>): Promise<void> {
    const telegramId = String(ctx.from?.id);
    const user = UserRepo.findById(telegramId);

    if (!user) {
      await ctx.reply('Please use /start first.');
      return;
    }

    if (manager.isRunning(telegramId)) {
      await ctx.reply('Bot is already running. Use /stopbot to stop it first.');
      return;
    }

    const cfg = ConfigRepo.findById(telegramId) ?? ConfigRepo.upsertDefault(telegramId);

    // Allow overriding strategy via command arg: /startbot grid
    const arg = ctx.message?.text?.split(' ')[1]?.trim() as StrategyMode | undefined;
    const strategy: StrategyMode =
      arg && VALID_STRATEGIES.includes(arg) ? arg : (cfg.strategy as StrategyMode);

    await ctx.reply(`Starting ${strategy} bot on ${cfg.symbol}...`);

    try {
      const privateKey = decrypt(user.enc_key);
      await manager.start({
        telegramId,
        privateKey,
        walletAddress: user.address,
        symbol: cfg.symbol,
        strategy,
        executionMode: cfg.execution_mode as 'http' | 'contract',
        orderAmount: cfg.order_amount,
        gridTradeSizeQuote: cfg.grid_trade_size_quote,
        gridStepBps: cfg.grid_step_bps,
        gridMaxSpreadBps: cfg.grid_max_spread_bps,
        gridMaxLongQuote: cfg.grid_max_long_quote,
        dryRun: cfg.dry_run === 1,
        persistenceDir: '',  // manager overrides this
      });

      const dryRunNote = cfg.dry_run === 1 ? ' (dry-run mode — no real orders)' : '';
      await ctx.reply(
        `Bot started!${dryRunNote}\nStrategy: ${strategy}\nMarket: ${cfg.symbol}\n\nUse /status to check progress.`,
      );
    } catch (err) {
      await ctx.reply(`Failed to start bot: ${String(err)}`);
    }
  };
}

export function makeStopBot(manager: BotInstanceManager) {
  return async function handleStopBot(ctx: CommandContext<Context>): Promise<void> {
    const telegramId = String(ctx.from?.id);

    if (!manager.isRunning(telegramId)) {
      await ctx.reply('No bot is running.');
      return;
    }

    await ctx.reply('Stopping bot and saving state...');

    try {
      await manager.stop(telegramId);
      await ctx.reply('Bot stopped successfully.');
    } catch (err) {
      await ctx.reply(`Failed to stop bot: ${String(err)}`);
    }
  };
}

export function makeStatus(manager: BotInstanceManager) {
  return async function handleStatus(ctx: CommandContext<Context>): Promise<void> {
    const telegramId = String(ctx.from?.id);
    const user = UserRepo.findById(telegramId);

    if (!user) {
      await ctx.reply('Please use /start first.');
      return;
    }

    const runner = manager.get(telegramId);
    const isRunning = runner?.isRunning ?? false;
    const cfg = ConfigRepo.findById(telegramId);

    if (!isRunning) {
      await ctx.reply(
        `*Bot Status:* Stopped\n` +
        `*Strategy:* ${cfg?.strategy ?? 'grid'}\n` +
        `*Market:* ${cfg?.symbol ?? 'N/A'}`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const statusLine = runner!.getStatusLine();
    const market = runner!.getMarket();

    await ctx.reply(
      `*Bot Status:* Running\n` +
      `*Strategy:* ${cfg?.strategy ?? 'N/A'}\n` +
      `*Market:* ${market?.symbol ?? 'N/A'}\n` +
      `*Status:* ${statusLine}`,
      { parse_mode: 'Markdown' },
    );
  };
}
