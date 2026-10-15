import type { Account, Bar, Candidate, Features,Instrument, Order, Quote } from '../core/models.js';
// This error is only for a refusal BEFORE a broker mutation request is sent.
export class NoSubmissionError extends Error {}
export interface Broker {
  readonly production: boolean;
  dirty: boolean;
  generation: number;
  connect(): Promise<void>;
  close(): Promise<void>;
  account(now: Date): Promise<Account>;
  reconcile(orders: Order[], force?: boolean): Promise<Order[]>;
  subscribe(symbols: string[], wholeLots: boolean): Promise<void>;
  quotes(now: Date): Quote[];
  instruments(symbols: string[], now: Date): Promise<Record<string, Instrument>>;
  discover(count: number, now: Date): Promise<Candidate[]>;
  history(symbol: string, now: Date): Promise<Bar[]>;
  /** Local simulation cost ledger, never a brokerage API call. */
  costBasis?(symbol:string):string|undefined;
  features?(symbol:string,now:Date):Features|undefined;
  submit(order: Order): Promise<Order>;
  cancel(order: Order): Promise<Order>;
}
