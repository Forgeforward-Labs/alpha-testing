# DreamDEX Developer Feedback

Feedback from building a production-grade trading bot on DreamDEX (Somnia Shannon testnet) during the Alpha Trading Competition. Written from the perspective of a developer integrating against the API from scratch.

---

## Overview

Overall the DreamDEX API is well-structured and the dual execution path (HTTP-prepared vs direct contract) is a thoughtful design that gives developers real flexibility. The SIWE authentication flow is standard and easy to implement. Getting a first order on-chain took under an hour from a clean start.

The issues below are integration-level friction points, not fundamental problems. They are worth addressing before the full launch because they will slow down new developers significantly.

---

## Issues Encountered

### 1. Order book frequently empty across both WebSocket and REST

**What happened:** During trading sessions the order book would regularly be completely empty on one or both sides for minutes at a time. This affected both the WebSocket feed and the `GET /v0/orderbook` REST endpoint simultaneously — it was not a streaming reconnect issue but a genuine state where no resting orders existed on the exchange. The bot's spread guard correctly skipped trading during these windows, but the grid strategy could not determine a reference price and buy/sell triggers never fired.

**Impact:** Any bot that relies on live book data for pricing is effectively blind during these windows. For volume-based competitions this directly hurts participants who depend on the order book rather than fixed-price strategies. Bots that use the REST endpoint as a fallback to the WebSocket are equally affected since both reflect the same empty state.

**Suggestion:**
- Surface a "last known mid price" or "reference price" in the market metadata endpoint so bots can fall back gracefully
- Consider a minimum liquidity guarantee during competition windows to keep the book usable for participants
- Document the expected book state clearly — is an empty book a known limitation or a resolvable gap?

---

### 2. Setting `expiresAt = 0` returns an error

**What happened:** The contract's `placeOrder` function accepts an `expiresAt` parameter. Setting it to `0` (intending "no expiry") caused the transaction to revert on both testnet and mainnet. The behaviour is consistent across environments — `0` is simply not accepted as a valid expiry value.

**Workaround implemented:** The bot substitutes a 1-hour expiry (`Math.floor(Date.now() / 1000) + 3600`) whenever `DREAMDEX_EXPIRE_SECONDS=0` is configured.

**Impact:** This is not documented anywhere in the current API or contract reference. Developers on both testnet and mainnet will hit this with no indication of why their transaction reverted. The RPC error message is generic and gives no hint that the expiry parameter is the cause.

**Suggestion:**
- Document the minimum valid `expiresAt` value (or that `0` is not a valid no-expiry sentinel)
- Consider using `type(uint256).max` as the canonical no-expiry value and documenting it
- Alternatively, handle `0` in the contract as "no expiry" — this is the most intuitive behaviour for developers

---

### 3. Docs inconsistency between staging and mainnet examples

**What happened:** Quick-start examples in some docs sections use the mainnet API host (`api.dreamdex.io`) while the testnet/Shannon section references `stg.api.dreamdex.io`. Copy-pasting examples into a testnet project silently sent requests to mainnet.

**Suggestion:** Add a clear environment selector or banner to the docs. Prefix all code examples with the relevant environment variable block.

---

### 4. `placeTakerOrderWithoutVault` vs `placeOrder` distinction not prominently documented

**What happened:** The difference between the two contract entry points is critical for bot developers — wallet-funded orders must use `placeTakerOrderWithoutVault` (IOC/FOK only), while vault-funded resting orders use `placeOrder`. This distinction was discovered by reading contract ABI comments rather than from the main documentation.

**Suggestion:** Add a one-page contract integration guide that explicitly maps funding source + order type to the correct function, including the vault deposit/withdraw flow.

---

## What Worked Well

- **Dual execution modes** (HTTP and direct contract) are genuinely useful. Being able to bypass the private API and call SpotPool directly made it easy to build a contract-native execution path.
- **SIWE authentication** is straightforward and the nonce/login endpoints behave exactly as documented.
- **Market metadata** (`GET /v0/markets`) is comprehensive — tick size, lot size, min quantity, contract address, and decimals in one call. This is exactly what a bot needs at startup.
- **WebSocket order book** is low-latency and the snapshot/update message types are easy to reconstruct a local book from.
- **`getWithdrawableBalance`** on the SpotPool contract is a clean way to check vault state without depending on any API endpoint. Appreciated for offline/contract-native workflows.

---

## Suggestions Summary

| Priority | Suggestion |
|---|---|
| High | Document that `expiresAt = 0` is invalid; provide the canonical no-expiry pattern |
| High | Add a contract integration guide: funding source → order type → function mapping |
| Medium | Surface a fallback reference price in the market API for empty-book conditions |
| Medium | Fix docs environment inconsistency (staging vs mainnet examples) |
| Low | Add a minimum book depth SLA or disclosure for testnet |

---

## Build context

- **Repo:** pnpm + Turbo monorepo with `@trading/sdk`, `@trading/grid-bot`, `@trading/scripts`, `@trading/dashboard`
- **Strategies tested:** grid, market-maker, minute-rebalance, threshold
- **Execution modes tested:** both `http` and `contract`
- **Vault features tested:** `deposit`, `depositNative`, `withdraw`, `getWithdrawableBalance`
- **Competition result:** Top 3 on the leaderboard at time of writing
