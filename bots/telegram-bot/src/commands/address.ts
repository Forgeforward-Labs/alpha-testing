import type { CommandContext, Context } from 'grammy';
import { UserRepo } from '../db/repos.js';

export async function handleAddress(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const user = UserRepo.findById(telegramId);

  if (!user) {
    await ctx.reply('Please use /start first to create your wallet.');
    return;
  }

  await ctx.reply(
    `*Your deposit address:*\n\`${user.address}\`\n\n` +
    `Send SOMI (for gas) and your trading token (USDso, WETH, etc.) to this address before starting the bot.`,
    { parse_mode: 'Markdown' },
  );
}
