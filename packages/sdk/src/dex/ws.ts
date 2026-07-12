import WebSocket from 'ws';
import type { WebSocketOrderBookMessage, WebSocketOrderMessage, WsOrder } from './types.js';

type OrderBookCallback = (message: WebSocketOrderBookMessage) => Promise<void> | void;
type OrderCallback = (order: WsOrder) => void;

export class DreamDexWsClient {
  private ws?: WebSocket;
  private heartbeat?: NodeJS.Timeout;
  private intentionallyClosed = false;
  private reconnectDelay = 1_000;

  // Keyed by decimal orderId string for fast lookup.
  private orderCallbacks = new Map<string, OrderCallback>();
  // Track which decimal orderIds we're subscribed to so we can re-subscribe on reconnect.
  private subscribedOrders = new Set<string>();
  // Track which orderbook symbols we're subscribed to for reconnect.
  private subscribedSymbols = new Set<string>();

  private orderbookCallback?: OrderBookCallback;

  constructor(private readonly url: string) {}

  connect(onOrderBook?: OrderBookCallback): Promise<void> {
    this.orderbookCallback = onOrderBook;
    this.intentionallyClosed = false;
    return this.openConnection();
  }

  subscribeOrderBook(symbol: string): void {
    this.subscribedSymbols.add(symbol);
    this.send({
      operation: 'subscribe',
      channel: 'orderbook',
      params: { symbols: [symbol] },
    });
  }

  /**
   * Subscribe to real-time updates for a specific order.
   * orderId must be the decimal string returned by simulatedOrderId / REST API.
   * The WS protocol expects hex, so conversion is handled internally.
   */
  subscribeOrder(orderId: string, onUpdate: OrderCallback): void {
    this.orderCallbacks.set(orderId, onUpdate);
    this.subscribedOrders.add(orderId);
    this.send({
      operation: 'subscribe',
      channel: 'order',
      params: { orderId: toHexId(orderId) },
    });
  }

  unsubscribeOrder(orderId: string): void {
    this.orderCallbacks.delete(orderId);
    this.subscribedOrders.delete(orderId);
    try {
      this.send({
        operation: 'unsubscribe',
        channel: 'order',
        params: { orderId: toHexId(orderId) },
      });
    } catch {
      // Ignore if WS is closed — cleanup already handled by deleting the callback.
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  private openConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.once('open', () => {
        this.reconnectDelay = 1_000;
        this.startHeartbeat();
        // Re-subscribe to anything we were tracking before reconnect.
        for (const symbol of this.subscribedSymbols) {
          this.send({
            operation: 'subscribe',
            channel: 'orderbook',
            params: { symbols: [symbol] },
          });
        }
        for (const orderId of this.subscribedOrders) {
          this.send({
            operation: 'subscribe',
            channel: 'order',
            params: { orderId: toHexId(orderId) },
          });
        }
        resolve();
      });

      ws.on('message', async (raw) => {
        const text = raw.toString();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          console.error('WebSocket: failed to parse message');
          return;
        }

        const message = parsed as { operation?: string; channel?: string };

        if (message.operation === 'pong') {
          return;
        }

        if (message.channel === 'orderbook' && this.orderbookCallback) {
          try {
            await this.orderbookCallback(message as WebSocketOrderBookMessage);
          } catch (error) {
            console.error('WebSocket orderbook handler failed:', error);
          }
          return;
        }

        if (message.channel === 'order') {
          const msg = message as WebSocketOrderMessage;
          if (msg.order) {
            // WS orderId is hex — normalize to decimal to find our callback.
            const decimalId = toDecimalId(msg.order.id);
            const cb = this.orderCallbacks.get(decimalId);
            if (cb) {
              try {
                cb(msg.order);
              } catch (error) {
                console.error('WebSocket order handler failed:', error);
              }
            }
          }
        }
      });

      ws.once('error', (error) => {
        if (ws.readyState === WebSocket.CONNECTING) {
          reject(error);
        } else {
          console.error('WebSocket error:', error);
        }
      });

      ws.on('close', () => {
        this.stopHeartbeat();
        if (this.intentionallyClosed) return;
        console.warn(`DreamDEX WebSocket disconnected; reconnecting in ${this.reconnectDelay}ms`);
        setTimeout(() => {
          if (!this.intentionallyClosed) {
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
            this.openConnection().catch((error) => {
              console.error('WebSocket reconnect failed:', error);
            });
          }
        }, this.reconnectDelay);
      });
    });
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      try {
        this.send({ operation: 'ping' });
      } catch (error) {
        console.error('WebSocket heartbeat failed:', error);
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }
}

/** Convert decimal orderId (from REST/simulatedOrderId) to hex for WS subscribe. */
function toHexId(decimalId: string): string {
  return '0x' + BigInt(decimalId).toString(16);
}

/** Normalize a WS orderId (could be hex "0x..." or decimal) to decimal string for callback lookup. */
function toDecimalId(id: string): string {
  try {
    return BigInt(id).toString();
  } catch {
    return id;
  }
}
