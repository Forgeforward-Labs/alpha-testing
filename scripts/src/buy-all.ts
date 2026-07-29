import 'dotenv/config';
import { Wallet, formatUnits } from 'ethers';
import { config } from './config.js';
import { DreamDexHttpClient } from '@trading/sdk';
import type { MarketInfo, PrepareOrderRequest } from '@trading/sdk';
import { HttpOrderExecutor, TransactionExecutor, VaultManager } from '@trading/sdk';
import { adjustPriceByBps, alignToStep } from '@trading/sdk';

// Buy the base token using the entire wallet quote token balance.
// Usage: npx tsx src/buy-all.ts
// Override market: DREAMDEX_BUY_SYMBOL=WETH:USDso npx tsx src/buy-all.ts

function getSymbol(): string {
  return process.env.DREAMDEX_BUY_SYMBOL ?? config.symbol;
}

function getSlippageBps(): number {
  const bps = Number(process.env.DREAMDEX_BUY_SLIPPAGE_BPS ?? '25');
  if (Number.isNaN(bps) || bps < 0) {
    throw new Error('DREAMDEX_BUY_SLIPPAGE_BPS must be a non-negative number');
  }
  return bps;
}

function shouldAutoWithdraw(): boolean {
  return (process.env.DREAMDEX_BUY_AUTO_WITHDRAW ?? 'true') === 'true';
}

function resolvePrice(market: MarketInfo, bestAsk: string | undefined): string {
  const override = process.env.DREAMDEX_BUY_PRICE;
  if (override) return alignToStep(override, market.tickSize);

  if (!bestAsk) {
    throw new Error(
      'No ask price in the order book and no DREAMDEX_BUY_PRICE override was provided.',
    );
  }

  const adjusted = adjustPriceByBps(bestAsk, getSlippageBps(), 'up');
  return alignToStep(adjusted, market.tickSize);
}

async function main(): Promise<void> {
  const symbol = getSymbol();
  const wallet = new Wallet(config.privateKey);
  const http = new DreamDexHttpClient(
    config.baseUrl,
    wallet,
    config.chainId,
    config.siweDomain,
    config.siweUri,
  );
  const executor = new TransactionExecutor(
    config.rpcUrl,
    config.privateKey,
    config.chainId,
  );
  const httpExecutor = new HttpOrderExecutor(http, executor);

  await executor.assertConnectedChain();

  const markets = await http.listMarkets();
  const market = markets.find((m) => m.symbol === symbol);
  if (!market) throw new Error(`Market not found: ${symbol}`);

  const [baseName, quoteName] = market.symbol.split(':') as [string, string];
  const isNativeBase = market.symbol.startsWith('SOMI:');

  const orderBook = await http.getOrderBook(symbol, 5);
  const bestBid = orderBook?.bids[0]?.price;
  const bestAsk = orderBook?.asks[0]?.price;
  const price = resolvePrice(market, bestAsk);

  const quoteBalanceRaw = await executor.getErc20Balance(market.quote);
  const quoteBalance = formatUnits(quoteBalanceRaw, market.quoteDecimals);

  console.log(`[buy-all] Symbol       = ${market.symbol}`);
  console.log(`[buy-all] Wallet       = ${config.walletAddress}`);
  console.log(`[buy-all] ${quoteName} balance = ${quoteBalance}`);
  if (bestBid || bestAsk) {
    console.log(
      `[buy-all] Book best bid=${bestBid ?? 'n/a'} best ask=${bestAsk ?? 'n/a'}`,
    );
  }
  console.log(`[buy-all] Buy price    = ${price} (slippage=${getSlippageBps()}bps)`);

  if (quoteBalanceRaw === 0n) {
    console.log(`[buy-all] No ${quoteName} balance to spend — nothing to do.`);
    return;
  }

  const baseAmount = alignToStep(
    (Number(quoteBalance) / Number(price)).toString(),
    market.lotSize,
  );

  if (Number(baseAmount) < Number(market.minQuantity)) {
    throw new Error(
      `Computed buy amount ${baseAmount} ${baseName} is below market minimum ${market.minQuantity}`,
    );
  }

  console.log(
    `[buy-all] Buying ${baseAmount} ${baseName} for up to ${quoteBalance} ${quoteName}`,
  );

  const request: PrepareOrderRequest = {
    walletAddress: config.walletAddress,
    type: 'limit',
    side: 'buy',
    amount: baseAmount,
    price,
    fundingSource: config.fundingSource,
    orderType: config.orderType,
    selfMatchingOption: config.selfMatchingOption,
  };

  if (config.dryRun) {
    console.log(
      '[dry-run] Skipping order execution. Set DREAMDEX_DRY_RUN=false to send.',
    );
    return;
  }

  const result = await httpExecutor.executeOrder(market, request);
  if (result.approvalTxHash) {
    console.log(`[buy-all] Approval tx: ${result.approvalTxHash}`);
  }
  console.log(`[buy-all] Buy tx: ${result.txHash}`);

  if (shouldAutoWithdraw()) {
    console.log('[buy-all] Withdrawing filled balance from vault to wallet...');
    const vault = new VaultManager(executor, market.contract);
    await vault.withdrawAll(market);
  }

  const [baseAfterRaw, quoteAfterRaw] = await Promise.all([
    isNativeBase
      ? executor.getNativeBalance()
      : executor.getErc20Balance(market.base),
    executor.getErc20Balance(market.quote),
  ]);
  console.log(
    `[buy-all] ${baseName} balance after  = ${formatUnits(baseAfterRaw, market.baseDecimals)}`,
  );
  console.log(
    `[buy-all] ${quoteName} balance after = ${formatUnits(quoteAfterRaw, market.quoteDecimals)}`,
  );

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
