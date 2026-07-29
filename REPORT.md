# Trading Strategy Report

A record of building and tuning two distinct volume strategies on DreamDEX (Somnia mainnet): a passive maker bot and an EIP-7702 taker scalper.

---

## Strategy 1: Market Making (Passive Maker)

### The Approach

Instead of paying the spread as a taker on every cycle, the market maker rests PostOnly orders on both sides of the book and waits for someone else to cross. When a fill happens, the spread is earned rather than paid.

- **Pair:** `USDC.e:USDso` by default — a stable/stable pair pinned near $1.0000 with near-zero price risk between fills
- **Order type:** `PostOnly` — guaranteed never to cross (a crossing PostOnly is rejected, not filled as taker)
- **Funding:** vault — required for resting limit orders; wallet-funded orders are IOC/FOK only
- **Requote logic:** quotes are left in place until mid drifts past `MM_REQUOTE_TRIGGER_BPS` (default 3bps), saving gas on unnecessary cancel/replace cycles
- **Inventory skew:** if base inventory exceeds `MM_TARGET_INVENTORY_USDSO`, both quotes shift down, increasing sell pressure and reducing buy exposure proportional to the imbalance

### Configuration Used

| Parameter | Default | Effect |
|---|---|---|
| `MM_HALF_SPREAD_BPS` | 5 | Each quote sits 5bps from mid; total captured spread = 10bps |
| `MM_NOTIONAL_USDSO` | 20 | $20 per side |
| `MM_INVENTORY_SKEW_BPS` | 4 | 4bps lean per 1× notional of imbalance |
| `MM_REQUOTE_TRIGGER_BPS` | 3 | Only move quotes once mid has drifted ≥3bps |
| `MM_MAX_BOOK_SPREAD_BPS` | 50 | Skip quoting if the book's own spread is too wide |

### Key Insight

The USDC.e:USDso market has a fixed 4bps bid-ask spread (4-tick minimum on a $1 asset). A maker quoting at 5bps half-spread captures 10bps when filled — which more than covers the spread cost. The taker scalper on the same pair pays that 4bps every cycle; the maker earns it. For a volume competition this is the capital-efficient path: fills generate volume at near-zero or negative cost, not at a loss.

The main risk is that fills are not guaranteed — volume only accumulates when someone else crosses the quote. Fill rate depends on how competitive the quoted price is relative to other resting orders.

---

## Strategy 2: EIP-7702 Taker Scalper

Two EIP-7702 volume scalpers that bundle a complete buy→sell round-trip into a single type-4 transaction. The EOA temporarily delegates to an on-chain impl contract for the duration of the tx — no vault deposit needed, no pre-approval per cycle, gas paid in SOMI once per trade.

| Script | Contract | Behaviour on empty buy |
|---|---|---|
| `scalper.ts` | `DreamDexVolumeBatch7702` (`atomicRoundTrip`) | Never reverts — emits `RoundTrip(bought=0)` and skips sell |
| `scalper-batch.ts` | `BatchTrader` (`executeBatch`) | Reverts with `BuyRejected` / `NoCyclesCompleted` |

Both support multi-pair trading (WETH:USDso, WBTC:USDso, USDC.e:USDso) and configurable cycle counts per transaction.

---

## EIP-7702 Mechanics

- Each transaction is a **type-4 tx** carrying an `authorizationList`: a self-signed tuple `(chainId, implAddr, nonce)` that tells the chain "for this tx, my EOA behaves as `implAddr`"
- `address(this)` inside the impl resolves to the **EOA**, not the deployed contract — token balances, approvals, and vault positions all live on the EOA
- **Two nonces consumed per tx**: the tx nonce and the auth nonce (`authNonce = txNonce + 1`). Nonce management must account for this or subsequent transactions will fail
- A single `MaxUint256` token approval at startup eliminates per-cycle approval overhead — since `address(this) = EOA`, the approval is durable across all future delegations to the same impl

---

## Key Finding: Buy Orders Not Filling

The first version of the scalper submitted buy orders at `ob.ask` (exact snapshot price). On Somnia mainnet, by the time the tx is included the ask had moved — the IOC buy filled 0. The trade succeeded (no revert, gas consumed, Transfer events absent from explorer) but produced no economic activity.

**Fix:** Cross the spread by `CROSS_BPS` (default 10bps) above the snapshot ask:

```ts
const buyPrice = roundTick(ob.ask * (1 + CROSS_BPS / 10_000), p.tickSize);
```

In a limit order book the buy fills at the maker's ask price, not our limit — so crossing adds no cost when liquidity sits at the ask. It only changes whether the order fills at all if the ask moves between snapshot and inclusion.

---

## Market Microstructure Findings

Actual spread ranges observed on mainnet during trading sessions:

| Pair | Observed spread | Mid price | Spread bps | Loss/$1k |
|---|---|---|---|---|
| WETH:USDso | $0.14 – $0.26 | ~$1,855 | 0.8 – 1.4 bps | ~$0.04 – $0.07 |
| WBTC:USDso | $4.4 – $11.0 | ~$63,960 | 0.7 – 1.7 bps | ~$0.03 – $0.09 |
| USDC.e:USDso | $0.0004 (fixed) | $1.0000 | **4 bps** | **$0.20** |

USDC.e is the worst pair despite being a stablecoin. The DreamDEX minimum tick of $0.0001 means the tightest possible bid-ask is $0.0002, but in practice the book rests at a $0.0004 (4-tick) spread. At a $1 mid, that 4bps spread costs $0.20 per $1k traded — three times worse than WETH or WBTC.

**Loss/$1k formula** (per round-trip, ignoring gas):

```
Loss/$1k = spread / (2 × mid) × 1000
```

Since IOC fills at the maker's price, the `CROSS_BPS` overpay on the limit price does not contribute to the spread loss — it only affects fill probability.

---

## Spread Cap Tuning

Initial spread caps (`maxSpreadUSD`) were set too tight relative to real market conditions, causing the bot to sit idle:

| Pair | Initial cap | Real spread | Effect |
|---|---|---|---|
| WETH | $0.01 | $0.14 – $0.26 | Never traded |
| WBTC | $4.00 | $4.4 – $11.0 | Rarely traded |
| USDC.e | $0.001 | $0.0004 | Always traded |

Result: USDC.e dominated volume at $0.20/$1k while WETH and WBTC — which are far cheaper to trade — sat idle.

**Corrected caps:** WETH → $0.25, WBTC → $7.0, USDC.e → disabled.

---

## Sell Price: 1-Tick Is Optimal

The sell leg uses an IOC limit at 1 tick (`p.tickSize`), which is effectively a market sell. This is optimal:

- The IOC fill price equals `ob.bid` regardless of the limit — your limit is a floor, not the execution price
- Setting `sellPrice = ob.bid - buffer` is equivalent but worse: it still fills at `ob.bid` but rejects if the bid drops more than `buffer` ticks between snapshot and inclusion
- `sellPrice = 1 tick` accepts any bid above zero — no limit on how far the bid can move

A `sellBuffer` field was implemented in the `PairInfo` struct but correctly never applied. The 1-tick approach already handles block-inclusion delay more aggressively than any fixed buffer.

---

## Observed Performance

Sample from a stable run (USDC.e disabled, WETH max spread $0.20, WBTC max spread $4.0):

```
Trades=50  Vol=$16,628  TotalPnL=$-1.7786  Loss/$1k=$0.107  Runtime=8m
```

Breakdown from that session:
- USDC.e trades: Loss/$1k = $0.1999 (fixed — spread minimum on $1 asset)
- WETH trades (Cycles=1): Loss/$1k ≈ $0.073 early, dropping to $0.005 as spread tightened
- WETH trades (Cycles=2): Loss/$1k ≈ $0.027 – $0.070 depending on spread at execution time
- WBTC trades (Cycles=2): Loss/$1k ≈ $0.023 – $0.048

---

## Operational Notes

- **Redeploy cost:** Each fresh `BatchTrader` deploy costs ~9.4M gas. Persisting the deployed address in `SCALPER_BATCH_IMPL_ADDR` eliminates this on restart.
- **Nonce consumption:** At 2 nonces per tx and ~3s block time, nonce exhaustion is not a concern for the current trade frequency, but nonce management must be explicit — the SDK cannot derive the auth nonce from the tx nonce without knowing the offset.
- **Token balance reads:** On mainnet, some ERC-20 `balanceOf` calls return empty data for addresses with no deployed code (relevant on testnet clones). Wrapping in try-catch and defaulting to 0 is sufficient for equity tracking.

---

## What Would Improve It

1. **Multi-wallet rotation** — a single wallet serialises all txs. Sharding across N wallets could multiply throughput by N at the cost of capital fragmentation.
2. **Dynamic cycle count** — currently `maxCycles` is computed from balance. A tighter model that estimates gas cost per additional cycle vs spread capture would cap cycles more precisely.
3. **Per-pair CROSS_BPS** — stable pairs like USDC.e need less crossing headroom than volatile assets. A 2bps cross on USDC.e would still fill reliably given the predictable $0.0004 spread.
4. **Spread forecasting** — WBTC spread oscillates between $4 and $11. A simple moving average of recent spread observations could improve when to enter vs wait.
