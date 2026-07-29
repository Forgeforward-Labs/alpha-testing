import type { CommandContext, Context } from 'grammy';
import { UserRepo, ExecutionRepo } from '../db/repos.js';

export async function handlePnl(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const user = UserRepo.findById(telegramId);

  if (!user) {
    await ctx.reply('Please use /start first.');
    return;
  }

  const stats = ExecutionRepo.getStats(telegramId);

  const sign = stats.netQuote >= 0 ? '+' : '';
  await ctx.reply(
    `*Session P&L*\n` +
    `• Total executions: ${stats.totalExecutions}\n` +
    `• Net quote (USDso): ${sign}${stats.netQuote.toFixed(4)}`,
    { parse_mode: 'Markdown' },
  );
}

export async function handleHistory(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const user = UserRepo.findById(telegramId);

  if (!user) {
    await ctx.reply('Please use /start first.');
    return;
  }

  const parts = ctx.message?.text?.split(' ').slice(1) ?? [];
  const limitArg = Number(parts[0]);
  const limit = !isNaN(limitArg) && limitArg > 0 ? Math.min(limitArg, 50) : 10;

  const rows = ExecutionRepo.findRecent(telegramId, limit);

  if (rows.length === 0) {
    await ctx.reply('No trade history yet.');
    return;
  }

  const lines = rows.map((row) => {
    const date = new Date(row.timestamp).toISOString().replace('T', ' ').slice(0, 19);
    const side = row.side.toUpperCase().padEnd(4);
    const amount = (row.filled_amount ?? row.requested_amount ?? '?').substring(0, 10);
    const price = row.execution_price ?? row.requested_price ?? '?';
    return `${date} ${side} ${amount} @ ${price}`;
  });

  await ctx.reply(`*Last ${rows.length} Trades:*\n\`\`\`\n${lines.join('\n')}\n\`\`\``, {
    parse_mode: 'Markdown',
  });
}
