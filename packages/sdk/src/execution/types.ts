import type { MarketInfo, OrderExecutionResult, PrepareOrderRequest } from '../dex/types.js';

export interface OrderExecutor {
  executeOrder(
    market: MarketInfo,
    request: PrepareOrderRequest,
  ): Promise<OrderExecutionResult>;
}
