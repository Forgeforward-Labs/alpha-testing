import type { ExecutionMode, StrategyMode } from '@trading/sdk';

export type { ExecutionMode, StrategyMode };

export interface GridLot {
  price: number;
  amount: number;
}

export interface PositionData {
  strategyName: string;
  symbol: string;
  lots: GridLot[];
  reservedBaseBalance: number;
  quoteBalance: number;
  referencePrice: number | undefined;
  lastMidPrice: number | undefined;
  markedEquityQuote: number | undefined;
  tradeCount: number;
}

export interface UserBotConfig {
  telegramId: string;
  privateKey: string;      // plaintext, in-memory only
  walletAddress: string;
  symbol: string;
  strategy: StrategyMode;
  executionMode: ExecutionMode;
  orderAmount: string;
  gridTradeSizeQuote: number;
  gridStepBps: number;
  gridMaxSpreadBps: number;
  gridMaxLongQuote: number;
  dryRun: boolean;
  persistenceDir: string;  // ./data/<telegramId>
}
