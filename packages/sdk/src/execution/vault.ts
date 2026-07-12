import { Contract, parseUnits } from 'ethers';
import type { MarketInfo } from '../dex/types.js';
import type { TransactionExecutor } from './signer.js';

const VAULT_ABI = [
  'function deposit(address token, uint256 amount) external',
  'function depositNative() external payable',
  'function withdraw(address token, uint256 amount) external',
  'function getWithdrawableBalance(address owner, address token) external view returns (uint256)',
  'function getOwnLockedBalance() external view returns (uint256 lockedBase, uint256 lockedQuote)',
] as const;

export class VaultManager {
  private readonly pool: Contract;

  constructor(
    private readonly executor: TransactionExecutor,
    private readonly marketContract: string,
  ) {
    this.pool = new Contract(marketContract, VAULT_ABI, executor.getSigner());
  }

  async depositAll(market: MarketInfo, nativeGasReserve: string): Promise<void> {
    const isNative = market.symbol.startsWith('SOMI:');

    const quoteBalance = await this.executor.getErc20Balance(market.quote);
    if (quoteBalance > 0n) {
      await this.executor.ensureErc20Allowance(market.quote, this.marketContract, quoteBalance);
      const tx = await this.pool.deposit(market.quote, quoteBalance);
      await tx.wait();
      console.log(`[vault] Deposited quote (${market.quote}) to vault`);
    }

    if (isNative) {
      const nativeBalance = await this.executor.getNativeBalance();
      const gasReserve = parseUnits(nativeGasReserve, 18);
      const amount = nativeBalance > gasReserve ? nativeBalance - gasReserve : 0n;
      if (amount > 0n) {
        const tx = await this.pool.depositNative({ value: amount });
        await tx.wait();
        console.log(`[vault] Deposited native SOMI to vault (${nativeGasReserve} reserved for gas)`);
      } else {
        console.warn(`[vault] Native SOMI balance too low to deposit after gas reserve (${nativeGasReserve})`);
      }
    } else {
      const baseBalance = await this.executor.getErc20Balance(market.base);
      if (baseBalance > 0n) {
        await this.executor.ensureErc20Allowance(market.base, this.marketContract, baseBalance);
        const tx = await this.pool.deposit(market.base, baseBalance);
        await tx.wait();
        console.log(`[vault] Deposited base (${market.base}) to vault`);
      }
    }
  }

  async withdrawAll(market: MarketInfo): Promise<void> {
    const owner = this.executor.walletAddress;
    for (const token of [market.quote, market.base]) {
      try {
        const amount = (await this.pool.getWithdrawableBalance(owner, token)) as bigint;
        if (amount > 0n) {
          const tx = await this.pool.withdraw(token, amount);
          await tx.wait();
          console.log(`[vault] Withdrew token ${token} from vault`);
        }
      } catch (err) {
        console.warn(`[vault] Withdraw failed for token ${token}:`, err);
      }
    }
  }

  async getVaultBalance(token: string): Promise<bigint> {
    const balance = (await this.pool.getWithdrawableBalance(this.executor.walletAddress, token)) as bigint;
    // Native SOMI deposits go in via depositNative() and the vault stores them under address(0).
    // If the API-provided token address returns 0, also try the zero-address sentinel.
    if (balance === 0n && token !== '0x0000000000000000000000000000000000000000') {
      try {
        const native = (await this.pool.getWithdrawableBalance(
          this.executor.walletAddress,
          '0x0000000000000000000000000000000000000000',
        )) as bigint;
        if (native > 0n) return native;
      } catch { /* not a native-capable vault */ }
    }
    return balance;
  }

  async getLockedBalance(): Promise<{ lockedBase: bigint; lockedQuote: bigint }> {
    const [lockedBase, lockedQuote] = (await this.pool.getOwnLockedBalance()) as [bigint, bigint];
    return { lockedBase, lockedQuote };
  }
}
