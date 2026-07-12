import 'dotenv/config';
import { Wallet } from 'ethers';
import { config } from './config.js';
import { DreamDexHttpClient, TransactionExecutor } from '@trading/sdk';

async function main(): Promise<void> {
  const wallet = new Wallet(config.privateKey);
  const http = new DreamDexHttpClient(
    config.baseUrl, wallet, config.chainId, config.siweDomain, config.siweUri,
  );
  const signer = new TransactionExecutor(config.rpcUrl, config.privateKey, config.chainId);

  // Optional: filter to a specific symbol via DREAMDEX_SYMBOL, or cancel all markets.
  const symbolFilter = process.env.CANCEL_ALL_MARKETS === 'true' ? undefined : [config.symbol];

  console.log(symbolFilter
    ? `[cancel] Fetching open orders for ${symbolFilter[0]}...`
    : '[cancel] Fetching open orders across all markets...',
  );

  const openOrders = await http.listAllOrders(symbolFilter, 'open', 1000);

  if (openOrders.length === 0) {
    console.log('[cancel] No open orders found.');
    return;
  }

  console.log(`[cancel] Found ${openOrders.length} open order(s).\n`);

  let cancelled = 0;
  let failed = 0;

  for (const order of openOrders) {
    process.stdout.write(
      `[cancel] ${order.side.toUpperCase()} ${order.remaining}/${order.amount} @ ${order.price}  id=${order.id}  symbol=${order.symbol} ... `,
    );

    try {
      const tx = await http.prepareCancel(order.symbol, order.id);
      const txHash = await signer.sendPreparedTransaction(tx);
      console.log(`done  tx=${txHash}`);
      cancelled++;
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }

  console.log(`\n[cancel] Done. Cancelled=${cancelled} Failed=${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
