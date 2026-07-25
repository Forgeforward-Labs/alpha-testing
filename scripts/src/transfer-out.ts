import 'dotenv/config';
import { Wallet, Contract, formatUnits, JsonRpcProvider } from 'ethers';
import { DreamDexHttpClient } from '@trading/sdk';
import { config } from './config.js';

// Transfer base + quote wallet balances to another address.
// Usage: TRANSFER_TO=0x... npx tsx src/transfer-out.ts

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

async function main(): Promise<void> {
  const to = process.env.TRANSFER_TO;
  if (!to) throw new Error('Set TRANSFER_TO=0x<address>');
  if (!/^0x[0-9a-fA-F]{40}$/.test(to))
    throw new Error(`Invalid address: ${to}`);

  const provider = new JsonRpcProvider(config.rpcUrl);
  const signer = new Wallet(config.privateKey, provider);

  const http = new DreamDexHttpClient(
    config.baseUrl,
    new Wallet(config.privateKey),
    config.chainId,
    config.siweDomain,
    config.siweUri,
  );
  const markets = await http.listMarkets();
  const market = markets.find((m) => m.symbol === config.symbol);
  if (!market) throw new Error(`Market not found: ${config.symbol}`);

  const [baseName, quoteName] = market.symbol.split(':') as [string, string];
  const isNativeBase = market.symbol.startsWith('SOMI:');

  const tokens = [
    { name: quoteName, address: market.quote, decimals: market.quoteDecimals },
    ...(!isNativeBase
      ? [
          {
            name: baseName,
            address: market.base,
            decimals: market.baseDecimals,
          },
        ]
      : []),
  ];

  console.log(`From : ${signer.address}`);
  console.log(`To   : ${to}`);
  console.log(`Market: ${market.symbol}\n`);

  for (const token of tokens) {
    const erc20 = new Contract(token.address, ERC20_ABI, signer);
    const balance = (await erc20.balanceOf(signer.address)) as bigint;
    const human = formatUnits(balance, token.decimals);

    if (balance === 0n) {
      console.log(`${token.name.padEnd(8)}: 0 — skip`);
      continue;
    }

    console.log(`${token.name.padEnd(8)}: transferring ${human}...`);
    const tx = await erc20.transfer(to, balance);
    const receipt = await tx.wait();
    console.log(`${token.name.padEnd(8)}: ✓  tx=${receipt.hash}`);
  }

  if (isNativeBase) {
    console.log(
      '\nNote: SOMI is native gas — not transferred. Send manually if needed.',
    );
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
