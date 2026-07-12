import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Wallet, formatUnits, parseUnits } from 'ethers';
import { config } from './config.js';
import {
  DreamDexHttpClient,
  ContractOrderExecutor,
  TransactionExecutor,
  VaultManager,
} from '@trading/sdk';
import type { MarketInfo, Order } from '@trading/sdk';
import { alignToStep } from '@trading/sdk';

// ── Grid configuration ────────────────────────────────────────────────────────
const PROFIT_BPS  = Number(process.env.GRID_PROFIT_BPS  ?? '30');
const STEP_BPS    = Number(process.env.GRID_STEP_BPS    ?? '20');
const SIZE_QUOTE  = Number(process.env.GRID_SIZE_QUOTE  ?? '10');
const LEVELS      = Number(process.env.GRID_LEVELS      ?? '5');
const LOWER_PRICE = Number(process.env.GRID_LOWER_PRICE ?? '0');
const UPPER_PRICE = Number(process.env.GRID_UPPER_PRICE ?? '1e18');
const ORDER_TTL_S = Number(process.env.GRID_ORDER_TTL_S ?? '3600');
const POLL_MS     = Number(process.env.GRID_POLL_MS     ?? '5000');
const DATA_DIR    = process.env.GRID_DATA_DIR ?? path.join(config.persistenceDir, 'grid');
const STATE_FILE  = path.join(DATA_DIR, 'state.json');
const LOG_FILE    = path.join(DATA_DIR, 'grid-maker.log');

// ── Logger ────────────────────────────────────────────────────────────────────

let logStream: fs.WriteStream | undefined;

function initLogger(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  logStream.write(`\n${'─'.repeat(60)}\n`);
  logStream.write(`${new Date().toISOString()} [grid] ── Session start ──\n`);
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

// ── Types ─────────────────────────────────────────────────────────────────────

interface GridOrder {
  id: string;
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  placedAt: number;
}

interface PendingSell {
  price: string;
  amount: string;
  buyCost: number;
  retries: number;
}

interface GridState {
  activeOrders: Record<string, GridOrder>;
  pendingSells: PendingSell[];
  totalPnl: number;
  roundTrips: number;
  totalVolume: number;
}

// ── Mutable state ─────────────────────────────────────────────────────────────

const activeOrders = new Map<string, GridOrder>();
const pendingSells: PendingSell[] = [];
let totalPnl    = 0;
let roundTrips  = 0;
let totalVolume = 0;
let running     = true;

process.on('SIGINT',  () => { log('\n[grid] Stopping after this poll...'); running = false; });
process.on('SIGTERM', () => { running = false; });

// ── Persistence ───────────────────────────────────────────────────────────────

function loadState(): void {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as GridState;
    for (const [id, order] of Object.entries(s.activeOrders ?? {})) {
      activeOrders.set(id, order);
    }
    pendingSells.push(...(s.pendingSells ?? []));
    totalPnl    = s.totalPnl    ?? 0;
    roundTrips  = s.roundTrips  ?? 0;
    totalVolume = s.totalVolume ?? 0;
  } catch {
    log('[grid] State file corrupt or unreadable — starting fresh');
  }
}

function saveState(): void {
  try {
    const s: GridState = {
      activeOrders: Object.fromEntries(activeOrders),
      pendingSells: [...pendingSells],
      totalPnl,
      roundTrips,
      totalVolume,
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (err) {
    logError('[grid] Failed to save state', err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function targetBuyPrices(mid: number, market: MarketInfo): string[] {
  const prices: string[] = [];
  for (let i = 1; i <= LEVELS * 3; i++) {
    const raw = mid * (1 - (i * STEP_BPS) / 10_000);
    if (LOWER_PRICE > 0 && raw < LOWER_PRICE) break;
    if (raw > UPPER_PRICE) continue;
    prices.push(alignToStep(raw.toFixed(8), market.tickSize));
  }
  return prices.slice(0, LEVELS);
}

// ── Order placement ───────────────────────────────────────────────────────────

async function placeOrder(
  side: 'buy' | 'sell',
  price: string,
  amount: string,
  market: MarketInfo,
  executor: ContractOrderExecutor,
): Promise<void> {
  if (config.dryRun) {
    log(`[grid] [dry-run] Would place ${side.toUpperCase()} ${amount} @ ${price}`);
    return;
  }

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
    if (!id) {
      log(`[grid] [WARN] No orderId for ${side} @ ${price} — order not tracked`);
      return;
    }

    activeOrders.set(id, { id, side, price, amount, placedAt: Date.now() });
    saveState();
    log(`[grid] + ${side.toUpperCase()} ${amount} @ ${price}  id=${id}  tx=${result.txHash}`);
  } catch (err) {
    logError(`[grid] Failed to place ${side} @ ${price}`, err);
  }
}

// ── Pending sell flush ────────────────────────────────────────────────────────

async function flushPendingSells(
  market: MarketInfo,
  executor: ContractOrderExecutor,
  vault: VaultManager,
): Promise<void> {
  if (pendingSells.length === 0) return;

  const vaultBase = await vault.getVaultBalance(market.base);
  let i = 0;
  while (i < pendingSells.length) {
    const ps = pendingSells[i];
    const needed = parseUnits(ps.amount, market.baseDecimals);

    if (vaultBase < needed) {
      ps.retries++;
      if (ps.retries >= 10) {
        logError(`[grid] Pending sell ${ps.amount} @ ${ps.price} failed after 10 retries — dropping`);
        pendingSells.splice(i, 1);
        saveState();
      } else {
        log(
          `[grid] Vault base low for sell ${ps.amount} @ ${ps.price} ` +
          `(have ${formatUnits(vaultBase, market.baseDecimals)}) — retry ${ps.retries}/10`,
        );
        i++;
      }
      continue;
    }

    await placeOrder('sell', ps.price, ps.amount, market, executor);
    pendingSells.splice(i, 1);
    saveState();
  }
}

// ── Poll & react ──────────────────────────────────────────────────────────────

async function pollAndReact(
  market: MarketInfo,
  executor: ContractOrderExecutor,
  http: DreamDexHttpClient,
): Promise<void> {
  let closedOrders: Order[] = [];
  try {
    const [filled, canceled, expired] = await Promise.all([
      http.listOrders(market.symbol, 'closed'),
      http.listOrders(market.symbol, 'canceled'),
      http.listOrders(market.symbol, 'expired'),
    ]);
    closedOrders = [...filled, ...canceled, ...expired];
  } catch {
    for (const id of [...activeOrders.keys()]) {
      try { closedOrders.push(await http.fetchOrder(market.symbol, id)); } catch { /* skip */ }
    }
  }

  const closedById = new Map(closedOrders.map((o) => [o.id, o]));
  let changed = false;

  for (const id of [...activeOrders.keys()]) {
    const slot  = activeOrders.get(id)!;
    const order = closedById.get(id);
    if (!order) continue;

    const filled    = Number(order.filled ?? '0');
    const remaining = Number(order.remaining ?? slot.amount);
    const isFilled  = remaining === 0 && filled > 0;
    const isClosed  = ['canceled', 'expired', 'cancelled'].includes(order.status);

    if (isFilled) {
      activeOrders.delete(id);
      const fillPrice  = Number(order.executionPrice ?? slot.price);
      const fillAmount = alignToStep(order.filled, market.lotSize);
      const notional   = fillPrice * Number(fillAmount);
      totalVolume += notional;
      changed = true;

      log(`[grid] ✓ ${slot.side.toUpperCase()} FILLED  ${fillAmount} @ ${fillPrice.toFixed(4)}  id=${id}  +$${notional.toFixed(2)} vol`);

      if (slot.side === 'buy') {
        const sellPrice = alignToStep(
          (fillPrice * (1 + PROFIT_BPS / 10_000)).toFixed(8),
          market.tickSize,
        );
        if (Number(sellPrice) <= UPPER_PRICE) {
          pendingSells.push({ price: sellPrice, amount: fillAmount, buyCost: fillPrice * Number(fillAmount), retries: 0 });
          log(`[grid] Queued sell ${fillAmount} @ ${sellPrice}`);
        }
      } else {
        const sellRevenue = fillPrice * filled;
        const profit      = sellRevenue - Number(slot.price) * filled;
        totalPnl   += profit;
        roundTrips += 1;
        log(`[grid] ↺ Round-trip #${roundTrips}  profit=$${profit.toFixed(4)}  total P&L=$${totalPnl.toFixed(4)}  vol=$${totalVolume.toFixed(2)}`);
      }
    } else if (isClosed) {
      log(`[grid] Order ${id} ${order.status} — removed`);
      activeOrders.delete(id);
      changed = true;
      if (slot.side === 'sell') {
        log(`[grid] Re-queuing expired sell ${slot.amount} @ ${slot.price}`);
        pendingSells.push({ price: slot.price, amount: slot.amount, buyCost: 0, retries: 0 });
      }
    }
  }

  if (changed) saveState();
}

// ── Backfill buys ─────────────────────────────────────────────────────────────

async function backfillBuys(
  mid: number,
  market: MarketInfo,
  executor: ContractOrderExecutor,
  vault: VaultManager | undefined,
): Promise<void> {
  const activeBuys = [...activeOrders.values()].filter((o) => o.side === 'buy');
  if (activeBuys.length >= LEVELS) return;

  // Pre-flight vault balance check — skip entirely if clearly insufficient.
  // Default to 0 so a failed query fails safely (won't place orders blind).
  let vaultFree = 0;
  if (vault) {
    try {
      vaultFree = Number(formatUnits(
        await vault.getVaultBalance(market.quote),
        market.quoteDecimals,
      ));
    } catch { /* leave vaultFree=0, skip backfill */ }
  } else {
    vaultFree = Infinity; // dry-run: no vault, allow placement
  }
  log(`[grid] Backfill vault check: $${vaultFree.toFixed(2)} free (need $${SIZE_QUOTE})`);
  if (vaultFree < SIZE_QUOTE) {
    log(`[grid] Vault quote $${vaultFree.toFixed(2)} < $${SIZE_QUOTE} — skipping backfill`);
    return;
  }

  // Proximity tolerance: an existing buy within STEP_BPS/2 of a target covers that slot.
  // Prevents chasing the grid every poll when mid drifts by a few ticks.
  const toleranceBps = STEP_BPS / 2;
  const targets      = targetBuyPrices(mid, market);

  for (const targetPrice of targets) {
    const covered = activeBuys.some(
      (o) => (Math.abs(Number(o.price) - Number(targetPrice)) / Number(targetPrice)) * 10_000 <= toleranceBps,
    );
    if (covered) continue;

    if (vaultFree < SIZE_QUOTE) {
      log(`[grid] Vault quote exhausted ($${vaultFree.toFixed(2)}) — stopping backfill`);
      break;
    }

    const amount = alignToStep((SIZE_QUOTE / Number(targetPrice)).toFixed(8), market.lotSize);
    if (Number(amount) < Number(market.minQuantity)) continue;

    await placeOrder('buy', targetPrice, amount, market, executor);
    vaultFree -= SIZE_QUOTE; // optimistic deduction to avoid over-placing

    if ([...activeOrders.values()].filter((o) => o.side === 'buy').length >= LEVELS) break;
  }
}

// ── Startup reconciliation ────────────────────────────────────────────────────
// API + vault are source of truth. Patch local state to match reality.

async function reconcileOnStartup(
  market: MarketInfo,
  http: DreamDexHttpClient,
  vault: VaultManager | undefined,
): Promise<void> {
  log('[grid] ── Startup reconciliation ──');

  // 1. Fetch live open orders
  let apiOrders: Order[] = [];
  try {
    apiOrders = await http.listOrders(market.symbol, 'open');
  } catch (err) {
    logError('[grid] Could not fetch open orders — proceeding with local state', err);
  }

  const apiById = new Map(apiOrders.map((o) => [o.id, o]));
  log(`[grid] Open orders from API: ${apiOrders.length}`);
  for (const o of apiOrders) log(`[grid]   ${o.side.toUpperCase()} ${o.amount} @ ${o.price}  id=${o.id}`);

  // 2. Vault snapshot
  if (vault) {
    const [freeBase, freeQuote, lk] = await Promise.all([
      vault.getVaultBalance(market.base),
      vault.getVaultBalance(market.quote),
      vault.getLockedBalance(),
    ]);
    const [b, q] = market.symbol.split(':');
    log(`[grid] Vault free  : ${formatUnits(freeBase, market.baseDecimals)} ${b}  /  ${formatUnits(freeQuote, market.quoteDecimals)} ${q}`);
    log(`[grid] Vault locked: ${formatUnits(lk.lockedBase, market.baseDecimals)} ${b}  /  ${formatUnits(lk.lockedQuote, market.quoteDecimals)} ${q}`);
  }

  // 3. Check every saved order against API
  for (const id of [...activeOrders.keys()]) {
    const slot = activeOrders.get(id)!;

    if (apiById.has(id)) {
      log(`[grid] Resumed ${slot.side.toUpperCase()} ${slot.amount} @ ${slot.price}  id=${id}`);
      continue; // still open — keep as-is
    }

    // Not in open list — find out what happened
    try {
      const order   = await http.fetchOrder(market.symbol, id);
      const filled  = Number(order.filled ?? '0');
      const isFilled = Number(order.remaining ?? slot.amount) === 0 && filled > 0;

      if (isFilled) {
        activeOrders.delete(id);
        const fillPrice  = Number(order.executionPrice ?? slot.price);
        const fillAmount = alignToStep(order.filled, market.lotSize);
        totalVolume += fillPrice * Number(fillAmount);

        log(`[grid] ✓ ${slot.side.toUpperCase()} filled offline: ${fillAmount} @ ${fillPrice}  id=${id}`);

        if (slot.side === 'buy') {
          const sellPrice = alignToStep(
            (fillPrice * (1 + PROFIT_BPS / 10_000)).toFixed(8),
            market.tickSize,
          );
          if (Number(sellPrice) <= UPPER_PRICE) {
            pendingSells.push({ price: sellPrice, amount: fillAmount, buyCost: fillPrice * Number(fillAmount), retries: 0 });
            log(`[grid] Queued sell ${fillAmount} @ ${sellPrice}`);
          }
        } else {
          const profit = (fillPrice - Number(slot.price)) * filled;
          totalPnl   += profit;
          roundTrips += 1;
          log(`[grid] ↺ Recovered round-trip #${roundTrips}  profit=$${profit.toFixed(4)}`);
        }
      } else {
        log(`[grid] Order ${id} is ${order.status} — removing`);
        activeOrders.delete(id);
        if (order.status === 'expired' && slot.side === 'sell') {
          pendingSells.push({ price: slot.price, amount: slot.amount, buyCost: 0, retries: 0 });
          log(`[grid] Re-queued expired sell ${slot.amount} @ ${slot.price}`);
        }
      }
    } catch {
      log(`[grid] Could not verify order ${id} — removing`);
      activeOrders.delete(id);
    }
  }

  // 4. Adopt open orders from API that we don't know about
  for (const o of apiOrders) {
    if (!activeOrders.has(o.id)) {
      log(`[grid] Adopting API order: ${o.side.toUpperCase()} ${o.amount} @ ${o.price}  id=${o.id}`);
      activeOrders.set(o.id, { id: o.id, side: o.side, price: o.price, amount: o.amount, placedAt: o.createdAt });
    }
  }

  log(`[grid] Reconciled: ${activeOrders.size} active orders, ${pendingSells.length} pending sells`);
  log(`[grid] Restored  : P&L=$${totalPnl.toFixed(4)}  trips=${roundTrips}  vol=$${totalVolume.toFixed(2)}`);
  saveState();
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  initLogger();
  loadState();
  log(`[grid] Starting. Restored P&L=$${totalPnl.toFixed(4)}  trips=${roundTrips}  vol=$${totalVolume.toFixed(2)}`);
  log(`[grid] State : ${STATE_FILE}`);
  log(`[grid] Log   : ${LOG_FILE}`);

  const wallet = new Wallet(config.privateKey);
  const http   = new DreamDexHttpClient(
    config.baseUrl, wallet, config.chainId, config.siweDomain, config.siweUri,
  );
  const signer   = new TransactionExecutor(config.rpcUrl, config.privateKey, config.chainId);
  const executor = new ContractOrderExecutor(signer, ORDER_TTL_S + 300, config.chainId);

  await signer.assertConnectedChain();

  const markets = await http.listMarkets();
  const market  = markets.find((m) => m.symbol === config.symbol);
  if (!market) throw new Error(`Market not found: ${config.symbol}`);

  log(`[grid] Symbol   : ${market.symbol}`);
  log(`[grid] Profit   : ${PROFIT_BPS} bps`);
  log(`[grid] Step     : ${STEP_BPS} bps between levels`);
  log(`[grid] Levels   : ${LEVELS} concurrent buys`);
  log(`[grid] Size     : $${SIZE_QUOTE} per order`);
  log(`[grid] TTL      : ${ORDER_TTL_S}s`);
  log(`[grid] Poll     : ${POLL_MS / 1000}s`);

  const vault = config.dryRun ? undefined : new VaultManager(signer, market.contract);

  if (vault) {
    const vaultQuote    = await vault.getVaultBalance(market.quote);
    const vaultQuoteFmt = Number(formatUnits(vaultQuote, market.quoteDecimals));
    const quoteTicker   = market.symbol.split(':')[1];
    log(`[grid] Vault quote: ${vaultQuoteFmt.toFixed(2)} ${quoteTicker} (free)`);
    if (vaultQuoteFmt < SIZE_QUOTE) {
      log('[grid] Vault low — topping up from wallet...');
      await vault.depositAll(market, '0.02');
      const after = await vault.getVaultBalance(market.quote);
      log(`[grid] Vault after deposit: ${formatUnits(after, market.quoteDecimals)} ${quoteTicker}`);
    } else {
      log('[grid] Vault has funds — skipping deposit');
    }
  }

  // Reconcile saved + API state before placing any new orders.
  await reconcileOnStartup(market, http, vault);

  // Get mid price.
  const initBook = await http.getOrderBook(market.symbol, 3);
  const initBid  = initBook?.bids[0]?.price;
  const initAsk  = initBook?.asks[0]?.price;
  if (!initBid || !initAsk) throw new Error('Order book empty at startup');
  let mid = (Number(initBid) + Number(initAsk)) / 2;

  log(`\n[grid] Mid price: ${mid.toFixed(4)}`);

  // Flush any pending sells recovered from state before backfilling buys.
  if (vault && pendingSells.length > 0) {
    log(`[grid] Flushing ${pendingSells.length} recovered pending sell(s)...`);
    await flushPendingSells(market, executor, vault);
  }

  await backfillBuys(mid, market, executor, vault);

  // ── Poll loop ──────────────────────────────────────────────────────────────
  let poll = 0;
  while (running) {
    await sleep(POLL_MS);
    if (!running) break;
    poll++;

    const book = await http.getOrderBook(market.symbol, 3);
    const bid  = book?.bids[0]?.price;
    const ask  = book?.asks[0]?.price;
    if (bid && ask) mid = (Number(bid) + Number(ask)) / 2;

    const buys  = [...activeOrders.values()].filter((o) => o.side === 'buy').length;
    const sells = [...activeOrders.values()].filter((o) => o.side === 'sell').length;
    log(`\n[grid] ── Poll ${poll}  mid=${mid.toFixed(4)}  orders: ${buys}B ${sells}S  P&L=$${totalPnl.toFixed(4)}  trips=${roundTrips}  vol=$${totalVolume.toFixed(2)} ──`);

    await pollAndReact(market, executor, http);
    if (vault) await flushPendingSells(market, executor, vault);
    await backfillBuys(mid, market, executor, vault);
  }

  log('[grid] Stopped. Vault funds left in place for next session.');
  logStream?.end();
}

main().catch((err) => {
  logError('[grid] Fatal error', err);
  logStream?.end();
  process.exit(1);
});
