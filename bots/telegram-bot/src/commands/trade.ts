import type { CommandContext, Context } from 'grammy';
import type { BotInstanceManager } from '../runner/manager.js';
import { UserRepo } from '../db/repos.js';
import { ExecutionRepo } from '../db/repos.js';

function makeTrade(side: 'buy' | 'sell', manager: BotInstanceManager) {
  return async function handleTrade(ctx: CommandContext<Context>): Promise<void> {
    const telegramId = String(ctx.from?.id);
    const user = UserRepo.findById(telegramId);

    if (!user) {
      await ctx.reply('Please use /start first.');
      return;
    }

    const runner = manager.get(telegramId);
    if (!runner?.isRunning) {
      await ctx.reply('Bot is not running. Start it with /startbot first.');
      return;
    }

    const parts = ctx.message?.text?.split(' ').slice(1) ?? [];
    const amount = parts[0];
    const price = parts[1];

    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      await ctx.reply(`Usage: /${side} <amount> [price]\nExample: /${side} 10 0.05`);
      return;
    }

    await ctx.reply(`Submitting ${side} order for ${amount}...`);

    try {
      const txHash = await runner.executeManualOrder(side, amount, price);
      const market = runner.getMarket();

      // Record execution
      ExecutionRepo.insert({
        telegram_id: telegramId,
        symbol: market?.symbol ?? 'unknown',
        side,
        requested_price: price ?? null,
        requested_amount: amount,
        filled_amount: amount,
        execution_price: price ?? null,
        tx_hash: txHash,
        timestamp: Date.now(),
      });

      await ctx.reply(`Order submitted!\nTx: \`${txHash}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      await ctx.reply(`Order failed: ${String(err)}`);
    }
  };
}

export function makeBuy(manager: BotInstanceManager) {
  return makeTrade('buy', manager);
}

export function makeSell(manager: BotInstanceManager) {
  return makeTrade('sell', manager);
}
