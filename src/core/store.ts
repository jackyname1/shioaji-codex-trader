import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExperienceSchema, ReviewSchema, type Experience, type ExperienceReview } from './experience.js';
import { AccountSchema, OrderSchema, PlanSchema, ProtectionSchema, SessionSchema, SettingsSchema,
  active, storedSettings, type Account, type Order, type Plan, type Protection, type SessionDay, type Settings } from './models.js';
import type { AnalystEvent } from './codex.js';

export class Store {
  readonly db: DatabaseSync;
  private lockPath?: string;
  private nonce = randomUUID();
  private closed = false;
  constructor(readonly path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      this.lockPath = path + '.lock.pid';
      this.acquireLock();
    }
    let opened: DatabaseSync | undefined;
    try {
      this.db = opened = new DatabaseSync(path);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS analyst_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, tag TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS protections (symbol TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (day TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS experiences (id TEXT PRIMARY KEY, at TEXT NOT NULL, mode TEXT NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS experiences_scope_time ON experiences(mode,at);
        CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, at TEXT NOT NULL, mode TEXT NOT NULL, value TEXT NOT NULL);`);
      if (path !== ':memory:') chmodSync(path, 0o600);
      const version = this.get<number>('schema_version');
      if (version !== undefined && version !== 2) throw new Error('資料庫版本不同，請使用獨立的 TypeScript 資料庫');
      this.set('schema_version', 2);
    } catch (error) { try { opened?.close(); } catch { /* Keep the original failure. */ } finally { this.releaseLock(); } throw error; }
  }
  recordAnalystEvent(event:AnalystEvent):void {
    const id=event.id??randomUUID();
    this.db.prepare('INSERT INTO analyst_events(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value')
      .run(id,JSON.stringify({...event,id}));
  }
  analystEvents(limit=200):AnalystEvent[]{
    const rows=(limit>0?this.db.prepare('SELECT value FROM (SELECT sequence,value FROM analyst_events ORDER BY sequence DESC LIMIT ?) ORDER BY sequence').all(limit):
      this.db.prepare('SELECT value FROM analyst_events ORDER BY sequence').all()) as {value:string}[];
    return rows.map(row=>JSON.parse(row.value) as AnalystEvent);
  }
  analystEvent(id:string):AnalystEvent|undefined {
    const row=this.db.prepare('SELECT value FROM analyst_events WHERE id=?').get(id) as {value:string}|undefined;
    return row?JSON.parse(row.value) as AnalystEvent:undefined;
  }
  private acquireLock(): void {
    const path = this.lockPath!;
    try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: this.nonce })); closeSync(fd); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let record: { pid: number; nonce: string };
      try { record = JSON.parse(readFileSync(path, 'utf8')) as typeof record; }
      catch { throw new Error('程式鎖無法辨識，請確認沒有執行中的程式後人工移除 .lock.pid'); }
      if (!Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('程式鎖資料不完整');
      try { process.kill(record.pid, 0); throw new Error('這個資料庫已有執行中的程式'); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        // Compare before removing a stale lock. A competing process's lock is never removed.
        if (readFileSync(path, 'utf8') !== JSON.stringify(record)) throw new Error('程式鎖已更新');
        unlinkSync(path); this.acquireLock();
      }
    }
  }
  private releaseLock(): void {
    if (!this.lockPath) return;
    try { const record = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { nonce: string };
      if (record.nonce === this.nonce) unlinkSync(this.lockPath); } catch { /* already removed */ }
  }
  close(): void { if(this.closed)return;this.db.close();this.closed=true;this.releaseLock(); }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  delete(key: string): void { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  settings(): Settings { return storedSettings(this.get('settings') ?? {}); }
  saveSettings(s: Settings): void { this.set('settings', SettingsSchema.parse(s)); }
  orders(activeOnly = false): Order[] {
    const values = (this.db.prepare('SELECT value FROM orders ORDER BY rowid').all() as { value: string }[])
      .map(r => OrderSchema.parse(JSON.parse(r.value)));
    return activeOnly ? values.filter(active) : values;
  }
  insertIntent(o: Order): boolean {
    const value = OrderSchema.parse(o);
    // Both the full intent ID and the broker's six-character tag must be unique.
    const result = this.db.prepare('INSERT OR IGNORE INTO orders VALUES (?,?,?)').run(value.local_id, value.tag, JSON.stringify(value));
    return result.changes === 1;
  }
  prepareIntent(o:Order,protection?:Protection):boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {const inserted=this.insertIntent(o);if(inserted&&protection)this.saveProtection(protection);this.db.exec('COMMIT');return inserted;}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  saveOrder(o: Order): void {
    const value = OrderSchema.parse(o);
    this.db.prepare('INSERT INTO orders VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.local_id, value.tag, JSON.stringify(value));
  }
  plan(): Plan | undefined { const x = this.get('plan'); return x ? PlanSchema.parse(x) : undefined; }
  protections(): Protection[] {
    return (this.db.prepare('SELECT value FROM protections').all() as { value: string }[])
      .map(r => ProtectionSchema.parse(JSON.parse(r.value)));
  }
  saveProtection(p: Protection): void {
    const value = ProtectionSchema.parse(p);
    this.db.prepare('INSERT INTO protections VALUES (?,?) ON CONFLICT(symbol) DO UPDATE SET value=excluded.value').run(p.symbol, JSON.stringify(value));
  }
  removeProtection(symbol: string): void { this.db.prepare('DELETE FROM protections WHERE symbol=?').run(symbol); }
  activatePlan(plan: Plan, protections: Protection[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.set('plan', PlanSchema.parse(plan)); protections.forEach(p => this.saveProtection(p)); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  saveSessions(days: SessionDay[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { for (const s of days) this.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(day) DO UPDATE SET value=excluded.value')
      .run(s.day, JSON.stringify(SessionSchema.parse(s))); this.db.exec('COMMIT'); }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  session(day: string): SessionDay | undefined {
    const row = this.db.prepare('SELECT value FROM sessions WHERE day=?').get(day) as { value: string } | undefined;
    return row ? SessionSchema.parse(JSON.parse(row.value)) : undefined;
  }
  audit(kind: string, message: string): void {
    this.db.prepare('INSERT INTO audit(at,kind,message) VALUES (?,?,?)').run(new Date().toISOString(), kind, message.slice(0, 3000));
  }
  logs(limit = 80): string[] {
    return (this.db.prepare('SELECT at,kind,message FROM audit ORDER BY id DESC LIMIT ?').all(limit) as { at: string; kind: string; message: string }[])
      .reverse().map(r => `${r.at} ${r.kind}: ${r.message}`);
  }
  savePaper(a: Account): void { this.set('paper_account', AccountSchema.parse(a)); }
  recordExperience(raw: Experience): void {
    const x = ExperienceSchema.parse(raw);
    this.db.prepare('INSERT OR IGNORE INTO experiences VALUES (?,?,?,?)').run(x.id,new Date(x.at).toISOString(),x.mode,JSON.stringify(x));
  }
  experiences(mode: string, asof: string, limit = 40): Experience[] {
    return (this.db.prepare('SELECT value FROM experiences WHERE mode=? AND at<=? ORDER BY at DESC,rowid DESC LIMIT ?')
      .all(mode,new Date(asof).toISOString(),limit) as {value:string}[]).reverse().map(x => ExperienceSchema.parse(JSON.parse(x.value)));
  }
  saveReview(raw: ExperienceReview): void {
    const x = ReviewSchema.parse(raw);
    this.db.prepare('INSERT OR IGNORE INTO reviews VALUES (?,?,?,?)').run(x.id,new Date(x.at).toISOString(),x.mode,JSON.stringify(x));
  }
  reviews(mode: string, asof: string, limit = 5): ExperienceReview[] {
    return (this.db.prepare('SELECT value FROM reviews WHERE mode=? AND at<=? ORDER BY at DESC,rowid DESC LIMIT ?')
      .all(mode,new Date(asof).toISOString(),limit) as {value:string}[]).reverse().map(x => ReviewSchema.parse(JSON.parse(x.value)));
  }
}
