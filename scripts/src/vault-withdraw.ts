import 'dotenv/config';
import { Wallet, formatUnits } from 'ethers';
import { DreamDexHttpClient, TransactionExecutor, VaultManager } from '@trading/sdk';
import { config } from './config.js';

async function main(): Promise<void> {
  const wallet = new Wallet(config.privateKey);
  const http = new DreamDexHttpClient(
    config.baseUrl, wallet, config.chainId, config.siweDomain, config.siweUri,
  );
  const signer = new TransactionExecutor(config.rpcUrl, config.privateKey, config.chainId);

  const markets = await http.listMarkets();
  const market = markets.find((m) => m.symbol === config.symbol);
  if (!market) throw new Error(`Market not found: ${config.symbol}`);

  const vault = new VaultManager(signer, market.contract);
  const [b, q] = market.symbol.split(':');

  const [freeBase, freeQuote] = await Promise.all([
    vault.getVaultBalance(market.base),
    vault.getVaultBalance(market.quote),
  ]);

  console.log(`Market  : ${market.symbol}`);
  console.log(`Wallet  : ${config.walletAddress}`);
  console.log('');
  console.log('Free vault balances (withdrawable):');
  console.log(`  ${b.padEnd(8)}: ${formatUnits(freeBase, market.baseDecimals)}`);
  console.log(`  ${q.padEnd(8)}: ${formatUnits(freeQuote, market.quoteDecimals)}`);
  console.log('');

  if (freeBase === 0n && freeQuote === 0n) {
    console.log('Nothing to withdraw (locked funds stay in vault until orders fill/cancel).');
    return;
  }

  console.log('Withdrawing all free balances...');
  await vault.withdrawAll(market);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
