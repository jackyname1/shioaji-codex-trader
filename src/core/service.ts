import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { TradingCalendar } from './calendar.js';
import { Engine } from './engine.js';
import { CodexAnalyst } from './codex.js';
import { collectFacts } from './facts.js';
import { SettingsSchema, twClock, twDay, type Settings } from './models.js';
import { demoAnalysis } from './strategy.js';
import { ShioajiHttpBroker } from '../broker/http.js';
import { PaperBroker, SyntheticMarket } from '../broker/paper.js';
import type { Broker } from '../broker/types.js';
import { experienceStatus } from './experience.js';

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
  private lastSchedule = '';
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
    if (runTimer) this.timer = setInterval(() => {
      if (this.tickPending || this.stopping) return;
      this.tickPending = true;
      void this.enqueue(async () => {
        try { await this.engine.tick(new Date()); }
        catch { this.engine.entryBlocked = true; if (this.engine.account) this.engine.account.complete = false;
          this.engine.quotes.clear(); this.engine.logOnce('ERROR','連線或資料核對失敗，暫停新委託，等待重新核對'); }
        this.schedule(new Date());
      }).finally(() => { this.tickPending = false; }).catch(() => undefined);
    },1000);
  }
  private schedule(now: Date): void {
    if (!this.calendar.isOpen(twDay(now))) return;
    const s = this.engine.settings, clock = twClock(now);
    if (!s.codex_enabled && s.mode !== 'demo') return;
    let slot = '', review = false;
    if (clock >= s.premarket_time && clock < '09:00') slot = 'premarket';
    else if (clock >= s.postmarket_time && clock < '15:30') { slot = 'postmarket'; review = true; }
    else if (this.calendar.inSession(now)) {
      const minutes = Number(clock.slice(0,2)) * 60 + Number(clock.slice(3));
      slot = `intraday-${Math.floor((minutes - 540) / s.decision_interval_minutes)}`;
    }
    const key = `${twDay(now)}:${slot}`;
    if (!slot || key === this.lastSchedule || this.decisionTask || this.store.get('schedule_' + key)) return;
    this.lastSchedule = key; this.store.set('schedule_' + key,{started_at:now.toISOString()});
    void this.decide(review).catch(() => undefined);
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
    await this.enqueue(() => this.engine.log('ANALYSIS','開始收集動態股票池；背景監控持續'));
    try {
      const bundle = await this.engine.collectBundle(new Date());
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
    } catch {
      if (!this.stopping) await this.enqueue(async () => {
        this.engine.entryBlocked = true;
        this.store.recordExperience({id:'analysis-failure:'+randomUUID(),at:new Date().toISOString(),mode:this.engine.settings.mode,
          kind:'ANALYSIS_FAILURE',symbol:'',action:'NONE',shares:0,price:null,fee:null,tax:null,realized_pnl:null,
          note:'分析逾時、資料不足或 schema／快照核對失敗；未採用該輪結果'});
        this.engine.log('ANALYSIS_FAIL','分析逾時、資料不足或結果未通過檢查；停止新買進，既有保護持續');
        // A failed analysis must also cancel owned outstanding entry orders when execution is enabled.
        if (this.engine.canExecute()) for (const o of this.store.orders(true)) if (o.purpose === 'ENTRY') await this.engine.cancel(o.local_id,new Date());
      });
      throw new Error('本輪決策未啟用；請查看本機狀態');
    }
  }
  async command(input: string): Promise<string> {
    const [name,...args] = input.trim().split(/\s+/);
    if (name === 'decide' || name === 'review') { void this.decide(name === 'review').catch(() => undefined); return '分析已排程，可繼續監控'; }
    return this.enqueue(async () => {
      const now = new Date();
      switch (name) {
        case 'status': return this.engine.status(now);
        case 'experience': return experienceStatus(this.store,this.engine.settings,now.toISOString());
        case 'pause': this.engine.pauseEntries(); return '已暫停新增買進';
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
        case 'help': return 'status | experience | decide | review | pause | resume | stop | continue | auto on/off | cancel ID | cancel-all | reconcile | calendar 年份 | help | exit\nstop 不會自動撤單；exit 關閉監控，不會自動撤銷券商掛單。';
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
      await Promise.allSettled([this.queue,this.decisionTask ?? Promise.resolve(),closingBroker]);
      this.engine.connected = false; this.store.close();
    })();
    return this.closeTask;
  }
}
