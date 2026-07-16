import 'dotenv/config';
import { MaxUint256, Wallet, parseUnits, formatUnits } from 'ethers';
import { config } from './config.js';
import { DreamDexHttpClient } from '@trading/sdk';
import type {
  MarketInfo,
  PrepareOrderRequest,
  Side,
  OrderBook,
} from '@trading/sdk';
import { HttpOrderExecutor } from '@trading/sdk';
import { TransactionExecutor } from '@trading/sdk';
import { adjustPriceByBps, alignToStep } from '@trading/sdk';

const SWAP_AMOUNT_QUOTE = Number(
  process.env.DREAMDEX_SWAP_AMOUNT_QUOTE ?? '100',
);
const SLIPPAGE_BPS = Number(process.env.DREAMDEX_SWAP_SLIPPAGE_BPS ?? '5');
const CYCLE_MS = Number(process.env.DREAMDEX_SWAP_CYCLE_MS ?? '15000');
const GAS_RESERVE = Number(process.env.DREAMDEX_GAS_RESERVE ?? '0.02');

// Markets to compete on — tweak via env if needed.
const SYMBOLS = (process.env.DREAMDEX_SYMBOLS ?? 'WETH:USDso,WBTC:USDso')
  .split(',')
  .map((s) => s.trim());

let running = true;
process.on('SIGINT', () => {
  console.log('\n[swap] Stopping after current cycle...');
  running = false;
});
process.on('SIGTERM', () => {
  running = false;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Score a book: higher = better to trade on (tighter spread, more depth).
function bookScore(book: OrderBook | null | undefined): number {
  if (!book?.bids[0] || !book?.asks[0]) return -Infinity;
  const bid = Number(book.bids[0].price);
  const ask = Number(book.asks[0].price);
  const spread = ((ask - bid) / bid) * 10_000; // bps
  const depth = Math.min(
    Number(book.bids[0].quantity),
    Number(book.asks[0].quantity),
  );
  if (spread <= 0) return -Infinity;
  return depth / spread; // more depth per bps of spread = better
}

async function approveAll(
  signer: TransactionExecutor,
  markets: MarketInfo[],
): Promise<void> {
  console.log('[swap] Checking token approvals...');
  const seen = new Set<string>();
  for (const m of markets) {
    const isNative = m.symbol.startsWith('SOMI:');
    for (const token of isNative ? [m.quote] : [m.quote, m.base]) {
      if (seen.has(token)) continue;
      seen.add(token);
      const hash = await signer.ensureErc20Allowance(
        token,
        m.contract,
        MaxUint256,
      );
      console.log(
        hash
          ? `[swap] Approved ${token}  tx=${hash}`
          : `[swap] ${token} already approved`,
      );
    }
  }
}

async function placeSide(
  side: Side,
  market: MarketInfo,
  bestBid: string | undefined,
  bestAsk: string | undefined,
  executor: HttpOrderExecutor,
  signer: TransactionExecutor,
  fixedBaseAmount?: string,
  effectiveQuoteAmount?: number,
): Promise<string | undefined> {
  const reference = side === 'buy' ? bestAsk : bestBid;
  if (!reference) {
    console.log(
      `[swap] No ${side === 'buy' ? 'ask' : 'bid'} in book — skipping ${side}`,
    );
    return undefined;
  }

  const price = alignToStep(
    adjustPriceByBps(reference, SLIPPAGE_BPS, side === 'buy' ? 'up' : 'down'),
    market.tickSize,
  );

  const quoteToUse = effectiveQuoteAmount ?? SWAP_AMOUNT_QUOTE;
  const baseAmount =
    fixedBaseAmount ??
    alignToStep((quoteToUse / Number(price)).toString(), market.lotSize);

  if (Number(baseAmount) < Number(market.minQuantity)) {
    console.log(
      `[swap] Computed amount ${baseAmount} < min ${market.minQuantity} — skipping ${side}`,
    );
    return undefined;
  }

  const request: PrepareOrderRequest = {
    walletAddress: config.walletAddress,
    type: 'limit',
    side,
    amount: baseAmount,
    price,
    fundingSource: config.fundingSource,
    orderType: 'immediateOrCancel',
    selfMatchingOption: config.selfMatchingOption,
  };

  console.log(
    `[swap] ${side.toUpperCase()} ${baseAmount} ${market.symbol} @ ${price}` +
      ` (${side === 'buy' ? 'ask' : 'bid'}=${reference}, slippage=${SLIPPAGE_BPS}bps)`,
  );

  if (config.dryRun) {
    console.log('[swap] Dry-run — skipping send');
    return baseAmount;
  }

  if (side === 'sell') {
    const hash = await signer.ensureErc20Allowance(
      market.base,
      market.contract,
      parseUnits(baseAmount, market.baseDecimals),
    );
    if (hash) console.log(`[swap] Base approval tx: ${hash}`);
  }

  try {
    const result = await executor.executeOrder(market, request);
    if (result.approvalTxHash)
      console.log(`[swap] Approval tx: ${result.approvalTxHash}`);
    console.log(`[swap] ${side.toUpperCase()} tx: ${result.txHash}`);
    return baseAmount;
  } catch (err) {
    console.error(
      `[swap] ${side.toUpperCase()} failed:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

async function main(): Promise<void> {
  const wallet = new Wallet(config.privateKey);
  const http = new DreamDexHttpClient(
    config.baseUrl,
    wallet,
    config.chainId,
    config.siweDomain,
    config.siweUri,
  );
  const signer = new TransactionExecutor(
    config.rpcUrl,
    config.privateKey,
    config.chainId,
  );
  const executor = new HttpOrderExecutor(http, signer);

  await signer.assertConnectedChain();

  const allMarkets = await http.listMarkets();
  const markets = SYMBOLS.map((s) => {
    const m = allMarkets.find((m) => m.symbol === s);
    if (!m) throw new Error(`Market not found: ${s}`);
    return m;
  });

  if (!config.dryRun) await approveAll(signer, markets);

  console.log(`[swap] Markets    : ${markets.map((m) => m.symbol).join(', ')}`);
  console.log(`[swap] Amount     : $${SWAP_AMOUNT_QUOTE} quote per cycle`);
  console.log(`[swap] Slippage   : ${SLIPPAGE_BPS}bps`);
  console.log(`[swap] Cycle      : ${CYCLE_MS / 1000}s`);
  console.log(`[swap] Dry-run    : ${config.dryRun}`);

  let cycle = 0;

  while (running) {
    const cycleStart = Date.now();
    cycle++;
    console.log(`\n[swap] ─── Cycle ${cycle} ───`);

    // Fetch all books in parallel.
    const books = await Promise.all(
      markets.map((m) => http.getOrderBook(m.symbol, 3)),
    );

    // Check base balances for all markets to detect lingering inventory.
    const baseBalances = await Promise.all(
      markets.map(async (m) => {
        const raw = m.symbol.startsWith('SOMI:')
          ? await signer.getNativeBalance()
          : await signer.getErc20Balance(m.base);
        return Number(formatUnits(raw, m.baseDecimals));
      }),
    );

    const quoteRaw = await signer.getErc20Balance(markets[0]!.quote);
    const quoteBalance = Number(
      formatUnits(quoteRaw, markets[0]!.quoteDecimals),
    );

    // If holding base from a previous cycle, stay on that market to close the position.
    let marketIdx = -1;
    for (let i = 0; i < markets.length; i++) {
      if (baseBalances[i]! >= Number(markets[i]!.minQuantity)) {
        marketIdx = i;
        console.log(
          `[swap] Holding ${baseBalances[i]!.toFixed(6)} ${markets[i]!.symbol.split(':')[0]} — staying on ${markets[i]!.symbol}`,
        );
        break;
      }
    }

    // No lingering inventory: pick the market with the best book.
    if (marketIdx === -1) {
      const scores = books.map((b, i) => ({
        i,
        score: bookScore(b),
        sym: markets[i]!.symbol,
      }));
      scores.sort((a, b) => b.score - a.score);
      marketIdx = scores[0]!.i;
      console.log(
        `[swap] Book scores: ${scores.map((s) => `${s.sym}=${s.score === -Infinity ? 'no book' : s.score.toFixed(2)}`).join('  ')}` +
          `  → selected ${markets[marketIdx]!.symbol}`,
      );
    }

    const market = markets[marketIdx]!;
    const book = books[marketIdx]!;
    const baseBalance = baseBalances[marketIdx]!;
    const isNativeSomi = market.symbol.startsWith('SOMI:');
    const tradableBase = isNativeSomi
      ? Math.max(0, baseBalance - GAS_RESERVE)
      : baseBalance;
    let effectiveQuote = Math.min(SWAP_AMOUNT_QUOTE, quoteBalance);

    let bestBid = book?.bids[0]?.price;
    let bestAsk = book?.asks[0]?.price;

    const minQty = Number(market.minQuantity);
    const canBuy = bestAsk ? effectiveQuote / Number(bestAsk) >= minQty : false;
    const canSell = tradableBase >= minQty;

    console.log(
      `[swap] ${market.symbol}  base=${baseBalance.toFixed(6)}  quote=$${quoteBalance.toFixed(4)}` +
        `  canBuy=${canBuy}  canSell=${canSell}`,
    );

    if (!canBuy && !canSell) {
      console.log('[swap] Insufficient balance on both sides — skipping cycle');
    } else {
      // Sell first if no quote to buy.
      if (!canBuy && canSell) {
        const sellQty = alignToStep(tradableBase.toString(), market.lotSize);
        if (Number(sellQty) >= minQty) {
          console.log(
            `[swap] Quote low — selling ${sellQty} ${market.symbol.split(':')[0]} to recover`,
          );
          await placeSide(
            'sell',
            market,
            bestBid,
            bestAsk,
            executor,
            signer,
            sellQty,
          );
          if (!running) break;
          const [freshBook, freshQuoteRaw] = await Promise.all([
            http.getOrderBook(market.symbol, 3),
            signer.getErc20Balance(market.quote),
          ]);
          bestBid = freshBook?.bids[0]?.price ?? bestBid;
          bestAsk = freshBook?.asks[0]?.price ?? bestAsk;
          effectiveQuote = Math.min(
            SWAP_AMOUNT_QUOTE,
            Number(formatUnits(freshQuoteRaw, market.quoteDecimals)),
          );
        }
      }

      // Buy leg.
      const canBuyNow = bestAsk
        ? effectiveQuote / Number(bestAsk) >= minQty
        : false;
      if (!canBuyNow) {
        console.log(
          `[swap] Insufficient quote ($${effectiveQuote.toFixed(4)}) — skipping buy`,
        );
      } else {
        const boughtAmount = await placeSide(
          'buy',
          market,
          bestBid,
          bestAsk,
          executor,
          signer,
          undefined,
          effectiveQuote,
        );
        if (running && boughtAmount) {
          const baseNowRaw = isNativeSomi
            ? await signer.getNativeBalance()
            : await signer.getErc20Balance(market.base);
          const baseNow = Number(formatUnits(baseNowRaw, market.baseDecimals));
          const tradableNow = isNativeSomi
            ? Math.max(0, baseNow - GAS_RESERVE)
            : baseNow;
          const sellQty = alignToStep(tradableNow.toString(), market.lotSize);

          if (Number(sellQty) < minQty) {
            console.log(
              `[swap] Buy fill too small to sell (${sellQty}) — will recover next cycle`,
            );
          } else {
            const freshBook = await http.getOrderBook(market.symbol, 3);
            bestBid = freshBook?.bids[0]?.price ?? bestBid;
            bestAsk = freshBook?.asks[0]?.price ?? bestAsk;
            await placeSide(
              'sell',
              market,
              bestBid,
              bestAsk,
              executor,
              signer,
              sellQty,
            );
          }
        }
      }
    }

    const elapsed = Date.now() - cycleStart;
    const wait = Math.max(0, CYCLE_MS - elapsed);
    if (running && wait > 0) {
      console.log(`[swap] Next cycle in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }

  console.log('[swap] Stopped.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
