import { formatUnits } from 'ethers';
import type { CommandContext, Context } from 'grammy';
import { TransactionExecutor } from '@trading/sdk';
import { DreamDexHttpClient } from '@trading/sdk';
import { Wallet } from 'ethers';
import { UserRepo } from '../db/repos.js';
import { decrypt } from '../crypto.js';
import { globalConfig } from '../config.js';

export async function handleWallet(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = String(ctx.from?.id);
  const user = UserRepo.findById(telegramId);

  if (!user) {
    await ctx.reply('Please use /start first to create your wallet.');
    return;
  }

  await ctx.reply('Fetching balances...');

  try {
    const privateKey = decrypt(user.enc_key);
    const wallet = new Wallet(privateKey);
    const executor = new TransactionExecutor(
      globalConfig.rpcUrl,
      privateKey,
      globalConfig.chainId,
    );
    const http = new DreamDexHttpClient(
      globalConfig.baseUrl,
      wallet,
      globalConfig.chainId,
      globalConfig.siweDomain,
      globalConfig.siweUri,
    );

    // Get SOMI (native) balance
    const nativeRaw = await executor.getNativeBalance();
    const somiBalance = Number(formatUnits(nativeRaw, 18)).toFixed(6);

    // Try to fetch markets for USDso address
    let usdsoBalance = 'N/A';
    try {
      const markets = await http.listMarkets();
      const market = markets.find((m) => m.symbol.endsWith(':USDso'));
      if (market) {
        const quoteRaw = await executor.getErc20Balance(market.quote);
        usdsoBalance = Number(formatUnits(quoteRaw, market.quoteDecimals)).toFixed(4);
      }
    } catch {
      // Best-effort
    }

    await ctx.reply(
      `*Wallet Address:*\n\`${user.address}\`\n\n` +
      `*Balances:*\n` +
      `• SOMI: ${somiBalance}\n` +
      `• USDso: ${usdsoBalance}`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await ctx.reply(`Failed to fetch balances: ${String(err)}`);
  }
}
