# Sominia Trading

A production-grade TypeScript trading system built on [DreamDEX](https://dreamdex.io) — Somnia's on-chain CLOB. Built as a submission for the **DreamDEX Alpha Trading Competition** and as a demo of what a full trading stack on Somnia looks like.

---

## What's inside

```
sominia-trading/
├── packages/
│   └── sdk/              @trading/sdk — shared DreamDEX clients, executors, vault, persistence
├── bots/
│   └── grid-bot/         @trading/grid-bot — multi-strategy trading bot
├── apps/
│   └── dashboard/        @trading/dashboard — real-time Next.js monitoring dashboard
└── scripts/              @trading/scripts — swap loop + one-shot order tools
```

Built as a **Turbo monorepo** with pnpm workspaces. The SDK is compiled once; all consumers resolve it via pnpm symlinks.

---

## Architecture

```
  DreamDEX API / Somnia Chain
         │  WebSocket + HTTP + Contract calls
         │
  ┌──────▼──────────────────────────┐
  │         @trading/sdk            │
  │  DreamDexHttpClient             │
  │  DreamDexWsClient               │
  │  ContractOrderExecutor          │
  │  HttpOrderExecutor              │
  │  TransactionExecutor            │
  │  VaultManager                   │
  │  BotStateStore                  │
  └──────┬──────────────────────────┘
         │
  ┌──────▼──────────────┐    ┌──────────────────────┐
  │   @trading/grid-bot │    │  @trading/scripts    │
  │  Grid strategy      │    │  Swap loop           │
  │  Market-maker       │    │  One-shot orders     │
  │  Minute-rebalance   │    │  State viewer        │
  │  Threshold          │    └──────────────────────┘
  │  MetricsServer ─────┼──► SSE on METRICS_PORT
  └─────────────────────┘         │
                            ┌─────▼──────────────────┐
                            │  @trading/dashboard    │
                            │  Next.js + Recharts    │
                            │  Real-time P&L / trades│
                            └────────────────────────┘
```

---

## Quick start

```bash
# 1. Install
pnpm install

# 2. Build SDK (required before running bots)
pnpm build

# 3. Configure
cp .env.example bots/grid-bot/.env
# Edit bots/grid-bot/.env — set DREAMDEX_PRIVATE_KEY, DREAMDEX_RPC_URL, DREAMDEX_DRY_RUN=true

# 4. Run bot (dry-run by default)
pnpm --filter @trading/grid-bot run dev

# 5. When logs look right, set DREAMDEX_DRY_RUN=false
```

---

## Packages

### `@trading/sdk`

Shared library consumed by all other packages. No runtime dependencies beyond `ethers` and `ws`.

| Module | Purpose |
|---|---|
| `DreamDexHttpClient` | SIWE auth, market discovery, order prep, order fetch |
| `DreamDexWsClient` | Public order book WebSocket feed |
| `ContractOrderExecutor` | Calls SpotPool directly (`placeOrder` / `placeTakerOrderWithoutVault`) |
| `HttpOrderExecutor` | HTTP-prepared unsigned tx → sign → broadcast |
| `TransactionExecutor` | Wallet, RPC, ERC-20 allowance, balance reads |
| `VaultManager` | `deposit` / `depositNative` / `withdraw` / `getWithdrawableBalance` |
| `BotStateStore` | JSON snapshot + JSONL execution journal |

---

### `@trading/grid-bot`

Multi-strategy bot that connects to DreamDEX via WebSocket and trades on every order book update.

#### Strategies

| Strategy | Description |
|---|---|
| `grid` | Buys one step below reference price, sells one step above. FIFO lot tracking. Caps max inventory. |
| `marketMaker` | Inventory-aware spread capture. Skews anchor thresholds toward the short side. |
| `minuteRebalance` | Keeps base inventory near a target value. Trades when deviation exceeds tolerance. |
| `threshold` | Simple trigger: buy below price X, sell above price Y. |

#### Auto-vault flow

Set `DREAMDEX_AUTO_VAULT=true` to enable automatic vault management:

1. On startup — deposits wallet balance into the SpotPool vault (keeps `DREAMDEX_VAULT_GAS_RESERVE` SOMI for gas)
2. During trading — all orders use vault funding, enabling resting limit orders
3. On shutdown (SIGINT/SIGTERM) — withdraws everything back to wallet

#### Execution modes

| Mode | How it works |
|---|---|
| `http` | Private API prepares unsigned tx → bot signs → broadcasts |
| `contract` | Bot calls SpotPool directly, no private API dependency |

> Wallet-funded contract mode only supports `immediateOrCancel` / `fillOrKill`.
> Resting orders (`normalOrder`, `postOnly`) require vault funding.

#### Live dashboard

Start the metrics server by setting `METRICS_PORT=3001`, then run the dashboard:

```bash
# Terminal 1
METRICS_PORT=3001 pnpm --filter @trading/grid-bot run dev

# Terminal 2
pnpm --filter @trading/dashboard run dev
# Open http://localhost:3000
```

The dashboard shows real-time P&L, equity curve, trade history, and bot status over SSE.

#### Strategy backtester

Simulate any strategy against a generated price series without spending real funds:

```bash
pnpm --filter @trading/grid-bot run backtest
```

```bash
# Reproducible run (same seed = same price series)
BT_SEED=42 BT_TICKS=5000 pnpm --filter @trading/grid-bot run backtest

# Higher volatility, smaller capital
BT_VOLATILITY=0.005 BT_INITIAL_QUOTE=20 pnpm --filter @trading/grid-bot run backtest
```

Output includes: P&L, volume, drawdown, open position, trade count, and an ASCII equity sparkline.

| Variable | Default | Description |
|---|---|---|
| `BT_INITIAL_QUOTE` | `50` | Starting quote balance |
| `BT_INITIAL_BASE` | `0` | Starting base balance |
| `BT_START_PRICE` | `0.175` | Simulated start price |
| `BT_TICKS` | `2000` | Number of price ticks |
| `BT_SPREAD_BPS` | `10` | Simulated bid-ask spread |
| `BT_VOLATILITY` | `0.003` | Price volatility per tick |
| `BT_SEED` | random | RNG seed for reproducible runs |

---

### `@trading/scripts`

Utility scripts for testing and volume generation.

```bash
# Continuous buy/sell swap loop
pnpm --filter @trading/scripts run dev          # tsx (local dev)
pnpm --filter @trading/scripts run start        # compiled (production)

# One-shot orders
pnpm --filter @trading/scripts run contract:buy
pnpm --filter @trading/scripts run contract:sell
pnpm --filter @trading/scripts run http:buy
pnpm --filter @trading/scripts run http:sell

# Show persisted bot state
pnpm --filter @trading/scripts run state:show
```

#### Swap loop behaviour

- Checks live balances at the start of every cycle
- If quote balance is too low to buy (below `minQuantity × bestAsk`), sells base first to recover quote — prevents cascading failures from a failed sell leaving residual base
- Re-fetches the order book before the second leg so pricing is always fresh
- Effective buy size caps to available balance (`min(SWAP_AMOUNT_QUOTE, quoteBalance)`) so chop-reduced balances keep the loop running at a smaller clip

| Variable | Default | Description |
|---|---|---|
| `DREAMDEX_SWAP_AMOUNT_QUOTE` | `10` | Target quote amount per side |
| `DREAMDEX_SWAP_SLIPPAGE_BPS` | `5` | Slippage tolerance |
| `DREAMDEX_SWAP_CYCLE_MS` | `15000` | Minimum cycle interval |
| `DREAMDEX_GAS_RESERVE` | `0.02` | Native SOMI kept for gas |

---

### `@trading/dashboard`

Real-time bot monitoring dashboard. Connects to the bot's SSE endpoint.

```bash
pnpm --filter @trading/dashboard run dev    # development
pnpm --filter @trading/dashboard run build  # production build
pnpm --filter @trading/dashboard run start  # production server
```

Set `NEXT_PUBLIC_BOT_URL` to point at the bot's metrics server (default: `http://localhost:3001`).

---

## Configuration reference

All configuration is via environment variables. Copy `.env.example` and customise.

### Core

| Variable | Required | Description |
|---|---|---|
| `DREAMDEX_PRIVATE_KEY` | ✓ | Wallet private key |
| `DREAMDEX_RPC_URL` | ✓ | Somnia RPC endpoint |
| `DREAMDEX_SYMBOL` | ✓ | Market symbol e.g. `SOMI:USDso` |
| `DREAMDEX_ENV` | | `staging` (Shannon) or `mainnet` |
| `DREAMDEX_CHAIN_ID` | | `50312` (Shannon) or `5031` (mainnet) |
| `DREAMDEX_DRY_RUN` | | `true` to skip tx broadcast |

### Bot behaviour

| Variable | Default | Description |
|---|---|---|
| `DREAMDEX_STRATEGY` | `threshold` | `grid`, `marketMaker`, `minuteRebalance`, `threshold` |
| `DREAMDEX_EXECUTION_MODE` | `http` | `http` or `contract` |
| `DREAMDEX_ALLOWED_SIDE` | `both` | `buy`, `sell`, or `both` |
| `DREAMDEX_FUNDING_SOURCE` | `wallet` | `wallet` or `vault` |
| `DREAMDEX_ORDER_TYPE` | `immediateOrCancel` | `immediateOrCancel`, `fillOrKill`, `normalOrder`, `postOnly` |
| `DREAMDEX_COOLDOWN_MS` | `20000` | Minimum ms between orders |
| `DREAMDEX_AUTO_VAULT` | `false` | Auto deposit/withdraw vault on start/stop |
| `METRICS_PORT` | `0` | Port for dashboard metrics server (`0` = disabled) |

### Grid strategy

| Variable | Default | Description |
|---|---|---|
| `DREAMDEX_GRID_TRADE_SIZE_QUOTE` | `20` | Quote notional per clip |
| `DREAMDEX_GRID_STEP_BPS` | `8` | Distance between grid levels |
| `DREAMDEX_GRID_MAX_SPREAD_BPS` | `25` | Skip if spread is wider |
| `DREAMDEX_GRID_MAX_LONG_QUOTE` | `60` | Cap on open base position value |
| `DREAMDEX_GRID_MAX_SESSION_LOSS_QUOTE` | `5` | Stop trading if equity drops by this |
| `DREAMDEX_GRID_STUCK_TIMEOUT_MS` | `1200000` | Cut stuck position after this many ms |

---

## Deployment

### Railway (recommended)

1. Push repo to GitHub
2. Create a new Railway project → **Deploy from GitHub repo**
3. Set all env vars in the Railway **Variables** tab
4. Railway auto-detects `build` and `start` scripts — no Dockerfile needed

The `railway.json` at the root configures restart-on-failure and the correct start command.

To deploy the dashboard as a separate Railway service, set `NEXT_PUBLIC_BOT_URL` to the bot service's public URL.

### Local

```bash
pnpm build                                    # compile all packages
pnpm --filter @trading/grid-bot run start     # run grid bot
pnpm --filter @trading/scripts run start      # run swap loop
pnpm --filter @trading/dashboard run start    # run dashboard
```

---

## Competition context

Built for the **DreamDEX Alpha Trading Competition** (Somnia Shannon testnet, 1 week, $50 SOMI capital). Primary KPI: trading volume.

**Strategy**: Grid bot with `normalOrder` resting limits via vault funding, complemented by the swap loop for continuous volume generation. The grid captures small spread on each round-trip; the swap loop ensures consistent activity even when the grid is waiting for a trigger.

**Architecture rationale**: The monorepo structure allows the SDK to be developed independently of the strategies, making it easy to add new bots or integrate with other Somnia DEXes without duplicating DreamDEX client logic.
