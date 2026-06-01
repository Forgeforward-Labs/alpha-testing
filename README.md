# DreamDEX Trading Bot Starter

A TypeScript starter bot for DreamDEX's on-chain CLOB on Somnia.

It implements the documented DreamDEX flow:
- discovers market metadata from `GET /v0/markets`
- authenticates with SIWE via `GET /v0/auth/nonce` and `POST /v0/auth/login`
- subscribes to the configured public WebSocket feed
- supports two execution modes:
  - `http`: prepares orders via `POST /v0/markets/{symbol}/orders`
  - `contract`: calls the SpotPool directly with `placeTakerOrderWithoutVault(...)` or `placeOrder(...)`
- signs and broadcasts transactions to Somnia
- automatically sends an approval transaction first when needed

## Strategies Included

### Threshold

The original starter strategy is intentionally simple:
- buy with IOC when best ask is less than or equal to `DREAMDEX_BUY_BELOW_PRICE`
- sell with IOC when best bid is greater than or equal to `DREAMDEX_SELL_ABOVE_PRICE`
- optionally restrict signals to `buy`, `sell`, or `both` with `DREAMDEX_ALLOWED_SIDE`

### Micro Market Maker

There is now a second strategy mode for a small wallet:
- set `DREAMDEX_STRATEGY=marketMaker`
- keeps an internal estimate of base and quote inventory
- maintains a moving anchor price from the live mid-price
- buys only when the ask is cheap relative to the anchor
- sells only when the bid is rich relative to the anchor
- skews the buy/sell aggressiveness based on inventory so it gradually rebuilds the side it is short on
- stops trading if the estimated mark-to-market drawdown exceeds `DREAMDEX_MM_MAX_SESSION_LOSS_QUOTE`
- prints inventory, equity, and estimated traded volume after reconciled fills
- does not require `DREAMDEX_BUY_BELOW_PRICE` or `DREAMDEX_SELL_ABOVE_PRICE`

### Grid

There is also a grid-style mode:
- set `DREAMDEX_STRATEGY=grid`
- seeds inventory from live wallet balances while reserving startup SOMI for gas
- bootstraps the first tradable SOMI buy from USDso
- buys when ask falls one grid step below the latest reference price
- sells when bid rises one grid step above the latest reference price
- updates the reference price after each real fill
- caps total tradable SOMI inventory with `DREAMDEX_GRID_MAX_LONG_QUOTE`

This is still a starter, not a guaranteed profitable system. The market-maker mode is best thought of as an inventory-aware spread-capture bot, not a fully featured maker engine with resting-order cancel/replace logic yet.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env file and configure it:

```bash
cp .env.example .env
```

3. Run in dry-run mode first:

```bash
npm run dev
```

4. When logs look correct, switch `DREAMDEX_DRY_RUN=false`.

## Persistent State

The bot now persists runtime state so you can stop and restart it without losing the running picture:
- strategy state is stored in a JSON snapshot under `DREAMDEX_PERSISTENCE_DIR`
- every execution is appended to a JSONL journal in the same folder
- for `marketMaker`, the persisted strategy state includes estimated base inventory, quote inventory, anchor price, marked equity, cumulative traded quote volume, and trade count

Default persistence folder:

```env
DREAMDEX_PERSISTENCE_DIR=./data
```

Useful command:

```bash
npm run state:show
```

That prints the latest persisted snapshot for the currently configured symbol/strategy pair.

## Small-Wallet Market-Maker Setup

For a conservative Shannon testnet setup with about `50 USDso`, start with:

```env
DREAMDEX_SYMBOL=SOMI:USDso
DREAMDEX_STRATEGY=grid
DREAMDEX_EXECUTION_MODE=contract
DREAMDEX_ALLOWED_SIDE=both
DREAMDEX_FUNDING_SOURCE=wallet
DREAMDEX_ORDER_TYPE=immediateOrCancel
DREAMDEX_DRY_RUN=true

DREAMDEX_GRID_TRADE_SIZE_QUOTE=10
DREAMDEX_GRID_STEP_BPS=15
DREAMDEX_GRID_MAX_SPREAD_BPS=20
DREAMDEX_GRID_MAX_LONG_QUOTE=30
```

Notes:
- this mode starts quote-heavy and bootstraps tradable SOMI from USDso
- startup SOMI is reserved for gas and not treated as sellable inventory
- because it uses IOC wallet flow, every executed trade is still a real taker order
- after each successful tx, the bot tries to reconcile the order through DreamDEX HTTP so inventory tracking is based on actual fills instead of blind assumptions

## One-Shot Contract Tests

For direct contract testing without running the event loop, use:

```bash
npm run test:buy
npm run test:sell
```

These scripts:

- always use the direct SpotPool contract execution path
- fetch market metadata from the public API
- read the live order book to choose a default limit price
- use best ask for `test:buy` if `DREAMDEX_TEST_PRICE` is not set
- use best bid for `test:sell` if `DREAMDEX_TEST_PRICE` is not set
- respect `DREAMDEX_DRY_RUN`

Optional env overrides:

- `DREAMDEX_TEST_SYMBOL`
- `DREAMDEX_TEST_AMOUNT`
- `DREAMDEX_TEST_PRICE`
- `DREAMDEX_TEST_SLIPPAGE_BPS`
- `DREAMDEX_TEST_AUTO_WITHDRAW`

If `DREAMDEX_TEST_PRICE` is unset, the scripts nudge the live book price to make taker tests more realistic:

- buy: best ask plus slippage bps
- sell: best bid minus slippage bps

Default test slippage is `25` bps.

For Shannon testnet native SOMI sells:

- the script now follows the proven pattern from direct contract testing
- if `DREAMDEX_EXPIRE_SECONDS=0`, contract mode uses a 1-hour expiry on chain `50312`
- after a successful fill, the script checks `getWithdrawableBalance(...)`
- by default, it auto-withdraws the received quote token from the pool vault back to your wallet

## One-Shot HTTP Tests

For HTTP-prepared order testing without running the event loop, use:

```bash
npm run test:http:buy
npm run test:http:sell
```

These scripts:

- use DreamDEX private HTTP endpoints to prepare the unsigned transaction
- sign and broadcast locally with your configured wallet
- use the same market-data lookup and test-price logic as the contract scripts
- check the pool vault after execution and auto-withdraw quote token by default

They support the same optional overrides:

- `DREAMDEX_TEST_SYMBOL`
- `DREAMDEX_TEST_AMOUNT`
- `DREAMDEX_TEST_PRICE`
- `DREAMDEX_TEST_SLIPPAGE_BPS`
- `DREAMDEX_TEST_AUTO_WITHDRAW`

## Execution Modes

Set `DREAMDEX_EXECUTION_MODE` to one of:

- `http`: use DreamDEX private HTTP endpoints to prepare the unsigned transaction, then sign and broadcast locally
- `contract`: bypass private order-prep endpoints and call the SpotPool contract directly

Notes:

- The bot still uses public HTTP + WebSocket market data in both modes.
- `contract` mode is useful if you want the order-placement path to be fully on-chain from the bot.
- Wallet-funded contract execution auto-checks ERC-20 allowance and submits `approve(...)` if needed.
- Vault-funded contract execution assumes you already deposited funds into the pool vault.
- On startup, the bot now verifies that `DREAMDEX_RPC_URL` is actually connected to `DREAMDEX_CHAIN_ID` and will stop early if they mismatch.
- On startup, the bot also prints warnings for side-filter/threshold combinations that would otherwise surprise you.
- In `marketMaker` strategy mode, the bot warns if you try to run one-sided quoting or HTTP execution on Shannon.
- In `grid` strategy mode, the bot trades around a reference price using fixed quote clips and live wallet-seeded inventory.

## Testnet Notes

The newer DreamDEX docs currently show a testnet/staging environment for **Somnia Shannon**:
- testnet chain ID: `50312`
- documented staging REST base: `https://stg.api.dreamdex.io`
- documented staging WS base: `wss://stg.api.dreamdex.io/v0/ws/public`
- testnet `WETH:USDso` SpotPool: `0xD180195da5459C7a0DEA188ed61216ec43682b50`
- testnet `WBTC:USDso` SpotPool: `0x3605f28aA7C50e7441211e77Cb0762d49539326C`
- testnet `SOMI:USDso` SpotPool: `0x259fD6559214dd5aD3752322426eA9F9fABEFff4`

The docs are a little inconsistent because the testnet-oriented pages expose staging API server entries, while some quick-start examples still use the mainnet host. For now, this starter is configured around the documented staging endpoints in `/Users/0xmumin/Documents/projects/hackathons/sominia/trading/.env.example`.

## Important DreamDEX notes

Based on the current docs:
- Chain ID is `5031` on Somnia mainnet.
- Chain ID is `50312` on Somnia Shannon testnet.
- Private HTTP endpoints use SIWE auth and `Authorization: Bearer <token>`.
- The order endpoint returns an unsigned EVM transaction, not a confirmed order.
- Wallet funding only supports IOC or FOK.
- Resting GTC/PostOnly orders require vault funding.
- If token allowance is insufficient, the API may return an `approval` transaction that must be sent first.

## Useful env vars

- `DREAMDEX_SYMBOL`: market symbol like `WETH:USDso`
- `DREAMDEX_STRATEGY`: `threshold`, `marketMaker`, `minuteRebalance`, or `grid`
- `DREAMDEX_EXECUTION_MODE`: `http` or `contract`
- `DREAMDEX_CHAIN_ID`: `5031` for mainnet or `50312` for Shannon testnet
- `DREAMDEX_ORDER_AMOUNT`: base asset quantity to trade
- `DREAMDEX_ALLOWED_SIDE`: `buy`, `sell`, or `both`
- `DREAMDEX_BUY_BELOW_PRICE`: trigger level for buys
- `DREAMDEX_SELL_ABOVE_PRICE`: trigger level for sells
- `DREAMDEX_EXPIRE_SECONDS`: optional order expiry window used by contract mode, `0` for no expiry
- `DREAMDEX_DRY_RUN`: `true` or `false`
- `DREAMDEX_PERSISTENCE_DIR`: where bot state and execution journals are stored
- `DREAMDEX_MM_STARTING_QUOTE_BALANCE_QUOTE`: quote inventory assumption for market-maker mode
- `DREAMDEX_MM_STARTING_BASE_BALANCE`: starting SOMI/base inventory assumption for market-maker mode
- `DREAMDEX_MM_QUOTE_SIZE_QUOTE`: per-trade notional in quote units for market-maker mode
- `DREAMDEX_MM_TARGET_BASE_INVENTORY_QUOTE`: preferred amount of base inventory, measured in quote value
- `DREAMDEX_MM_MAX_BASE_INVENTORY_QUOTE`: max base inventory before buy signals are suppressed
- `DREAMDEX_MM_MIN_SPREAD_BPS`: minimum live spread needed before market-maker mode does anything
- `DREAMDEX_MM_TARGET_HALF_SPREAD_BPS`: how far away from the anchor the market-maker wants each side to trade
- `DREAMDEX_MM_INVENTORY_SKEW_BPS`: how strongly the anchor thresholds lean toward rebuilding the short side
- `DREAMDEX_MM_MAX_SESSION_LOSS_QUOTE`: estimated mark-to-market loss cap before the market-maker pauses itself
- `DREAMDEX_GRID_TRADE_SIZE_QUOTE`: quote notional per grid trade
- `DREAMDEX_GRID_STEP_BPS`: distance between buy/sell grid steps
- `DREAMDEX_GRID_MAX_SPREAD_BPS`: skip trading if live spread is wider than this
- `DREAMDEX_GRID_MAX_LONG_QUOTE`: cap on tradable SOMI inventory value

Threshold env vars only matter when `DREAMDEX_STRATEGY=threshold`.

## Sell Native SOMI Only

For a wallet-funded native SOMI sell test on Shannon testnet, a good starting setup is:

```env
DREAMDEX_SYMBOL=SOMI:USDso
DREAMDEX_EXECUTION_MODE=contract
DREAMDEX_FUNDING_SOURCE=wallet
DREAMDEX_ORDER_TYPE=immediateOrCancel
DREAMDEX_ALLOWED_SIDE=sell
DREAMDEX_BUY_BELOW_PRICE=0
DREAMDEX_SELL_ABOVE_PRICE=0.1709
```

Notes:

- native SOMI wallet sells use `msg.value` directly
- no ERC-20 approval is needed to sell native SOMI
- if you accidentally leave a large buy threshold set, the bot will now warn you when `DREAMDEX_ALLOWED_SIDE=sell`

## Extending this bot

Good next upgrades:
- add real resting maker order placement with vault funding plus cancel/replace loops
- sync wallet and vault balances directly instead of relying on fill reconciliation plus configured starting inventory
- persist pnl, equity curve, and per-trade stats
- add a rebalance mode and a trend mode alongside the current threshold and market-maker strategies
- add explicit kill-switches for max daily volume, max failed orders, and stale-orderbook conditions
