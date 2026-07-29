import type { CommandContext, Context } from 'grammy';
import type { BotInstanceManager } from '../runner/manager.js';
import { UserRepo } from '../db/repos.js';

export function makePositions(manager: BotInstanceManager) {
  return async function handlePositions(ctx: CommandContext<Context>): Promise<void> {
    const telegramId = String(ctx.from?.id);

    if (!UserRepo.findById(telegramId)) {
      await ctx.reply('Please use /start first.');
      return;
    }

    const runner = manager.get(telegramId);
    if (!runner?.isRunning) {
      await ctx.reply('Bot is not running. Start it with /startbot to track positions.');
      return;
    }

    const pos = runner.getPositionData();
    const mid = runner.getMidPrice();
    const [base, quote] = pos.symbol.split(':');

    if (pos.strategyName !== 'grid') {
      // Non-grid strategies don't track lots — show generic status
      await ctx.reply(
        `*Positions (${pos.strategyName})*\n` +
        `Strategy does not track individual lots.\n` +
        `Use /status for current state.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }

    const totalBase = pos.lots.reduce((s, l) => s + l.amount, 0);
    const totalBaseValue = mid ? totalBase * mid : undefined;

    let lotLines = '';
    if (pos.lots.length === 0) {
      lotLines = '_No open lots_';
    } else {
      lotLines = pos.lots
        .map((lot, i) => {
          const value = mid ? ` (~${(lot.amount * mid).toFixed(2)} ${quote})` : '';
          const pnl =
            mid !== undefined
              ? mid > lot.price
                ? ` +${((mid / lot.price - 1) * 100).toFixed(2)}%`
                : ` ${((mid / lot.price - 1) * 100).toFixed(2)}%`
              : '';
          return `  ${i + 1}. ${lot.amount.toFixed(6)} ${base} @ ${lot.price.toFixed(6)}${value}${pnl}`;
        })
        .join('\n');
    }

    const equityLine =
      pos.markedEquityQuote !== undefined
        ? `\n• Marked equity: ${pos.markedEquityQuote.toFixed(4)} ${quote}`
        : '';

    const valueLine =
      totalBaseValue !== undefined
        ? `\n• Open lot value: ${totalBaseValue.toFixed(4)} ${quote}`
        : '';

    await ctx.reply(
      `*Positions — ${pos.symbol} (grid)*\n\n` +
      `*Open lots (${pos.lots.length}):*\n${lotLines}\n\n` +
      `*Balances:*\n` +
      `• Tradable ${base}: ${totalBase.toFixed(6)}${valueLine}\n` +
      `• Reserved ${base} (gas): ${pos.reservedBaseBalance.toFixed(6)}\n` +
      `• ${quote} balance: ${pos.quoteBalance.toFixed(4)}${equityLine}\n\n` +
      `*Reference price:* ${pos.referencePrice?.toFixed(6) ?? 'n/a'}\n` +
      `*Mid price:* ${mid?.toFixed(6) ?? 'n/a'}\n` +
      `*Trades this session:* ${pos.tradeCount}`,
      { parse_mode: 'Markdown' },
    );
  };
}
