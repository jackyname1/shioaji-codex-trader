import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { Engine, type Bundle } from './engine.js';
import { CodexAnalyst, type AnalystEvent } from './codex.js';
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
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private tickPending = false;
  private stopping = false;
  private stop = new AbortController();
  private decisionTask?: Promise<void>;
  private analyst?: CodexAnalyst;
  private watchTask?:Promise<void>;
  private calendarTask?:Promise<void>;
  private bundleTask?:Promise<Bundle>;
  private lastWatchAttempt=0;
  private lastConnectAttempt=0;
  lastMonitorAt='';
  analysisStatus='等待策略排程';
  analystEvents:AnalystEvent[]=[];
  private decisionAbort?:AbortController;
  get analyzing():boolean{return !!this.decisionTask;}
  get scanning():boolean{return !!this.watchTask;}
  private closeTask?: Promise<void>;
  constructor(path: string, mode?: Settings['mode'], createMarket?: (store: Store, settings: Settings, session: LiveSession) => Broker) {
    this.store = new Store(path);
    const stored = this.store.settings(), settings = SettingsSchema.parse({...stored,...(mode ? {mode} : {}),auto_execute:false});
    const priorMode = this.store.get<string>('database_mode');
    if (priorMode && priorMode !== settings.mode) { this.store.close(); throw new Error('每種交易模式須使用獨立資料庫'); }
    this.store.set('database_mode',settings.mode); this.store.saveSettings(settings);
    this.store.delete('live_consent');
    this.calendar = new TradingCalendar(this.store,settings.mode === 'demo');
    const market = createMarket?.(this.store,settings,this.liveSession) ?? (settings.mode === 'demo' ? new SyntheticMarket()
      : new ShioajiHttpBroker(this.store,settings,settings.mode === 'live',undefined,this.liveSession));
    this.broker = ['demo','paper'].includes(settings.mode) ? new PaperBroker(this.store,market,settings,this.calendar) : market;
    this.engine = new Engine(this.store,this.broker,settings,this.calendar);
  }
  enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const task = this.queue.then(() => { if (this.stopping) throw new Error('程式正在停止'); return operation(); });
    this.queue = task.catch(() => undefined); return task;
  }
  async start(runTimer = true): Promise<void> {
    this.lastConnectAttempt=Date.now();
    try { await this.enqueue(() => this.engine.start(new Date())); }
    catch(error) { this.engine.dataUnavailable(error,new Date()); if(!runTimer)throw error; }
    if(runTimer){void this.refreshObservations().catch(()=>undefined);void this.ensureCalendar();}
    if (runTimer) this.timer = setInterval(() => {
      if (this.tickPending || this.stopping) return;
      this.tickPending = true;
      void this.enqueue(async () => {
        const now=new Date();
        try { if(!this.engine.connected && now.getTime()-this.lastConnectAttempt>=10000){
          this.lastConnectAttempt=now.getTime();await this.engine.start(now);
        } else if(this.engine.connected && (!this.lastMonitorAt||now.getTime()-Date.parse(this.lastMonitorAt)>=this.engine.settings.monitor_interval_seconds*1000)) {
          await this.engine.tick(now);this.lastMonitorAt=now.toISOString();
        } }
        catch (error) { this.engine.dataUnavailable(error, now); }
        if(this.engine.connected)this.schedule(new Date());
        if(!this.calendarTask)void this.ensureCalendar();
        if(this.engine.settings.auto_watchlist&&!this.watchTask&&this.calendar.inSession(new Date(),'COMMON')
          &&Date.now()-this.lastWatchAttempt>=this.engine.settings.watch_refresh_minutes*60000)void this.refreshObservations().catch(()=>undefined);
      }).finally(() => { this.tickPending = false; }).catch(() => undefined);
    },1000);
  }
  private schedule(now: Date): void {
    if (!this.calendar.isOpen(twDay(now))) return;
    const s = this.engine.settings;
    if (!s.codex_enabled && s.mode !== 'demo') return;
    if(this.decisionTask)return;
    const slot=dueStrategy(now,s,this.calendar,key=>!!this.store.get('schedule_'+key));
    if(!slot)return;
    const run:ScheduleRun={...slot,state:'RUNNING',started_at:now.toISOString()};
    this.store.set('schedule_'+slot.key,run);this.store.set('last_schedule_run',run);
    void this.decide(slot.review).then(()=>{run.state='SUCCESS';},()=>{run.state='FAILED';}).finally(()=>{
      if(this.stopping)return;run.finished_at=new Date().toISOString();this.store.set('schedule_'+slot.key,run);this.store.set('last_schedule_run',run);
    });
  }
  nextStrategyAt(now=new Date()):string|null{return nextStrategy(now,this.engine.settings,this.calendar,key=>!!this.store.get('schedule_'+key))?.at??null;}
  private ensureCalendar():Promise<void>{
    if(this.stopping||this.engine.settings.mode==='demo')return Promise.resolve();
    if(this.calendarTask)return this.calendarTask;
    const day=twDay(new Date()),year=Number(day.slice(0,4)),key='calendar_attempt_'+year;
    if(this.store.session(year+'-01-01')||this.store.get(key)===day)return Promise.resolve();
    this.store.set(key,day);
    this.calendarTask=(async()=>{try{await this.calendar.refresh(year,this.stop.signal);
      if(!this.stopping)await this.enqueue(()=>this.engine.log('CALENDAR',`已自動載入 ${year} 官方交易日`));
    }catch{if(!this.stopping)await this.enqueue(()=>this.engine.logOnce('CALENDAR','官方行事曆尚未確認，等待重新取得；不在未知交易日送單'));}
    })().finally(()=>{this.calendarTask=undefined;});return this.calendarTask;
  }
  private collect():Promise<Bundle> {
    if(!this.bundleTask)this.bundleTask=this.engine.collectBundle(new Date()).finally(()=>{this.bundleTask=undefined;});
    return this.bundleTask;
  }
  refreshObservations():Promise<void> {
    if(this.stopping)return Promise.reject(new Error('程式正在停止'));
    if(this.watchTask)return this.watchTask;
    this.lastWatchAttempt=Date.now();
    this.watchTask=(async()=>{
      try {const bundle=await this.collect();if(this.stopping)return;
        await this.enqueue(()=>this.engine.refreshWatch(bundle,new Date()));
      }catch {if(!this.stopping)await this.enqueue(async()=>{
        this.engine.watchFailed();if(this.engine.canExecute())for(const o of this.store.orders(true))if(o.purpose==='ENTRY')await this.engine.cancel(o.local_id,new Date());
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
        await collectFacts(this.store,new Set([...bundle.pool.map(p => p.symbol),...(this.engine.account?.positions.map(p => p.symbol) ?? [])]),new Date(),this.stop.signal));
      const snapshot = await this.enqueue(async () => {
        const now = new Date(); await this.engine.reconcile(now); await this.engine.refreshAccount(now);
        return this.engine.snapshotFromBundle(bundle,now,review);
      });
      let analysis;
      if (s.mode === 'demo'&&!s.codex_enabled) analysis = demoAnalysis(snapshot,s,new Date());
      else {
        const profile = join(dirname(this.store.path),'codex-analysis-profile');
        this.analyst = new CodexAnalyst(s,profile,undefined,join(dirname(this.store.path),'codex-login'),event=>{this.analystEvents.push(event);this.analystEvents=this.analystEvents.slice(-80);});
        signal.throwIfAborted();
        analysis = await this.analyst.analyze(snapshot,signal);
      }
      await this.enqueue(() => { signal.throwIfAborted(); return this.engine.activate(analysis,snapshot,new Date()); });
      this.analysisStatus=review?'盤後檢討已保存':'策略已啟用，程式持續監測';
    } catch {
      this.analysisStatus=review?'盤後檢討未通過':'本輪策略未通過，停止新買進';
      if (!this.stopping) await this.enqueue(async () => {
        if(!review)this.engine.entryBlocked = true;
        this.store.recordExperience({id:'analysis-failure:'+randomUUID(),at:new Date().toISOString(),mode:this.engine.settings.mode,
          kind:'ANALYSIS_FAILURE',symbol:'',action:'NONE',shares:0,price:null,fee:null,tax:null,realized_pnl:null,
          note:'分析逾時、資料不足或 schema／快照核對失敗；未採用該輪結果'});
        this.engine.log('ANALYSIS_FAIL','分析逾時、資料不足或結果未通過檢查；停止新買進，既有保護持續');
        // A failed analysis must also cancel owned outstanding entry orders when execution is enabled.
        if (!review&&this.engine.canExecute()) for (const o of this.store.orders(true)) if (o.purpose === 'ENTRY') await this.engine.cancel(o.local_id,new Date());
      });
      throw new Error('本輪決策未啟用；請查看本機狀態');
    }
  }
  async command(input: string): Promise<string> {
    const [name,...args] = input.trim().split(/\s+/);
    if(name==='stop'||name==='lock-live'){
      this.decisionAbort?.abort();this.analyst?.cancel();
      if(this.engine.settings.mode==='live'){this.liveEpoch++;this.liveSession.revoke();}
    }
    if (name === 'decide' || name === 'review') {
      if(this.decisionTask)throw new Error('上一輪分析仍在執行');
      if(!this.engine.settings.codex_enabled&&this.engine.settings.mode!=='demo')throw new Error('請先啟用 Codex 並在本機登入');
      void this.decide(name === 'review').catch(() => undefined); return '分析已排程，可繼續監控';
    }
    if(name==='cancel-analysis'){this.decisionAbort?.abort();this.analyst?.cancel();return '已要求停止本輪分析';}
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
      if(!this.engine.plan||Date.parse(this.engine.plan.analysis.expires_at)<=Date.now()) {
        if(!this.decisionTask)await this.command('decide');
        return '已啟動自動模式；等待有效策略後依條件執行';
      }
      return '已啟動自動模式；程式依現有策略持續監測';
    }
    return this.enqueue(async () => {
      const now = new Date();
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
        case 'help': return 'status | experience | decide | review | watch | start-auto | pause | resume | stop | lock-live | continue | auto on/off | cancel ID | cancel-all | reconcile | calendar 年份 | help | exit\n實盤請從桌面「啟動實盤」確認本次授權。stop 不會自動撤單；exit 關閉監控，不會自動撤銷券商掛單。';
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
      const changedLots = s.whole_lots !== this.engine.settings.whole_lots;
      this.engine.setSettings(s);
      if (changedLots && this.engine.connected) { this.engine.quotes.clear(); await this.engine.updateSubscriptions(new Date()); }
    });
    if(s.auto_watchlist&&!this.engine.watch.healthy)void this.refreshObservations().catch(()=>undefined);
  }
  get liveAuthorized(): boolean { return this.liveSession.authorized(this.store.get('account_fingerprint')); }
  get liveCancelAuthorized(): boolean { return this.liveSession.authorized(this.store.get('account_fingerprint'),'cancel'); }
  liveReadiness(now = new Date()): LiveReadiness {
    const s=this.engine.settings,broker=this.broker instanceof ShioajiHttpBroker?this.broker.liveStatus():{account:'尚未連接實盤帳戶',issues:['請切換至實盤模式']};
    const issues=[...broker.issues];
    if(!this.engine.connected)issues.push('請先連接 Shioaji');
    const a=this.engine.account;
    if(!a?.complete)issues.push(a?.issue||'帳戶快照尚未完整');
    else if(!(ageSeconds(now,a.asof)>=0&&ageSeconds(now,a.asof)<=s.account_max_age))issues.push('帳戶快照已過期，請重新核對');
    if(a?.orders.some(o=>['UNKNOWN','PREPARED','SUBMITTING','CANCEL_PENDING'].includes(o.status)))issues.push('仍有待核對委託');
    return {authorized:this.liveAuthorized,ready:!issues.length,account:broker.account,issues:[...new Set(issues)]};
  }
  async prepareLive(): Promise<LiveReadiness> {
    return this.enqueue(async()=>{
      if(!(this.broker instanceof ShioajiHttpBroker)||this.engine.settings.mode!=='live'||!this.engine.connected)
        throw new Error('請先連接實盤帳戶');
      await this.broker.verifyLiveConnection();const now=new Date();
      await this.engine.reconcile(now,true);await this.engine.refreshAccount(now);
      const state=this.liveReadiness();if(!state.ready)throw new Error('實盤尚未就緒：'+state.issues.join('；'));
      return state;
    });
  }
  async activateLive(scope:'trade'|'cancel'='trade'): Promise<void> {
    const epoch=this.liveEpoch;
    await this.prepareLive();
    await this.enqueue(()=>{
      if(epoch!==this.liveEpoch)throw new Error('實盤啟動已停止');
      const state=this.liveReadiness();if(!state.ready)throw new Error('實盤尚未就緒：'+state.issues.join('；'));
      this.liveSession.grant(this.store.get<string>('account_fingerprint')??'',scope);
      this.engine.log('LIVE_CONSENT',`${scope==='trade'?'本次實盤':'本次撤單'}授權已開啟；重新連線、重啟、鎖定或變更交易風控後失效`);
    });
  }
  private lockLive(): void {
    this.liveEpoch++;this.liveSession.revoke();this.engine.setSettings({...this.engine.settings,auto_execute:false});
    this.engine.log('LIVE_LOCK','實盤授權已關閉；不影響券商既有掛單');
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.stopping = true;this.liveEpoch++;this.liveSession.revoke();clearInterval(this.timer); this.stop.abort(); this.analyst?.cancel();
    // Abort native HTTP/SSE immediately, then wait for queued operations and the analyst before closing SQLite.
    this.closeTask = (async () => {
      const closingBroker = this.broker.close();
      await Promise.allSettled([this.queue,this.decisionTask ?? Promise.resolve(),this.watchTask??Promise.resolve(),this.bundleTask??Promise.resolve(),this.calendarTask??Promise.resolve(),closingBroker]);
      this.engine.connected = false; this.store.close();
    })();
    return this.closeTask;
  }
}
