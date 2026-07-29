import { Wallet, formatUnits } from 'ethers';
import {
  DreamDexHttpClient,
  DreamDexWsClient,
  ContractOrderExecutor,
  HttpOrderExecutor,
  TransactionExecutor,
  BotStateStore,
} from '@trading/sdk';
import type {
  MarketInfo,
  OrderBook,
  OrderBookLevel,
  OrderExecutor,
  WebSocketOrderBookMessage,
} from '@trading/sdk';
// Import strategies directly from grid-bot
import { GridStrategy } from '../../../grid-bot/src/strategies/grid.js';
import { MarketMakerStrategy } from '../../../grid-bot/src/strategies/market-maker.js';
import { MinuteRebalanceStrategy } from '../../../grid-bot/src/strategies/minute-rebalance.js';
import { ThresholdStrategy } from '../../../grid-bot/src/strategies/threshold.js';
import type { TradingStrategy, StrategyExecution } from '../../../grid-bot/src/strategies/types.js';
import { toPrepareOrderRequest } from '../../../grid-bot/src/strategies/types.js';
import type { GlobalConfig } from '../config.js';
import type { UserBotConfig, PositionData } from './types.js';

export class BotRunner {
  private ws!: DreamDexWsClient;
  private strategy!: TradingStrategy;
  private orderExecutor!: OrderExecutor;
  private txExecutor!: TransactionExecutor;
  private http!: DreamDexHttpClient;
  private stateStore!: BotStateStore;
  private shuttingDown = false;
  private market: MarketInfo | null = null;
  private cachedOrderBook: OrderBook | undefined;
  private isHandling = false;
  private lastActionAt = 0;
  private lastPersistenceAt = 0;
  private lastInventorySyncAt = 0;

  constructor(
    private readonly config: UserBotConfig,
    private readonly globalConfig: GlobalConfig,
  ) {}

  get isRunning(): boolean {
    return !this.shuttingDown && this.market !== null;
  }

  async start(): Promise<void> {
    if (this.market !== null) {
      throw new Error('Bot is already running.');
    }
    this.shuttingDown = false;

    const wallet = new Wallet(this.config.privateKey);

    this.http = new DreamDexHttpClient(
      this.globalConfig.baseUrl,
      wallet,
      this.globalConfig.chainId,
      this.globalConfig.siweDomain,
      this.globalConfig.siweUri,
    );

    this.txExecutor = new TransactionExecutor(
      this.globalConfig.rpcUrl,
      this.config.privateKey,
      this.globalConfig.chainId,
    );

    this.ws = new DreamDexWsClient(this.globalConfig.wsUrl);

    this.strategy = this.buildStrategy();

    this.orderExecutor =
      this.config.executionMode === 'contract'
        ? new ContractOrderExecutor(this.txExecutor, 0, this.globalConfig.chainId)
        : new HttpOrderExecutor(this.http, this.txExecutor);

    this.stateStore = await BotStateStore.open(this.config.persistenceDir, {
      symbol: this.config.symbol,
      strategy: this.config.strategy,
      executionMode: this.config.executionMode,
    });

    const markets = await this.http.listMarkets();
    const market = markets.find((m) => m.symbol === this.config.symbol);
    if (!market) {
      throw new Error(`Market not found: ${this.config.symbol}`);
    }
    this.market = market;

    await this.txExecutor.assertConnectedChain();

    const previousSnapshot = this.stateStore.getSnapshot();
    if (previousSnapshot.strategyState) {
      this.strategy.hydrate?.(previousSnapshot.strategyState);
    }

    const liveInventory = await this.getLiveInventory();
    this.strategy.syncInventory?.(liveInventory);

    await this.stateStore.saveStrategyState(this.strategy.getPersistentState?.());

    console.log(
      `[bot:${this.config.telegramId}] Starting ${this.config.strategy} strategy on ${this.config.symbol}`,
    );

    await this.ws.connect(async (message) => {
      if (this.shuttingDown) return;
      if (message.type !== 'snapshot' && message.type !== 'update') return;
      if (message.symbol && message.symbol !== this.config.symbol) return;
      if (this.isHandling) return;
      this.isHandling = true;

      try {
        this.cachedOrderBook = applyOrderBookMessage(
          this.cachedOrderBook,
          message,
          this.config.symbol,
        );

        const effectiveBook = this.cachedOrderBook ?? {
          symbol: this.config.symbol,
          timestamp: Date.now(),
          bids: [],
          asks: [],
        };

        const now = Date.now();

        if (now - this.lastInventorySyncAt >= 5 * 60_000) {
          try {
            const fresh = await this.getLiveInventory();
            this.strategy.syncInventory?.(fresh);
            this.lastInventorySyncAt = now;
          } catch (err) {
            console.warn(`[bot:${this.config.telegramId}] Failed to refresh inventory:`, err);
          }
        }

        const signal = this.strategy.evaluate(effectiveBook, {
          market: this.market!,
          orderAmount: this.config.orderAmount,
          allowedSide: 'both',
          buyBelowPrice: 0,
          sellAbovePrice: 0,
          gridTradeSizeQuote: this.config.gridTradeSizeQuote,
          gridStepBps: this.config.gridStepBps,
          gridMaxSpreadBps: this.config.gridMaxSpreadBps,
          gridMaxLongQuote: this.config.gridMaxLongQuote,
        });

        if (now - this.lastPersistenceAt >= 15_000) {
          await this.stateStore.saveStrategyState(this.strategy.getPersistentState?.());
          this.lastPersistenceAt = now;
        }

        if (!signal) return;
        if (now - this.lastActionAt < 20_000) return;

        this.lastActionAt = now;

        const request = toPrepareOrderRequest(
          this.config.walletAddress,
          signal,
          'wallet',
          'immediateOrCancel',
          'cancelTaker',
        );

        console.log(
          `[bot:${this.config.telegramId}] ${signal.side.toUpperCase()} ${signal.amount} ${this.config.symbol} @ ${signal.price}`,
        );

        if (this.config.dryRun) {
          console.log(`[bot:${this.config.telegramId}] [dry-run] Skipping order submission`);
          return;
        }

        try {
          const result = await this.orderExecutor.executeOrder(this.market!, request);
          const execution = await this.resolveExecution(
            this.config.symbol,
            signal.side,
            signal.price,
            signal.amount,
            result.simulatedOrderId,
          );
          this.strategy.onExecution?.(execution);
          await this.stateStore.recordExecution(execution, {
            txHash: result.txHash,
            approvalTxHash: result.approvalTxHash,
            simulatedOrderId: result.simulatedOrderId,
            strategyState: this.strategy.getPersistentState?.(),
          });
        } catch (err) {
          console.error(`[bot:${this.config.telegramId}] Order failed:`, err);
        }
      } finally {
        this.isHandling = false;
      }
    });

    this.ws.subscribeOrderBook(this.config.symbol);
    console.log(`[bot:${this.config.telegramId}] Subscribed to ${this.config.symbol}`);
  }

  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.ws?.close();
    try {
      await this.stateStore?.saveStrategyState(this.strategy?.getPersistentState?.());
    } catch (err) {
      console.error(`[bot:${this.config.telegramId}] Failed to save state on stop:`, err);
    }
    this.market = null;
    this.cachedOrderBook = undefined;
    console.log(`[bot:${this.config.telegramId}] Bot stopped.`);
  }

  /**
   * Execute a manual IOC order from /buy or /sell commands.
   * Returns the tx hash or a dry-run notice.
   */
  async executeManualOrder(
    side: 'buy' | 'sell',
    amount: string,
    price?: string,
  ): Promise<string> {
    if (!this.market) {
      throw new Error('Bot is not running. Start the bot first with /startbot.');
    }

    const effectivePrice =
      price ??
      (this.cachedOrderBook
        ? side === 'buy'
          ? (this.cachedOrderBook.asks[0]?.price ?? '0')
          : (this.cachedOrderBook.bids[0]?.price ?? '0')
        : '0');

    if (effectivePrice === '0') {
      throw new Error('No price available from order book. Provide a price manually.');
    }

    const request = toPrepareOrderRequest(
      this.config.walletAddress,
      { side, price: effectivePrice, amount, reason: 'manual' },
      'wallet',
      'immediateOrCancel',
      'cancelTaker',
    );

    if (this.config.dryRun) {
      return `[dry-run] Would ${side} ${amount} @ ${effectivePrice}`;
    }

    const result = await this.orderExecutor.executeOrder(this.market, request);
    return result.txHash;
  }

  getStatusLine(): string {
    return this.strategy?.getStatusLine?.() ?? 'no status available';
  }

  getMarket(): MarketInfo | null {
    return this.market;
  }

  /**
   * Returns structured position data from the strategy's persistent state.
   * For grid: array of open lots + balances + reference price.
   */
  getPositionData(): PositionData {
    const state = this.strategy?.getPersistentState?.();
    const data = state?.data ?? {};

    const lots = Array.isArray(data['lots'])
      ? (data['lots'] as Array<{ price: number; amount: number }>)
      : [];

    return {
      strategyName: state?.name ?? this.config.strategy,
      symbol: this.config.symbol,
      lots,
      reservedBaseBalance: typeof data['reservedBaseBalance'] === 'number' ? data['reservedBaseBalance'] : 0,
      quoteBalance: typeof data['quoteBalance'] === 'number' ? data['quoteBalance'] : 0,
      referencePrice: typeof data['referencePrice'] === 'number' ? data['referencePrice'] : undefined,
      lastMidPrice: typeof data['lastMidPrice'] === 'number' ? data['lastMidPrice'] : undefined,
      markedEquityQuote: typeof data['markedEquityQuote'] === 'number' ? data['markedEquityQuote'] : undefined,
      tradeCount: typeof data['tradeCount'] === 'number' ? data['tradeCount'] : 0,
    };
  }

  /** Returns the bid/ask mid price from the cached order book, if available. */
  getMidPrice(): number | undefined {
    const book = this.cachedOrderBook;
    if (!book) return undefined;
    const bid = Number(book.bids[0]?.price ?? 0);
    const ask = Number(book.asks[0]?.price ?? 0);
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    return ask || bid || undefined;
  }

  private buildStrategy(): TradingStrategy {
    switch (this.config.strategy) {
      case 'grid':
        return new GridStrategy({
          tradeSizeQuote: this.config.gridTradeSizeQuote,
          stepBps: this.config.gridStepBps,
          maxSpreadBps: this.config.gridMaxSpreadBps,
          maxLongQuote: this.config.gridMaxLongQuote,
          maxSessionLossQuote: 5,
          stuckTimeoutMs: 20 * 60_000,
        });
      case 'marketMaker':
        return new MarketMakerStrategy({
          startingQuoteBalanceQuote: 50,
          startingBaseBalance: 0,
          quoteSizeQuote: 3,
          targetBaseInventoryQuote: 8,
          maxBaseInventoryQuote: 15,
          minSpreadBps: 5,
          targetHalfSpreadBps: 35,
          inventorySkewBps: 20,
          maxSessionLossQuote: 3,
        });
      case 'minuteRebalance':
        return new MinuteRebalanceStrategy({
          tradeSizeQuote: 10,
          targetBaseQuote: 6,
          targetToleranceQuote: 2,
          maxSpreadBps: 15,
        });
      default:
        return new ThresholdStrategy();
    }
  }

  private async getLiveInventory(): Promise<{ baseBalance: number; quoteBalance: number }> {
    if (!this.market) throw new Error('Market not loaded');
    const { symbol, base, quote, baseDecimals, quoteDecimals } = this.market;
    const isNativeSomi = symbol.startsWith('SOMI:');
    const [baseRaw, quoteRaw] = await Promise.all([
      isNativeSomi
        ? this.txExecutor.getNativeBalance()
        : this.txExecutor.getErc20Balance(base),
      this.txExecutor.getErc20Balance(quote),
    ]);
    return {
      baseBalance: Number(formatUnits(baseRaw, baseDecimals)),
      quoteBalance: Number(formatUnits(quoteRaw, quoteDecimals)),
    };
  }

  private async resolveExecution(
    symbol: string,
    side: StrategyExecution['side'],
    requestedPrice: string,
    requestedAmount: string,
    orderId?: string,
  ): Promise<StrategyExecution> {
    if (!orderId) {
      return { side, requestedPrice, requestedAmount, filledAmount: requestedAmount, executionPrice: requestedPrice };
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const order = await this.http.fetchOrder(symbol, orderId);
        return {
          side,
          requestedPrice,
          requestedAmount,
          filledAmount: order.filled,
          executionPrice: order.executionPrice || requestedPrice,
          status: order.status,
        };
      } catch {
        if (attempt < 4) await sleep(1_000);
      }
    }
    return { side, requestedPrice, requestedAmount, filledAmount: '0', executionPrice: requestedPrice, status: 'unknown' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyOrderBookMessage(
  current: OrderBook | undefined,
  message: WebSocketOrderBookMessage,
  symbol: string,
): OrderBook | undefined {
  if (message.type === 'snapshot') {
    if (!message.bids || !message.asks || !message.timestamp) return current;
    return validateBook({
      symbol,
      timestamp: message.timestamp,
      bids: normalizeLevels(message.bids, 'desc'),
      asks: normalizeLevels(message.asks, 'asc'),
    });
  }
  if (!current) {
    if (!message.bids || !message.asks || !message.timestamp) return undefined;
    return validateBook({
      symbol,
      timestamp: message.timestamp,
      bids: normalizeLevels(message.bids, 'desc'),
      asks: normalizeLevels(message.asks, 'asc'),
    });
  }
  return validateBook({
    symbol,
    timestamp: message.timestamp ?? current.timestamp,
    bids: mergeLevels(current.bids, message.bids, 'desc'),
    asks: mergeLevels(current.asks, message.asks, 'asc'),
  });
}

function validateBook(book: OrderBook): OrderBook | undefined {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  if (bestBid && bestAsk && Number(bestBid.price) >= Number(bestAsk.price)) return undefined;
  return book;
}

function mergeLevels(
  existing: OrderBookLevel[],
  updates: OrderBookLevel[] | undefined,
  direction: 'asc' | 'desc',
): OrderBookLevel[] {
  if (!updates || updates.length === 0) return existing;
  const byPrice = new Map(existing.map((l) => [l.price, l]));
  for (const u of updates) {
    if (Number(u.quantity) <= 0) byPrice.delete(u.price);
    else byPrice.set(u.price, u);
  }
  return normalizeLevels([...byPrice.values()], direction);
}

function normalizeLevels(levels: OrderBookLevel[], direction: 'asc' | 'desc'): OrderBookLevel[] {
  return levels
    .filter((l) => Number(l.quantity) > 0)
    .sort((a, b) =>
      direction === 'asc' ? Number(a.price) - Number(b.price) : Number(b.price) - Number(a.price),
    );
}
