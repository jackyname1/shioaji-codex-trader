import {authorizedRisk} from './risk-policy.js';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, openSync, readFileSync, closeSync, unlinkSync, writeFileSync, fstatSync, statSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {createHash, randomUUID } from 'node:crypto';
import { ExperienceSchema, ReviewSchema, type Experience, type ExperienceReview } from './experience.js';
import { AccountSchema, OrderSchema, PlanSchema, ProtectionSchema, EntryTrackSchema, SessionSchema, SettingsSchema,
  active, storedSettings, type Account, type Order, type Plan, type Protection, type EntryTrack, type SessionDay, type Settings } from './models.js';
import type {WatchChange} from './watchlist.js';
import type { AnalystEvent } from './codex.js';
import {processState,type ProcessState} from './store-process.js';

// A transient Windows unlink denial may outlive SQLite.close(). Only a nonce
// released by this process is eligible for a retry while its PID still exists.
const releasedLocks=new Map<string,string>();

export type StoreOperation='directory'|'lock_create'|'lock_read'|'lock_owner'|'lock_remove'|'database_open'|'permissions'|'schema'|'write';
export class StoreOpenError extends Error {
  readonly code?:string;readonly errcode?:number;
  constructor(readonly operation:StoreOperation,error:unknown){
    const value=error&&typeof error==='object'?error as {message?:unknown;code?:unknown;errcode?:unknown}:{};
    const safeMessages=['資料庫版本不同，請使用獨立的 TypeScript 資料庫','這個資料庫已有執行中的程式'];
    super(typeof value.message==='string'&&safeMessages.includes(value.message)?value.message:'本機紀錄初始化未完成');
    this.name='StoreOpenError';
    if(typeof value.code==='string')this.code=value.code;
    if(typeof value.errcode==='number')this.errcode=value.errcode;
  }
}

export class Store {
  readonly db: DatabaseSync;
  private lockPath?: string;
  private nonce = randomUUID();
  private closed = false;
  private ownsLock=false;
  private operation:StoreOperation='directory';
  private orderSequence=0;
  private orderChanges=new Map<string,{sequence:number;created:number}>();
  get orderRevision():number{return this.orderSequence;}
  constructor(readonly path: string,private readonly options:{platform?:NodeJS.Platform;probeProcess?:(pid:number)=>ProcessState}={}) {
    let opened: DatabaseSync | undefined;
    try {
      if (path !== ':memory:') {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        this.lockPath = path + '.lock.pid';
        this.acquireLock();
      }
      this.operation='database_open';
      this.db = opened = new DatabaseSync(path);
      // Tighten POSIX permissions before writing tables. On Windows chmod only
      // changes the read-only attribute; the user's directory ACL already protects it.
      this.operation='permissions';
      if(path!==':memory:'&&(this.options.platform??process.platform)!=='win32')chmodSync(path,0o600);
      this.operation='schema';
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS watch_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS analyst_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, tag TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS orders_status ON orders(json_extract(value,'$.status'));
        CREATE INDEX IF NOT EXISTS orders_symbol ON orders(json_extract(value,'$.symbol'));
        CREATE INDEX IF NOT EXISTS orders_broker ON orders(json_extract(value,'$.broker_id'));
        CREATE TABLE IF NOT EXISTS protections (symbol TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (day TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS experiences (id TEXT PRIMARY KEY, at TEXT NOT NULL, mode TEXT NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS experiences_scope_time ON experiences(mode,at);
        CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, at TEXT NOT NULL, mode TEXT NOT NULL, value TEXT NOT NULL);`);
      const version = this.get<number>('schema_version');
      if (version !== undefined && version !== 2) throw new Error('資料庫版本不同，請使用獨立的 TypeScript 資料庫');
      this.operation='write';
      this.set('schema_version', 2);
    } catch (error) { let safelyClosed=!opened;try { opened?.close();safelyClosed=true; } catch { /* Keep the original failure and its lock. */ }
      if(safelyClosed)this.releaseLock();
      throw error instanceof StoreOpenError?error:new StoreOpenError(this.operation,error); }
  }
  recordWatchChanges(changes:WatchChange[]):void {
    const insert=this.db.prepare('INSERT OR IGNORE INTO watch_events(id,value) VALUES(?,?)');
    for(const event of changes){const value=JSON.stringify(event);insert.run(createHash('sha256').update(value).digest('hex'),value);}
  }
  watchChanges():WatchChange[]{return (this.db.prepare('SELECT value FROM watch_events ORDER BY sequence').all() as {value:string}[]).map(r=>JSON.parse(r.value) as WatchChange);}
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
    this.operation='lock_create';
    let fd:number;
    try {fd=openSync(path,'wx',0o600);}
    catch (error) {
      const platform=this.options.platform??process.platform,code=(error as NodeJS.ErrnoException).code;
      // Windows reports EPERM rather than EEXIST for an existing hidden file
      // opened with 'w'. Read and verify that lock before attempting any cleanup.
      if(code!=='EEXIST'&&!(platform==='win32'&&code==='EPERM'&&existsSync(path)))throw error;
      this.operation='lock_read';
      let record: { pid: number; nonce: string };
      const contents=readFileSync(path,'utf8'),identity=statSync(path);
      try { record = JSON.parse(contents) as typeof record; }
      catch { throw Object.assign(new Error('程式鎖無法辨識'),{code:'LOCK_INVALID'}); }
      if (!record||!Number.isSafeInteger(record.pid)||record.pid<=0||typeof record.nonce!=='string'||!record.nonce)
        throw Object.assign(new Error('程式鎖資料不完整'),{code:'LOCK_INVALID'});
      this.operation='lock_owner';
      const releasedHere=record.pid===process.pid&&releasedLocks.get(path)===record.nonce;
      const owner=releasedHere?{state:'absent' as const}:this.options.probeProcess?.(record.pid)??processState(record.pid,platform);
      // Legacy locks contain only a PID. A later process start proves the PID was
      // reused; leave a generous margin for legacy filesystem timestamp precision.
      const reused=platform==='win32'&&owner.state==='running'&&owner.startedAt!==undefined&&owner.startedAt>identity.mtimeMs+5000;
      if(owner.state==='unknown')throw Object.assign(new Error('無法確認程式鎖擁有者'),{code:'LOCK_OWNER_UNKNOWN'});
      if(owner.state==='running'&&!reused)throw new Error('這個資料庫已有執行中的程式');
      this.operation='lock_remove';
      const current=statSync(path);
      if(current.dev!==identity.dev||current.ino!==identity.ino||readFileSync(path,'utf8')!==contents)
        throw Object.assign(new Error('程式鎖已更新'),{code:'LOCK_CHANGED'});
      unlinkSync(path);releasedLocks.delete(path);this.acquireLock();return;
    }
    this.ownsLock=true;
    let identity:ReturnType<typeof fstatSync>|undefined;
    try {identity=fstatSync(fd);writeFileSync(fd,JSON.stringify({pid:process.pid,nonce:this.nonce}));}
    catch(error){
      // A failed write can leave an empty lock. Remove only the file we created.
      try {const current=statSync(path);if(identity&&current.dev===identity.dev&&current.ino===identity.ino){closeSync(fd);fd=-1;unlinkSync(path);}}
      catch{/* Keep the original storage error and never remove a replacement lock. */}
      this.ownsLock=false;throw error;
    }finally{if(fd!==-1)closeSync(fd);}
  }
  private releaseLock(): void {
    if (!this.lockPath||!this.ownsLock) return;
    releasedLocks.set(this.lockPath,this.nonce);
    try { const record = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { nonce: string };
      if (record.nonce === this.nonce) {unlinkSync(this.lockPath);releasedLocks.delete(this.lockPath);this.ownsLock=false;} } catch { /* Leave unverified or inaccessible locks intact. */ }
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
  settings(): Settings { return authorizedRisk(storedSettings(this.get('settings') ?? {})); }
  saveSettings(s: Settings): void { this.set('settings', authorizedRisk(SettingsSchema.parse(s))); }
  orders(activeOnly = false): Order[] {
    const sql=activeOnly?"SELECT value FROM orders WHERE json_extract(value,'$.status') IN ('PREPARED','SUBMITTING','PENDING','PARTIAL','CANCEL_PENDING','UNKNOWN') ORDER BY rowid":'SELECT value FROM orders ORDER BY rowid';
    const values = (this.db.prepare(sql).all() as { value: string }[])
      .map(r => OrderSchema.parse(JSON.parse(r.value)));
    return activeOnly ? values.filter(active) : values;
  }
  order(id:string):Order|undefined {const row=this.db.prepare('SELECT value FROM orders WHERE id=?').get(id) as {value:string}|undefined;
    return row?OrderSchema.parse(JSON.parse(row.value)):undefined;}
  planOrders(planId:string,symbol:string,action:Order['action']):Order[]{
    return (this.db.prepare("SELECT value FROM orders WHERE json_extract(value,'$.plan_id')=? AND json_extract(value,'$.symbol')=? AND json_extract(value,'$.action')=? AND json_extract(value,'$.purpose') IN ('ENTRY','EXIT') ORDER BY rowid").all(planId,symbol,action) as {value:string}[])
      .map(row=>OrderSchema.parse(JSON.parse(row.value)));
  }
  orderByBroker(id:string):Order|undefined {if(!id)return;const row=this.db.prepare("SELECT value FROM orders WHERE json_extract(value,'$.broker_id')=? ORDER BY rowid DESC LIMIT 1").get(id) as {value:string}|undefined;
    return row?OrderSchema.parse(JSON.parse(row.value)):undefined;}
  lastOrder(symbol:string):Order|undefined {
    const row=this.db.prepare("SELECT value FROM orders WHERE json_extract(value,'$.symbol')=? AND (json_extract(value,'$.filled')>0 OR json_extract(value,'$.status') IN ('PREPARED','SUBMITTING','PENDING','PARTIAL','CANCEL_PENDING','UNKNOWN')) ORDER BY rowid DESC LIMIT 1").get(symbol) as {value:string}|undefined;
    return row?OrderSchema.parse(JSON.parse(row.value)):undefined;
  }
  protectionAttempts(symbol:string,day:string):number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE json_extract(value,'$.symbol')=? AND json_extract(value,'$.purpose')='PROTECTION' AND substr(json_extract(value,'$.created_at'),1,10)=?").get(symbol,day) as {n:number}).n;
  }
  changedOrders(since:number):{order:Order;created:boolean}[]{
    return [...this.orderChanges].flatMap(([id,change])=>{if(change.sequence<=since)return [];const order=this.order(id);
      return order?[{order,created:change.created>since}]:[];});
  }
  private changedOrder(order:Order,created=false):void {const previous=this.orderChanges.get(order.local_id),sequence=++this.orderSequence;
    this.orderChanges.set(order.local_id,{sequence,created:created?sequence:previous?.created??0});}
  insertIntent(o: Order): boolean {
    const value = OrderSchema.parse(o);
    // Both the full intent ID and the broker's six-character tag must be unique.
    const result = this.db.prepare('INSERT OR IGNORE INTO orders VALUES (?,?,?)').run(value.local_id, value.tag, JSON.stringify(value));
    if(result.changes===1)this.changedOrder(value,true);
    return result.changes === 1;
  }
  prepareIntent(o:Order,protection?:Protection):boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {const inserted=this.insertIntent(o);if(inserted&&protection)this.saveProtection(protection);this.db.exec('COMMIT');return inserted;}
    catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  saveOrder(o: Order): void {
    const value = OrderSchema.parse(o);
    const previous=this.order(value.local_id);
    this.db.prepare('INSERT INTO orders VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.local_id, value.tag, JSON.stringify(value));
    if(!previous||previous.status!==value.status||previous.filled!==value.filled)this.changedOrder(value,!previous);
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
  entryTracks():EntryTrack[]{return (this.get<unknown[]>('entry_tracks')??[]).map(x=>EntryTrackSchema.parse(x));}
  removeEntryTracks(symbol:string):void {this.set('entry_tracks',this.entryTracks().filter(t=>t.symbol!==symbol));}
  saveEntryTrack(value:EntryTrack):void {
    const track=EntryTrackSchema.parse(value),all=this.entryTracks().filter(t=>t.plan_id===track.plan_id
      &&!(t.symbol===track.symbol&&t.lot===track.lot));
    this.set('entry_tracks',[...all,track]);
  }
  activatePlan(plan: Plan, protections: Protection[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.set('plan', PlanSchema.parse(plan)); this.set('entry_tracks',[]);protections.forEach(p => this.saveProtection(p)); this.db.exec('COMMIT'); }
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
  // Risk accounting must not depend on the prompt's sample limit or feedback switch.
  simulatedFills(mode:string,asof:string):Experience[] {
    return (this.db.prepare("SELECT value FROM experiences WHERE mode=? AND at<=? AND json_extract(value,'$.kind')='SIMULATED_FILL' ORDER BY at,rowid")
      .all(mode,new Date(asof).toISOString()) as {value:string}[]).map(x=>ExperienceSchema.parse(JSON.parse(x.value)));
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
