import type { Account, Bar, Candidate, Instrument, Order, Quote } from '../core/models.js';
export interface Broker {
  readonly production: boolean;
  dirty: boolean;
  generation: number;
  connect(): Promise<void>;
  close(): Promise<void>;
  account(now: Date): Promise<Account>;
  reconcile(orders: Order[]): Promise<Order[]>;
  subscribe(symbols: string[], wholeLots: boolean): Promise<void>;
  quotes(now: Date): Quote[];
  instruments(symbols: string[], now: Date): Promise<Record<string, Instrument>>;
  discover(count: number, now: Date): Promise<Candidate[]>;
  history(symbol: string, now: Date): Promise<Bar[]>;
  submit(order: Order): Promise<Order>;
  cancel(order: Order): Promise<Order>;
}
