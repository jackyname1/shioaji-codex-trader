import { createHash, randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { Risk, alignedPrice, fee, roundPrice } from './risk.js';
import { evaluate, updateProtection,trackEntry,entryReady,reboundExit } from './smart.js';
import { indicators, validateAnalysis } from './strategy.js';
import { conditionIssue } from './conditions.js';
import {entryWindow} from './entry-window.js';
import {capitalSnapshot} from './capital.js';
import {entryRiskIssues,entryQualityIssues} from './costs.js';
import {adaptiveSetups,adaptiveProtection,signalScore,adaptiveLimits} from './adaptive.js';
import { experienceContext } from './experience.js';
import { emptyWatch, selectWatchlist, watchEligibility, ruleEntry, type WatchState } from './watchlist.js';
import { nextStrategy } from './schedule.js';
import { active, ageSeconds, d, equity, remaining, twDay, twClock, type Account, type Analysis, type Candidate, type Features,
  type Instrument, type Order, type Plan, type Quote, type Settings, type Snapshot, type SmartSpec } from './models.js';
import { NoSubmissionError, type Broker } from '../broker/types.js';
import { brokerIssue } from '../broker/health.js';
import { ExecutionAdviceSchema, executionLot, executionSettingsKey, spendableCash,
  type ExecutionAdvice, type ExecutionRequest, type ExecutionTicket } from './execution.js';

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
  advisorIssue='';
  setAdvisorIssue(issue:string):void {
    this.advisorIssue=issue;if(issue)this.clearExecutions(issue+'；未確認數量不送單');
  }
  private _entryBlocked=false;
  get entryBlocked():boolean{return this._entryBlocked;}
  set entryBlocked(value:boolean){this._entryBlocked=value;this.store.set('entry_blocked',value);}
  watch:WatchState;
  watchFeatures:Record<string,Features>={};
  decisionStates=new Map<string,{state:string;reason:string;source:string}>();
  readonly pendingExecutions=new Map<string,ExecutionTicket>();
  private executionRetry:Record<string,string>;
  private lastTick?: Date;
  private lastRefresh?: Date;
  private lastReconcile?: Date;
  private generation = -1;
  private metadataDay = '';
  private inspectedSymbol='';
  private recent: string[] = [];
  constructor(readonly store: Store, readonly broker: Broker, public settings: Settings, readonly calendar: TradingCalendar) {
    this.risk = new Risk(settings,calendar); this.plan = store.plan();
    this._entryBlocked=store.get<boolean>('entry_blocked')??false;
    this.watch=store.get<WatchState>('watch_state')??emptyWatch();
    this.pausedEntries = store.get<boolean>('paused_entries') ?? false; this.killed = store.get<boolean>('kill_switch') ?? false;
    this.executionRetry=store.get<Record<string,string>>('execution_retry')??{};
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
    this.clearExecutions('帳務或行情正在重新核對');
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
    if(executionSettingsKey(s)!==executionSettingsKey(this.settings))this.clearExecutions('設定已變更，重新確認交易數量');
    this.settings = s; this.risk = new Risk(s,this.calendar); this.store.saveSettings(s);
    if ('settings' in this.broker) (this.broker as Broker & { settings: Settings }).settings = s;
    if ('market' in this.broker) {
      const market = (this.broker as Broker & {market: Broker}).market;
      if ('settings' in market) (market as Broker & {settings: Settings}).settings = s;
    }
  }
  canExecute(): boolean { return this.connected && this.settings.auto_execute && this.settings.mode !== 'readonly' && !this.killed; }
  pauseEntries(paused = true): void {
    if(paused)this.clearExecutions('已暫停新增買進',true);
    this.pausedEntries = paused; this.store.set('paused_entries',paused);
    this.log('PAUSE',paused ? '停止新增買進；保護監控持續' : '恢復新增買進');
  }
  kill(enabled = true): void { if(enabled)this.clearExecutions('已停止新委託');this.killed = enabled; this.store.set('kill_switch',enabled);
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
    if(account.complete)for(const old of this.account?.positions??[])if(old.shares&&!account.positions.some(p=>p.symbol===old.symbol&&p.shares)
      &&!account.orders.some(o=>o.symbol===old.symbol&&o.action==='BUY'&&active(o))){
      this.store.removeProtection(old.symbol);this.store.set('entry_tracks',this.store.entryTracks().filter(t=>t.symbol!==old.symbol));
    }
    this.account = account; this.lastRefresh = now;
    const pins=new Map<string,string>();
    account.positions.filter(p=>p.shares>0).forEach(p=>pins.set(p.symbol,'持倉：持續監測出場條件'));
    account.orders.filter(active).forEach(o=>pins.set(o.symbol,'未完成委託：保留成交核對'));
    let newPin=false;
    for(const [symbol,reason] of pins)if(!this.watch.entries.some(w=>w.symbol===symbol)){
      newPin=true;
      const at=now.toISOString();this.watch.entries.push({symbol,name:this.metadata[symbol]?.name??symbol,state:'RETAINED',source:'SCANNER',
        eligible:false,score:0,reason,added_at:at,checked_at:at,misses:0});
      this.watch.changes.push({at,symbol,action:'RETAIN',reason});
    }
    this.watch.changes=this.watch.changes.slice(-120);this.store.set('watch_state',this.watch);
    if(newPin&&this.connected)try{await this.updateSubscriptions(now);}catch(error){
      this.metadataDay='';this.logOnce('SUBSCRIPTION','持倉已保留監測；行情訂閱稍後重新核對：'+brokerIssue(error));
    }
    this.dataIssue = account.complete ? '' : account.issue;
    const key = 'baseline_' + twDay(now);
    if (account.complete && !this.store.get(key)) { this.store.set(key,{equity:equity(account).toFixed(),at:now.toISOString()});
      this.log('BASELINE','建立今日首次有效快照基準；不是歷史開盤資產'); }
    const baseline=this.baseline(now),lossKey='daily_loss_hit_'+twDay(now);
    if(account.complete&&baseline&&equity(account).lte(d(baseline).times(d(1).minus(this.settings.daily_loss_fraction)))&&!this.store.get(lossKey)){
      this.store.set(lossKey,{at:now.toISOString(),equity:equity(account).toFixed()});
      this.log('DAILY_LOSS','達到日損失限制；本日鎖定新增買進，持倉保護持續');
    }
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
    if(this.inspectedSymbol)symbols.add(this.inspectedSymbol);
    this.account?.positions.forEach(p => symbols.add(p.symbol)); this.store.orders(true).forEach(o => symbols.add(o.symbol));
    this.plan?.analysis.candidates.forEach(s => symbols.add(s)); this.plan?.analysis.decisions.forEach(d => symbols.add(d.symbol));
    this.watch.entries.forEach(w=>symbols.add(w.symbol));
    const list = [...symbols]; await this.broker.subscribe(list,this.settings.whole_lots);
    this.metadata = await this.broker.instruments(list,now); this.metadataDay = twDay(now);
  }
  /** Viewing an extra stock subscribes quotes without changing watch eligibility or strategy. */
  async inspectSymbol(symbol:string,now:Date):Promise<void>{
    if(!/^[1-9]\d{3}$/.test(symbol))throw new Error('圖表股票代碼不合法');
    if(this.inspectedSymbol===symbol&&this.metadata[symbol])return;
    const old=this.inspectedSymbol;this.inspectedSymbol=symbol;
    try{await this.updateSubscriptions(now);}catch(error){this.inspectedSymbol=old;this.metadataDay='';throw error;}
  }
  async collectBundle(now: Date): Promise<Bundle> {
    const pool = await this.broker.discover(this.settings.candidate_pool_size,now);
    const symbols = [...new Set([...pool.map(p => p.symbol),...(this.account?.positions.map(p => p.symbol) ?? [])])];
    const features: Record<string,Features> = {};
    // Limit concurrent history queries; collection happens outside the single-writer engine queue.
    const pending = [...symbols];
    await Promise.all(Array.from({length:3},async () => {
      for (;;) { const symbol = pending.shift(); if (!symbol) break;
        const supplied=this.broker.features?.(symbol,now);
        if(supplied){features[symbol]=structuredClone(supplied);continue;}
        // A morning cache must never hide the completed current-day bar at review time.
        const key = `history_v3_${twDay(now)}_${twClock(now)>='13:40'?'POST':'PRE'}_${symbol}`;
        let issue='';
        let bars = this.store.get<import('./models.js').Bar[]>(key);
        if (!bars) { try { bars = await this.broker.history(symbol,now); if (bars.length) this.store.set(key,bars); }
          catch(error) { bars = [];issue=brokerIssue(error); } }
        const f = indicators(bars);
        if(!f.sufficient)f.issue=issue||`歷史 K 線只有 ${bars.length} 個已完成交易日，至少需要 20 日`;
        if (this.settings.mode !== 'demo'||this.store.get('historical_real_data')) {
          let previous = '9999-12-31'; try { previous = this.calendar.next(twDay(now),-1); } catch { /* fail closed */ }
          if (!f.asof || f.asof < previous) { f.sufficient = false; f.issue ||= '歷史行情過期或交易日未知'; }
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
    const baseline=this.baseline(now),loss=baseline?d(baseline).minus(equity(a)):undefined;
    const cash=spendableCash(a,this.settings),minimum=equity(a).times(this.settings.min_cash_fraction),room=d(cash.available).minus(minimum);
    this.metadata = {...this.metadata,...bundle.metadata};
    for(const q of this.broker.quotes(now))this.quotes.set(`${q.symbol}:${q.odd}`,q);
    const quoteSymbols=new Set([...bundle.pool.map(c=>c.symbol),...a.positions.map(p=>p.symbol)]);
    const quotes=[...this.quotes.values()].filter(q=>quoteSymbols.has(q.symbol)&&!q.simulated
      &&[q.trade_at,q.book_at].every(at=>ageSeconds(now,at)>=0&&ageSeconds(now,at)<=this.settings.quote_max_age));
    const limits = Object.fromEntries(['whole_lots','min_cash_fraction','max_order_fraction','order_budget_basis','target_exposure_fraction','min_entry_reward_risk','max_trade_risk_fraction','max_symbol_fraction',
      'max_exposure_fraction','max_daily_buy_fraction','max_daily_buy_orders','daily_loss_fraction',
      'price_deviation_fraction','minimum_fee','fee_rate','sell_tax_rate','plan_max_minutes','watch_min_amount','watch_max_symbols'].map(k => [k,this.settings[k as keyof Settings]]));
    return {snapshot_id:randomUUID(),asof:now.toISOString(),synthetic:this.settings.mode === 'demo',review_only:review,
      account:{cash:a.cash,settlement_debits:a.settlement_debits,settlement_credits:a.settlement_credits,
        equity:equity(a).toFixed(),available_cash:cash.available,order_cash_reserved:cash.reserved,
        minimum_cash_reserve:minimum.toFixed(),buying_power:room.gt(0)?room.toFixed():'0',
        daily_baseline_equity:baseline??null,daily_loss_amount:loss?(loss.gt(0)?loss.toFixed():'0'):null,
        daily_loss_ratio:loss&&d(baseline!).gt(0)?(loss.gt(0)?loss.div(baseline!).toFixed():'0'):null,
        daily_buy_amount:a.daily_buy_amount,daily_buy_count:a.daily_buy_count,
        positions:structuredClone(a.positions),open_orders:a.orders.filter(active).map(o => ({
          symbol:o.symbol,action:o.action,shares:remaining(o),limit_price:o.limit_price}))},
      universe:bundle.pool,features:bundle.features,hard_limits:{...limits,...adaptiveLimits(this.settings),capital_profile:this.store.get('replay_capital_profile')??'custom'},capital:capitalSnapshot(a,this.settings),
      quotes:structuredClone(quotes),parallel_entries:this.adaptiveCandidates(),entry_feedback:this.entryFeedback(bundle,now),
      instruments:structuredClone(bundle.metadata),data_readiness:{pool_count:bundle.pool.length,
        history_ready:bundle.pool.filter(c=>bundle.features[c.symbol]?.sufficient).length,
        eligible_symbols:bundle.pool.filter(c=>!watchEligibility(c,bundle.features[c.symbol],bundle.metadata[c.symbol],this.settings,undefined,now).length).map(c=>c.symbol),
        history_issues:Object.entries(bundle.features).flatMap(([symbol,f])=>f.issue?[{symbol,issue:f.issue}]:[])},
      existing_protection:Object.fromEntries(this.store.protections().map(p => [p.symbol,p.spec])),
      smart_tracking:{entries:this.store.entryTracks(),protections:this.store.protections()},
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
  private entryFeedback(bundle:Bundle,now:Date):Snapshot['entry_feedback']{
    if(!this.plan)return undefined;
    const selected=this.adaptiveDecisions(),programSymbols=new Set(selected.map(d=>d.symbol));
    const decisions=new Map([...this.plan.analysis.decisions.filter(d=>d.action==='BUY'),...selected].map(d=>[d.symbol,d]));
    return {plan_id:this.plan.id,asof:now.toISOString(),signals:[...decisions.values()].map(decision=>({symbol:decision.symbol,
      window:entryWindow(decision,bundle.features[decision.symbol],now,bundle.metadata[decision.symbol]),
      state:this.decisionStates.get(decision.symbol)?.state??'WAIT',reason:this.decisionStates.get(decision.symbol)?.reason??'等待進場條件',
      source:programSymbols.has(decision.symbol)?'PROGRAM' as const:'MODEL' as const,selected_strategy:decision.entry_strategy}))};
  }
  async activate(analysis: Analysis, snapshot: Snapshot, now: Date): Promise<void> {
    const plan = validateAnalysis(analysis,snapshot,now,this.settings);
    if(this.settings.adaptive_entries&&!snapshot.review_only)for(const d of plan.analysis.decisions)
      if(d.entry_when==='REBOUND')d.tracking_timeout_minutes??=this.settings.entry_tracking_minutes;
    if(snapshot.review_only) {
      if(analysis.decisions.some(d=>d.smart!==null))this.log('REVIEW_NOTE','盤後 HOLD 附帶的智慧單已轉為說明資料；檢討不更新交易保護');
      if(this.settings.experience_enabled)this.store.saveReview({id:plan.id,at:now.toISOString(),
        mode:this.store.get<string>('experience_scope')??this.settings.mode,summary:plan.analysis.summary,sample_count:snapshot.experience?.sample_count??0});
      this.log('REVIEW',plan.analysis.summary);return;
    }
    const existing = new Map(this.store.protections().map(p => [p.symbol,p]));
    const protections = plan.analysis.decisions.filter(d => d.smart !== null)
      .map(d => updateProtection(this.account?.positions.some(p=>p.symbol===d.symbol&&p.shares>0)?existing.get(d.symbol):undefined,d.symbol,d.smart!,plan.id));
    if (this.canExecute()) for (const order of this.store.orders(true))
      if (order.purpose === 'ENTRY' && order.plan_id !== plan.id) await this.cancel(order.local_id,now);
    this.store.activatePlan(plan,protections); this.plan = plan; this.entryBlocked = false;
    this.clearExecutions('Codex 已更新條件，舊的數量建議作廢');
    this.decisionStates.clear();
    await this.refreshWatch({pool:snapshot.universe,features:snapshot.features,metadata:this.metadata},now);
    this.log('PLAN',`啟用 ${plan.id.slice(0,8)}，有效至 ${plan.analysis.expires_at}；${plan.analysis.screening?.entry?'含自動選股進場規則':'依個股決策執行'}`);
  }
  private observeEntries(now:Date):void {
    if(!this.plan||Date.parse(this.plan.analysis.expires_at)<=now.getTime())return;
    const setups=this.store.get<{plan_id:string;decisions:import('./models.js').Decision[]}>('adaptive_setups');
    const decisions=[...this.plan.analysis.decisions,...(setups?.plan_id===this.plan.id?setups.decisions:[])];
    const tracks=new Map(this.store.entryTracks().filter(t=>t.plan_id===this.plan!.id||!!t.strategy&&!!t.expires_at&&t.expires_at>now.toISOString())
      .map(t=>[t.symbol+':'+t.lot+':'+(t.strategy??'MODEL'),t]));let changed=false;
    for(const decision of decisions.filter(d=>d.entry_when==='REBOUND'||(d.confirmation_ticks??1)>1))for(const odd of [true,false]){
      const q=this.quotes.get(`${decision.symbol}:${odd}`);
      if(!q||q.simulated||!this.calendar.inSession(now,odd?'ODD':'COMMON')||!odd&&!this.settings.whole_lots
        ||ageSeconds(now,q.trade_at)<0||ageSeconds(now,q.trade_at)>this.settings.quote_max_age)continue;
      const key=decision.symbol+':'+(odd?'ODD':'COMMON')+':'+(decision.entry_strategy??'MODEL'),old=tracks.get(key);
      const next=trackEntry(old,decision,this.plan.id,q,this.plan.created_at,!conditionIssue(decision,q,this.watchFeatures[decision.symbol],now));
      if(JSON.stringify(old)!==JSON.stringify(next)){tracks.set(key,next);changed=true;}
    }
    if(changed)this.store.replaceEntryTracks([...tracks.values()]);
  }
  async tick(now: Date,evaluateConditions=true,smartConditions=false): Promise<void> {
    if (!this.connected) return;
    const resumed = this.lastTick && now.getTime() - this.lastTick.getTime() > 45000;
    const changed = this.generation !== this.broker.generation;
    if (resumed || changed || this.metadataDay !== twDay(now)) {
      if(changed)this.clearExecutions('行情連線已變更，重新確認條件與數量');
      this.quotes.clear(); await this.syncAccount(now,true); await this.updateSubscriptions(now);
      this.generation = this.broker.generation;
      if (resumed || changed) this.logOnce('RESUME','連線或系統狀態變更，清除行情並重新核對');
    }
    this.lastTick = now;
    if (!this.lastReconcile || this.broker.dirty || this.store.orders(true).length&&now.getTime()-this.lastReconcile.getTime()>=this.settings.monitor_interval_seconds*1000
      || now.getTime() - this.lastReconcile.getTime() >= 15000)try{await this.reconcile(now);}catch(error){this.dataUnavailable(error,now);}
    if (!this.lastRefresh || now.getTime() - this.lastRefresh.getTime() >= 20000 || this.broker.dirty) {
      await this.syncAccount(now);
    }
    if (this.plan && Date.parse(this.plan.analysis.expires_at) <= now.getTime() && this.canExecute())
      for (const o of this.store.orders(true)) if (o.purpose === 'ENTRY') await this.cancel(o.local_id,now);
    for (const q of this.broker.quotes(now)) this.quotes.set(`${q.symbol}:${q.odd}`,q);
    if (['demo','paper'].includes(this.settings.mode)) { await this.reconcile(now); await this.refreshAccount(now); }
    this.observeEntries(now);
    if (!this.account || !evaluateConditions&&!smartConditions) return;
    const exitsTriggered=new Set<string>();
    for (let protection of this.store.protections()) {
      const p = this.account.positions.find(p => p.symbol === protection.symbol);
      const pendingBuy = this.account.orders.some(o => active(o) && o.symbol === protection.symbol && o.action === 'BUY');
      const plannedBuy = this.plan && Date.parse(this.plan.analysis.expires_at) > now.getTime()
        && this.plan.analysis.decisions.some(d => d.symbol === protection.symbol && d.action === 'BUY');
      if (!p?.shares) { if (!pendingBuy && !plannedBuy) this.store.removeProtection(protection.symbol); continue; }
      const protectionLot = this.settings.whole_lots && p.sellable >= 1000 ? 'COMMON' : 'ODD';
      if(!this.calendar.inSession(now,protectionLot))continue;
      const q = this.quotes.get(`${p.symbol}:${protectionLot === 'ODD'}`);
      if (!q || q.simulated || !(ageSeconds(now,q.trade_at) >= 0 && ageSeconds(now,q.trade_at) <= this.settings.quote_max_age)) continue;
      protection=adaptiveProtection(protection,p,this.watchFeatures[p.symbol],this.settings,this.broker.costBasis?.(p.symbol));
      const trigger = evaluate(protection,q.last,q.trade_at); this.store.saveProtection(protection);
      if (!trigger) continue;
      exitsTriggered.add(p.symbol);
      if(trigger==='STOP')for(const [id,ticket] of this.pendingExecutions)if(ticket.order.symbol===p.symbol
        &&(ticket.source!=='PROTECTION'||ticket.trigger!=='STOP'))this.pendingExecutions.delete(id);
      const pending = this.store.orders(true).find(o => o.symbol === p.symbol);
      if(pending?.action==='BUY'&&this.canExecute()){await this.cancel(pending.local_id,now);continue;}
      if (!p.sellable) { this.decisionStates.set(p.symbol,{state:'WAIT',reason:'出場已觸發；今日新增零股不可當沖，等待可賣庫存',source:'PROTECTION'});
        this.logOnce('WAIT',`${p.symbol} ${trigger} 觸發；今日買進量不可賣，下個交易日重評`); continue; }
      if (!this.canExecute()) continue;
      if(!d(q.bid).gt(0)||q.bid_shares<=0){this.decisionStates.set(p.symbol,{state:'WAIT',reason:trigger+' 已觸發；跌停或無有效買盤，保留退場追蹤',source:'PROTECTION'});continue;}
      if (pending) {
        if (pending.action === 'BUY') await this.cancel(pending.local_id,now);
        else if (pending.purpose === 'PROTECTION' && d(q.bid).gt(0) && alignedPrice(q.bid)
          && d(q.bid).lt(pending.limit_price) && ageSeconds(now,pending.created_at) >= 60) await this.cancel(pending.local_id,now);
        continue; // Replacement is allowed only on a later tick after confirmed cancel + inventory refresh.
      }
      const attempts = this.store.orders().filter(o => o.symbol === p.symbol && o.purpose === 'PROTECTION'
        && twDay(new Date(o.created_at)) === twDay(now)).length;
      if (attempts >= 10) { const reason='保護出場嘗試已達上限，請核對委託';this.decisionStates.set(p.symbol,{state:'BLOCKED',reason,source:'PROTECTION'});this.logOnce('BLOCK',`${p.symbol} ${reason}`); continue; }
      const protectionShares = protectionLot === 'COMMON' ? Math.floor(p.sellable / 1000) * 1000 : Math.min(999,p.sellable);
      let protectionPrice=q.bid;
      if(!this.broker.production&&['paper','demo'].includes(this.settings.mode)){
        const tolerance=d(this.settings.exit_slippage_fraction).gte(this.settings.simulation_slippage_fraction)?d(this.settings.exit_slippage_fraction):d(this.settings.simulation_slippage_fraction);
        const floor=d(q.bid).times(d(1).minus(tolerance)),minimum=this.metadata[p.symbol]?.limit_down;
        protectionPrice=roundPrice(minimum&&floor.lt(minimum)?minimum:floor);
      }
      await this.requestExecution(this.newOrder(p.symbol,'SELL',protectionShares,protectionPrice,protectionLot,now,protection.plan_id,'PROTECTION'),
        now,'PROTECTION',undefined,undefined,trigger,protection.spec);
    }
    if (!this.canExecute() || !this.plan || Date.parse(this.plan.analysis.expires_at) <= now.getTime()) return;
    const plan = this.plan;
    const decisions=[...plan.analysis.decisions];
    if(this.settings.adaptive_entries&&this.settings.auto_watchlist&&this.watch.healthy&&plan.analysis.stance==='BUY_ALLOWED'){
      let cache=this.store.get<{plan_id:string;decisions:import('./models.js').Decision[];checked:string[];selected?:import('./models.js').Decision[]}>('adaptive_setups');
      if(cache?.plan_id!==plan.id)cache={plan_id:plan.id,decisions:[],checked:[]};
      for(const w of this.watch.entries.filter(w=>w.eligible&&w.state==='OBSERVE')){
        if(decisions.some(d=>d.symbol===w.symbol&&d.action==='SELL')||this.account.positions.some(p=>p.symbol===w.symbol&&p.shares))continue;
        const q=this.quotes.get(w.symbol+':true')??(this.settings.whole_lots?this.quotes.get(w.symbol+':false'):undefined);
        if(!q||q.simulated||ageSeconds(now,q.trade_at)<0||ageSeconds(now,q.trade_at)>this.settings.quote_max_age)continue;
        // Freeze each strategy independently. An earlier rebound must not prevent a
        // trend/breakout setup from appearing later in the same plan.
        const existing=new Set(cache.decisions.filter(d=>d.symbol===w.symbol).map(d=>d.entry_strategy));
        cache.decisions.push(...adaptiveSetups(w.symbol,this.watchFeatures[w.symbol],q,now,this.settings)
          .filter(d=>!existing.has(d.entry_strategy)));if(!cache.checked.includes(w.symbol))cache.checked.push(w.symbol);
      }
      this.store.set('adaptive_setups',cache);this.observeEntries(now);
      const candidates=cache.decisions.filter(d=>!this.account!.positions.some(p=>p.symbol===d.symbol&&p.shares)
        &&!decisions.some(x=>x.symbol===d.symbol&&x.action==='SELL'));
      const observedTracks=this.store.entryTracks();
      cache.selected=(cache.selected??[]).filter(d=>this.account!.positions.some(p=>p.symbol===d.symbol&&p.shares)
        ||this.account!.orders.some(o=>o.symbol===d.symbol&&active(o)));
      for(const symbol of new Set(candidates.map(d=>d.symbol))){
        const group=[...decisions.filter(d=>d.symbol===symbol&&d.action==='BUY'),...candidates.filter(d=>d.symbol===symbol)];
        const readiness=(decision:import('./models.js').Decision):number=>{
          let rank=0;
          for(const odd of this.settings.whole_lots?[true,false]:[true]){
            const lot=odd?'ODD':'COMMON',q=this.quotes.get(symbol+':'+odd),m=this.metadata[symbol];
            const t=observedTracks.find(t=>t.plan_id===plan.id&&t.symbol===symbol&&t.strategy===decision.entry_strategy&&t.lot===lot);
            if(!q||!m||q.simulated||!this.calendar.inSession(now,lot)||[q.trade_at,q.book_at].some(at=>ageSeconds(now,at)<0||ageSeconds(now,at)>this.settings.quote_max_age)
              ||!entryReady(decision,q.last,t)||conditionIssue(decision,q,this.watchFeatures[symbol],now)||entryWindow(decision,this.watchFeatures[symbol],now,m).issue)continue;
            rank=1;
            const order=this.newOrder(symbol,'BUY',decision.shares,decision.limit_price,lot,now,plan.id,'ENTRY');
            const ticket:ExecutionTicket={id:'selection',key:'',queued_at:now.toISOString(),state:'QUEUED',order,
              source:plan.analysis.decisions.includes(decision)?'CODEX':'RULE',condition:decision,smart:decision.smart??undefined,
              trigger:'selection',settings_key:executionSettingsKey(this.settings),generation:this.broker.generation};
            const last=this.store.orders().filter(o=>o.symbol===symbol&&(active(o)||o.filled>0)).at(-1)?.created_at;
            if(executionLot(ticket,q,this.account!,m,this.risk,now,this.baseline(now),last).max_shares>0)return 2;
          }
          return rank;
        };
        const ranks=new Map(group.map(d=>[d,readiness(d)]));
        group.sort((a,b)=>ranks.get(b)!-ranks.get(a)!||signalScore(b,this.watchFeatures[symbol],this.settings)-signalScore(a,this.watchFeatures[symbol],this.settings));
        const index=decisions.findIndex(d=>d.symbol===symbol);if(index>=0)decisions.splice(index,1);
        const selected=group[0]!;decisions.push(selected);
        if(!plan.analysis.decisions.includes(selected))cache.selected.push(selected);
      }
      this.store.set('adaptive_setups',cache);
    }
    if(evaluateConditions&&this.settings.auto_watchlist&&!this.settings.adaptive_entries&&plan.analysis.screening?.entry)for(const w of this.watch.entries) {
      if(decisions.some(d=>d.symbol===w.symbol))continue;
      if(!this.watch.healthy||ageSeconds(now,this.watch.asof)>this.settings.watch_refresh_minutes*120) {
        this.decisionStates.set(w.symbol,{state:'WAIT',reason:'觀測資料更新尚未確認',source:'RULE'});continue;
      }
      const common=this.settings.whole_lots?ruleEntry(plan,w,this.watchFeatures[w.symbol],this.quotes.get(`${w.symbol}:false`),this.account,this.settings,now):undefined;
      const sized=common?.decision?common:ruleEntry(plan,w,this.watchFeatures[w.symbol],this.quotes.get(`${w.symbol}:true`),this.account,this.settings,now);
      if(sized.decision)decisions.push(sized.decision);
      else this.decisionStates.set(w.symbol,{state:'WAIT',reason:sized.reason,source:'RULE'});
    }
    if(this.settings.dynamic_allocation)decisions.sort((a,b)=>(a.action==='SELL'?0:1)-(b.action==='SELL'?0:1)
      ||signalScore(b,this.watchFeatures[b.symbol],this.settings)-signalScore(a,this.watchFeatures[a.symbol],this.settings)||a.symbol.localeCompare(b.symbol));
    for (const decision of decisions) {
      if(!evaluateConditions&&decision.entry_when!=='REBOUND')continue;
      const source=plan.analysis.decisions.includes(decision)?'CODEX':'RULE';
      const state=(state:string,reason:string):void=>{this.decisionStates.set(decision.symbol,{state,reason,source});};
      if(exitsTriggered.has(decision.symbol))continue;
      if([...this.pendingExecutions.values()].some(t=>t.order.symbol===decision.symbol))continue;
      if(decision.action==='HOLD'){state('HOLD',decision.reason);continue;}
      if(twDay(new Date(plan.created_at))!==twDay(now)){state('EXPIRED','舊交易日的進場／減碼計畫失效，等待今日策略');continue;}
      if(decision.action==='BUY'){
        const window=entryWindow(decision,this.watchFeatures[decision.symbol],now,this.metadata[decision.symbol]);
        if(window.issue){state('BLOCKED',window.issue);this.logOnce('BLOCK',`${decision.symbol} ${window.issue}`);continue;}
      }
      if(decision.action==='BUY'&&(this.entryBlocked||this.pausedEntries)){state('BLOCKED','新買進已暫停，保護監控持續');continue;}
      if(decision.action==='BUY'&&this.store.get('daily_loss_hit_'+twDay(now))){state('BLOCKED','達到日損失限制；本日鎖定新增買進');continue;}
      if(decision.action==='BUY'&&this.store.get('postfill_block_'+twDay(now))){state('BLOCKED','成交後風險預算或停損有效性異常；本日停止新增買進');continue;}
      if(decision.action==='BUY'&&this.settings.auto_watchlist&&(!this.watch.healthy
        ||ageSeconds(now,this.watch.asof)>this.settings.watch_refresh_minutes*120
        ||!this.watch.entries.some(w=>w.symbol===decision.symbol&&w.eligible))){state('BLOCKED','目前觀測資格未確認');continue;}
      const preferred=this.quotes.get(`${decision.symbol}:${decision.shares<1000}`);
      const q=this.settings.codex_enabled?(preferred??this.quotes.get(`${decision.symbol}:true`)??this.quotes.get(`${decision.symbol}:false`)):preferred;
      const lot=q?.odd===false?'COMMON':'ODD';
      if(q&&(q.simulated||!this.calendar.inSession(now,lot)||[q.trade_at,q.book_at].some(t=>ageSeconds(now,t)<0||ageSeconds(now,t)>this.settings.quote_max_age))){
        state('WAIT','等待交易時段內新鮮成交與五檔行情');continue;
      }
      const tracking=this.store.entryTracks().find(t=>t.plan_id===plan.id&&t.symbol===decision.symbol&&t.strategy===decision.entry_strategy&&t.lot===lot);
      if(tracking?.state==='EXPIRED'||tracking?.state==='INVALID'){state('EXPIRED',tracking.state==='EXPIRED'?'追蹤逾時，等待新策略重新啟動':'訊號跌破停損已失效，等待新策略');continue;}
      if(tracking?.state==='CONFIRMING'){state('TRACKING','追蹤確認中，等待不同時間的持續訊號');continue;}
      if (!q || !entryReady(decision,q.last,tracking)) {state('WAIT',!q?'等待對應市場行情':decision.entry_when==='REBOUND'
        ?tracking?.armed?`追蹤低點 ${tracking.low_water}；等待回升至 ${reboundExit(tracking,decision)}`:`等待跌至 ${decision.trigger_price} 啟動反彈追蹤`
        :`等待${decision.entry_when==='BELOW'?'低於':'高於'} ${decision.trigger_price}`);continue;}
      if (decision.action === 'BUY' && decision.smart && d(q.ask).lte(decision.smart.stop_price)) {
        state('BLOCKED','已跌破進場計畫停損，等待新策略');this.logOnce('BLOCK',`${decision.symbol} 已跌破進場計畫停損，等待新計畫`); continue;
      }
      const guardIssue=conditionIssue(decision,q,this.watchFeatures[decision.symbol],now);
      if(guardIssue){state('WAIT',guardIssue);continue;}
      const id = createHash('sha256').update(`${plan.id}:${decision.symbol}:${decision.action}`).digest('hex').slice(0,32);
      const prior=this.store.orders().find(o=>o.local_id===id);
      if(prior){state(prior.status,`${prior.filled}/${prior.shares} 股；本輪已執行，不重送`);continue;}
      if(this.pendingExecutions.size&&[...this.pendingExecutions.values()].some(t=>t.order.symbol===decision.symbol))continue;
      const sent=await this.requestExecution(this.newOrder(decision.symbol,decision.action,decision.shares,decision.limit_price,lot,now,plan.id,
        decision.action === 'BUY' ? 'ENTRY' : 'EXIT',id),now,source,decision,decision.smart??undefined);
      if(sent){const actual=this.store.orders().find(o=>o.local_id===id);state('SUBMITTED',`${decision.action} ${actual?.shares??decision.shares} 股 @ ${actual?.limit_price??decision.limit_price}`);}
    }
  }
  private async requestExecution(order:Order,now:Date,source:ExecutionTicket['source'],condition?:import('./models.js').Decision,
    smart?:SmartSpec,trigger='',protectionSpec?:SmartSpec):Promise<boolean>{
    if(condition?.entry_strategy)order.entry_strategy=condition.entry_strategy;
    if(source==='PROTECTION')order.exit_trigger=trigger;
    if(order.action==='BUY'){
      const q=this.quotes.get(order.symbol+':'+(order.lot==='ODD')),m=this.metadata[order.symbol];
      if(q&&m&&this.account){
        const ticket:ExecutionTicket={id:'preflight',key:'',queued_at:now.toISOString(),state:'QUEUED',order,source,condition,smart,
          trigger,settings_key:executionSettingsKey(this.settings),generation:this.broker.generation};
        let bounds=executionLot(ticket,q,this.account,m,this.risk,now,this.baseline(now),this.store.orders()
          .filter(o=>o.symbol===order.symbol&&(active(o)||o.filled>0)).at(-1)?.created_at);
        if(!bounds.max_shares&&this.settings.whole_lots&&(this.settings.codex_enabled||this.settings.dynamic_allocation||condition?.entry_strategy)){
          const other=this.quotes.get(order.symbol+':'+!q.odd),track=condition?this.store.entryTracks()
            .find(t=>t.plan_id===order.plan_id&&t.symbol===order.symbol&&t.strategy===condition.entry_strategy&&t.lot===(other?.odd?'ODD':'COMMON')):undefined;
          if(other&&(!condition||entryReady(condition,other.last,track)&&!conditionIssue(condition,other,this.watchFeatures[order.symbol],now))){
            const alternative=executionLot(ticket,other,this.account,m,this.risk,now,this.baseline(now),this.store.orders()
              .filter(o=>o.symbol===order.symbol&&(active(o)||o.filled>0)).at(-1)?.created_at);
            if(alternative.max_shares)bounds=alternative;
          }
        }
        if(!bounds.max_shares){
          const reason=bounds.reasons.join('；')||'可用預算或成本門檻不符',key=order.plan_id+':'+order.symbol+':'+order.lot;
          const blocks=this.store.get<Record<string,string>>('entry_blocks')??{};
          this.decisionStates.set(order.symbol,{state:'BLOCKED',reason,source});
          if(blocks[key]!==reason){this.log('RISK',order.symbol+' '+order.lot+'：'+reason);blocks[key]=reason;
            this.store.set('entry_blocks',Object.fromEntries(Object.entries(blocks).slice(-100)));}
          return false;
        }
        if((condition?.entry_strategy||this.settings.dynamic_allocation)&&!this.settings.codex_enabled)
          order={...order,shares:bounds.preferred_shares??bounds.max_shares,limit_price:bounds.limit_price,lot:bounds.lot};
      }
    }
    if(this.settings.codex_enabled&&this.advisorIssue){
      this.decisionStates.set(order.symbol,{state:'WAIT',reason:this.advisorIssue+'；先測試連線或重新分析，未送單',source});return false;
    }
    // Historical exits use only current sellable inventory; production sizing authority is unchanged.
    if(!this.settings.codex_enabled||source==='PROTECTION'&&(this.store.get('historical_replay')===true||this.settings.adaptive_exits)&&!this.broker.production
      &&['demo','paper'].includes(this.settings.mode))return this.submit(order,now,source==='RULE'?smart:undefined,undefined,condition);
    const key=`${twDay(now)}:${order.plan_id}:${order.symbol}:${order.purpose}:${trigger}`;
    if(this.executionRetry[key]&&Date.parse(this.executionRetry[key]!)>now.getTime())return false;
    if([...this.pendingExecutions.values()].some(t=>t.order.symbol===order.symbol))return false;
    const ticket:ExecutionTicket={id:randomUUID(),key,queued_at:now.toISOString(),state:'QUEUED',order,source,condition,smart,
      trigger:trigger||condition?.reason||'Codex 條件成立',protection_spec:protectionSpec,
      allocation_fraction:source==='RULE'&&!condition?.entry_strategy?(this.settings.dynamic_allocation?this.settings.max_order_fraction:this.plan?.analysis.screening?.entry?.allocation_fraction):undefined,
      settings_key:executionSettingsKey(this.settings),generation:this.broker.generation};
    this.pendingExecutions.set(ticket.id,ticket);
    this.decisionStates.set(order.symbol,{state:'SIZING',reason:'條件已觸發，等待 Codex 按目前現金與可賣股數確認數量',source});
    this.log('TRIGGER',`${order.symbol} ${order.action} ${ticket.trigger}；等待 Codex 數量確認`);return false;
  }
  clearExecutions(reason:string,buysOnly=false):void {
    for(const [id,ticket] of this.pendingExecutions)if(!buysOnly||ticket.order.action==='BUY'){
      this.pendingExecutions.delete(id);this.decisionStates.set(ticket.order.symbol,{state:'WAIT',reason,source:ticket.source});
    }
  }
  nextExecutionId():string|undefined {
    return [...this.pendingExecutions.values()].filter(t=>t.state==='QUEUED')
      .sort((a,b)=>(a.order.action==='SELL'?0:1)-(b.order.action==='SELL'?0:1)||a.queued_at.localeCompare(b.queued_at))[0]?.id;
  }
  adaptiveDecisions():import('./models.js').Decision[]{
    const cache=this.store.get<{plan_id:string;selected?:import('./models.js').Decision[]}>('adaptive_setups');
    return cache?.plan_id===this.plan?.id?cache?.selected??[]:[];
  }
  adaptiveCandidates():import('./models.js').Decision[]{
    const cache=this.store.get<{plan_id:string;decisions:import('./models.js').Decision[]}>('adaptive_setups');
    return cache?.plan_id===this.plan?.id?cache?.decisions??[]:[];
  }
  private executionInvalid(ticket:ExecutionTicket,q:Quote|undefined,now:Date):string {
    if(!this.pendingExecutions.has(ticket.id))return '數量確認已取消';
    if(this.advisorIssue)return this.advisorIssue+'；數量確認暫停';
    if(!this.canExecute()||!this.settings.codex_enabled)return '交易已停止，數量建議作廢';
    if(ticket.settings_key!==executionSettingsKey(this.settings)||ticket.generation!==this.broker.generation
      ||twDay(new Date(ticket.queued_at))!==twDay(now))return '設定、連線或交易日已改變';
    if(!this.account?.complete)return '帳戶快照尚未完整';
    if(!q||q.simulated||[q.trade_at,q.book_at].some(at=>ageSeconds(now,at)<0||ageSeconds(now,at)>this.settings.quote_max_age))return '等待新鮮成交與五檔行情';
    if(this.account.orders.some(o=>active(o)&&o.symbol===ticket.order.symbol))return '同標的已有未完成委託，繼續核對';
    if(ticket.source==='PROTECTION'){
      const p=this.store.protections().find(p=>p.symbol===ticket.order.symbol);
      if(!p||p.plan_id!==ticket.order.plan_id||JSON.stringify(p.spec)!==JSON.stringify(ticket.protection_spec))return '持倉出場條件已更新';
      if(evaluate(structuredClone(p),q.last,q.trade_at)!==ticket.trigger)return '出場條件目前已不成立';
      if(!this.account.positions.some(p=>p.symbol===ticket.order.symbol&&p.sellable>0))return '今日新增零股不可當沖，等待可賣庫存';
      return '';
    }
    if(!this.plan||this.plan.id!==ticket.order.plan_id||Date.parse(this.plan.analysis.expires_at)<=now.getTime())return '策略已更新或到期';
    if(ticket.order.action==='BUY'){
      if(this.store.get('daily_loss_hit_'+twDay(now)))return '達到日損失限制；本日鎖定新增買進';
      if(this.store.get('postfill_block_'+twDay(now)))return '成交後風險預算異常；本日停止新增買進';
      if(this.entryBlocked||this.pausedEntries)return '新增買進已暫停';
      if(this.settings.auto_watchlist&&(!this.watch.healthy||ageSeconds(now,this.watch.asof)>this.settings.watch_refresh_minutes*120
        ||!this.watch.entries.some(w=>w.symbol===ticket.order.symbol&&w.eligible)))return '監測股票目前已不符合買進資格';
      if(ticket.smart&&d(q.ask).lte(ticket.smart.stop_price))return '價格已跌破本輪進場停損';
    }
    if(ticket.source==='RULE'&&!ticket.condition?.entry_strategy){
      const w=this.watch.entries.find(w=>w.symbol===ticket.order.symbol);
      if(!w)return '股票已離開監測清單';
      const result=ruleEntry(this.plan,w,this.watchFeatures[w.symbol],q,this.account,this.settings,now);
      return result.decision?'':result.reason;
    }
    const c=ticket.condition;
    if(c&&ticket.order.action==='BUY'){
      const window=entryWindow(c,this.watchFeatures[c.symbol],now,this.metadata[c.symbol]);if(window.issue)return window.issue;
    }
    this.observeEntries(now);
    const track=c?this.store.entryTracks().find(t=>t.plan_id===ticket.order.plan_id&&t.symbol===c.symbol&&t.strategy===c.entry_strategy&&t.lot===(q.odd?'ODD':'COMMON')):undefined;
    if(!c||!entryReady(c,q.last,track))return '買賣觸發條件目前已不成立';
    return conditionIssue(c,q,this.watchFeatures[c.symbol],now);
  }
  private async executionInputs(now:Date):Promise<void>{
    for(const q of this.broker.quotes(now))this.quotes.set(`${q.symbol}:${q.odd}`,q);
    await this.reconcile(now,true);await this.refreshAccount(now);
    for(const q of this.broker.quotes(this.broker.production?new Date():now))this.quotes.set(`${q.symbol}:${q.odd}`,q);
    if(this.broker.dirty){await this.reconcile(now,true);await this.refreshAccount(now);}
  }
  async executionRequest(id:string,now:Date):Promise<ExecutionRequest|undefined>{
    const ticket=this.pendingExecutions.get(id);if(!ticket||ticket.state!=='QUEUED')return;
    await this.executionInputs(now);
    now=this.broker.production?new Date():now;
    const m=this.metadata[ticket.order.symbol];
    const quotes=[true,...(this.settings.whole_lots?[false]:[])].map(odd=>this.quotes.get(`${ticket.order.symbol}:${odd}`)).filter((q):q is Quote=>!!q);
    const valid=quotes.filter(q=>!this.executionInvalid(ticket,q,now));
    if(!m||!valid.length){this.finishExecution(id,'WAIT',m?this.executionInvalid(ticket,quotes[0],now):'商品資料未確認',now);return;}
    const last=this.store.orders().filter(o=>o.symbol===ticket.order.symbol&&(active(o)||o.filled>0)).at(-1)?.created_at;
    const lots=valid.map(q=>executionLot(ticket,q,this.account!,m,this.risk,now,this.baseline(now),last));
    if(!lots.some(l=>l.max_shares>0)){
      const issue=lots.map(l=>l.lot+'：'+(l.reasons.join('；')||'目前可用預算或庫存不足')).join(' / ');
      this.finishExecution(id,'BLOCKED',issue,now);this.logOnce('RISK',`${ticket.order.symbol} ${ticket.order.action}：${issue}`);return;
    }
    ticket.state='RUNNING';const a=this.account!,cash=spendableCash(a,this.settings);
    return {request_id:id,asof:now.toISOString(),triggered_at:ticket.queued_at,symbol:ticket.order.symbol,action:ticket.order.action,purpose:ticket.order.purpose,
      source:ticket.source,trigger:ticket.trigger,plan_id:ticket.order.plan_id,condition:ticket.condition,protection:ticket.protection_spec??ticket.smart,
      account:{cash:a.cash,settlement_debits:a.settlement_debits,settlement_credits:a.settlement_credits,reserved_buys:cash.reserved,
        available_cash:cash.available,equity:equity(a).toFixed(),positions:structuredClone(a.positions),
        open_orders:a.orders.filter(active).map(o=>({symbol:o.symbol,action:o.action,shares:remaining(o),limit_price:o.limit_price})),
        daily_buy_count:a.daily_buy_count,daily_buy_amount:a.daily_buy_amount},
      lots,features:this.watchFeatures[ticket.order.symbol],instrument:structuredClone(m),
      capital:capitalSnapshot(a,this.settings),
      hard_limits:{...adaptiveLimits(this.settings),...Object.fromEntries(['min_cash_fraction','max_order_fraction','order_budget_basis','target_exposure_fraction','min_entry_reward_risk','max_trade_risk_fraction','max_symbol_fraction','max_exposure_fraction','max_daily_buy_fraction',
        'max_daily_buy_orders','daily_loss_fraction','fee_rate','minimum_fee','sell_tax_rate','whole_lots'].map(k=>[k,this.settings[k as keyof Settings]]))},
      historical_replay:!!this.store.get('historical_replay')};
  }
  finishExecution(id:string,state:string,reason:string,now:Date):void {
    const ticket=this.pendingExecutions.get(id);if(!ticket)return;this.pendingExecutions.delete(id);
    this.executionRetry[ticket.key]=new Date(now.getTime()+Math.max(30,this.settings.cooldown_seconds)*1000).toISOString();
    this.executionRetry=Object.fromEntries(Object.entries(this.executionRetry).filter(([,at])=>Date.parse(at)>now.getTime()).slice(-100));
    this.store.set('execution_retry',this.executionRetry);
    this.decisionStates.set(ticket.order.symbol,{state,reason,source:ticket.source});
    this.log('SIZE_RESULT',`${ticket.order.symbol} ${state}：${reason}`);
  }
  async confirmExecution(id:string,raw:ExecutionAdvice,now:Date):Promise<boolean>{
    const ticket=this.pendingExecutions.get(id);if(!ticket||ticket.state!=='RUNNING')return false;
    const advice=ExecutionAdviceSchema.parse(raw);
    if(advice.request_id!==id||advice.symbol!==ticket.order.symbol||advice.action!=='HOLD'&&advice.action!==ticket.order.action){
      this.finishExecution(id,'BLOCKED','Codex 數量回覆的股票、方向或請求識別不符',now);return false;
    }
    if(advice.action==='HOLD'){this.finishExecution(id,'HOLD',advice.reason,now);return false;}
    await this.executionInputs(now);
    now=this.broker.production?new Date():now;
    const q=this.quotes.get(`${advice.symbol}:${advice.lot==='ODD'}`),issue=this.executionInvalid(ticket,q,now);
    if(issue){this.finishExecution(id,'WAIT',issue+'；未送單',now);return false;}
    const m=this.metadata[advice.symbol];if(!m){this.finishExecution(id,'BLOCKED','商品資料未確認',now);return false;}
    const last=this.store.orders().filter(o=>o.symbol===advice.symbol&&(active(o)||o.filled>0)).at(-1)?.created_at;
    const bounds=executionLot(ticket,q!,this.account!,m,this.risk,now,this.baseline(now),last);
    if(advice.action==='BUY'){
      const issues=[...entryRiskIssues(advice.shares,advice.limit_price,ticket.smart,this.account!,this.settings),
        ...entryQualityIssues(advice.shares,advice.limit_price,ticket.smart,this.settings)];
      if(issues.length){this.finishExecution(id,'BLOCKED',issues.join('；')+'；未送單',now);return false;}
    }
    if(advice.shares<(bounds.min_shares??bounds.step)||advice.shares>bounds.max_shares||advice.shares%bounds.step!==0||d(advice.limit_price).lt(bounds.min_price)||d(advice.limit_price).gt(bounds.max_price)
      ||ticket.allocation_fraction&&d(advice.limit_price).times(advice.shares).plus(fee(d(advice.limit_price).times(advice.shares),this.settings)).gt(equity(this.account!).times(ticket.allocation_fraction))
      ||ticket.smart&&advice.action==='BUY'&&(d(advice.limit_price).lte(ticket.smart.stop_price)||ticket.smart.take_profit&&d(advice.limit_price).gte(ticket.smart.take_profit))){
      this.finishExecution(id,'BLOCKED','目前現金、可賣庫存、限價或股數不符合條件，數量建議未採用',now);return false;
    }
    const order={...ticket.order,shares:advice.shares,lot:advice.lot,limit_price:advice.limit_price,created_at:now.toISOString()};
    this.log('SIZE_CONFIRMED',`${order.symbol} ${order.action} ${order.shares} 股（${order.lot==='COMMON'?order.shares/1000+' 張':'盤中零股'}）：${advice.reason}`);
    const sent=await this.submit(order,now,ticket.source==='RULE'?ticket.smart:undefined,id);
    const stored=this.store.orders().find(o=>o.local_id===order.local_id);
    if(sent){this.pendingExecutions.delete(id);this.decisionStates.set(order.symbol,{state:stored?.status??'SUBMITTED',
      reason:`Codex 確認 ${order.shares} 股 @ ${order.limit_price}；${advice.reason}`,source:ticket.source});}
    else this.finishExecution(id,stored?.status??'BLOCKED',stored?.status==='UNKNOWN'?'送單結果尚未確認，繼續核對；禁止重送'
      :this.decisionStates.get(order.symbol)?.reason??'送單前條件已更新；未送單',now);
    return sent;
  }
  newOrder(symbol: string, action: 'BUY' | 'SELL', shares: number, limitPrice: string, lot: 'ODD' | 'COMMON',
    now: Date, planId: string, purpose: Order['purpose'], id = randomUUID().replaceAll('-','')): Order {
    return {local_id:id,broker_id:'',tag:id.slice(0,6),symbol,action,shares,limit_price:limitPrice,lot,
      status:'PREPARED',filled:0,created_at:now.toISOString(),plan_id:planId,purpose};
  }
  async submit(order: Order, suppliedNow: Date,smart?:SmartSpec,executionId?:string,condition?:import('./models.js').Decision): Promise<boolean> {
    if (!this.canExecute()||this.settings.codex_enabled&&this.advisorIssue) return false;
    await this.reconcile(suppliedNow,true); const account = await this.refreshAccount(suppliedNow);
    const now = this.broker.production ? new Date() : suppliedNow;
    if(!this.canExecute()||this.settings.codex_enabled&&this.advisorIssue)return false;
    for(const q of this.broker.quotes(now))this.quotes.set(`${q.symbol}:${q.odd}`,q);
    this.observeEntries(now);
    const quote=this.quotes.get(`${order.symbol}:${order.lot==='ODD'}`);
    if(condition){const t=this.store.entryTracks().find(t=>t.plan_id===order.plan_id&&t.symbol===order.symbol&&t.strategy===condition.entry_strategy&&t.lot===order.lot);
      if(order.action==='BUY'&&entryWindow(condition,this.watchFeatures[order.symbol],now,this.metadata[order.symbol]).issue)return false;
      if(!quote||!entryReady(condition,quote.last,t)||conditionIssue(condition,quote,this.watchFeatures[order.symbol],now))return false;}
    if(order.purpose==='PROTECTION'){
      const p=this.store.protections().find(p=>p.symbol===order.symbol);
      if(!p||p.plan_id!==order.plan_id||!quote||!evaluate(structuredClone(p),quote.last,quote.trade_at))return false;
    }
    if(executionId){
      const ticket=this.pendingExecutions.get(executionId);
      if(!ticket)return false;
      const issue=this.executionInvalid(ticket,this.quotes.get(`${order.symbol}:${order.lot==='ODD'}`),now);
      if(issue){this.finishExecution(executionId,'WAIT',issue+'；未送單',now);return false;}
    }
    if (order.purpose === 'ENTRY' && (!this.plan || order.plan_id !== this.plan.id
      ||twDay(new Date(this.plan.created_at))!==twDay(now)|| Date.parse(this.plan.analysis.expires_at) <= now.getTime() || this.entryBlocked)) return false;
    const last = this.store.orders().filter(o => o.symbol === order.symbol && (active(o) || o.filled > 0)).at(-1)?.created_at;
    const reasons = this.risk.check(order,account,this.quotes.get(`${order.symbol}:${order.lot === 'ODD'}`),this.metadata[order.symbol],
      now,this.baseline(now),this.killed || (this.pausedEntries && order.action === 'BUY'),last);
    if(order.action==='BUY'){
      const spec=smart??(executionId?this.pendingExecutions.get(executionId)?.smart:undefined)
        ??this.plan?.analysis.decisions.find(d=>d.symbol===order.symbol)?.smart??undefined;
      reasons.push(...entryRiskIssues(order.shares,order.limit_price,spec,account,this.settings),
        ...entryQualityIssues(order.shares,order.limit_price,spec,this.settings));
      if(this.store.get('daily_loss_hit_'+twDay(now)))reasons.push('達到日損失限制；本日鎖定新增買進');
      if(this.store.get('postfill_block_'+twDay(now)))reasons.push('成交後風險預算異常；本日停止新增買進');
    }
    if (reasons.length) { this.decisionStates.set(order.symbol,{state:'BLOCKED',reason:reasons.join('；'),source:order.purpose});
      this.logOnce('RISK',`${order.symbol} ${order.action}：${reasons.join('；')}`);
      const refusal=order.purpose==='PROTECTION'?createHash('sha256').update(`${twDay(now)}:${order.symbol}:${reasons.join(';')}`).digest('hex'):order.local_id;
      this.store.recordExperience({id:`risk:${refusal}`,at:now.toISOString(),mode:this.store.get<string>('experience_scope') ?? this.settings.mode,
        kind:'RISK_REFUSAL',symbol:order.symbol,action:order.action,shares:order.shares,price:null,fee:null,tax:null,
        realized_pnl:null,note:reasons.join('；')}); return false; }
    const protection=smart?updateProtection(account.positions.some(p=>p.symbol===order.symbol&&p.shares>0)?this.store.protections().find(p=>p.symbol===order.symbol):undefined,order.symbol,smart,order.plan_id):undefined;
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
      if(result.plan_id===this.plan?.id)this.decisionStates.set(result.symbol,{state:result.status,reason:`${result.filled}/${result.shares} 股；撤單結果已核對`,source:result.purpose});
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

