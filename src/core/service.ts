import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { Engine, type Bundle } from './engine.js';
import { CodexAnalyst } from './codex.js';
import { collectFacts } from './facts.js';
import { SettingsSchema, twClock, twDay, type Settings } from './models.js';
import { demoAnalysis } from './strategy.js';
import { ShioajiHttpBroker } from '../broker/http.js';
import { PaperBroker, SyntheticMarket } from '../broker/paper.js';
import type { Broker } from '../broker/types.js';
import { experienceStatus } from './experience.js';
import { dueStrategy, nextStrategy, type ScheduleRun } from './schedule.js';

export const LIVE_ACK = '我確認啟用現股自動實盤交易並了解零股不可當沖';
export class TradingService {
  readonly store: Store;
  readonly calendar: TradingCalendar;
  readonly broker: Broker;
  readonly engine: Engine;
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
  lastMonitorAt='';
  analysisStatus='等待策略排程';
  get analyzing():boolean{return !!this.decisionTask;}
  get scanning():boolean{return !!this.watchTask;}
  private closeTask?: Promise<void>;
  constructor(path: string, mode?: Settings['mode']) {
    this.store = new Store(path);
    const stored = this.store.settings(), settings = SettingsSchema.parse({...stored,...(mode ? {mode} : {})});
    const priorMode = this.store.get<string>('database_mode');
    if (priorMode && priorMode !== settings.mode) { this.store.close(); throw new Error('每種交易模式須使用獨立資料庫'); }
    this.store.set('database_mode',settings.mode); this.store.saveSettings(settings);
    this.calendar = new TradingCalendar(this.store,settings.mode === 'demo');
    const market = settings.mode === 'demo' ? new SyntheticMarket() : new ShioajiHttpBroker(this.store,settings,settings.mode === 'live');
    this.broker = ['demo','paper'].includes(settings.mode) ? new PaperBroker(this.store,market,settings,this.calendar) : market;
    this.engine = new Engine(this.store,this.broker,settings,this.calendar);
  }
  enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const task = this.queue.then(() => { if (this.stopping) throw new Error('程式正在停止'); return operation(); });
    this.queue = task.catch(() => undefined); return task;
  }
  async start(runTimer = true): Promise<void> {
    await this.enqueue(() => this.engine.start(new Date()));
    if(runTimer){void this.refreshObservations().catch(()=>undefined);void this.ensureCalendar();}
    if (runTimer) this.timer = setInterval(() => {
      if (this.tickPending || this.stopping) return;
      this.tickPending = true;
      void this.enqueue(async () => {
        const now=new Date();
        try { if(!this.lastMonitorAt||now.getTime()-Date.parse(this.lastMonitorAt)>=this.engine.settings.monitor_interval_seconds*1000) {
          await this.engine.tick(now);this.lastMonitorAt=now.toISOString();
        } }
        catch { this.engine.entryBlocked = true; if (this.engine.account) this.engine.account.complete = false;
          this.engine.quotes.clear(); this.engine.logOnce('ERROR','連線或資料核對失敗，暫停新委託，等待重新核對'); }
        this.schedule(new Date());
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
    const task = this.performDecision(review);
    this.decisionTask = task.finally(() => { this.decisionTask = undefined; this.analyst = undefined; });
    return this.decisionTask;
  }
  private async performDecision(review: boolean): Promise<void> {
    const s = this.engine.settings;
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
        this.analyst = new CodexAnalyst(s,profile,undefined,join(dirname(this.store.path),'codex-login')); analysis = await this.analyst.analyze(snapshot,this.stop.signal);
      }
      await this.enqueue(() => this.engine.activate(analysis,snapshot,new Date()));
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
    if (name === 'decide' || name === 'review') {
      if(this.decisionTask)throw new Error('上一輪分析仍在執行');
      if(!this.engine.settings.codex_enabled&&this.engine.settings.mode!=='demo')throw new Error('請先啟用 Codex 並在本機登入');
      void this.decide(name === 'review').catch(() => undefined); return '分析已排程，可繼續監控';
    }
    if(name==='watch'){void this.refreshObservations().catch(()=>undefined);return '已排程觀測更新，無需呼叫 Codex';}
    if(name==='start-auto') {
      if(!this.engine.settings.codex_enabled&&this.engine.settings.mode!=='demo')throw new Error('請先啟用 Codex 並在本機登入');
      await this.command('auto on');await this.command('continue');await this.command('resume');
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
        case 'stop': this.engine.kill(); return '停止全部新委託；現有掛單需另行撤單';
        case 'continue': this.engine.kill(false); return '解除停止委託';
        case 'auto': {
          if (!['on','off'].includes(args[0] ?? '')) throw new Error('用法：auto on 或 auto off');
          if (args[0] === 'on' && this.engine.settings.mode === 'readonly') throw new Error('唯讀模式無法啟用自動委託');
          if (args[0] === 'on' && this.engine.settings.mode === 'live'
            && (!this.store.get('live_consent') || process.env.LIVE_TRADING !== 'true')) throw new Error('須先在本機啟用實盤授權');
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
        case 'help': return 'status | experience | decide | review | watch | start-auto | pause | resume | stop | continue | auto on/off | cancel ID | cancel-all | reconcile | calendar 年份 | help | exit\nstop 不會自動撤單；exit 關閉監控，不會自動撤銷券商掛單。';
        default: throw new Error('未知指令，輸入 help 查看');
      }
    });
  }
  async saveSettings(raw: unknown): Promise<void> {
    const s = SettingsSchema.parse(raw);
    if (s.mode === 'live' && s.auto_execute && (!this.store.get('live_consent') || process.env.LIVE_TRADING !== 'true'))
      throw new Error('實盤自動執行須先取得本機授權');
    await this.enqueue(async () => {
      const changedLots = s.whole_lots !== this.engine.settings.whole_lots;
      this.engine.setSettings(s);
      if (changedLots && this.engine.connected) { this.engine.quotes.clear(); await this.engine.updateSubscriptions(new Date()); }
    });
    if(s.auto_watchlist&&!this.engine.watch.healthy)void this.refreshObservations().catch(()=>undefined);
  }
  async activateLive(ack: string): Promise<void> {
    if (ack !== LIVE_ACK || this.engine.settings.mode !== 'live' || process.env.LIVE_TRADING !== 'true') throw new Error('實盤授權文字或啟用方式不符');
    if (!this.engine.settings.fee_verified || this.engine.settings.settlement_debit_sign === 'unverified' || !this.engine.account?.complete)
      throw new Error('請先完成帳戶唯讀核對、手續費及交割款正負號確認');
    await this.enqueue(() => { this.store.set('live_consent',{at:new Date().toISOString(),fingerprint:this.store.get('account_fingerprint')});
      this.engine.log('LIVE_CONSENT','已在本機授權實盤；需另行 auto on 才開始新增委託'); });
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.stopping = true; clearInterval(this.timer); this.stop.abort(); this.analyst?.cancel();
    // Abort native HTTP/SSE immediately, then wait for queued operations and the analyst before closing SQLite.
    this.closeTask = (async () => {
      const closingBroker = this.broker.close();
      await Promise.allSettled([this.queue,this.decisionTask ?? Promise.resolve(),this.watchTask??Promise.resolve(),this.bundleTask??Promise.resolve(),this.calendarTask??Promise.resolve(),closingBroker]);
      this.engine.connected = false; this.store.close();
    })();
    return this.closeTask;
  }
}
