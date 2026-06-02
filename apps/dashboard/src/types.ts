export interface TradeRecord {
  at: number;
  side: 'buy' | 'sell';
  price: string;
  amount: string;
  filledAmount: string;
  notional: number;
}

export interface EquityPoint {
  at: number;
  value: number;
}

export interface BotSnapshot {
  symbol: string;
  strategy: string;
  executionMode: string;
  startedAt: number;
  baseBalance: number;
  quoteBalance: number;
  totalTrades: number;
  totalVolume: number;
  statusLine: string;
  equitySeries: EquityPoint[];
  recentTrades: TradeRecord[];
}
