import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TradingService } from './core/service.js';
import { SettingsSchema } from './core/models.js';
import { demoAnalysis } from './core/strategy.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2), demo = args.includes('--demo'), doctor = args.includes('--doctor');
  const modeValue = args.find(a => a.startsWith('--mode='))?.slice(7) ?? (doctor ? 'readonly' : 'demo');
  const mode = SettingsSchema.shape.mode.parse(modeValue);
  if (demo && mode !== 'demo') throw new Error('--demo 只能使用虛構行情');
  const temporary = demo ? mkdtempSync(join(tmpdir(),'shioaji-ts-demo-')) : undefined;
  const database = resolve(args.find(a => a.startsWith('--db='))?.slice(5) ?? join(temporary ?? join(homedir(),'.shioaji-codex-trader'),`${mode}.db`));
  const service = new TradingService(database,mode);
  let reader: ReturnType<typeof createInterface> | undefined;
  const abort = (): void => { reader?.close(); void service.close(); };
  process.once('SIGINT',abort); process.once('SIGTERM',abort);
  try {
    if (demo) {
      const virtual = new Date('2026-10-08T10:00:00+08:00');
      await service.engine.start(virtual); service.engine.setSettings({...service.engine.settings,auto_execute:true});
      const snapshot = await service.engine.snapshot(virtual);
      await service.engine.activate(demoAnalysis(snapshot,service.engine.settings,virtual),snapshot,virtual);
      for (let n = 0; n < 5; n++) await service.engine.tick(new Date(virtual.getTime() + n * 1000));
      console.log(service.engine.status(new Date(virtual.getTime() + 5000)));
      console.log('\nDEMO 完成：虛構行情、虛構交易時間、模擬資金，未連線券商或 Codex。');
      if (!service.store.orders().some(o => o.filled > 0)) throw new Error('DEMO 未驗證成交流程');
      return;
    }
    await service.start(!doctor);
    if (doctor) {
      await service.command('reconcile'); console.log(service.engine.status(new Date()));
      console.log('\n唯讀診斷完成；未啟用真實下單。'); return;
    }
    console.log(service.engine.status(new Date())); console.log(await service.command('help'));
    reader = createInterface({input:stdin,output:stdout});
    for (;;) {
      let input: string; try { input = await reader.question('trader> '); } catch { break; }
      if (input.trim() === 'exit') break;
      try { console.log(await service.command(input)); } catch (e) { console.log(e instanceof Error ? e.message : '指令未完成'); }
    }
  } finally {
    reader?.close(); await service.close(); process.removeListener('SIGINT',abort); process.removeListener('SIGTERM',abort);
    if (temporary) rmSync(temporary,{recursive:true,force:true});
  }
}
void main().catch(() => { console.error('啟動或診斷失敗。請檢查本機官方 Shioaji 服務、版本、模式與帳戶設定。'); process.exitCode = 1; });
