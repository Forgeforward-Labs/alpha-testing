import { Wallet } from 'ethers';
import type { CommandContext, Context } from 'grammy';
import { encrypt } from '../crypto.js';
import { UserRepo, ConfigRepo } from '../db/repos.js';

export async function handleStart(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const username = ctx.from?.username ?? null;

  if (!telegramId) {
    await ctx.reply('Could not identify your Telegram account.');
    return;
  }

  const existing = UserRepo.findById(telegramId);
  if (existing) {
    await ctx.reply(
      `Welcome back! Your wallet address is:\n\`${existing.address}\``,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // Generate new wallet
  const newWallet = Wallet.createRandom();
  const encKey = encrypt(newWallet.privateKey);

  UserRepo.insert({
    telegram_id: telegramId,
    username,
    enc_key: encKey,
    address: newWallet.address,
    created_at: Date.now(),
  });

  ConfigRepo.upsertDefault(telegramId);

  await ctx.reply(
    `Welcome to the DreamDEX Trading Bot!\n\n` +
    `A new wallet has been generated for you:\n\`${newWallet.address}\`\n\n` +
    `*Important:* Fund this address with SOMI (for gas) and your desired quote token before starting the bot.\n\n` +
    `Use /wallet to check balances, /config to review settings, and /startbot to begin trading.`,
    { parse_mode: 'Markdown' },
  );
}
