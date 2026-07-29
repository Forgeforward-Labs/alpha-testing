import { Wallet } from 'ethers';
import type { CommandContext, Context } from 'grammy';
import { DreamDexHttpClient } from '@trading/sdk';
import { globalConfig } from '../config.js';
import { UserRepo, ConfigRepo } from '../db/repos.js';

// listMarkets is a public endpoint; a dummy key satisfies the constructor without auth
const DUMMY_KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';

/** Fetch markets using a temporary HTTP client (no auth needed for listMarkets). */
async function fetchMarkets() {
  const http = new DreamDexHttpClient(
    globalConfig.baseUrl,
    new Wallet(DUMMY_KEY),
    globalConfig.chainId,
    globalConfig.siweDomain,
    globalConfig.siweUri,
  );
  return http.listMarkets();
}

export async function handlePairs(ctx: CommandContext<Context>): Promise<void> {
  await ctx.reply('Fetching available markets...');

  try {
    const markets = await fetchMarkets();

    const cfg = ConfigRepo.findById(String(ctx.from?.id));
    const current = cfg?.symbol ?? 'none';

    const lines = markets.map((m) => {
      const marker = m.symbol === current ? ' ◀ current' : '';
      return `• ${m.symbol}  (tick=${m.tickSize}, lot=${m.lotSize})${marker}`;
    });

    await ctx.reply(
      `*Available trading pairs:*\n${lines.join('\n')}\n\n` +
      `Use /pair <symbol> to switch, e.g. /pair SOMI:USDso`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await ctx.reply(`Failed to fetch markets: ${String(err)}`);
  }
}

export async function handlePair(ctx: CommandContext<Context>): Promise<void> {
  const telegramId = String(ctx.from?.id);

  if (!UserRepo.findById(telegramId)) {
    await ctx.reply('Please use /start first.');
    return;
  }

  const symbol = ctx.message?.text?.split(' ')[1]?.trim().toUpperCase();
  if (!symbol) {
    await ctx.reply('Usage: /pair <symbol>\nExample: /pair SOMI:USDso\n\nSee /pairs for the full list.');
    return;
  }

  // Validate against live markets
  try {
    const markets = await fetchMarkets();
    const match = markets.find((m) => m.symbol.toUpperCase() === symbol);
    if (!match) {
      const available = markets.map((m) => m.symbol).join(', ');
      await ctx.reply(`Unknown pair: ${symbol}\nAvailable: ${available}`);
      return;
    }

    ConfigRepo.upsertDefault(telegramId);
    ConfigRepo.updateField(telegramId, 'symbol', match.symbol);

    await ctx.reply(
      `Switched to *${match.symbol}*\n` +
      `Tick size: ${match.tickSize} | Lot size: ${match.lotSize}\n\n` +
      `Restart the bot with /startbot to trade this pair.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    await ctx.reply(`Failed to switch pair: ${String(err)}`);
  }
}
