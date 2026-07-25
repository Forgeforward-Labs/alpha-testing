import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC_URL =
  process.env.MAINNET_RPC_URL ??
  process.env.DREAMDEX_RPC_URL ??
  'https://api.infra.mainnet.somnia.network';
const CHAIN_ID = parseInt(
  process.env.MAINNET_CHAIN_ID ?? process.env.DREAMDEX_CHAIN_ID ?? '5031',
);
const PK = process.env.MAINNET_BOT_PK ?? process.env.DREAMDEX_PRIVATE_KEY ?? '';
// authNonce = txNonce + offset; use the same env var as scalper
const AUTH_NONCE_OFFSET = parseInt(
  process.env.SCALPER_AUTH_NONCE_OFFSET ?? '1',
);

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as Address;

async function main() {
  if (!PK) {
    console.error('Set MAINNET_BOT_PK or DREAMDEX_PRIVATE_KEY');
    process.exit(1);
  }

  const chain = defineChain({
    id: CHAIN_ID,
    name: 'Somnia',
    nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

  const account = privateKeyToAccount(
    (PK.startsWith('0x') ? PK : `0x${PK}`) as Hex,
  );
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(RPC_URL),
  });

  console.log(`Wallet  : ${account.address}`);
  console.log(`Chain   : ${CHAIN_ID}  RPC: ${RPC_URL}`);

  // Check current delegation
  const code = await publicClient.getBytecode({ address: account.address });
  const codeHex = code ?? '0x';
  console.log(`Code    : ${codeHex}`);

  if (!codeHex.startsWith('0xef0100') || codeHex.length < 48) {
    console.log('No EIP-7702 delegation found — nothing to clear.');
    return;
  }

  const implAddr = `0x${codeHex.slice(8, 48)}`;
  console.log(`Delegated to: ${implAddr}`);

  const txNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: 'pending',
  });
  const authNonce = txNonce + AUTH_NONCE_OFFSET;
  const rawGasPrice = await publicClient.getGasPrice();
  const gasPrice = rawGasPrice > 2_000_000_000n ? rawGasPrice : 2_000_000_000n;

  console.log(
    `Nonce   : tx=${txNonce} auth=${authNonce} (offset=${AUTH_NONCE_OFFSET})`,
  );
  console.log(`GasPrice: ${gasPrice / 1_000_000_000n} gwei`);
  console.log('Sending clear-delegation SetCodeTx (contractAddress=0x0000...)');

  // contractAddress = ZERO_ADDR → EIP-7702 clears the account's delegated code
  const auth = await walletClient.signAuthorization({
    // account,
    contractAddress: ZERO_ADDR,
    // nonce: authNonce,
  });

  // to = account.address (not zeroAddress — Sominia nodes reject to=0x0000... with 0x08)
  // The outer call goes to the wallet which now has no code (delegation cleared before
  // outer call executes) → succeeds as a plain EOA-to-EOA call.
  let txHash: Hex;
  try {
    txHash = await walletClient.sendTransaction({
      account,
      authorizationList: [auth],
      to: account.address,
      data: '0x',
      gas: 100_000n,
      nonce: txNonce,
      // maxFeePerGas: gasPrice + 2_000_000_000n,
      // maxPriorityFeePerGas: 0n,
      // chain: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Sominia returns data=0x08 whenever contractAddress=0x0000... appears in the
    // authorization list — the network does not support EIP-7702 delegation clearing.
    if (msg.includes('0x08') || msg.includes('invalid transaction')) {
      console.error(
        '\n[UNSUPPORTED] Sominia rejected the clear-delegation tx (data=0x08).',
      );
      console.error(
        'The network does not honour contractAddress=0x0000... in the auth list.',
      );
      console.error('\nWorkarounds:');
      console.error(
        '  1. Move funds to a fresh wallet (new private key, no delegation)',
      );
      console.error(
        '  2. Re-delegate to a no-op contract — suppresses BatchTrader behaviour',
      );
      console.error(
        '     but 0xef0100 prefix stays in code until Somnia enables clearing',
      );
      process.exit(1);
    }
    throw err;
  }

  console.log(`SetCodeTx: ${txHash}`);
  console.log('Waiting for receipt...');

  const deadline = Date.now() + 30_000;
  let receipt = null;
  while (Date.now() < deadline) {
    receipt = await publicClient
      .getTransactionReceipt({ hash: txHash })
      .catch(() => null);
    if (receipt) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!receipt) {
    console.error('Timeout — no receipt after 30s');
    process.exit(1);
  }

  console.log(`Receipt : status=${receipt.status} gas=${receipt.gasUsed}`);

  const newCode = await publicClient.getBytecode({ address: account.address });
  const newCodeHex = newCode ?? '0x';
  console.log(`New code: ${newCodeHex || '(empty)'}`);

  if (!newCodeHex || newCodeHex === '0x') {
    console.log('Delegation cleared successfully.');
  } else if (newCodeHex.startsWith('0xef0100')) {
    console.error(
      `Delegation still active after tx — chain may not support clearing via impl=0x0. Code: ${newCodeHex}`,
    );
    process.exit(1);
  } else {
    console.log(`Account now has non-delegation code: ${newCodeHex}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
