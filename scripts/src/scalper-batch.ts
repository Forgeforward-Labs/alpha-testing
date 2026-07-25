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
const SCALPER_IMPL_ADDR = process.env.SCALPER_BATCH_IMPL_ADDR ?? '';
const CROSS_BPS = parseFloat(process.env.SCALPER_CROSS_BPS ?? '10');

if (!PK) {
  console.error('[scalper-batch] Set MAINNET_BOT_PK or DREAMDEX_PRIVATE_KEY');
  process.exit(1);
}

// BatchTrader bytecode — selector 0xd98b92e9
// executeBatch(address pool, address quote, address base,
//              uint256 buyPrice, uint256 sellPrice, uint256 amount,
//              uint256 maxCycles, uint256 deadline)
// Reverts on BuyRejected / SellRejected / NoCyclesCompleted.
const CREATION_BYTECODE =
  '0x6080604052348015600e575f80fd5b50610aab8061001c5f395ff3fe608060405260043610610021575f3560e01c8063d98b92e91461002c57610028565b3661002857005b5f80fd5b348015610037575f80fd5b50610052600480360381019061004d9190610611565b610054565b005b5f83148061006157505f82145b15610098576040517f4e70768d00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b8673ffffffffffffffffffffffffffffffffffffffff1663095ea7b3897fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6040518363ffffffff1660e01b81526004016100f39291906106e0565b6020604051808303815f875af115801561010f573d5f803e3d5ffd5b505050506040513d601f19601f82011682018060405250810190610133919061073c565b508573ffffffffffffffffffffffffffffffffffffffff1663095ea7b3897fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff6040518363ffffffff1660e01b815260040161018f9291906106e0565b6020604051808303815f875af11580156101ab573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101cf919061073c565b505f805f90505b838110156104e7575f8873ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b81526004016102189190610767565b602060405180830381865afa158015610233573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906102579190610794565b90505f8b73ffffffffffffffffffffffffffffffffffffffff16634e97837360015f8c8b8a60025f805f6040518a63ffffffff1660e01b81526004016102a5999897969594939291906108c4565b60408051808303815f875af11580156102c0573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906102e49190610994565b5090508061032c575f8303610325576040517fc534dbe100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b50506104e7565b5f828b73ffffffffffffffffffffffffffffffffffffffff166370a08231306040518263ffffffff1660e01b81526004016103679190610767565b602060405180830381865afa158015610382573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906103a69190610794565b6103b091906109ff565b90505f81036103fa575f84036103f2576040517fc534dbe100000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b5050506104e7565b5f8d73ffffffffffffffffffffffffffffffffffffffff16634e9783735f808d868c60025f805f6040518a63ffffffff1660e01b8152600401610445999897969594939291906108c4565b60408051808303815f875af1158015610460573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906104849190610994565b509050806104ce575f85036104c5576040517f370868be00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b505050506104e7565b85806001019650505050505080806001019150506101d6565b505f8103610521576040517f48c7827c00000000000000000000000000000000000000000000000000000000815260040160405180910390fd5b8873ffffffffffffffffffffffffffffffffffffffff167f1862948b87d6c9395b7690fd0b50b1f131529d79bcc3fbfd49247cec28674ecf8286898960405161056d9493929190610a32565b60405180910390a2505050505050505050565b5f80fd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6105ad82610584565b9050919050565b6105bd816105a3565b81146105c7575f80fd5b50565b5f813590506105d8816105b4565b92915050565b5f819050919050565b6105f0816105de565b81146105fa575f80fd5b50565b5f8135905061060b816105e7565b92915050565b5f805f805f805f80610100898b03121561062e5761062d610580565b5b5f61063b8b828c016105ca565b985050602061064c8b828c016105ca565b975050604061065d8b828c016105ca565b965050606061066e8b828c016105fd565b955050608061067f8b828c016105fd565b94505060a06106908b828c016105fd565b93505060c06106a18b828c016105fd565b92505060e06106b28b828c016105fd565b9150509295985092959890939650565b6106cb816105a3565b82525050565b6106da816105de565b82525050565b5f6040820190506106f35f8301856106c2565b61070060208301846106d1565b9392505050565b5f8115159050919050565b61071b81610707565b8114610725575f80fd5b50565b5f8151905061073681610712565b92915050565b5f60208284031215610751576107506105c7565b5b5f61075e84828501610728565b91505092915050565b5f60208201905061077a5f8301846106c2565b92915050565b5f8151905061078e816105e7565b92915050565b5f602082840312156107a9576107a8610580565b5b5f6107b684828501610780565b91505092915050565b6107c881610707565b82525050565b5f819050919050565b5f67ffffffffffffffff82169050919050565b5f819050919050565b5f61080d610808610803846107ce565b6107ea565b6107d7565b9050919050565b61081d816107f3565b82525050565b61082c816107d7565b82525050565b5f60ff82169050919050565b61084781610832565b82525050565b5f61086761086261085d846107ce565b6107ea565b610832565b9050919050565b6108778161084d565b82525050565b5f6bffffffffffffffffffffffff82169050919050565b5f6108ae6108a96108a4846107ce565b6107ea565b61087d565b9050919050565b6108be81610894565b82525050565b5f610120820190506108d85f83018c6107bf565b6108e5602083018b610814565b6108f2604083018a6106d1565b6108ff60608301896106d1565b61090c6080830188610823565b61091960a083018761083e565b61092660c083018661086e565b61093360e08301856106c2565b6109416101008301846108b5565b9a9950505050505050505050565b5f6fffffffffffffffffffffffffffffffff82169050919050565b6109738161094f565b811461097d575f80fd5b50565b5f8151905061098e8161096a565b92915050565b5f80604083850312156109aa576109a9610580565b5b5f6109b785828601610728565b92505060206109c885828601610980565b9150509250929050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f610a09826105de565b9150610a14836105de565b9250828203905081811115610a2c57610a2b6109d2565b5b92915050565b5f608082019050610a455f8301876106d1565b610a5260208301866106d1565b610a5f60408301856106d1565b610a6c60608301846106d1565b9594505050505056fea2646970667358221220583569f587c0237b888026071847b21578b21a29ec03251ae9b842763f09cfc664736f6c634300081a0033';

const EXECUTE_SELECTOR = 'd98b92e9';

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
async function deployImpl(): Promise<void> {
  implAddr = SCALPER_IMPL_ADDR as Address;
  if (implAddr) {
    logInfo('deploy', `Using impl: ${implAddr} (SCALPER_BATCH_IMPL_ADDR)`);
    return;
  }
  const deployNonce = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: 'pending',
  });
  const gasPrice = await fetchGasPrice();
  logInfo(
    'deploy',
    `Deploying BatchTrader (nonce=${deployNonce}, gasPrice=${gasPrice / 1_000_000_000n} gwei)`,
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
    `BatchTrader deployed: ${implAddr} (gas=${deployReceipt.gasUsed})`,
  );
  logInfo(
    'deploy',
    `  -> set SCALPER_BATCH_IMPL_ADDR=${implAddr} in .env to skip re-deploy`,
  );
  nonce = -1;
}

// --- Calldata builder ---
// Encodes executeBatch(pool, quote, base, buyPrice, sellPrice, amount, maxCycles, deadline)
function buildTradeCalldata(
  p: PairInfo,
  buyPrice: number,
  sellPrice: number,
  amount: number,
  maxCycles: number,
): Hex {
  const ticksPerUnit = BigInt(Math.round(1 / p.tickSize));
  const tickScaled = 10n ** 18n / ticksPerUnit;
  const buyPriceWei = BigInt(Math.round(buyPrice / p.tickSize)) * tickScaled;
  const sellPriceWei = BigInt(Math.round(sellPrice / p.tickSize)) * tickScaled;

  const lotsPerUnit = BigInt(Math.round(1 / p.lotSize));
  const lotScaled = 10n ** BigInt(p.baseDecimals) / lotsPerUnit;
  const amountWei = BigInt(Math.round(amount / p.lotSize)) * lotScaled;

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
    pad32uint(BigInt(maxCycles)) +
    pad32uint(deadlineWei)) as Hex;
}

// --- Send trade tx ---
async function sendTradeTx(
  calldata: Hex,
  gasLimit = 6_000_000n,
): Promise<MinReceipt> {
  await ensureGasPrice();
  const txN = await getNextNonce();

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

// --- Equity ---
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

// --- Trading loop ---
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

    const buyPrice = roundTick(ob.ask * (1 + CROSS_BPS / 10_000), p.tickSize);
    const sellPrice = p.tickSize; // 1 tick = effective market-sell IOC

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

    const calldata = buildTradeCalldata(
      p,
      buyPrice,
      sellPrice,
      amount,
      maxCycles,
    );
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
        `${p.symbol} tx reverted (gas=${receipt?.gasUsed}) — buy/sell rejected`,
      );
    } else {
      cyclesDone = maxCycles;
      cycleVolume = amount * (buyPrice + ob.bid) * maxCycles;
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
      maxSpreadUSD: parseFloat(process.env.SCALPER_MAX_SPREAD_WETH ?? '0.020'),
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
      maxSpreadUSD: parseFloat(process.env.SCALPER_MAX_SPREAD_WBTC ?? '5.0'),
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
      symbol: 'USDC.e:USDso',
      enabled: process.env.SCALPER_ENABLE_USDCE !== 'false',
      pool: '',
      base: '',
      quote: '',
      baseDecimals: 6,
      lotSize: 0.01,
      minQty: 1,
      tickSize: 0.0001,
      maxSpreadUSD: parseFloat(
        process.env.SCALPER_MAX_SPREAD_USDCE ?? '0.0001',
      ),
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
    'DreamDEX Scalper — EIP-7702 BatchTrader (delegation bundled per tx)',
  );
  logInfo('main', `Wallet : ${account.address}`);
  logInfo('main', `RPC    : ${RPC_URL}`);
  logInfo(
    'main',
    `Poll   : ${POLL_MS}ms  MaxBatch: ${MAX_BATCH}  CrossBps: ${CROSS_BPS}`,
  );

  await fetchMarketInfo();
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
    console.log('\n[scalper-batch] Stopping...');
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
