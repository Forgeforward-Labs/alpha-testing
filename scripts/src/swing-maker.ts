import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Wallet, formatUnits } from 'ethers';
import { config } from './config.js';
import {
  DreamDexHttpClient,
  DreamDexWsClient,
  ContractOrderExecutor,
  TransactionExecutor,
  VaultManager,
} from '@trading/sdk';
import type { MarketInfo, WsOrder } from '@trading/sdk';
import { alignToStep } from '@trading/sdk';

// ── Config ────────────────────────────────────────────────────────────────────

const SWING_QUOTE = Number(process.env.SWING_QUOTE      ?? '100');
const PROFIT_BPS  = Number(process.env.SWING_PROFIT_BPS ?? '20');   // 0.2% per round-trip
const ORDER_TTL_S = Number(process.env.SWING_TTL_S      ?? '86400'); // 24h — orders wait patiently
const MIN_QUOTE   = Number(process.env.SWING_MIN_QUOTE  ?? '5');    // min $ to bother placing a buy
const DATA_DIR    = process.env.SWING_DATA_DIR ?? path.join(config.persistenceDir, 'swing');
const STATE_FILE  = path.join(DATA_DIR, 'state.json');
const LOG_FILE    = path.join(DATA_DIR, 'swing-maker.log');

// ── Logger ────────────────────────────────────────────────────────────────────

let logStream: fs.WriteStream | undefined;

function initLogger(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  logStream.write(`\n${'─'.repeat(60)}\n`);
  logStream.write(`${new Date().toISOString()} [swing] ── Session start ──\n`);
}

function log(msg: string): void {
  console.log(msg);
  logStream?.write(`${new Date().toISOString()} ${msg}\n`);
}

function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err != null ? String(err) : '';
  const line = detail ? `${msg}: ${detail}` : msg;
  console.error(line);
  logStream?.write(`${new Date().toISOString()} [ERROR] ${line}\n`);
}

// ── Persistent state ──────────────────────────────────────────────────────────

interface ActiveBuy {
  orderId: string;
  price: string;
  amount: string;
  placedAt: number;
}

interface PendingSell {
  price: string;
  amount: string;
  buyFillPrice: number;
  sellOrderId?: string;
}

interface SwingState {
  activeBuy?: ActiveBuy;
  pendingSell?: PendingSell;
  totalPnl: number;
  roundTrips: number;
}

let state: SwingState = { totalPnl: 0, roundTrips: 0 };

function loadState(): SwingState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SwingState;
    }
  } catch {
    // Corrupt state — start fresh.
  }
  return { totalPnl: 0, roundTrips: 0 };
}

function saveState(): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logError('[swing] Failed to save state', err);
  }
}

// ── Live orderbook (WS-maintained) ───────────────────────────────────────────

const liveBids = new Map<string, string>();
const liveAsks = new Map<string, string>();
let bookReady = false;

function applyBookUpdate(
  side: Map<string, string>,
  levels: Array<{ price: string; quantity: string }>,
): void {
  for (const { price, quantity } of levels) {
    if (Number(quantity) === 0) side.delete(price);
    else side.set(price, quantity);
  }
}

function getSortedBids(): Array<{ price: string; quantity: string }> {
  return [...liveBids.entries()]
    .map(([price, quantity]) => ({ price, quantity }))
    .sort((a, b) => Number(b.price) - Number(a.price));
}

// ── Running flag ──────────────────────────────────────────────────────────────

let running = true;
process.on('SIGINT',  () => { log('\n[swing] Stopping...'); running = false; });
process.on('SIGTERM', () => { running = false; });

// ── Order helpers ─────────────────────────────────────────────────────────────

async function placeLimitOrder(
  side: 'buy' | 'sell',
  price: string,
  amount: string,
  market: MarketInfo,
  executor: ContractOrderExecutor,
): Promise<string | undefined> {
  try {
    const result = await executor.executeOrder(market, {
      walletAddress: config.walletAddress,
      type: 'limit',
      side,
      amount,
      price,
      fundingSource: 'vault',
      orderType: 'normalOrder',
      selfMatchingOption: 'cancelTaker',
    });
    const id = result.simulatedOrderId;
    log(`[swing] + ${side.toUpperCase()} ${amount} @ ${price}  id=${id}  tx=${result.txHash}`);
    return id;
  } catch (err) {
    logError(`[swing] Place ${side} failed`, err);
    return undefined;
  }
}

async function cancelOrder(
  orderId: string,
  market: MarketInfo,
  http: DreamDexHttpClient,
  signer: TransactionExecutor,
): Promise<boolean> {
  try {
    const tx = await http.prepareCancel(market.symbol, orderId);
    await signer.sendPreparedTransaction(tx);
    log(`[swing] Cancelled order ${orderId}`);
    return true;
  } catch (err) {
    logError(`[swing] Cancel failed for ${orderId}`, err);
    return false;
  }
}

// ── WS fill detection ─────────────────────────────────────────────────────────

interface FillResult {
  status: 'filled' | 'cancelled' | 'stopped';
  executionPrice?: string;
  filled?: string;
}

function waitForFill(
  ws: DreamDexWsClient,
  orderId: string,
): Promise<FillResult> {
  return new Promise((resolve) => {
    let resolved = false;

    const finish = (result: FillResult) => {
      if (resolved) return;
      resolved = true;
      clearInterval(stopPoller);
      ws.unsubscribeOrder(orderId);
      resolve(result);
    };

    // No JS-level cancel — orders wait patiently until filled or the contract expires them.
    // The stop-poller handles graceful shutdown via SIGINT/SIGTERM.
    const stopPoller = setInterval(() => {
      if (!running) finish({ status: 'stopped' });
    }, 1_000);

    ws.subscribeOrder(orderId, (order: WsOrder) => {
      if (order.status === 'filled') {
        finish({
          status: 'filled',
          executionPrice: order.executionPrice ?? order.price,
          filled: order.filled ?? order.quantity,
        });
      } else if (order.status === 'cancelled') {
        finish({ status: 'cancelled' });
      } else if (order.status === 'partial') {
        log(`[swing] Partial fill... remaining=${order.remaining ?? '?'}`);
      }
    });
  });
}

// ── Sell price helper ─────────────────────────────────────────────────────────

async function computeSellPrice(
  fillPrice: number,
  market: MarketInfo,
  http: DreamDexHttpClient,
): Promise<string> {
  const floor = fillPrice * (1 + PROFIT_BPS / 10_000);
  let raw = floor;
  try {
    const book  = await http.getOrderBook(market.symbol, 5);
    const asks1 = book?.asks[1]?.price;
    if (asks1 && Number(asks1) > floor) {
      raw = Number(asks1);
      log(`[swing] Sell target: asks[1]=${asks1} (floor=${floor.toFixed(4)})`);
    } else {
      log(`[swing] asks[1] below floor — selling at ${floor.toFixed(4)}`);
    }
  } catch {
    log(`[swing] REST unavailable — selling at floor ${floor.toFixed(4)}`);
  }
  return alignToStep(raw.toFixed(8), market.tickSize);
}

// ── Startup reconciliation ────────────────────────────────────────────────────
//
// API / vault are the source of truth. Local state.json provides P&L history
// and order IDs, but on startup we always verify against the exchange and patch
// whatever diverged while the bot was offline.

async function reconcileAndRecover(
  market: MarketInfo,
  ws: DreamDexWsClient,
  http: DreamDexHttpClient,
  executor: ContractOrderExecutor,
  vault: VaultManager | undefined,
): Promise<void> {
  const [b, q] = market.symbol.split(':');

  // ── 1. Fetch live exchange state ──────────────────────────────────────────
  log('[swing] ── Startup reconciliation ──');

  let openOrders: Awaited<ReturnType<typeof http.listOrders>> = [];
  try {
    openOrders = await http.listOrders(market.symbol, 'open');
  } catch (err) {
    logError('[swing] Could not fetch open orders — proceeding with local state', err);
  }

  const openBuys  = openOrders.filter((o) => o.side === 'buy');
  const openSells = openOrders.filter((o) => o.side === 'sell');

  let freeBase    = 0n;
  let freeQuote   = 0n;
  let lockedBase  = 0n;
  let lockedQuote = 0n;

  if (vault) {
    [freeBase, freeQuote] = await Promise.all([
      vault.getVaultBalance(market.base),
      vault.getVaultBalance(market.quote),
    ]);
    const lk  = await vault.getLockedBalance();
    lockedBase  = lk.lockedBase;
    lockedQuote = lk.lockedQuote;
  }

  // Print summary.
  log(`[swing] Open orders : ${openBuys.length} buy, ${openSells.length} sell`);
  for (const o of openBuys)  log(`[swing]   BUY  ${o.amount} @ ${o.price}  id=${o.id}`);
  for (const o of openSells) log(`[swing]   SELL ${o.amount} @ ${o.price}  id=${o.id}`);
  if (vault) {
    log(`[swing] Vault free  : ${formatUnits(freeBase, market.baseDecimals)} ${b}  /  ${formatUnits(freeQuote, market.quoteDecimals)} ${q}`);
    log(`[swing] Vault locked: ${formatUnits(lockedBase, market.baseDecimals)} ${b}  /  ${formatUnits(lockedQuote, market.quoteDecimals)} ${q}`);
  }

  // ── 2. Top-up vault if quote is too low ───────────────────────────────────
  if (vault) {
    const freeFmt = Number(formatUnits(freeQuote, market.quoteDecimals));
    if (freeFmt < MIN_QUOTE && openBuys.length === 0 && openSells.length === 0) {
      log('[swing] Vault quote low and no open orders — topping up from wallet...');
      await vault.depositAll(market, '0.02');
      freeQuote = await vault.getVaultBalance(market.quote);
      log(`[swing] Vault quote after deposit: ${formatUnits(freeQuote, market.quoteDecimals)} ${q}`);
    }
  }

  // ── 3. Reconcile local state against API ──────────────────────────────────
  // API wins. Patch activeBuy / pendingSell to match reality.

  // local says activeBuy, but API says it's gone
  if (state.activeBuy && !openBuys.find((o) => o.id === state.activeBuy!.orderId)) {
    try {
      const order = await http.fetchOrder(market.symbol, state.activeBuy.orderId);
      if (order.status === 'closed' && Number(order.filled) > 0) {
        log(`[swing] activeBuy ${state.activeBuy.orderId} filled while offline`);
        const fillPrice  = Number(order.executionPrice ?? state.activeBuy.price);
        const fillAmount = alignToStep(order.filled, market.lotSize);
        const sellPrice  = await computeSellPrice(fillPrice, market, http);
        state.pendingSell = { price: sellPrice, amount: fillAmount, buyFillPrice: fillPrice };
      } else {
        log(`[swing] activeBuy ${state.activeBuy.orderId} is ${order.status} — clearing`);
      }
    } catch {
      log('[swing] Could not verify activeBuy — clearing');
    }
    state.activeBuy = undefined;
    saveState();
  }

  // API has open buys we don't know about — adopt the newest one
  if (openBuys.length > 0 && !state.activeBuy) {
    const buy = openBuys[0];
    log(`[swing] Adopting open buy from API: ${buy.id} @ ${buy.price}`);
    state.activeBuy = { orderId: buy.id, price: buy.price, amount: buy.amount, placedAt: 0 };
    for (const extra of openBuys.slice(1)) {
      log(`[swing] [WARN] Extra open buy detected: ${extra.id} @ ${extra.price} — run vault:balance to inspect`);
    }
    saveState();
  }

  // local says pendingSell.sellOrderId, but API says it's gone
  if (state.pendingSell?.sellOrderId &&
      !openSells.find((o) => o.id === state.pendingSell!.sellOrderId)) {
    const ps = state.pendingSell;
    try {
      const order = await http.fetchOrder(market.symbol, ps.sellOrderId!);
      if (order.status === 'closed' && Number(order.filled) > 0) {
        const sellFillPrice = Number(order.executionPrice ?? ps.price);
        const profit = ps.buyFillPrice > 0
          ? (sellFillPrice - ps.buyFillPrice) * Number(ps.amount)
          : 0;
        state.totalPnl   += profit;
        state.roundTrips += 1;
        state.pendingSell = undefined;
        saveState();
        log(`[swing] ✓ Recovered fill: sell ${ps.sellOrderId}  profit≈$${profit.toFixed(4)}  total P&L=$${state.totalPnl.toFixed(4)}`);
        return;
      } else {
        log(`[swing] sell ${ps.sellOrderId} is ${order.status} — will re-place`);
        ps.sellOrderId = undefined;
        saveState();
      }
    } catch {
      ps.sellOrderId = undefined;
      saveState();
    }
  }

  // API has open sells we don't know about — adopt
  if (openSells.length > 0 && !state.pendingSell) {
    const sell = openSells[0];
    log(`[swing] Adopting open sell from API: ${sell.id} @ ${sell.price}`);
    state.pendingSell = {
      price: sell.price,
      amount: sell.amount,
      buyFillPrice: 0,
      sellOrderId: sell.id,
    };
    saveState();
  } else if (openSells.length > 0 && state.pendingSell && !state.pendingSell.sellOrderId) {
    state.pendingSell.sellOrderId = openSells[0].id;
    saveState();
  }

  // ── 4. Recovery: free base in vault with no sell order ───────────────────
  // Match the free base balance against recent filled buy orders to find the
  // original fill price, then set an accurate sell target above it.
  if (!state.pendingSell && openSells.length === 0 && freeBase > 0n && vault) {
    const freeBaseFmt   = formatUnits(freeBase, market.baseDecimals);
    const freeBaseNum   = Number(freeBaseFmt);
    const recoverAmount = alignToStep(freeBaseFmt, market.lotSize);

    if (Number(recoverAmount) >= Number(market.minQuantity)) {
      log(`[swing] Free ${b} in vault: ${freeBaseFmt} — searching filled buy orders for fill price...`);

      let fillPrice = 0;
      try {
        const closedBuys = (await http.listOrders(market.symbol, 'closed'))
          .filter((o) => o.side === 'buy' && Number(o.filled) > 0)
          .sort((a, b) => b.createdAt - a.createdAt); // newest first

        if (closedBuys.length > 0) {
          // Find the closed buy whose filled amount is closest to what's free in the vault.
          const lotSize = Number(market.lotSize);
          const best = closedBuys.reduce((prev, cur) => {
            const prevDiff = Math.abs(Number(prev.filled) - freeBaseNum);
            const curDiff  = Math.abs(Number(cur.filled) - freeBaseNum);
            return curDiff < prevDiff ? cur : prev;
          });

          const diff = Math.abs(Number(best.filled) - freeBaseNum);
          if (diff <= lotSize * 2) {
            fillPrice = Number(best.executionPrice ?? best.price);
            log(`[swing] Matched fill: buy ${best.filled} @ ${fillPrice}  id=${best.id}  (diff=${diff.toFixed(6)})`);
          } else {
            // No close match — use most recent fill price as best guess.
            fillPrice = Number(closedBuys[0].executionPrice ?? closedBuys[0].price);
            log(`[swing] No exact match — using most recent buy fill price: ${fillPrice}  id=${closedBuys[0].id}`);
          }
        }
      } catch (err) {
        logError('[swing] Could not fetch closed orders for fill matching', err);
      }

      // If we couldn't determine a fill price from history, fall back to current bids[0].
      if (fillPrice === 0) {
        const bids = getSortedBids();
        const bid0 = bids.length > 0
          ? Number(bids[0].price)
          : Number((await http.getOrderBook(market.symbol, 3))?.bids[0]?.price ?? '0');
        fillPrice = bid0;
        if (fillPrice === 0) {
          log(`[swing] [WARN] Cannot determine fill price and book is empty — skipping recovery sell`);
          return;
        }
        log(`[swing] No order history found — using current bids[0]=${fillPrice} as fill price reference`);
      }

      const sellPrice = await computeSellPrice(fillPrice, market, http);
      log(`[swing] Recovery sell: ${recoverAmount} ${b} @ ${sellPrice}  (fill was ~${fillPrice})`);
      state.pendingSell = { price: sellPrice, amount: recoverAmount, buyFillPrice: fillPrice };
      saveState();
    }
  }

  log('[swing] ── Reconciliation complete ──');

  // ── 5. Resume WS tracking ─────────────────────────────────────────────────
  if (!state.activeBuy && !state.pendingSell) {
    log('[swing] Clean slate — starting fresh cycles');
    return;
  }

  // Resume active buy
  if (state.activeBuy) {
    const buy = state.activeBuy;
    log(`[swing] Waiting for buy ${buy.orderId} @ ${buy.price}...`);
    const result = await waitForFill(ws, buy.orderId);
    state.activeBuy = undefined;
    if (result.status === 'stopped') { saveState(); return; }
    if (result.status === 'cancelled') {
      log('[swing] Buy expired — starting fresh next cycle');
      saveState();
      return;
    }
    const fillPrice  = Number(result.executionPrice ?? buy.price);
    const fillAmount = alignToStep(result.filled ?? buy.amount, market.lotSize);
    log(`[swing] ✓ Buy filled ${fillAmount} @ ${fillPrice}`);
    const sellPrice  = await computeSellPrice(fillPrice, market, http);
    state.pendingSell = { price: sellPrice, amount: fillAmount, buyFillPrice: fillPrice };
    saveState();
  }

  // Resume / place sell
  if (!state.pendingSell) return;
  const ps = state.pendingSell;

  if (!ps.sellOrderId) {
    log(`[swing] Placing sell ${ps.amount} @ ${ps.price}`);
    const sellId = await placeLimitOrder('sell', ps.price, ps.amount, market, executor);
    if (!sellId) { logError('[swing] Sell failed — will retry on next restart'); return; }
    ps.sellOrderId = sellId;
    saveState();
  } else {
    log(`[swing] Tracking sell ${ps.sellOrderId} @ ${ps.price}`);
  }

  const sellResult = await waitForFill(ws, ps.sellOrderId);
  if (sellResult.status === 'stopped') return;
  if (sellResult.status === 'cancelled') {
    log('[swing] Sell expired — saved, will re-place on restart');
    ps.sellOrderId = undefined;
    saveState();
    return;
  }
  const sellFillPrice = Number(sellResult.executionPrice ?? ps.price);
  const profit = ps.buyFillPrice > 0
    ? (sellFillPrice - ps.buyFillPrice) * Number(ps.amount)
    : 0;
  state.totalPnl   += profit;
  state.roundTrips += 1;
  state.pendingSell = undefined;
  saveState();
  log(`[swing] ✓ Round-trip #${state.roundTrips}  sell=${sellFillPrice}  profit≈$${profit.toFixed(4)}  total P&L=$${state.totalPnl.toFixed(4)}`);
}

// ── Trading cycle ─────────────────────────────────────────────────────────────

async function runCycle(
  market: MarketInfo,
  ws: DreamDexWsClient,
  http: DreamDexHttpClient,
  executor: ContractOrderExecutor,
  signer: TransactionExecutor,
  vault: VaultManager | undefined,
): Promise<boolean> {
  // ── Step 0: Check available vault quote balance ────────────────────────────
  let effectiveQuote = SWING_QUOTE;
  if (vault) {
    const vaultFree = await vault.getVaultBalance(market.quote);
    const freeFmt   = Number(formatUnits(vaultFree, market.quoteDecimals));
    if (freeFmt < MIN_QUOTE) {
      log(`[swing] Vault quote too low ($${freeFmt.toFixed(2)}) — waiting 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
      return true;
    }
    if (freeFmt < SWING_QUOTE) {
      effectiveQuote = freeFmt * 0.99; // 1% buffer to avoid rounding into insufficient
      log(`[swing] Vault limited — trading $${effectiveQuote.toFixed(2)} (free: $${freeFmt.toFixed(2)})`);
    }
  }

  // ── Step 1: Determine buy price from WS book, with REST fallback ─────────
  const wsBids = getSortedBids();
  let buyPrice: string;

  if (wsBids.length >= 2) {
    buyPrice = wsBids[1].price;
  } else {
    // WS book is thin — query REST directly.
    const restBook = await http.getOrderBook(market.symbol, 5);
    if (!restBook || restBook.bids.length < 2) {
      log(`[swing] Book empty on WS and REST — waiting 10s`);
      await new Promise((r) => setTimeout(r, 10_000));
      return true;
    }
    buyPrice = restBook.bids[1].price;
    log(`[swing] WS thin — using REST bids[1]=${buyPrice}`);
  }
  const buyAmount = alignToStep((effectiveQuote / Number(buyPrice)).toFixed(8), market.lotSize);

  if (Number(buyAmount) < Number(market.minQuantity)) {
    log(`[swing] Computed amount ${buyAmount} below min ${market.minQuantity}`);
    await new Promise((r) => setTimeout(r, 5_000));
    return true;
  }

  const sellPrice      = alignToStep(
    (Number(buyPrice) * (1 + PROFIT_BPS / 10_000)).toFixed(8),
    market.tickSize,
  );
  const expectedProfit = (Number(sellPrice) - Number(buyPrice)) * Number(buyAmount);
  log(
    `\n[swing] ── Cycle ${state.roundTrips + 1} ──  buy@${buyPrice}  sell≥${sellPrice}  expected=$${expectedProfit.toFixed(4)}`,
  );

  // ── Step 2: Place resting buy ─────────────────────────────────────────────
  const buyId = await placeLimitOrder('buy', buyPrice, buyAmount, market, executor);
  if (!buyId) {
    await new Promise((r) => setTimeout(r, 5_000));
    return true;
  }

  state.activeBuy = { orderId: buyId, price: buyPrice, amount: buyAmount, placedAt: Date.now() };
  saveState();

  // ── Step 3: Wait for buy fill via WS ─────────────────────────────────────
  const buyResult = await waitForFill(ws, buyId);
  state.activeBuy = undefined;

  if (buyResult.status === 'stopped') { saveState(); return false; }
  if (buyResult.status === 'cancelled') { saveState(); return true; }

  const fillPrice  = Number(buyResult.executionPrice ?? buyPrice);
  const fillAmount = alignToStep(buyResult.filled ?? buyAmount, market.lotSize);
  log(`[swing] ✓ Buy filled ${fillAmount} @ ${fillPrice}`);

  if (!running) { saveState(); return false; }

  // ── Step 4: Compute sell price ────────────────────────────────────────────
  const actualSellPrice = await computeSellPrice(fillPrice, market, http);
  const lockedProfit    = (Number(actualSellPrice) - fillPrice) * Number(fillAmount);
  log(`[swing] Selling ${fillAmount} @ ${actualSellPrice}  locked profit=$${lockedProfit.toFixed(4)}`);

  state.pendingSell = { price: actualSellPrice, amount: fillAmount, buyFillPrice: fillPrice };
  saveState();

  // ── Step 5: Place resting sell ────────────────────────────────────────────
  const sellId = await placeLimitOrder('sell', actualSellPrice, fillAmount, market, executor);
  if (!sellId) {
    logError('[swing] Sell placement failed — base is in vault, will retry on restart');
    return true; // pendingSell is saved; next run will recover it
  }
  state.pendingSell.sellOrderId = sellId;
  saveState();

  // ── Step 6: Wait for sell fill via WS ────────────────────────────────────
  const sellResult = await waitForFill(ws, sellId);

  if (sellResult.status === 'stopped') return false;
  if (sellResult.status === 'cancelled') {
    log('[swing] Sell TTL expired — saved to state, will recover on next restart');
    // pendingSell remains in state; next run will re-place it.
    return true;
  }

  // ── Step 7: Account P&L ───────────────────────────────────────────────────
  const sellFillPrice = Number(sellResult.executionPrice ?? actualSellPrice);
  const profit = (sellFillPrice - fillPrice) * Number(fillAmount);
  state.totalPnl   += profit;
  state.roundTrips += 1;
  state.pendingSell = undefined;
  saveState();

  log(
    `[swing] ✓ Round-trip #${state.roundTrips}  buy=${fillPrice}  sell=${sellFillPrice}` +
    `  profit=$${profit.toFixed(4)}  total P&L=$${state.totalPnl.toFixed(4)}`,
  );

  return true;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  initLogger();
  state = loadState();
  log(`[swing] Starting. Previous P&L=$${state.totalPnl.toFixed(4)}  trips=${state.roundTrips}`);
  log(`[swing] State file : ${STATE_FILE}`);
  log(`[swing] Log file   : ${LOG_FILE}`);

  const wallet = new Wallet(config.privateKey);
  const http   = new DreamDexHttpClient(
    config.baseUrl, wallet, config.chainId, config.siweDomain, config.siweUri,
  );
  const signer   = new TransactionExecutor(config.rpcUrl, config.privateKey, config.chainId);
  const executor = new ContractOrderExecutor(signer, ORDER_TTL_S + 120, config.chainId);
  const ws       = new DreamDexWsClient(config.wsUrl);

  await signer.assertConnectedChain();

  const markets = await http.listMarkets();
  const market  = markets.find((m) => m.symbol === config.symbol);
  if (!market) throw new Error(`Market not found: ${config.symbol}`);

  log(`[swing] Symbol   : ${market.symbol}`);
  log(`[swing] Amount   : up to $${SWING_QUOTE} per round-trip (uses vault free balance)`);
  log(`[swing] Profit   : ${PROFIT_BPS}bps per round-trip`);
  log(`[swing] TTL      : ${ORDER_TTL_S}s before re-placing`);
  log(`[swing] Strategy : buy @ bids[1] (WS or REST), sell @ asks[1] or fill×(1+${PROFIT_BPS}bps) floor`);

  // Connect WS and subscribe to live orderbook.
  await ws.connect((msg) => {
    if (msg.type === 'snapshot') {
      liveBids.clear();
      liveAsks.clear();
      applyBookUpdate(liveBids, msg.bids ?? []);
      applyBookUpdate(liveAsks, msg.asks ?? []);
      bookReady = true;
    } else if (msg.type === 'update') {
      applyBookUpdate(liveBids, msg.bids ?? []);
      applyBookUpdate(liveAsks, msg.asks ?? []);
    }
  });
  ws.subscribeOrderBook(market.symbol);

  log('[swing] Waiting for orderbook snapshot...');
  await new Promise<void>((resolve) => {
    const check = setInterval(() => { if (bookReady) { clearInterval(check); resolve(); } }, 100);
  });
  log(`[swing] Book ready  bids=${liveBids.size}  asks=${liveAsks.size}`);

  const vault = config.dryRun ? undefined : new VaultManager(signer, market.contract);

  // Reconcile exchange state (open orders + vault balance) with local state,
  // then resume any in-progress buy or sell before starting fresh cycles.
  await reconcileAndRecover(market, ws, http, executor, vault);

  while (running) {
    const cont = await runCycle(market, ws, http, executor, signer, vault);
    if (!cont) break;
  }

  ws.close();
  log('[swing] Stopped. Vault funds left in place for next session.');
  logStream?.end();
}

main().catch((err) => {
  logError('[swing] Fatal error', err);
  logStream?.end();
  process.exit(1);
});
