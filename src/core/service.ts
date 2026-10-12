import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { Engine, type Bundle } from './engine.js';
import { CodexAnalyst, CodexError, codexIssue, appendAnalystEvent, type AnalystEvent } from './codex.js';
import type { ExecutionAdvice, ExecutionRequest } from './execution.js';
import { BrokerError, brokerIssue } from '../broker/health.js';
import { collectFacts } from './facts.js';
import { SettingsSchema, ageSeconds, twDay, type Settings } from './models.js';
import { demoAnalysis } from './strategy.js';
import { ShioajiHttpBroker } from '../broker/http.js';
import { PaperBroker, SyntheticMarket } from '../broker/paper.js';
import type { Broker } from '../broker/types.js';
import { experienceStatus } from './experience.js';
import { dueStrategy, nextStrategy, type ScheduleRun } from './schedule.js';
import { LiveSession, type LiveReadiness } from './live-session.js';

export class TradingService {
  readonly store: Store;
  readonly calendar: TradingCalendar;
  readonly broker: Broker;
  readonly engine: Engine;
  readonly liveSession = new LiveSession();
  private liveEpoch = 0;
  private automaticLive:boolean;
  readonly persistenceIssue:string;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private tickPending = false;
  private stopping = false;
  private stop = new AbortController();
  private decisionTask?: Promise<void>;
  private executionTask?:Promise<void>;
  private executionAnalyst?:CodexAnalyst;
  private executionAbort?:AbortController;
  private readonly now:()=>Date;
  private readonly executionAdvisor?: (request:ExecutionRequest,signal:AbortSignal)=>Promise<ExecutionAdvice>;
  private analyst?: CodexAnalyst;
  private watchTask?:Promise<void>;
  private calendarTask?:Promise<void>;
  private bundleTask?:Promise<Bundle>;
  private lastWatchAttempt=0;
  private lastConnectAttempt=0;
  private lastLiveReadyAttempt=0;
  lastMonitorAt='';
  analysisStatus='等待策略排程';
  analystEvents:AnalystEvent[]=[];
  private decisionAbort?:AbortController;
  get analyzing():boolean{return !!this.decisionTask;}
  get sizing():boolean{return !!this.executionTask;}
  get scanning():boolean{return !!this.watchTask;}
  private closeTask?: Promise<void>;
  constructor(path: string, mode?: Settings['mode'], createMarket?: (store: Store, settings: Settings, session: LiveSession) => Broker,
    options:{automaticLive?:boolean;now?:()=>Date;executionAdvisor?:(request:ExecutionRequest,signal:AbortSignal)=>Promise<ExecutionAdvice>;settings?:Settings;persistenceIssue?:string}={}) {
    this.now=options.now??(()=>new Date());this.executionAdvisor=options.executionAdvisor;
    this.persistenceIssue=options.persistenceIssue??'';
    this.automaticLive=!this.persistenceIssue&&(options.automaticLive??false);
    this.store = new Store(path);
    try {
    const stored = options.settings??this.store.settings(), settings = SettingsSchema.parse({...stored,...(mode ? {mode} : {}),auto_execute:false});
    const priorMode = this.store.get<string>('database_mode');
    // readonly and live contain the same real account history. Never carry simulated orders into live.
    if (priorMode && priorMode !== settings.mode && !(priorMode==='readonly'&&settings.mode==='live')) {
      throw new Error('每種交易模式須使用獨立資料庫');
    }
    this.store.set('database_mode',settings.mode); this.store.saveSettings(settings);
    this.store.delete('live_consent');
    this.calendar = new TradingCalendar(this.store,settings.mode === 'demo');
    const market = createMarket?.(this.store,settings,this.liveSession) ?? (settings.mode === 'demo' ? new SyntheticMarket()
      : new ShioajiHttpBroker(this.store,settings,settings.mode === 'live'&&!this.persistenceIssue,undefined,this.liveSession));
    this.broker = ['demo','paper'].includes(settings.mode) ? new PaperBroker(this.store,market,settings,this.calendar,settings.mode==='paper') : market;
    this.engine = new Engine(this.store,this.broker,settings,this.calendar);
    this.analystEvents=this.store.analystEvents();
    } catch(error) {try{this.store.close();}catch{/* Preserve the initialization error. */}throw error;}
  }
  enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const task = this.queue.then(() => { if (this.stopping) throw new Error('程式正在停止'); return operation(); });
    this.queue = task.catch(() => undefined); return task;
  }
  async start(runTimer = true): Promise<void> {
    this.lastConnectAttempt=Date.now();
    try { await this.enqueue(() => this.engine.start(this.now())); }
    catch(error) { this.engine.dataUnavailable(error,this.now()); if(!runTimer)throw error; }
    await this.syncLiveSession();
    if(runTimer){void this.refreshObservations().catch(()=>undefined);void this.ensureCalendar();}
    if (runTimer) this.timer = setInterval(() => {
      if (this.tickPending || this.stopping) return;
      this.tickPending = true;
      void this.enqueue(async () => {
        const now=this.now();
        try { if(!this.engine.connected && now.getTime()-this.lastConnectAttempt>=10000){
          this.lastConnectAttempt=now.getTime();await this.engine.start(now);
        } else if(this.engine.connected && (!this.lastMonitorAt||now.getTime()-Date.parse(this.lastMonitorAt)>=this.engine.settings.monitor_interval_seconds*1000)) {
          await this.engine.tick(now);this.lastMonitorAt=now.toISOString();
        } }
        catch (error) { this.engine.dataUnavailable(error, now); }
        if(this.engine.connected)this.schedule(this.now());
        if(!this.calendarTask)void this.ensureCalendar();
        if(this.engine.settings.auto_watchlist&&!this.watchTask&&this.calendar.inSession(this.now(),'COMMON')
          &&Date.now()-this.lastWatchAttempt>=this.engine.settings.watch_refresh_minutes*60000)void this.refreshObservations().catch(()=>undefined);
      }).then(()=>{void this.processExecutions().catch(()=>undefined);return this.syncLiveSession();}).finally(() => { this.tickPending = false; }).catch(() => undefined);
    },1000);
  }
  private schedule(now: Date): void {
    if (!this.calendar.isOpen(twDay(now))) return;
    const s = this.engine.settings;
    if(!s.auto_execute)return;
    if (!s.codex_enabled && s.mode !== 'demo') return;
    if(this.decisionTask)return;
    const slot=dueStrategy(now,s,this.calendar,key=>!!this.store.get('schedule_'+key));
    if(!slot)return;
    const run:ScheduleRun={...slot,state:'RUNNING',started_at:now.toISOString()};
    this.store.set('schedule_'+slot.key,run);this.store.set('last_schedule_run',run);
    void this.decide(slot.review).then(()=>{run.state='SUCCESS';},()=>{run.state='FAILED';}).finally(()=>{
      if(this.stopping)return;run.finished_at=this.now().toISOString();this.store.set('schedule_'+slot.key,run);this.store.set('last_schedule_run',run);
    });
  }
  nextStrategyAt(now=this.now()):string|null{return nextStrategy(now,this.engine.settings,this.calendar,key=>!!this.store.get('schedule_'+key))?.at??null;}
  private analystEvent=(event:AnalystEvent):void=>{
    this.store.recordAnalystEvent(event);appendAnalystEvent(this.analystEvents,event);
    this.analystEvents=this.analystEvents.slice(-200);
  };
  /** The model waits outside the engine queue, allowing ticks, fills and emergency commands to continue. */
  processExecutions():Promise<void>{
    if(this.stopping)return Promise.resolve();if(this.executionTask)return this.executionTask;
    this.executionTask=(async()=>{
      for(;;){if(this.stopping)return;
        const id=await this.enqueue(()=>this.engine.nextExecutionId());if(!id)return;
        let request:ExecutionRequest|undefined;
        try {
          request=await this.enqueue(()=>this.engine.executionRequest(id,this.now()));if(!request)continue;
          this.executionAbort=new AbortController();const signal=AbortSignal.any([this.stop.signal,this.executionAbort.signal]);
          const settings=structuredClone(this.engine.settings),profile=join(dirname(this.store.path),'codex-execution-profile');
          this.executionAnalyst=new CodexAnalyst(settings,profile,undefined,join(dirname(this.store.path),'codex-login'),this.analystEvent);
          const advice=this.executionAdvisor?await this.executionAdvisor(request,signal):await this.executionAnalyst.size(request,signal);
          signal.throwIfAborted();
          await this.enqueue(async()=>{
            signal.throwIfAborted();const sent=await this.engine.confirmExecution(id,advice,this.now());
            const status=this.engine.decisionStates.get(request!.symbol);
            this.analystEvent({id:randomUUID(),at:this.now().toISOString(),asof:this.now().toISOString(),stage:sent?'SUBMISSION':'EXECUTION_RESULT',
              message:`${request!.symbol}：${status?.reason??'條件已更新，未送單'}`,model:this.executionAnalyst?.selection?.model||settings.codex_model||'Codex 數量確認',
              reasoning:this.executionAnalyst?.selection?.reasoning||settings.codex_reasoning,purpose:'EXECUTION',details:{sent,status,advice}});
          });
        }catch(error){
          if(!this.stopping){const issue=this.executionAbort?.signal.aborted?'Codex 數量確認已停止'
            :error instanceof BrokerError?brokerIssue(error):codexIssue(error);
            await this.enqueue(()=>this.engine.finishExecution(id,'SIZE_FAILED',issue+'；未送單',this.now()));
            this.analystEvent({id:randomUUID(),at:this.now().toISOString(),asof:request?.asof??this.now().toISOString(),stage:'FAILED',
              message:issue+'；本次未送單',model:this.executionAnalyst?.selection?.model||this.engine.settings.codex_model||'Codex 數量確認',
              reasoning:this.engine.settings.codex_reasoning,purpose:'EXECUTION'});
          }
        }finally{this.executionAnalyst=undefined;this.executionAbort=undefined;}
      }
    })().finally(()=>{this.executionTask=undefined;});return this.executionTask;
  }
  private ensureCalendar():Promise<void>{
    if(this.stopping||this.engine.settings.mode==='demo')return Promise.resolve();
    if(this.calendarTask)return this.calendarTask;
    const day=twDay(this.now()),year=Number(day.slice(0,4)),key='calendar_attempt_'+year;
    if(this.store.session(year+'-01-01')||this.store.get(key)===day)return Promise.resolve();
    this.store.set(key,day);
    this.calendarTask=(async()=>{try{await this.calendar.refresh(year,this.stop.signal);
      if(!this.stopping)await this.enqueue(()=>this.engine.log('CALENDAR',`已自動載入 ${year} 官方交易日`));
    }catch{if(!this.stopping)await this.enqueue(()=>this.engine.logOnce('CALENDAR','官方行事曆尚未確認，等待重新取得；不在未知交易日送單'));}
    })().finally(()=>{this.calendarTask=undefined;});return this.calendarTask;
  }
  private collect():Promise<Bundle> {
    if(!this.bundleTask)this.bundleTask=this.engine.collectBundle(this.now()).finally(()=>{this.bundleTask=undefined;});
    return this.bundleTask;
  }
  refreshObservations():Promise<void> {
    if(this.stopping)return Promise.reject(new Error('程式正在停止'));
    if(this.watchTask)return this.watchTask;
    this.lastWatchAttempt=Date.now();
    this.watchTask=(async()=>{
      try {const bundle=await this.collect();if(this.stopping)return;
        await this.enqueue(()=>this.engine.refreshWatch(bundle,this.now()));
      }catch {if(!this.stopping)await this.enqueue(async()=>{
        this.engine.watchFailed();if(this.engine.canExecute())for(const o of this.store.orders(true))if(o.purpose==='ENTRY')await this.engine.cancel(o.local_id,this.now());
      });}
    })().finally(()=>{this.watchTask=undefined;});return this.watchTask;
  }
  decide(review = false): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('程式正在停止'));
    if (this.decisionTask) return Promise.reject(new Error('上一輪分析仍在執行'));
    this.decisionAbort=new AbortController();
    const task = this.performDecision(review);
    this.decisionTask = task.finally(() => { this.decisionTask = undefined; this.analyst = undefined; });
    return this.decisionTask;
  }
  private async performDecision(review: boolean): Promise<void> {
    const s = this.engine.settings;
    const signal = AbortSignal.any([this.stop.signal,this.decisionAbort!.signal]);
    if (s.mode !== 'demo' && !s.codex_enabled) throw new Error('請先啟用 Codex 並在本機登入');
    this.analysisStatus=review?'正在進行盤後檢討':'正在更新策略';
    await this.enqueue(() => this.engine.log('ANALYSIS','開始收集動態股票池；背景監控持續'));
    try {
      const bundle = await this.collect();
      if (s.mode !== 'demo' && s.official_facts_enabled) Object.assign(bundle,
        await collectFacts(this.store,new Set([...bundle.pool.map(p => p.symbol),...(this.engine.account?.positions.map(p => p.symbol) ?? [])]),this.now(),this.stop.signal));
      const snapshot = await this.enqueue(async () => {
        const now = this.now(); await this.engine.reconcile(now); await this.engine.refreshAccount(now);
        return this.engine.snapshotFromBundle(bundle,now,review);
      });
      let analysis;
      if (s.mode === 'demo'&&!s.codex_enabled) analysis = demoAnalysis(snapshot,s,this.now());
      else {
        const profile = join(dirname(this.store.path),'codex-analysis-profile');
        this.analyst = new CodexAnalyst(s,profile,undefined,join(dirname(this.store.path),'codex-login'),this.analystEvent);
        signal.throwIfAborted();
        analysis = await this.analyst.analyze(snapshot,signal);
      }
      await this.enqueue(() => { signal.throwIfAborted(); return this.engine.activate(analysis,snapshot,this.now()); });
      this.analysisStatus=review?'盤後檢討已保存':'策略已啟用，程式持續監測';
    } catch (error) {
      const issue=signal.aborted?'Codex 分析已停止':error instanceof CodexError?codexIssue(error):
        error instanceof BrokerError?brokerIssue(error):error instanceof Error&&/^(帳戶快照|Codex 使用|Codex 決策|計畫有效|候選|買進標的|盤後檢討|策略|行情|歷史|觀測)/.test(error.message)?error.message:'策略資料或分析結果尚未通過核對';
      this.analysisStatus=issue;
      if(!this.analystEvents.some(e=>e.stage==='FAILED'&&Date.parse(e.at)>=this.now().getTime()-2000))this.analystEvent({id:randomUUID(),at:this.now().toISOString(),asof:this.now().toISOString(),stage:'FAILED',message:issue,model:this.analyst?.selection?.model||s.codex_model||'Codex 預設模型',reasoning:s.codex_reasoning,purpose:'STRATEGY'});
      if (!this.stopping) await this.enqueue(async () => {
        if(!review)this.engine.entryBlocked = true;
        this.store.recordExperience({id:'analysis-failure:'+randomUUID(),at:this.now().toISOString(),mode:this.engine.settings.mode,
          kind:'ANALYSIS_FAILURE',symbol:'',action:'NONE',shares:0,price:null,fee:null,tax:null,realized_pnl:null,
          note:'分析逾時、資料不足或 schema／快照核對失敗；未採用該輪結果'});
        this.engine.log('ANALYSIS_FAIL',issue+'；停止新買進，既有保護持續');
        // A failed analysis must also cancel owned outstanding entry orders when execution is enabled.
        if (!review&&this.engine.canExecute()) for (const o of this.store.orders(true)) if (o.purpose === 'ENTRY') await this.engine.cancel(o.local_id,this.now());
      });
      throw new Error('本輪決策未啟用：'+issue);
    }
  }
  async command(input: string): Promise<string> {
    const [name,...args] = input.trim().split(/\s+/);
    if(name==='pause'){
      const activeBuy=[...this.engine.pendingExecutions.values()].some(t=>t.state==='RUNNING'&&t.order.action==='BUY');
      this.engine.pauseEntries();
      if(activeBuy){this.executionAbort?.abort();this.executionAnalyst?.cancel();}
    }
    if(name==='auto'&&args[0]==='off'){this.executionAbort?.abort();this.executionAnalyst?.cancel();this.engine.clearExecutions('自動交易已停止');}
    if(name==='stop'||name==='lock-live'){
      this.decisionAbort?.abort();this.analyst?.cancel();
      this.executionAbort?.abort();this.executionAnalyst?.cancel();this.engine.clearExecutions('使用者已停止交易');
      if(name==='stop')this.engine.kill(true);
      if(this.engine.settings.mode==='live'){this.liveEpoch++;this.liveSession.revoke();}
    }
    if (name === 'decide' || name === 'review') {
      if(this.decisionTask)throw new Error('上一輪分析仍在執行');
      if(!this.engine.settings.codex_enabled&&this.engine.settings.mode!=='demo')throw new Error('請先啟用 Codex 並在本機登入');
      void this.decide(name === 'review').catch(() => undefined); return '分析已排程，可繼續監控';
    }
    if(name==='cancel-analysis'){this.decisionAbort?.abort();this.analyst?.cancel();this.executionAbort?.abort();this.executionAnalyst?.cancel();
      for(const id of [...this.engine.pendingExecutions.keys()])this.engine.finishExecution(id,'WAIT','本輪 Codex 已停止',this.now());return '已要求停止本輪分析與數量確認';}
    if(name==='watch'){void this.refreshObservations().catch(()=>undefined);return '已排程觀測更新，無需呼叫 Codex';}
    if(name==='start-auto') {
      // One queued transition: a competing emergency stop cannot be undone by later resume steps.
      await this.enqueue(() => {
        if(!this.engine.connected)throw new Error('請先連接 Shioaji 真實行情');
        if(!this.engine.settings.codex_enabled&&this.engine.settings.mode!=='demo')throw new Error('請先啟用 Codex 並在本機登入');
        if(this.engine.settings.mode==='readonly')throw new Error('目前模式無法啟用自動委託');
        if(this.engine.settings.mode==='live'&&!this.liveAuthorized)throw new Error('請先確認本次實盤授權');
        this.engine.setSettings({...this.engine.settings,auto_execute:true});this.engine.kill(false);this.engine.pauseEntries(false);
      });
      if(this.engine.killed||!this.engine.settings.auto_execute)return '自動啟動已停止';
      if(!this.engine.plan||Date.parse(this.engine.plan.analysis.expires_at)<=this.now().getTime()) {
        if(!this.decisionTask)await this.command('decide');
        return '已啟動自動模式；等待有效策略後依條件執行';
      }
      return '已啟動自動模式；程式依現有策略持續監測';
    }
    return this.enqueue(async () => {
      const now = this.now();
      switch (name) {
        case 'status': return this.engine.status(now);
        case 'experience': return experienceStatus(this.store,this.engine.settings,now.toISOString());
        case 'pause': this.engine.pauseEntries();
          if(this.engine.canExecute())for(const o of this.store.orders(true))if(o.purpose==='ENTRY')await this.engine.cancel(o.local_id,now);
          return '已暫停新買進，核對本程式進場掛單的撤單；保護監控持續';
        case 'resume': this.engine.pauseEntries(false); return '已恢復新增買進';
        case 'stop': this.engine.kill();this.decisionAbort?.abort();this.analyst?.cancel();
          if(this.engine.settings.mode==='live')this.lockLive();
          return '停止全部新委託；現有掛單需另行撤單';
        case 'lock-live': if(this.engine.settings.mode!=='live')throw new Error('目前不是實盤模式');
          this.engine.kill();this.lockLive();return '實盤已鎖定；現有掛單仍須另行撤單';
        case 'continue': this.engine.kill(false); return '解除停止委託';
        case 'auto': {
          if (!['on','off'].includes(args[0] ?? '')) throw new Error('用法：auto on 或 auto off');
          if (args[0] === 'on' && this.engine.settings.mode === 'readonly') throw new Error('唯讀模式無法啟用自動委託');
          if (args[0] === 'on' && this.engine.settings.mode === 'live'
            && !this.liveAuthorized) throw new Error('請先確認本次實盤授權');
          this.engine.setSettings({...this.engine.settings,auto_execute:args[0] === 'on'}); return '自動執行=' + this.engine.settings.auto_execute;
        }
        case 'cancel': {
          const id = args[0]; if (!id) throw new Error('用法：cancel <本機委託 ID 前綴>');
          const matches = this.store.orders(true).filter(o => o.local_id.startsWith(id));
          if (matches.length !== 1) throw new Error('委託 ID 不存在或不唯一'); await this.engine.cancel(matches[0]!.local_id,now); return '已執行撤單核對';
        }
        case 'cancel-all': for (const o of this.store.orders(true)) await this.engine.cancel(o.local_id,now); return '已核對本程式的未完成委託';
        case 'calendar': return '已更新 ' + await this.calendar.refresh(Number(args[0] ?? twDay(now).slice(0,4)),this.stop.signal) + ' 天行事曆';
        case 'reconcile': await this.engine.reconcile(now); await this.engine.refreshAccount(now); return '已重新核對帳戶及委託';
        case 'help': return 'status | experience | decide | review | watch | start-auto | pause | resume | stop | lock-live | continue | auto on/off | cancel ID | cancel-all | reconcile | calendar 年份 | help | exit\n桌面實盤連線後會自動核對帳戶；「開始自動交易」才會啟用策略執行。stop 不會自動撤單；exit 關閉監控，不會自動撤銷券商掛單。';
        default: throw new Error('未知指令，輸入 help 查看');
      }
    });
  }
  async saveSettings(raw: unknown): Promise<void> {
    const s = SettingsSchema.parse(raw);
    await this.enqueue(async () => {
      if (s.mode === 'live' && s.auto_execute && !this.liveAuthorized) throw new Error('實盤自動執行須先確認本次授權');
      if(s.mode==='live'&&['fee_rate','minimum_fee','sell_tax_rate',
        'min_cash_fraction','max_order_fraction','max_symbol_fraction','max_exposure_fraction','max_daily_buy_fraction',
        'max_daily_buy_orders','daily_loss_fraction','whole_lots','allow_attention','price_deviation_fraction',
        'max_spread_fraction','quote_max_age','account_max_age','cooldown_seconds'].some(k=>s[k as keyof Settings]!==this.engine.settings[k as keyof Settings])) {
        this.lockLive();s.auto_execute=false;
      }
      if(['codex_model','codex_reasoning','codex_instruction','codex_enabled'].some(k=>s[k as keyof Settings]!==this.engine.settings[k as keyof Settings])) {
        this.decisionAbort?.abort();this.analyst?.cancel();
      }
      this.executionAbort?.abort();this.executionAnalyst?.cancel();
      const changedLots = s.whole_lots !== this.engine.settings.whole_lots;
      this.engine.setSettings(s);
      if (changedLots && this.engine.connected) { this.engine.quotes.clear(); await this.engine.updateSubscriptions(this.now()); }
    });
    if(s.auto_watchlist&&!this.engine.watch.healthy)void this.refreshObservations().catch(()=>undefined);
  }
  get liveAuthorized(): boolean { return this.liveSession.authorized(this.store.get('account_fingerprint')); }
  get liveCancelAuthorized(): boolean { return this.liveSession.authorized(this.store.get('account_fingerprint'),'cancel'); }
  liveReadiness(now = this.now()): LiveReadiness {
    const s=this.engine.settings,broker=this.broker instanceof ShioajiHttpBroker?this.broker.liveStatus():{account:'尚未連接實盤帳戶',issues:['請切換至實盤模式']};
    const issues=[...broker.issues,...(this.persistenceIssue?[this.persistenceIssue]:[])];
    if(!this.engine.connected)issues.push('請先連接 Shioaji');
    const a=this.engine.account;
    if(!a?.complete)issues.push(a?.issue||'帳戶快照尚未完整');
    else if(!(ageSeconds(now,a.asof)>=0&&ageSeconds(now,a.asof)<=s.account_max_age))issues.push('帳戶快照已過期，請重新核對');
    if(a?.orders.some(o=>['UNKNOWN','PREPARED','SUBMITTING','CANCEL_PENDING'].includes(o.status)))issues.push('仍有待核對委託');
    return {authorized:this.liveAuthorized,ready:!issues.length,account:broker.account,issues:[...new Set(issues)]};
  }
  async prepareLive(): Promise<LiveReadiness> {
    return this.enqueue(async()=>{
      if(this.persistenceIssue)throw new BrokerError(this.persistenceIssue);
      if(!(this.broker instanceof ShioajiHttpBroker)||this.engine.settings.mode!=='live'||!this.engine.connected)
        throw new Error('請先連接實盤帳戶');
      await this.broker.verifyLiveConnection();const now=this.now();
      await this.engine.reconcile(now,true);await this.engine.refreshAccount(now);
      const state=this.liveReadiness();if(!state.ready)throw new BrokerError('實盤尚未就緒：'+state.issues.join('；'),true);
      return state;
    });
  }
  async activateLive(scope:'trade'|'cancel'='trade'): Promise<void> {
    const epoch=this.liveEpoch;
    await this.prepareLive();
    await this.enqueue(()=>{
      if(epoch!==this.liveEpoch)throw new Error('實盤啟動已停止');
      const state=this.liveReadiness();if(!state.ready)throw new BrokerError('實盤尚未就緒：'+state.issues.join('；'),true);
      this.liveSession.grant(this.store.get<string>('account_fingerprint')??'',scope);
      this.engine.log('LIVE_CONSENT',`${scope==='trade'?'本次實盤':'本次撤單'}授權已開啟；重新連線、重啟、鎖定或變更交易風控後失效`);
    });
  }
  private async syncLiveSession():Promise<void>{
    // Desktop live-mode selection is the user's intent. Establish readiness independently of Codex/automation.
    // Never restore a running strategy or undo an explicit stop/lock; grants remain account-bound and in memory.
    if(!this.automaticLive||this.stopping||this.liveAuthorized||this.engine.killed||!this.liveReadiness().ready||Date.now()-this.lastLiveReadyAttempt<5000)return;
    this.lastLiveReadyAttempt=Date.now();
    try {await this.activateLive();}
    catch(error){if(!this.stopping)this.engine.logOnce('LIVE_READY',brokerIssue(error));}
  }
  private lockLive(): void {
    this.automaticLive=false;this.liveEpoch++;this.liveSession.revoke();this.engine.setSettings({...this.engine.settings,auto_execute:false});
    this.engine.log('LIVE_LOCK','實盤授權已關閉；不影響券商既有掛單');
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.stopping = true;this.liveEpoch++;this.liveSession.revoke();clearInterval(this.timer); this.stop.abort(); this.analyst?.cancel();this.executionAnalyst?.cancel();
    // Abort native HTTP/SSE immediately, then wait for queued operations and the analyst before closing SQLite.
    this.closeTask = (async () => {
      const closingBroker = this.broker.close();
      await Promise.allSettled([this.queue,this.decisionTask ?? Promise.resolve(),this.executionTask??Promise.resolve(),this.watchTask??Promise.resolve(),this.bundleTask??Promise.resolve(),this.calendarTask??Promise.resolve(),closingBroker]);
      this.engine.connected = false; this.store.close();
    })();
    return this.closeTask;
  }
}
