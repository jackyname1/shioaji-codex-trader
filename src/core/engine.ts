import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { Risk, alignedPrice } from './risk.js';
import { evaluate, updateProtection } from './smart.js';
import { indicators, validateAnalysis } from './strategy.js';
import { experienceContext } from './experience.js';
import { emptyWatch, selectWatchlist, ruleEntry, type WatchState } from './watchlist.js';
import { nextStrategy } from './schedule.js';
import { active, ageSeconds, d, equity, remaining, twDay, type Account, type Analysis, type Candidate, type Features,
  type Instrument, type Order, type Plan, type Quote, type Settings, type Snapshot, type SmartSpec } from './models.js';
import { NoSubmissionError, type Broker } from '../broker/types.js';
import { brokerIssue } from '../broker/health.js';

export interface Bundle { pool: Candidate[]; features: Record<string,Features>; metadata: Record<string,Instrument>;
  fundamentals?: Record<string,unknown>; announcements?: unknown[]; limitations?: string[] }
export class Engine {
  risk: Risk;
  plan?: Plan;
  account?: Account;
  quotes = new Map<string,Quote>();
  metadata: Record<string,Instrument> = {};
  pausedEntries: boolean;
  killed: boolean;
  connected = false;
  dataIssue = '';
  private _entryBlocked=false;
  get entryBlocked():boolean{return this._entryBlocked;}
  set entryBlocked(value:boolean){this._entryBlocked=value;this.store.set('entry_blocked',value);}
  watch:WatchState;
  watchFeatures:Record<string,Features>={};
  decisionStates=new Map<string,{state:string;reason:string;source:string}>();
  private lastTick?: Date;
  private lastRefresh?: Date;
  private lastReconcile?: Date;
  private generation = -1;
  private metadataDay = '';
  private recent: string[] = [];
  constructor(readonly store: Store, readonly broker: Broker, public settings: Settings, readonly calendar: TradingCalendar) {
    this.risk = new Risk(settings,calendar); this.plan = store.plan();
    this._entryBlocked=store.get<boolean>('entry_blocked')??false;
    this.watch=store.get<WatchState>('watch_state')??emptyWatch();
    this.pausedEntries = store.get<boolean>('paused_entries') ?? false; this.killed = store.get<boolean>('kill_switch') ?? false;
  }
  log(kind: string, message: string): void { this.store.audit(kind,message); this.recent.push(`${kind}: ${message}`); this.recent = this.recent.slice(-100); }
  logOnce(kind: string, message: string): void { if (!this.recent.slice(-20).includes(`${kind}: ${message}`)) this.log(kind,message); }
  async start(now: Date): Promise<void> {
    await this.broker.connect(); this.connected = true;
    await this.syncAccount(now);
    try {await this.updateSubscriptions(now);} catch(error){this.dataUnavailable(error,now);}
    this.log('START',`模式=${this.settings.mode}；自動執行=${this.settings.auto_execute}`);
  }
  dataUnavailable(error: unknown, now: Date): void {
    this.dataIssue = brokerIssue(error);
    this.account = { ...(this.account ?? { cash:'0', settlement_debits:'0', settlement_credits:'0', positions:[], orders:[],
      daily_buy_count:0, daily_buy_amount:'0',available:{cash:false,settlements:false,positions:false,orders:false} }), asof:now.toISOString(), complete:false, issue:this.dataIssue };
    this.logOnce('CONNECTION', this.dataIssue);
  }
  async close(): Promise<void> { this.connected = false; await this.broker.close(); }
  setSettings(s: Settings): void {
    if (['mode','base_url','stock_account_index'].some(k => s[k as keyof Settings] !== this.settings[k as keyof Settings]))
      throw new Error('交易模式、服務網址及帳戶變更需停止並重啟；不同模式使用不同資料庫');
    if(['watch_min_amount','watch_max_symbols','watch_remove_after_scans','allow_attention','auto_watchlist'].some(k=>s[k as keyof Settings]!==this.settings[k as keyof Settings])) {
      this.watch={...this.watch,healthy:false,issue:'觀測條件已變更，等待重新核對'};this.store.set('watch_state',this.watch);
    }
    this.settings = s; this.risk = new Risk(s,this.calendar); this.store.saveSettings(s);
    if ('settings' in this.broker) (this.broker as Broker & { settings: Settings }).settings = s;
    if ('market' in this.broker) {
      const market = (this.broker as Broker & {market: Broker}).market;
      if ('settings' in market) (market as Broker & {settings: Settings}).settings = s;
    }
  }
  canExecute(): boolean { return this.connected && this.settings.auto_execute && this.settings.mode !== 'readonly' && !this.killed; }
  pauseEntries(paused = true): void {
    this.pausedEntries = paused; this.store.set('paused_entries',paused);
    this.log('PAUSE',paused ? '停止新增買進；保護監控持續' : '恢復新增買進');
  }
  kill(enabled = true): void { this.killed = enabled; this.store.set('kill_switch',enabled);
    this.log('KILL',enabled ? '停止全部新委託；現有掛單仍須撤單' : '解除停止委託'); }
  async reconcile(now: Date, force = false): Promise<void> {
    const prior = this.store.orders(true);
    if(!prior.length){this.lastReconcile=now;return;}
    const orders = await this.broker.reconcile(prior,force);
    for (const o of orders) {
      const old = prior.find(x => x.local_id === o.local_id);
      if (old) this.recordReconciledFill(o,old.filled,now);
      this.store.saveOrder(o);
      if(o.plan_id===this.plan?.id)this.decisionStates.set(o.symbol,{state:o.status,reason:`${o.filled}/${o.shares} 股已核對`,source:o.purpose});
    }
    this.lastReconcile = now;
    if (orders.some(o => ['UNKNOWN','SUBMITTING','PREPARED'].includes(o.status)))
      this.logOnce('BLOCK','有未確認委託，停止新增委託；先核對券商結果，不會盲目重送');
  }
  private async syncAccount(now:Date,force=false):Promise<void>{
    let failure:unknown;
    try{await this.reconcile(now,force);}catch(error){failure=error;}
    try{await this.refreshAccount(now);}catch(error){failure??=error;}
    if(failure)this.dataUnavailable(failure,now);
  }
  async refreshAccount(now: Date): Promise<Account> {
    const account = await this.broker.account(now), local = this.store.orders();
    const byBroker = new Map(local.filter(o => o.broker_id).map(o => [o.broker_id,o]));
    account.orders = account.orders.map(o => byBroker.get(o.broker_id) ?? o);
    const known = new Set(account.orders.map(o => o.local_id));
    account.orders.push(...local.filter(o => active(o) && !known.has(o.local_id)));
    this.account = account; this.lastRefresh = now;
    this.dataIssue = account.complete ? '' : account.issue;
    const key = 'baseline_' + twDay(now);
    if (account.complete && !this.store.get(key)) { this.store.set(key,{equity:equity(account).toFixed(),at:now.toISOString()});
      this.log('BASELINE','建立今日首次有效快照基準；不是歷史開盤資產'); }
    if (account.issue) this.logOnce('ACCOUNT',account.issue);
    return account;
  }
  private recordReconciledFill(o:Order,previous:number,now:Date):void {
    if(o.filled<=previous||['paper','demo'].includes(this.settings.mode))return;
    this.store.recordExperience({id:`${o.local_id}:${o.filled}`,at:now.toISOString(),mode:this.settings.mode,
      kind:'RECONCILED_FILL',symbol:o.symbol,action:o.action,shares:o.filled-previous,
      price:null,fee:null,tax:null,realized_pnl:null,note:`已核對 ${o.purpose} 成交股數；委託限價=${o.limit_price}，非實際成交價。實際成交價格與費用未提供，不推算損益`});
  }
  baseline(now: Date): string | undefined { return this.store.get<{equity:string}>('baseline_' + twDay(now))?.equity; }
  async updateSubscriptions(now: Date): Promise<void> {
    const symbols = new Set(this.store.protections().map(p => p.symbol));
    this.account?.positions.forEach(p => symbols.add(p.symbol)); this.store.orders(true).forEach(o => symbols.add(o.symbol));
    this.plan?.analysis.candidates.forEach(s => symbols.add(s)); this.plan?.analysis.decisions.forEach(d => symbols.add(d.symbol));
    this.watch.entries.forEach(w=>symbols.add(w.symbol));
    const list = [...symbols]; await this.broker.subscribe(list,this.settings.whole_lots);
    this.metadata = await this.broker.instruments(list,now); this.metadataDay = twDay(now);
  }
  async collectBundle(now: Date): Promise<Bundle> {
    const pool = await this.broker.discover(this.settings.candidate_pool_size,now);
    const symbols = [...new Set([...pool.map(p => p.symbol),...(this.account?.positions.map(p => p.symbol) ?? [])])];
    const features: Record<string,Features> = {};
    // Limit concurrent history queries; collection happens outside the single-writer engine queue.
    const pending = [...symbols];
    await Promise.all(Array.from({length:3},async () => {
      for (;;) { const symbol = pending.shift(); if (!symbol) break;
        const key = `history_${twDay(now)}_${symbol}`;
        let bars = this.store.get<import('./models.js').Bar[]>(key);
        if (!bars) { try { bars = await this.broker.history(symbol,now); if (bars.length) this.store.set(key,bars); } catch { bars = []; } }
        const f = indicators(bars);
        if (this.settings.mode !== 'demo'||this.store.get('historical_real_data')) {
          let previous = '9999-12-31'; try { previous = this.calendar.next(twDay(now),-1); } catch { /* fail closed */ }
          if (!f.asof || f.asof < previous) { f.sufficient = false; f.issue = '歷史行情過期或交易日未知'; }
        }
        features[symbol] = f;
      }
    }));
    return {pool,features,metadata:await this.broker.instruments(symbols,now)};
  }
  async refreshWatch(bundle:Bundle,now:Date):Promise<void> {
    this.metadata={...this.metadata,...bundle.metadata};this.watchFeatures=bundle.features;
    const previous=this.watch;
    this.watch=selectWatchlist(previous,bundle,this.settings,this.plan,this.account,this.store.orders(true),this.store.protections(),now);
    this.store.set('watch_state',this.watch);
    for(const c of this.watch.changes.filter(c=>c.at===now.toISOString()))this.log('WATCH',`${c.action} ${c.symbol}：${c.reason}`);
    if(this.canExecute())for(const o of this.store.orders(true))if(o.purpose==='ENTRY'
      &&!this.watch.entries.some(w=>w.symbol===o.symbol&&w.eligible))await this.cancel(o.local_id,now);
    await this.updateSubscriptions(now);
  }
  watchFailed():void {
    this.watch={...this.watch,healthy:false,issue:'觀測資料更新失敗，停止新買進；保護監控持續'};
    this.store.set('watch_state',this.watch);this.logOnce('WATCH_FAIL',this.watch.issue);
  }
  snapshotFromBundle(bundle: Bundle, now: Date, review = false): Snapshot {
    const a = this.account; if (!a?.complete) throw new Error('帳戶快照不完整，暫停新決策');
    this.metadata = {...this.metadata,...bundle.metadata};
    const limits = Object.fromEntries(['whole_lots','min_cash_fraction','max_order_fraction','max_symbol_fraction',
      'max_exposure_fraction','max_daily_buy_fraction','max_daily_buy_orders','daily_loss_fraction',
      'price_deviation_fraction','minimum_fee','fee_rate','sell_tax_rate','plan_max_minutes','watch_min_amount','watch_max_symbols'].map(k => [k,this.settings[k as keyof Settings]]));
    return {snapshot_id:randomUUID(),asof:now.toISOString(),synthetic:this.settings.mode === 'demo',review_only:review,
      account:{cash:a.cash,settlement_debits:a.settlement_debits,settlement_credits:a.settlement_credits,
        equity:equity(a).toFixed(),daily_buy_amount:a.daily_buy_amount,daily_buy_count:a.daily_buy_count,
        positions:structuredClone(a.positions),open_orders:a.orders.filter(active).map(o => ({
          symbol:o.symbol,action:o.action,shares:remaining(o),limit_price:o.limit_price}))},
      universe:bundle.pool,features:bundle.features,hard_limits:limits,
      existing_protection:Object.fromEntries(this.store.protections().map(p => [p.symbol,p.spec])),
      observation:{symbols:this.watch.entries.map(w=>w.symbol),refresh_minutes:this.settings.watch_refresh_minutes,
        max_symbols:this.settings.watch_max_symbols,next_strategy_at:nextStrategy(now,this.settings,this.calendar)?.at??null},
      experience:experienceContext(this.store,this.settings,now.toISOString()),
      fundamentals:bundle.fundamentals ?? {},news:bundle.announcements ?? [],data_limitations:[...(bundle.limitations ?? []),
        '重大訊息是公司公告；無完整新聞、財報、估值資料時不得編造',
        '日損失基準為今日首次有效帳戶快照；盤中啟動無法回推開盤資產',
        '智能停損由本機監控，零股不可當沖，觸發價格不保證成交']};
  }
  async snapshot(now: Date, review = false): Promise<Snapshot> {
    const bundle = await this.collectBundle(now); await this.reconcile(now); await this.refreshAccount(now);
    return this.snapshotFromBundle(bundle,now,review);
  }
  async activate(analysis: Analysis, snapshot: Snapshot, now: Date): Promise<void> {
    const plan = validateAnalysis(analysis,snapshot,now,this.settings);
    if(snapshot.review_only) {
      if(this.settings.experience_enabled)this.store.saveReview({id:plan.id,at:now.toISOString(),
        mode:this.store.get<string>('experience_scope')??this.settings.mode,summary:plan.analysis.summary,sample_count:snapshot.experience?.sample_count??0});
      this.log('REVIEW',plan.analysis.summary);return;
    }
    const existing = new Map(this.store.protections().map(p => [p.symbol,p]));
    const protections = plan.analysis.decisions.filter(d => d.smart !== null)
      .map(d => updateProtection(existing.get(d.symbol),d.symbol,d.smart!,plan.id));
    if (this.canExecute()) for (const order of this.store.orders(true))
      if (order.purpose === 'ENTRY' && order.plan_id !== plan.id) await this.cancel(order.local_id,now);
    this.store.activatePlan(plan,protections); this.plan = plan; this.entryBlocked = false;
    this.decisionStates.clear();
    await this.refreshWatch({pool:snapshot.universe,features:snapshot.features,metadata:this.metadata},now);
    this.log('PLAN',`啟用 ${plan.id.slice(0,8)}，有效至 ${plan.analysis.expires_at}；${plan.analysis.screening?.entry?'含自動選股進場規則':'依個股決策執行'}`);
  }
  async tick(now: Date,evaluateConditions=true): Promise<void> {
    if (!this.connected) return;
    const resumed = this.lastTick && now.getTime() - this.lastTick.getTime() > 45000;
    const changed = this.generation !== this.broker.generation;
    if (resumed || changed || this.metadataDay !== twDay(now)) {
      this.quotes.clear(); await this.syncAccount(now,true); await this.updateSubscriptions(now);
      this.generation = this.broker.generation;
      if (resumed || changed) this.logOnce('RESUME','連線或系統狀態變更，清除行情並重新核對');
    }
    this.lastTick = now;
    if (!this.lastReconcile || now.getTime() - this.lastReconcile.getTime() >= 15000)try{await this.reconcile(now);}catch(error){this.dataUnavailable(error,now);}
    if (!this.lastRefresh || now.getTime() - this.lastRefresh.getTime() >= 20000 || this.broker.dirty) {
      await this.syncAccount(now);
    }
    if (this.plan && Date.parse(this.plan.analysis.expires_at) <= now.getTime() && this.canExecute())
      for (const o of this.store.orders(true)) if (o.purpose === 'ENTRY') await this.cancel(o.local_id,now);
    for (const q of this.broker.quotes(now)) this.quotes.set(`${q.symbol}:${q.odd}`,q);
    if (['demo','paper'].includes(this.settings.mode)) { await this.reconcile(now); await this.refreshAccount(now); }
    if (!this.account || !evaluateConditions) return;
    for (const protection of this.store.protections()) {
      const p = this.account.positions.find(p => p.symbol === protection.symbol);
      const pendingBuy = this.account.orders.some(o => active(o) && o.symbol === protection.symbol && o.action === 'BUY');
      const plannedBuy = this.plan && Date.parse(this.plan.analysis.expires_at) > now.getTime()
        && this.plan.analysis.decisions.some(d => d.symbol === protection.symbol && d.action === 'BUY');
      if (!p?.shares) { if (!pendingBuy && !plannedBuy) this.store.removeProtection(protection.symbol); continue; }
      const protectionLot = this.settings.whole_lots && p.sellable >= 1000 ? 'COMMON' : 'ODD';
      if(!this.calendar.inSession(now,protectionLot))continue;
      const q = this.quotes.get(`${p.symbol}:${protectionLot === 'ODD'}`);
      if (!q || q.simulated || !(ageSeconds(now,q.trade_at) >= 0 && ageSeconds(now,q.trade_at) <= this.settings.quote_max_age)) continue;
      const trigger = evaluate(protection,q.last); this.store.saveProtection(protection);
      if (!trigger) continue;
      if (!p.sellable) { this.logOnce('WAIT',`${p.symbol} ${trigger} 觸發；今日買進量不可賣，下個交易日重評`); continue; }
      if (!this.canExecute()) continue;
      const pending = this.store.orders(true).find(o => o.symbol === p.symbol);
      if (pending) {
        if (pending.action === 'BUY') await this.cancel(pending.local_id,now);
        else if (pending.purpose === 'PROTECTION' && d(q.bid).gt(0) && alignedPrice(q.bid)
          && !d(q.bid).eq(pending.limit_price) && ageSeconds(now,pending.created_at) >= 60) await this.cancel(pending.local_id,now);
        continue; // Replacement is allowed only on a later tick after confirmed cancel + inventory refresh.
      }
      const attempts = this.store.orders().filter(o => o.symbol === p.symbol && o.purpose === 'PROTECTION'
        && twDay(new Date(o.created_at)) === twDay(now)).length;
      if (attempts >= 10) { this.logOnce('BLOCK',`${p.symbol} 保護出場嘗試已達上限，請核對委託`); continue; }
      const protectionShares = protectionLot === 'COMMON' ? Math.floor(p.sellable / 1000) * 1000 : Math.min(999,p.sellable);
      await this.submit(this.newOrder(p.symbol,'SELL',protectionShares,q.bid,protectionLot,now,protection.plan_id,'PROTECTION'),now);
    }
    if (!this.canExecute() || !this.plan || Date.parse(this.plan.analysis.expires_at) <= now.getTime()) return;
    const plan = this.plan;
    const decisions=[...plan.analysis.decisions];
    if(this.settings.auto_watchlist&&plan.analysis.screening?.entry)for(const w of this.watch.entries) {
      if(decisions.some(d=>d.symbol===w.symbol))continue;
      if(!this.watch.healthy||ageSeconds(now,this.watch.asof)>this.settings.watch_refresh_minutes*120) {
        this.decisionStates.set(w.symbol,{state:'WAIT',reason:'觀測資料更新尚未確認',source:'RULE'});continue;
      }
      const common=this.settings.whole_lots?ruleEntry(plan,w,this.watchFeatures[w.symbol],this.quotes.get(`${w.symbol}:false`),this.account,this.settings,now):undefined;
      const sized=common?.decision?common:ruleEntry(plan,w,this.watchFeatures[w.symbol],this.quotes.get(`${w.symbol}:true`),this.account,this.settings,now);
      if(sized.decision)decisions.push(sized.decision);
      else this.decisionStates.set(w.symbol,{state:'WAIT',reason:sized.reason,source:'RULE'});
    }
    for (const decision of decisions) {
      const source=plan.analysis.decisions.includes(decision)?'CODEX':'RULE';
      const state=(state:string,reason:string):void=>{this.decisionStates.set(decision.symbol,{state,reason,source});};
      if(decision.action==='HOLD'){state('HOLD',decision.reason);continue;}
      if(decision.action==='BUY'&&(this.entryBlocked||this.pausedEntries)){state('BLOCKED','新買進已暫停，保護監控持續');continue;}
      if(decision.action==='BUY'&&this.settings.auto_watchlist&&(!this.watch.healthy
        ||ageSeconds(now,this.watch.asof)>this.settings.watch_refresh_minutes*120
        ||!this.watch.entries.some(w=>w.symbol===decision.symbol&&w.eligible))){state('BLOCKED','目前觀測資格未確認');continue;}
      const lot = decision.shares >= 1000 ? 'COMMON' : 'ODD', q = this.quotes.get(`${decision.symbol}:${lot === 'ODD'}`);
      if (!q || (decision.entry_when === 'BELOW' && d(q.last).gt(decision.trigger_price))
        || (decision.entry_when === 'ABOVE' && d(q.last).lt(decision.trigger_price))) {state('WAIT',!q?'等待對應市場行情':`等待${decision.entry_when==='BELOW'?'低於':'高於'} ${decision.trigger_price}`);continue;}
      if (decision.action === 'BUY' && decision.smart && d(q.ask).lte(decision.smart.stop_price)) {
        state('BLOCKED','已跌破進場計畫停損，等待新策略');this.logOnce('BLOCK',`${decision.symbol} 已跌破進場計畫停損，等待新計畫`); continue;
      }
      const id = createHash('sha256').update(`${plan.id}:${decision.symbol}:${decision.action}`).digest('hex').slice(0,32);
      const prior=this.store.orders().find(o=>o.local_id===id);
      if(prior){state(prior.status,`${prior.filled}/${prior.shares} 股；本輪已執行，不重送`);continue;}
      const sent=await this.submit(this.newOrder(decision.symbol,decision.action,decision.shares,decision.limit_price,lot,now,plan.id,
        decision.action === 'BUY' ? 'ENTRY' : 'EXIT',id),now,source==='RULE'?decision.smart??undefined:undefined);
      if(sent)state('SUBMITTED',`${decision.action} ${decision.shares} 股 @ ${decision.limit_price}`);
    }
  }
  newOrder(symbol: string, action: 'BUY' | 'SELL', shares: number, limitPrice: string, lot: 'ODD' | 'COMMON',
    now: Date, planId: string, purpose: Order['purpose'], id = randomUUID().replaceAll('-','')): Order {
    return {local_id:id,broker_id:'',tag:id.slice(0,6),symbol,action,shares,limit_price:limitPrice,lot,
      status:'PREPARED',filled:0,created_at:now.toISOString(),plan_id:planId,purpose};
  }
  async submit(order: Order, suppliedNow: Date,smart?:SmartSpec): Promise<boolean> {
    if (!this.canExecute()) return false;
    await this.reconcile(suppliedNow,true); const account = await this.refreshAccount(suppliedNow);
    const now = this.broker.production ? new Date() : suppliedNow;
    if (order.purpose === 'ENTRY' && (!this.plan || order.plan_id !== this.plan.id
      || Date.parse(this.plan.analysis.expires_at) <= now.getTime() || this.entryBlocked)) return false;
    const last = this.store.orders().filter(o => o.symbol === order.symbol && (active(o) || o.filled > 0)).at(-1)?.created_at;
    const reasons = this.risk.check(order,account,this.quotes.get(`${order.symbol}:${order.lot === 'ODD'}`),this.metadata[order.symbol],
      now,this.baseline(now),this.killed || (this.pausedEntries && order.action === 'BUY'),last);
    if (reasons.length) { this.decisionStates.set(order.symbol,{state:'BLOCKED',reason:reasons.join('；'),source:order.purpose});
      this.logOnce('RISK',`${order.symbol} ${order.action}：${reasons.join('；')}`);
      const refusal=order.purpose==='PROTECTION'?createHash('sha256').update(`${twDay(now)}:${order.symbol}:${reasons.join(';')}`).digest('hex'):order.local_id;
      this.store.recordExperience({id:`risk:${refusal}`,at:now.toISOString(),mode:this.store.get<string>('experience_scope') ?? this.settings.mode,
        kind:'RISK_REFUSAL',symbol:order.symbol,action:order.action,shares:order.shares,price:null,fee:null,tax:null,
        realized_pnl:null,note:reasons.join('；')}); return false; }
    const protection=smart?updateProtection(this.store.protections().find(p=>p.symbol===order.symbol),order.symbol,smart,order.plan_id):undefined;
    if (!this.store.prepareIntent(order,protection)) { this.logOnce('BLOCK','委託識別已存在或短標籤碰撞，禁止重送'); return false; }
    order.status = 'SUBMITTING'; this.store.saveOrder(order);
    try {
      const result = await this.broker.submit(order); this.recordReconciledFill(result,order.filled,now);this.store.saveOrder(result);
      this.log('ORDER',`${order.symbol} ${order.action} ${order.shares} 股 @ ${order.limit_price} ${result.status}`);
    } catch (error) {
      if (error instanceof NoSubmissionError) {
        order.status = 'REJECTED'; this.store.saveOrder(order); this.entryBlocked = true;
        this.log('BLOCK',`${order.symbol} 未送出委託：${error.message}`); return false;
      }
      order.status = 'UNKNOWN'; this.store.saveOrder(order);
      this.log('UNKNOWN',`${order.symbol} 送單結果不明；先核對，禁止自動重送`); return false;
    }
    await this.refreshAccount(now); return true;
  }
  async cancel(localId: string, now: Date): Promise<void> {
    if (this.settings.mode === 'readonly' || !this.connected) throw new Error('目前模式無法撤單');
    const order = this.store.orders(true).find(o => o.local_id === localId);
    if (!order || order.purpose === 'EXTERNAL') return;
    if (['UNKNOWN','PREPARED','SUBMITTING','CANCEL_PENDING'].includes(order.status)) {
      this.logOnce('BLOCK','未確認委託須先核對，禁止重送撤單或重掛'); return;
    }
    const priorStatus = order.status;
    order.status = 'CANCEL_PENDING'; this.store.saveOrder(order);
    try { const result = await this.broker.cancel(order); this.recordReconciledFill(result,order.filled,now);this.store.saveOrder(result);
      this.log('CANCEL',`${order.symbol} 撤單核對：${result.status}，已成交 ${result.filled} 股`); }
    catch (error) {
      if (error instanceof NoSubmissionError) { order.status = priorStatus; this.store.saveOrder(order); this.logOnce('BLOCK',`${order.symbol} ${error.message}`); }
      else { order.status = 'UNKNOWN'; this.store.saveOrder(order); this.log('UNKNOWN',`${order.symbol} 撤單結果不明，停止重掛`); }
    }
    await this.refreshAccount(now);
  }
  status(now: Date): string {
    const a = this.account;
    const lines = [`Shioaji Codex Trader | TypeScript | ${this.settings.mode.toUpperCase()} | ${twDay(now)} ${new Date(now.getTime()+28800000).toISOString().slice(11,19)} 台北`,
      `連線=${this.connected} 自動執行=${this.settings.auto_execute} 暫停買進=${this.pausedEntries} 緊急停止=${this.killed}`,
      this.settings.mode === 'demo' ? 'DEMO：虛構股票與行情，無真實委託' : '數量單位：股；今日新增零股禁止當沖'];
    if (a) {
      lines.push(`現金=${a.cash} 待付交割=${a.settlement_debits} 淨資產=${equity(a).toFixed(0)}`,
        `帳戶快照=${a.asof} 完整=${a.complete} ${a.issue}`,`今日買進預算占用=${a.daily_buy_amount} 筆數=${a.daily_buy_count}`,'','持倉：');
      lines.push(...(a.positions.length ? a.positions.map(p => `${p.symbol} ${p.shares} 股 / 可賣 ${p.sellable} / 成本 ${p.average_price} / 現價 ${p.last_price}`) : ['無']));
    }
    if (this.plan) lines.push('',`計畫 ${this.plan.id.slice(0,8)} 到期 ${this.plan.analysis.expires_at}`,this.plan.analysis.summary,
      '候選：' + this.plan.analysis.candidates.join(', '),...this.plan.analysis.decisions.map(d => `${d.symbol} ${d.action} ${d.shares} 股 @ ${d.limit_price}：${d.reason}`));
    lines.push('',`偵測每 ${this.settings.monitor_interval_seconds} 秒 / 觀測更新每 ${this.settings.watch_refresh_minutes} 分鐘 / 策略 ${this.settings.strategy_schedule==='fixed'?this.settings.strategy_times.join('、'):this.settings.decision_interval_minutes+' 分鐘'}`,
      `觀測 ${this.watch.entries.filter(w=>w.state==='OBSERVE').length} 檔；${this.watch.healthy?'資料已確認':this.watch.issue}`);
    lines.push('','保護條件：',...this.store.protections().map(p => `${p.symbol} 停損=${p.spec.stop_price} 停利=${p.spec.take_profit ?? '-'} 高點=${p.high_water} 訊號=${p.triggered || '-'}`),
      '','未完成委託：',...this.store.orders(true).map(o => `${o.local_id.slice(0,8)} ${o.symbol} ${o.action} ${o.filled}/${o.shares} 股 @ ${o.limit_price} ${o.status}`));
    return lines.join('\n');
  }
}
