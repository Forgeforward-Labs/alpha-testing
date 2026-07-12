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

  const isNativeBase  = market.symbol.startsWith('SOMI:');

  const safeErc20 = async (token: string): Promise<bigint> => {
    try { return await signer.getErc20Balance(token); } catch { return 0n; }
  };

  const [freeBase, freeQuote, walletBase, walletQuote, nativeSomi, locked] = await Promise.all([
    vault.getVaultBalance(market.base),
    vault.getVaultBalance(market.quote),
    isNativeBase ? signer.getNativeBalance() : safeErc20(market.base),
    safeErc20(market.quote),
    signer.getNativeBalance(),        // always show SOMI gas balance
    vault.getLockedBalance(),
  ]);

  const totalVaultBase  = freeBase  + locked.lockedBase;
  const totalVaultQuote = freeQuote + locked.lockedQuote;

  let openOrders: Awaited<ReturnType<typeof http.listOrders>> = [];
  try {
    openOrders = await http.listOrders(market.symbol, 'open');
  } catch {
    // endpoint may not exist or use a different status param — show what we got
  }

  const [b, q] = market.symbol.split(':');
  const fmt = (v: bigint, dec: number) => formatUnits(v, dec);

  console.log(`Market : ${market.symbol}`);
  console.log(`Wallet : ${config.walletAddress}`);
  console.log('');
  console.log('Vault');
  console.log(`  ${b.padEnd(8)}: ${fmt(totalVaultBase, market.baseDecimals).padStart(18)}  (free: ${fmt(freeBase, market.baseDecimals)}  locked: ${fmt(locked.lockedBase, market.baseDecimals)})`);
  console.log(`  ${q.padEnd(8)}: ${fmt(totalVaultQuote, market.quoteDecimals).padStart(18)}  (free: ${fmt(freeQuote, market.quoteDecimals)}  locked: ${fmt(locked.lockedQuote, market.quoteDecimals)})`);
  console.log('');
  console.log('Wallet');
  console.log(`  ${b.padEnd(8)}: ${fmt(walletBase, market.baseDecimals)}`);
  console.log(`  ${q.padEnd(8)}: ${fmt(walletQuote, market.quoteDecimals)}`);
  if (!isNativeBase) {
    console.log(`  ${'SOMI'.padEnd(8)}: ${fmt(nativeSomi, 18)}  (gas)`);
  }
  console.log('');
  if (openOrders.length === 0) {
    console.log('Open orders: none');
  } else {
    console.log(`Open orders (${openOrders.length})`);
    const col = (s: string, w: number) => s.padEnd(w);
    console.log(`  ${col('ID', 24)} ${col('SIDE', 5)} ${col('PRICE', 12)} ${col('AMOUNT', 12)} REMAINING`);
    for (const o of openOrders) {
      console.log(
        `  ${col(o.id, 24)} ${col(o.side.toUpperCase(), 5)} ${col(o.price, 12)} ${col(o.amount, 12)} ${o.remaining}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
