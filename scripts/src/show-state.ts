import { config } from './config.js';
import { BotStateStore } from '@trading/sdk';

async function main(): Promise<void> {
  const store = await BotStateStore.open(config.persistenceDir, {
    symbol: config.symbol,
    strategy: config.strategy,
    executionMode: config.executionMode,
  });

  console.log(`[state] Snapshot file: ${store.getStatePath()}`);
  console.log(`[state] Journal file: ${store.getJournalPath()}`);
  console.log(JSON.stringify(store.getSnapshot(), null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
