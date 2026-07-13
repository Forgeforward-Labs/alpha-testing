import 'dotenv/config';
import { Wallet, formatUnits, MaxUint256 } from 'ethers';
import { config as envConfig } from './config.js';
import {
  DreamDexHttpClient,
  ContractOrderExecutor,
  TransactionExecutor,
  VaultManager,
} from '@trading/sdk';
import type { MarketInfo } from '@trading/sdk';
import { alignToStep } from '@trading/sdk';

// ── Config ────────────────────────────────────────────────────────────────────
const STEP_BPS         = Number(process.env.GRID_STEP_BPS          ?? '10');
const LOT_USDSO        = Number(process.env.GRID_SIZE_QUOTE        ?? '9');
const MAX_INVENTORY    = Number(process.env.GRID_MAX_INVENTORY     ?? '80');
const MAX_SESSION_LOSS = Number(process.env.GRID_MAX_SESSION_LOSS  ?? '20');
const MAX_SPREAD_BPS   = Number(process.env.GRID_MAX_SPREAD_BPS    ?? '100');
const STUCK_MS         = Number(process.env.GRID_STUCK_TIMEOUT_MS  ?? '3600000');
const POLL_MS          = Number(process.env.GRID_POLL_MS           ?? '2000');
const ORDER_TTL_S      = Number(process.env.GRID_ORDER_TTL_S       ?? '3600');

// ── Signals ───────────────────────────────────────────────────────────────────
let running = true;
process.on('SIGINT',  () => { log('[grid] Stopping...'); running = false; });
process.on('SIGTERM', () => { running = false; });

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg: string): void { console.log(msg); }
function logErr(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err != null ? String(err) : '';
  console.error(detail ? `${msg}: ${detail}` : msg);
}

// ── Lot ───────────────────────────────────────────────────────────────────────
interface Lot { price: number; qty: number; }

// ── Grid ──────────────────────────────────────────────────────────────────────
// placeOrder uses auto-pull by default: pulls input from wallet, delivers fill
// to wallet. No vault deposits needed during trading — just ERC-20 approvals
// set once at startup.

class Grid {
  private lots: Lot[] = [];
  private anchor: number | undefined;
  private realizedPnl = 0;
  private stuckSince: number | undefined;
  private totalVolume = 0;
  private trips = 0;
  private tickCount = 0;

  constructor(
    private readonly market: MarketInfo,
    private readonly executor: ContractOrderExecutor,
    private readonly http: DreamDexHttpClient,
    private readonly signer: TransactionExecutor,
  ) {}

  async tick(): Promise<void> {
    this.tickCount++;

    const book = await this.http.getOrderBook(this.market.symbol, 3);
    const bestBid = book?.bids[0] ? Number(book.bids[0].price) : undefined;
    const bestAsk = book?.asks[0] ? Number(book.asks[0].price) : undefined;
    if (bestBid === undefined || bestAsk === undefined) return;

    const mid = (bestBid + bestAsk) / 2;
    if (this.anchor === undefined) {
      this.anchor = mid;
      log(`[grid] Anchor set: ${mid.toFixed(4)}`);
    }

    const spreadBps = ((bestAsk - bestBid) / bestBid) * 10_000;
    if (spreadBps > MAX_SPREAD_BPS) {
      log(`[grid] Spread ${spreadBps.toFixed(1)}bps > ${MAX_SPREAD_BPS}bps — sitting out`);
      return;
    }

    const offloadOnly    = this.realizedPnl <= -MAX_SESSION_LOSS;
    const buyTrigger     = this.anchor * (1 - STEP_BPS / 10_000);
    const sellTrigger    = (this.lots[0]?.price ?? this.anchor) * (1 + STEP_BPS / 10_000);
    const inventoryUsdso = this.baseHeld() * mid;
    const qty            = LOT_USDSO / mid;
    const minQty         = Number(this.market.minQuantity);

    if (this.tickCount % 30 === 0) {
      log(
        `[grid] Tick ${this.tickCount}  mid=${mid.toFixed(4)}  anchor=${this.anchor.toFixed(4)}` +
        `  buyTrigger=${buyTrigger.toFixed(4)}  sellTrigger=${sellTrigger.toFixed(4)}` +
        `  lots=${this.lots.length}  inv=$${inventoryUsdso.toFixed(2)}` +
        `  pnl=$${this.realizedPnl.toFixed(4)}  vol=$${this.totalVolume.toFixed(2)}  trips=${this.trips}`,
      );
    }

    // ── SELL ───────────────────────────────────────────────────────────────
    if (this.lots.length > 0 && bestBid >= sellTrigger) {
      await this.sell(bestBid, Math.min(qty, this.baseHeld()));
      this.stuckSince = undefined;
      return;
    }

    // ── BUY ────────────────────────────────────────────────────────────────
    if (!offloadOnly && bestAsk <= buyTrigger && inventoryUsdso < MAX_INVENTORY && qty >= minQty) {
      await this.buy(buyTrigger, bestAsk, qty);
      return;
    }

    // ── STUCK ──────────────────────────────────────────────────────────────
    if (this.lots.length > 0 && STUCK_MS > 0) {
      const now = Date.now();
      this.stuckSince ??= now;
      if (now - this.stuckSince >= STUCK_MS) {
        log(`[grid] Stuck ${Math.round((now - this.stuckSince) / 60_000)}m — cutting at bid ${bestBid}`);
        await this.sell(bestBid, this.baseHeld());
        this.anchor = mid;
        this.stuckSince = undefined;
      }
    } else {
      this.stuckSince = undefined;
    }
  }

  private async buy(triggerPrice: number, bestAsk: number, qty: number): Promise<void> {
    const price    = Number.isFinite(bestAsk) ? bestAsk : triggerPrice;
    const priceStr = alignToStep(price.toFixed(8), this.market.tickSize);
    const qtyStr   = alignToStep(qty.toFixed(8),   this.market.lotSize);
    if (Number(qtyStr) < Number(this.market.minQuantity)) return;

    // Wallet USDso pre-check — auto-pull draws from wallet.
    try {
      const wq = Number(formatUnits(await this.signer.getErc20Balance(this.market.quote), this.market.quoteDecimals));
      if (wq < LOT_USDSO) { log(`[grid] Wallet $${wq.toFixed(2)} < $${LOT_USDSO} — skip buy`); return; }
    } catch { /* proceed */ }

    // Snapshot wallet WETH — fill is auto-delivered to wallet.
    let baseBefore = 0n;
    try { baseBefore = await this.signer.getErc20Balance(this.market.base); } catch { /* 0 */ }

    try {
      const res = await this.executor.executeOrder(this.market, {
        walletAddress: envConfig.walletAddress,
        type: 'limit',
        side: 'buy',
        amount: qtyStr,
        price: priceStr,
        fundingSource: 'vault',
        orderType: 'immediateOrCancel',
        selfMatchingOption: 'cancelTaker',
      });

      const baseAfter = await this.signer.getErc20Balance(this.market.base);
      const filled    = baseAfter > baseBefore
        ? Number(formatUnits(baseAfter - baseBefore, this.market.baseDecimals))
        : 0;
      if (filled > 0) {
        this.lots.push({ price, qty: filled });
        this.totalVolume += price * filled;
        log(`[grid] ✓ BUY ${filled.toFixed(6)} @ ${priceStr}  lots=${this.lots.length}  pnl=$${this.realizedPnl.toFixed(4)}  vol=$${this.totalVolume.toFixed(2)}  tx=${res.txHash}`);
      } else {
        log(`[grid] ✗ BUY no fill @ ${priceStr} (IOC cancelled)  tx=${res.txHash}`);
      }
    } catch (err) {
      logErr(`[grid] BUY failed @ ${priceStr}`, err);
    }
  }

  private async sell(bestBid: number, qty: number): Promise<void> {
    const priceStr = alignToStep(bestBid.toFixed(8), this.market.tickSize);
    const qtyStr   = alignToStep(qty.toFixed(8),     this.market.lotSize);
    if (Number(qtyStr) < Number(this.market.minQuantity)) { this.lots = []; return; }

    // Snapshot wallet WETH — auto-pull draws WETH from wallet.
    let baseBefore = 0n;
    try { baseBefore = await this.signer.getErc20Balance(this.market.base); } catch { /* 0 */ }

    if (baseBefore === 0n) {
      log('[grid] Wallet WETH = 0 — clearing phantom lots');
      this.lots = [];
      return;
    }

    try {
      const res = await this.executor.executeOrder(this.market, {
        walletAddress: envConfig.walletAddress,
        type: 'limit',
        side: 'sell',
        amount: qtyStr,
        price: priceStr,
        fundingSource: 'vault',
        orderType: 'immediateOrCancel',
        selfMatchingOption: 'cancelTaker',
      });

      const baseAfter = await this.signer.getErc20Balance(this.market.base);
      const sold      = baseBefore > baseAfter
        ? Number(formatUnits(baseBefore - baseAfter, this.market.baseDecimals))
        : 0;
      if (sold > 0) {
        this.closeLots(sold, bestBid);
        this.trips++;
        this.totalVolume += bestBid * sold;
        log(`[grid] ✓ SELL ${sold.toFixed(6)} @ ${priceStr}  trips=${this.trips}  pnl=$${this.realizedPnl.toFixed(4)}  vol=$${this.totalVolume.toFixed(2)}  tx=${res.txHash}`);
      } else {
        log(`[grid] ✗ SELL no fill @ ${priceStr} (IOC cancelled)  tx=${res.txHash}`);
        this.lots = [];
      }
    } catch (err) {
      logErr(`[grid] SELL failed @ ${priceStr}`, err);
      this.lots = [];
    }
  }

  private closeLots(qty: number, exitPrice: number): void {
    let rem = qty;
    while (rem > 1e-12 && this.lots.length > 0) {
      const lot = this.lots[0]!;
      const take = Math.min(lot.qty, rem);
      this.realizedPnl += (exitPrice - lot.price) * take;
      lot.qty -= take;
      rem -= take;
      if (lot.qty <= 1e-12) this.lots.shift();
    }
  }

  private baseHeld(): number {
    return this.lots.reduce((s, l) => s + l.qty, 0);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wallet = new Wallet(envConfig.privateKey);
  const http   = new DreamDexHttpClient(
    envConfig.baseUrl, wallet, envConfig.chainId, envConfig.siweDomain, envConfig.siweUri,
  );
  const signer   = new TransactionExecutor(envConfig.rpcUrl, envConfig.privateKey, envConfig.chainId);
  const executor = new ContractOrderExecutor(signer, ORDER_TTL_S + 300, envConfig.chainId);

  await signer.assertConnectedChain();

  const markets = await http.listMarkets();
  const market  = markets.find((m) => m.symbol === envConfig.symbol);
  if (!market) throw new Error(`Market not found: ${envConfig.symbol}`);

  log(`[grid] Symbol  : ${market.symbol}`);
  log(`[grid] Step    : ${STEP_BPS}bps`);
  log(`[grid] Lot     : $${LOT_USDSO}`);
  log(`[grid] MaxInv  : $${MAX_INVENTORY}`);
  log(`[grid] StopLoss: $${MAX_SESSION_LOSS}`);
  log(`[grid] StuckAt : ${STUCK_MS / 60_000}min`);
  log(`[grid] Poll    : ${POLL_MS}ms`);

  // Drain any vault balance to wallet — placeOrder auto-pulls from wallet.
  const vault = new VaultManager(signer, market.contract);
  await vault.withdrawAll(market);

  // Approve pool to pull both tokens from wallet (MaxUint256, one-time per token).
  log('[grid] Ensuring token approvals...');
  await signer.ensureErc20Allowance(market.quote, market.contract, MaxUint256);
  await signer.ensureErc20Allowance(market.base,  market.contract, MaxUint256);
  log('[grid] Approvals ready.');

  const grid = new Grid(market, executor, http, signer);

  log('[grid] Starting tick loop...');
  while (running) {
    try {
      await grid.tick();
    } catch (err) {
      logErr('[grid] Tick error', err);
    }
    if (running) await new Promise<void>((r) => setTimeout(r, POLL_MS));
  }

  log('[grid] Stopped.');
}

main().catch((err) => {
  logErr('[grid] Fatal', err);
  process.exit(1);
});
