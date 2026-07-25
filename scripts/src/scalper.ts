import 'dotenv/config';
import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// --- Config ---
const RPC_URL =
  process.env.MAINNET_RPC_URL ??
  process.env.DREAMDEX_RPC_URL ??
  'https://api.infra.mainnet.somnia.network';
const API_URL =
  process.env.MAINNET_API_URL ??
  process.env.DREAMDEX_BASE_URL ??
  'https://api.dreamdex.io';
const CHAIN_ID = parseInt(
  process.env.MAINNET_CHAIN_ID ?? process.env.DREAMDEX_CHAIN_ID ?? '5031',
);
const PK = process.env.MAINNET_BOT_PK ?? process.env.DREAMDEX_PRIVATE_KEY ?? '';
const POLL_MS = parseInt(process.env.SCALPER_POLL_MS ?? '50');
const RECEIPT_TIMEOUT_S = parseInt(process.env.SCALPER_RECEIPT_TIMEOUT ?? '15');
const MAX_BATCH = parseInt(process.env.SCALPER_MAX_BATCH ?? '50');
const SCALPER_IMPL_ADDR = process.env.SCALPER_IMPL_ADDR ?? '';
// Cross the spread: buy above ask so the IOC fills even if ask moves slightly before inclusion
const CROSS_BPS = parseFloat(process.env.SCALPER_CROSS_BPS ?? '10');

if (!PK) {
  console.error('[scalper] Set MAINNET_BOT_PK or DREAMDEX_PRIVATE_KEY');
  process.exit(1);
}

// DreamDexVolumeBatch7702 bytecode — selector 0x799b4396
// atomicRoundTrip(address pool, address quoteToken, address baseToken,
//                 uint256 buyPrice, uint256 sellPrice, uint256 quantity,
//                 uint64 expireTimestampNs)
// TX always succeeds even if buy fills 0 (sell skipped, RoundTrip event emitted).
// Only reverts if a buy fills but the sell is rejected.
const CREATION_BYTECODE =
  '0x6080604052348015600e575f80fd5b50610ab08061001c5f395ff3fe608060405260043610610021575f3560e01c8063799b43961461002c57610028565b3661002857005b5f80fd5b348015610037575f80fd5b50610052600480360381019061004d9190610583565b610054565b005b5f8211801561006257505f84115b801561006d57505f83115b6100ac576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016100a39061067a565b60405180910390fd5b8573ffffffffffffffffffffffffffffffffffffffff1663095ea7b3887fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6040518363ffffffff1660e01b81526004016101079291906106b6565b6020604051808303815f875af1158015610123573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101479190610712565b508473ffffffffffffffffffffffffffffffffffffffff1663095ea7b3887fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6040518363ffffffff1660e01b81526004016101a39291906106b6565b6020604051808303815f875af11580156101bf573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101e39190610712565b505f8573ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b815260040161021e919061073d565b602060405180830381865afa158015610239573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061025d919061076a565b905061026d886001878686610366565b5f818773ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b81526004016102a8919061073d565b602060405180830381865afa1580156102c3573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906102e7919061076a565b6102f191906107c2565b90505f81111561030957610308895f878487610366565b5b8873ffffffffffffffffffffffffffffffffffffffff167fef370973be5a05a46417a3c04a1659ccc3716ae5840f2170d931d39b07ac99bc828888604051610353939291906107f5565b60405180910390a2505050505050505050565b5f8573ffffffffffffffffffffffffffffffffffffffff16634e978373865f87878760025f805f6040518a63ffffffff1660e01b81526004016103b1999897969594939291906108ec565b60408051808303815f875af11580156103cc573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906103f091906109bc565b5090508085610434576040518060400160405280600d81526020017f73656c6c2072656a65637465640000000000000000000000000000000000000081525061046b565b6040518060400160405280600c81526020017f6275792072656a656374656400000000000000000000000000000000000000008152505b906104ac576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016104a39190610a5a565b60405180910390fd5b50505050505050565b5f80fd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6104e2826104b9565b9050919050565b6104f2816104d8565b81146104fc575f80fd5b50565b5f8135905061050d816104e9565b92915050565b5f819050919050565b61052581610513565b811461052f575f80fd5b50565b5f813590506105408161051c565b92915050565b5f67ffffffffffffffff82169050919050565b61056281610546565b811461056c575f80fd5b50565b5f8135905061057d81610559565b92915050565b5f805f805f805f60e0888a03121561059e5761059d6104b5565b5b5f6105ab8a828b016104ff565b97505060206105bc8a828b016104ff565b96505060406105cd8a828b016104ff565b95505060606105de8a828b01610532565b94505060806105ef8a828b01610532565b93505060a06106008a828b01610532565b92505060c06106118a828b0161056f565b91505092959891949750929550565b5f82825260208201905092915050565b7f62616420617267730000000000000000000000000000000000000000000000005f82015250565b5f610664600883610620565b915061066f82610630565b602082019050919050565b5f6020820190508181035f83015261069181610658565b9050919050565b6106a1816104d8565b82525050565b6106b081610513565b82525050565b5f6040820190506106c95f830185610698565b6106d660208301846106a7565b9392505050565b5f8115159050919050565b6106f1816106dd565b81146106fb575f80fd5b50565b5f8151905061070c816106e8565b92915050565b5f60208284031215610727576107266104b5565b5b5f610734848285016106fe565b91505092915050565b5f6020820190506107505f830184610698565b92915050565b5f815190506107648161051c565b92915050565b5f6020828403121561077f5761077e6104b5565b5b5f61078c84828501610756565b91505092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f6107cc82610513565b91506107d783610513565b92508282039050818111156107ef576107ee610795565b5b92915050565b5f6060820190506108085f8301866106a7565b61081560208301856106a7565b61082260408301846106a7565b949350505050565b610833816106dd565b82525050565b5f819050919050565b5f819050919050565b5f61086561086061085b84610839565b610842565b610546565b9050919050565b6108758161084b565b82525050565b61088481610546565b82525050565b5f60ff82169050919050565b61089f8161088a565b82525050565b5f6bffffffffffffffffffffffff82169050919050565b5f6108d66108d16108cc84610839565b610842565b6108a5565b9050919050565b6108e6816108bc565b82525050565b5f610120820190506109005f83018c61082a565b61090d602083018b61086c565b61091a604083018a610698565b61092760608301896106a7565b610934608083018861087b565b61094160a0830187610896565b61094e60c0830186610896565b61095b60e0830185610698565b6109696101008301846108dd565b9a9950505050505050505050565b5f6fffffffffffffffffffffffffffffffff82169050919050565b61099b81610977565b81146109a5575f80fd5b50565b5f815190506109b681610992565b92915050565b5f80604083850312156109d2576109d16104b5565b5b5f6109df858286016106fe565b92505060206109f0858286016109a8565b9150509250929050565b5f81519050919050565b8281835e5f83830152505050565b5f601f19601f8301169050919050565b5f610a2c826109fa565b610a368185610620565b9350610a46818560208601610a04565b610a4f81610a12565b840191505092915050565b5f6020820190508181035f830152610a728184610a22565b90509291505056fea264697066735822122019fd64f414e4d26cba61729a504c0b91f004ad841032d2fbd5559513457b7c0764736f6c634300081a0033';

const EXECUTE_SELECTOR = '799b4396';

// --- ERC-20 ABI ---
const erc20Abi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// --- Types ---
interface PairInfo {
  symbol: string;
  enabled: boolean;
  pool: string;
  base: string;
  quote: string;
  baseDecimals: number;
  lotSize: number;
  minQty: number;
  tickSize: number;
  maxSpreadUSD: number;
  minSpreadUSD: number;
  maxOrderUSD: number;
  minOrderUSD: number;
  sellBuffer: number;
  requiredConfs: number;
  confirmCount: number;
  lastBid: number;
  lastAsk: number;
}

interface OB {
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
}

type MinReceipt = {
  status: 'success' | 'reverted';
  gasUsed: bigint;
  contractAddress: Address | null | undefined;
} | null;

// --- Logging ---
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 23);
const logInfo = (tag: string, msg: string) =>
  console.log(`[${ts()}] [INFO   ] [${tag}] ${msg}`);
const logSuccess = (tag: string, msg: string) =>
  console.log(`[${ts()}] [SUCCESS] [${tag}] ${msg}`);
const logWarn = (tag: string, msg: string) =>
  console.log(`[${ts()}] [WARN   ] [${tag}] ${msg}`);
const logError = (tag: string, msg: string) =>
  console.log(`[${ts()}] [ERROR  ] [${tag}] ${msg}`);
const logBanner = (tag: string, msg: string) =>
  console.log(`[${ts()}] [BANNER ] [${tag}] ${msg}`);

// --- Global state ---
let running = true;
let nonce = -1;
let cachedGasPrice = 2_000_000_000n;
let gasPriceExpiry = 0;
let cachedUsdso = 0;
let quoteAddr = '' as Address;
let quoteDecimals = 18;

let totalTrades = 0;
let totalVolume = 0;
let initialEquity = 0;
let totalPnL = 0;
const botStart = Date.now();

let pairs: PairInfo[];
let implAddr: Address = '' as Address;

// Initialized in main()
let publicClient: ReturnType<typeof createPublicClient>;
let walletClient: ReturnType<typeof createWalletClient>;
let account: ReturnType<typeof privateKeyToAccount>;

// --- Basic helpers ---
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function roundLot(amount: number, lotSize: number): number {
  return Math.floor(amount / lotSize + 1e-9) * lotSize;
}

function roundTick(price: number, tickSize: number): number {
  return Math.round(price / tickSize + 1e-9) * tickSize;
}

// --- On-chain helpers ---
async function getBalanceFloat(
  token: Address,
  decimals: number,
): Promise<number> {
  try {
    const raw = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    return Number(formatUnits(raw, decimals));
  } catch {
    return 0;
  }
}

async function fetchGasPrice(): Promise<bigint> {
  const gp = await publicClient.getGasPrice();
  return gp > 2_000_000_000n ? gp : 2_000_000_000n;
}

async function ensureGasPrice() {
  if (Date.now() < gasPriceExpiry) return;
  try {
    cachedGasPrice = await fetchGasPrice();
  } catch {
    /* keep last */
  }
  gasPriceExpiry = Date.now() + 30_000;
}

async function getNextNonce(): Promise<number> {
  if (nonce < 0) {
    nonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'pending',
    });
  }
  const n = nonce;
  nonce += 2; // type-4 self-signed tx consumes tx nonce + auth nonce
  return n;
}

async function waitReceipt(txHash: Hex): Promise<MinReceipt> {
  const deadline = Date.now() + RECEIPT_TIMEOUT_S * 1_000;
  while (Date.now() < deadline) {
    const r = await publicClient
      .getTransactionReceipt({ hash: txHash })
      .catch(() => null);
    if (r) return r;
    await sleep(500);
  }
  return null;
}

// --- Deploy BatchTrader implementation contract ---
// Delegation is bundled into every trade tx (type-4 authorizationList).
// No separate SetCodeTx needed.
async function deployImpl(): Promise<void> {
  implAddr = SCALPER_IMPL_ADDR as Address;
  if (implAddr) {
    logInfo('deploy', `Using impl: ${implAddr} (SCALPER_IMPL_ADDR)`);
    return;
  }
  const deployNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: 'pending',
  });
  const gasPrice = await fetchGasPrice();
  logInfo(
    'deploy',
    `Deploying DreamDexVolumeBatch7702 (nonce=${deployNonce}, gasPrice=${gasPrice / 1_000_000_000n} gwei)`,
  );
  const deployHash = await walletClient.sendTransaction({
    account,
    data: CREATION_BYTECODE as Hex,
    gas: 16_000_000n,
    nonce: deployNonce,
    gasPrice,
    chain: null,
  });
  logInfo('deploy', `Deploy tx: ${deployHash}`);
  const deployReceipt = await waitReceipt(deployHash);
  if (!deployReceipt?.contractAddress || deployReceipt.status !== 'success') {
    throw new Error(
      `Deploy failed: status=${deployReceipt?.status} addr=${deployReceipt?.contractAddress} gas=${deployReceipt?.gasUsed}`,
    );
  }
  implAddr = deployReceipt.contractAddress;
  logInfo(
    'deploy',
    `DreamDexVolumeBatch7702 deployed: ${implAddr} (gas=${deployReceipt.gasUsed})`,
  );
  logInfo(
    'deploy',
    `  -> set SCALPER_IMPL_ADDR=${implAddr} in .env to skip re-deploy`,
  );
  nonce = -1;
}

// --- Calldata builder ---
// Encodes atomicRoundTrip(pool, quoteToken, baseToken, buyPrice, sellPrice, quantity, expireTimestampNs)
function buildTradeCalldata(
  p: PairInfo,
  buyPrice: number,
  sellPrice: number,
  amount: number,
): Hex {
  // Price encoding: ticks × (1e18 / ticksPerUnit)
  const ticksPerUnit = BigInt(Math.round(1 / p.tickSize));
  const tickScaled = 10n ** 18n / ticksPerUnit;
  const buyPriceWei = BigInt(Math.round(buyPrice / p.tickSize)) * tickScaled;
  const sellPriceWei = BigInt(Math.round(sellPrice / p.tickSize)) * tickScaled;

  // Amount encoding: lots × (10^baseDecimals / lotsPerUnit)
  const lotsPerUnit = BigInt(Math.round(1 / p.lotSize));
  const lotScaled = 10n ** BigInt(p.baseDecimals) / lotsPerUnit;
  const amountWei = BigInt(Math.round(amount / p.lotSize)) * lotScaled;

  // expireTimestampNs: uint64 in Solidity, ABI-padded to 32 bytes
  const deadlineWei =
    BigInt(Math.floor(Date.now() / 1000) + 3600) * 1_000_000_000n;

  const pad32addr = (addr: string) =>
    addr.toLowerCase().replace('0x', '').padStart(64, '0');
  const pad32uint = (val: bigint) => val.toString(16).padStart(64, '0');

  return ('0x' +
    EXECUTE_SELECTOR +
    pad32addr(p.pool) +
    pad32addr(quoteAddr) +
    pad32addr(p.base) +
    pad32uint(buyPriceWei) +
    pad32uint(sellPriceWei) +
    pad32uint(amountWei) +
    pad32uint(deadlineWei)) as Hex;
}

// --- Send trade tx: EIP-7702 delegation + executeBatch bundled in one type-4 tx ---
// authNonce = txNonce+1 per EIP-7702 spec (self-signed: auth validates after nonce increment).
// Consumes 2 nonces per tx: txNonce (tx) and txNonce+1 (auth).
async function sendTradeTx(
  calldata: Hex,
  gasLimit = 6_000_000n,
): Promise<MinReceipt> {
  await ensureGasPrice();
  const txN = await getNextNonce(); // increments by 2

  let txHash: Hex;
  try {
    const auth = await walletClient.signAuthorization({
      account,
      contractAddress: implAddr,
      nonce: txN + 1,
    });
    txHash = await walletClient.sendTransaction({
      account,
      authorizationList: [auth],
      to: account.address,
      data: calldata,
      gas: gasLimit,
      nonce: txN,
      maxFeePerGas: cachedGasPrice + 2_000_000_000n,
      maxPriorityFeePerGas: 0n,
      chain: null,
    });
    logInfo('tx', `submitted: ${txHash} nonce=${txN}`);
  } catch (err) {
    nonce -= 2;
    throw err;
  }

  return waitReceipt(txHash);
}

// --- Market info ---
async function fetchMarketInfo() {
  const resp = await fetch(`${API_URL}/v0/markets`);
  const body = (await resp.json()) as {
    markets: {
      symbol: string;
      contract: string;
      base: string;
      quote: string;
      baseDecimals: number;
      quoteDecimals: number;
      lotSize: string;
      minQuantity: string;
      tickSize: string;
    }[];
  };

  for (const p of pairs) {
    const m = body.markets.find((x) => x.symbol === p.symbol);
    if (!m) {
      logWarn('market', `${p.symbol} not found on this network — skipping`);
      p.enabled = false;
      continue;
    }

    p.pool = m.contract;
    p.base = m.base;
    p.quote = m.quote;
    p.baseDecimals = m.baseDecimals || 18;
    if (!quoteAddr) {
      quoteAddr = m.quote as Address;
      quoteDecimals = m.quoteDecimals || 18;
    }

    if (parseFloat(m.lotSize) > 0) p.lotSize = parseFloat(m.lotSize);
    if (parseFloat(m.minQuantity) > 0) p.minQty = parseFloat(m.minQuantity);
    if (parseFloat(m.tickSize) > 0) p.tickSize = parseFloat(m.tickSize);

    logInfo(
      'market',
      `${p.symbol}  pool=${m.contract}  lot=${p.lotSize}  tick=${p.tickSize}  minQty=${p.minQty}`,
    );
  }
}

// --- Orderbook ---
async function fetchOB(symbol: string): Promise<OB | null> {
  try {
    const resp = await fetch(`${API_URL}/v0/orderbooks?symbols=${symbol}`);
    const body = (await resp.json()) as {
      orderbooks: {
        bids: { price: string; quantity: string }[];
        asks: { price: string; quantity: string }[];
      }[];
    };
    const ob = body.orderbooks?.[0];
    if (!ob?.bids[0] || !ob?.asks[0]) return null;
    return {
      bid: parseFloat(ob.bids[0].price),
      ask: parseFloat(ob.asks[0].price),
      bidQty: parseFloat(ob.bids[0].quantity),
      askQty: parseFloat(ob.asks[0].quantity),
    };
  } catch {
    return null;
  }
}

// --- Equity (sums all base token balances at mid price) ---
async function getEquity(obs: (OB | null)[]): Promise<number> {
  const usdso =
    cachedUsdso > 0
      ? cachedUsdso
      : await getBalanceFloat(quoteAddr, quoteDecimals);
  let total = usdso;
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (!p.base) continue;
    const bal = await getBalanceFloat(p.base as Address, p.baseDecimals);
    const ob = obs[i] ?? null;
    const mid = ob ? (ob.bid + ob.ask) / 2 : 0;
    total += bal * mid;
  }
  return total;
}

// --- Trading loop (supports N pairs) ---
async function tradingLoop(initialOBs: (OB | null)[]) {
  const lastOBs: (OB | null)[] = [...initialOBs];
  let pollCount = 0;
  const STATUS_EVERY = Math.ceil(5000 / POLL_MS);

  while (running) {
    const obs = await Promise.all(
      pairs.map((p) => (p.enabled ? fetchOB(p.symbol) : Promise.resolve(null))),
    );
    for (let i = 0; i < pairs.length; i++) {
      if (obs[i]) lastOBs[i] = obs[i];
    }

    pollCount++;
    if (pollCount % STATUS_EVERY === 0) {
      const parts = pairs.map((p, i) => {
        const ob = obs[i];
        if (!ob) return `${p.symbol}=no book`;
        const spread = ob.ask - ob.bid;
        const ok = spread >= p.minSpreadUSD && spread <= p.maxSpreadUSD;
        return `${p.symbol} bid=${ob.bid} ask=${ob.ask} spread=$${spread.toFixed(4)} ${ok ? 'OK' : `OUT($${p.maxSpreadUSD})`}`;
      });
      logInfo('poll', parts.join(' | '));
    }

    // Confirmation filter
    let anyConfirmed = false;
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i]!;
      const ob = obs[i];
      if (!p.enabled || !ob) {
        p.confirmCount = 0;
        continue;
      }
      const spread = ob.ask - ob.bid;
      if (spread >= p.minSpreadUSD && spread <= p.maxSpreadUSD) {
        if (
          p.confirmCount > 0 &&
          ob.bid === p.lastBid &&
          ob.ask === p.lastAsk
        ) {
          p.confirmCount++;
        } else {
          p.confirmCount = 1;
          p.lastBid = ob.bid;
          p.lastAsk = ob.ask;
        }
        if (p.confirmCount >= p.requiredConfs) anyConfirmed = true;
      } else {
        p.confirmCount = 0;
        p.lastBid = 0;
        p.lastAsk = 0;
      }
    }

    if (!anyConfirmed) {
      await sleep(POLL_MS);
      continue;
    }

    // Pick confirmed pair with lowest % spread
    let bestPct = Infinity;
    let chosen: { p: PairInfo; ob: OB } | null = null;
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i]!;
      const ob = obs[i];
      if (!ob || p.confirmCount < p.requiredConfs) continue;
      const pct = (ob.ask - ob.bid) / ((ob.bid + ob.ask) / 2);
      if (pct < bestPct) {
        bestPct = pct;
        chosen = { p, ob };
      }
    }
    if (!chosen) {
      await sleep(POLL_MS);
      continue;
    }
    const { p, ob } = chosen;

    // --- Balance and sizing ---
    if (cachedUsdso <= 0)
      cachedUsdso = await getBalanceFloat(quoteAddr, quoteDecimals);
    if (cachedUsdso <= 0) {
      await sleep(POLL_MS);
      continue;
    }

    let amount = Math.min(Math.min(ob.askQty, ob.bidQty), cachedUsdso / ob.ask);
    amount = roundLot(amount, p.lotSize);
    if (amount < p.minQty) {
      await sleep(POLL_MS);
      continue;
    }

    let tradeUSD = amount * ob.ask;
    if (tradeUSD < p.minOrderUSD) {
      await sleep(POLL_MS);
      continue;
    }
    if (tradeUSD > p.maxOrderUSD) {
      amount = roundLot(p.maxOrderUSD / ob.ask, p.lotSize);
      if (amount < p.minQty) {
        await sleep(POLL_MS);
        continue;
      }
      tradeUSD = amount * ob.ask;
    }

    // Cross CROSS_BPS above ask so the IOC buy fills even if ask moves before inclusion
    const buyPrice = roundTick(ob.ask * (1 + CROSS_BPS / 10_000), p.tickSize);
    // 1 tick = effective market-sell IOC: fills at any available bid
    const sellPrice = p.tickSize;

    const spread = buyPrice - sellPrice;
    const buyCost = amount * buyPrice;
    const costPerCycle = amount * spread;
    const maxByBal =
      costPerCycle > 0
        ? Math.floor((cachedUsdso - buyCost) / costPerCycle) + 1
        : 1;
    const maxByQty = Math.floor(Math.min(ob.askQty, ob.bidQty) / amount);
    const maxCycles = Math.max(1, Math.min(maxByBal, maxByQty, MAX_BATCH));

    p.confirmCount = 0;
    p.lastBid = 0;
    p.lastAsk = 0;

    // atomicRoundTrip: 1 buy→sell round-trip per tx; tx always succeeds even if buy fills 0
    const calldata = buildTradeCalldata(p, buyPrice, sellPrice, amount);
    const equityBefore = await getEquity(lastOBs);

    let cyclesDone = 0;
    let cycleVolume = 0;
    let lastGasUsed = 0;

    let receipt: MinReceipt;
    try {
      receipt = await sendTradeTx(calldata);
    } catch (err) {
      logError(
        'trade',
        `${p.symbol} tx failed: ${err instanceof Error ? err.message : err}`,
      );
      await sleep(POLL_MS);
      continue;
    }
    if (!receipt || receipt.status !== 'success') {
      logWarn(
        'trade',
        `${p.symbol} tx reverted (gas=${receipt?.gasUsed}) — sell filled after buy reverted?`,
      );
    } else {
      cyclesDone = 1;
      // Use ob.bid for accurate volume tracking (actual fill side of the sell)
      cycleVolume = amount * (buyPrice + ob.bid);
      lastGasUsed = Number(receipt.gasUsed);
    }

    if (cyclesDone > 0) {
      totalTrades++;
      cachedUsdso = await getBalanceFloat(quoteAddr, quoteDecimals);
      const equity = await getEquity(lastOBs);
      const cyclePnL = equity - equityBefore;
      totalPnL = equity - initialEquity;
      totalVolume += cycleVolume;

      const lossPerK =
        totalVolume > 0 && totalPnL < 0 ? (-totalPnL / totalVolume) * 1000 : 0;
      logSuccess(
        'cycle',
        [
          `Trade #${totalTrades}`,
          p.symbol,
          `Cycles=${cyclesDone}`,
          `Vol=$${cycleVolume.toFixed(2)}`,
          `TotVol=$${totalVolume.toFixed(2)}`,
          `PnL=$${cyclePnL.toFixed(4)}`,
          `Loss/$1k=$${lossPerK.toFixed(4)}`,
          `Gas=${lastGasUsed}`,
        ].join('  '),
      );

      if (totalTrades % 10 === 0) {
        const s = (Date.now() - botStart) / 1000;
        logInfo(
          'stats',
          `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h ${Math.floor(s / 60) % 60}m  Trades=${totalTrades}  Vol=$${totalVolume.toFixed(2)}  TotalPnL=$${totalPnL.toFixed(4)}  Loss/$1k=${lossPerK.toFixed(4)}`,
        );
      }
    }

    await sleep(POLL_MS);
  }
}

// --- Main ---
async function main() {
  const somniaChain = defineChain({
    id: CHAIN_ID,
    name: 'Somnia',
    nativeCurrency: { name: 'STT', symbol: 'STT', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

  account = privateKeyToAccount((PK.startsWith('0x') ? PK : `0x${PK}`) as Hex);
  publicClient = createPublicClient({
    chain: somniaChain,
    transport: http(RPC_URL),
  });
  walletClient = createWalletClient({
    account,
    chain: somniaChain,
    transport: http(RPC_URL),
  });

  pairs = [
    {
      symbol: 'WETH:USDso',
      enabled: process.env.SCALPER_ENABLE_WETH !== 'false',
      pool: '',
      base: '',
      quote: '',
      baseDecimals: 18,
      lotSize: 0.0001,
      minQty: 0.001,
      tickSize: 0.01,
      maxSpreadUSD: parseFloat(process.env.SCALPER_MAX_SPREAD_WETH ?? '0.30'),
      minSpreadUSD: parseFloat(process.env.SCALPER_MIN_SPREAD_WETH ?? '0'),
      maxOrderUSD: parseFloat(process.env.SCALPER_MAX_USD_WETH ?? '100'),
      minOrderUSD: parseFloat(process.env.SCALPER_MIN_USD_WETH ?? '20'),
      sellBuffer: parseFloat(process.env.SCALPER_SELL_BUFFER_WETH ?? '0'),
      requiredConfs: parseInt(process.env.SCALPER_CONFIRM_WETH ?? '1'),
      confirmCount: 0,
      lastBid: 0,
      lastAsk: 0,
    },
    {
      symbol: 'WBTC:USDso',
      enabled: process.env.SCALPER_ENABLE_WBTC !== 'false',
      pool: '',
      base: '',
      quote: '',
      baseDecimals: 8,
      lotSize: 0.000001,
      minQty: 0.00001,
      tickSize: 1,
      maxSpreadUSD: parseFloat(process.env.SCALPER_MAX_SPREAD_WBTC ?? '4.0'),
      minSpreadUSD: parseFloat(process.env.SCALPER_MIN_SPREAD_WBTC ?? '0'),
      maxOrderUSD: parseFloat(process.env.SCALPER_MAX_USD_WBTC ?? '100'),
      minOrderUSD: parseFloat(process.env.SCALPER_MIN_USD_WBTC ?? '20'),
      sellBuffer: parseFloat(process.env.SCALPER_SELL_BUFFER_WBTC ?? '0'),
      requiredConfs: parseInt(process.env.SCALPER_CONFIRM_WBTC ?? '1'),
      confirmCount: 0,
      lastBid: 0,
      lastAsk: 0,
    },
    {
      // Stablecoin pair: USDC.e vs USDso (~$1 each). Mainnet only.
      symbol: 'USDC.e:USDso',
      enabled: process.env.SCALPER_ENABLE_USDCE !== 'false',
      pool: '',
      base: '',
      quote: '',
      baseDecimals: 6,
      lotSize: 0.01,
      minQty: 1,
      tickSize: 0.0001,
      maxSpreadUSD: parseFloat(process.env.SCALPER_MAX_SPREAD_USDCE ?? '0.001'),
      minSpreadUSD: parseFloat(process.env.SCALPER_MIN_SPREAD_USDCE ?? '0'),
      maxOrderUSD: parseFloat(process.env.SCALPER_MAX_USD_USDCE ?? '100'),
      minOrderUSD: parseFloat(process.env.SCALPER_MIN_USD_USDCE ?? '10'),
      sellBuffer: parseFloat(process.env.SCALPER_SELL_BUFFER_USDCE ?? '0'),
      requiredConfs: parseInt(process.env.SCALPER_CONFIRM_USDCE ?? '1'),
      confirmCount: 0,
      lastBid: 0,
      lastAsk: 0,
    },
  ];

  logBanner(
    'main',
    'DreamDEX Scalper — EIP-7702 DreamDexVolumeBatch7702 (delegation bundled per tx)',
  );
  logInfo('main', `Wallet : ${account.address}`);
  logInfo('main', `RPC    : ${RPC_URL}`);
  logInfo('main', `Poll   : ${POLL_MS}ms  MaxBatch: ${MAX_BATCH}`);

  await fetchMarketInfo();

  // Deploy BatchTrader impl if needed; delegation is bundled into each trade tx
  await deployImpl();

  for (const p of pairs) {
    logInfo(
      'main',
      `${p.symbol} | ${p.enabled ? 'ENABLED' : 'DISABLED'} | Confs=${p.requiredConfs} | Spread=[$${p.minSpreadUSD},$${p.maxSpreadUSD}] | Order=[$${p.minOrderUSD},$${p.maxOrderUSD}]`,
    );
  }

  cachedUsdso = await getBalanceFloat(quoteAddr, quoteDecimals);
  const balParts = [`USDso=$${cachedUsdso.toFixed(4)}`];
  for (const p of pairs) {
    if (!p.base) continue;
    const bal = await getBalanceFloat(p.base as Address, p.baseDecimals);
    const sym = p.symbol.split(':')[0]!;
    const dp = Math.max(2, Math.ceil(-Math.log10(p.lotSize)));
    balParts.push(`${sym}=${bal.toFixed(dp)}`);
  }
  logInfo('main', balParts.join('  '));

  const initialOBs = await Promise.all(pairs.map((p) => fetchOB(p.symbol)));
  initialEquity = await getEquity(initialOBs);
  logInfo(
    'main',
    `Initial equity: $${initialEquity.toFixed(4)} | Polling @${POLL_MS}ms`,
  );

  process.on('SIGINT', () => {
    console.log('\n[scalper] Stopping...');
    running = false;
  });
  process.on('SIGTERM', () => {
    running = false;
  });

  await tradingLoop(initialOBs);
  logInfo('main', 'Shutdown complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
