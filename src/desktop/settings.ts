import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SettingsSchema, storedSettings, type Settings } from '../core/models.js';
import { Store } from '../core/store.js';

const localKeys = new Set(['mode', 'base_url', 'auto_execute']);
type SharedValues = Omit<Settings, 'mode' | 'base_url' | 'auto_execute'>;
const shared = (s: Settings): SharedValues => Object.fromEntries(Object.entries(s).filter(([key]) => !localKeys.has(key))) as SharedValues;

/** Preferences are common; balances, orders and execution authority stay in each mode's database. */
export class DesktopSettings {
  private values?: SharedValues;
  private readonly path: string;
  constructor(readonly root: string) {
    this.path = join(root, 'common-settings.json');
    if (existsSync(this.path)) {
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as { version: number; settings: unknown };
      if (saved.version !== 1) throw new Error('設定檔版本無法辨識');
      this.values = shared(storedSettings(saved.settings));
    }
  }
  get accountIndex(): number { return this.values?.stock_account_index ?? 0; }
  migrate(lastMode: Settings['mode'], index: number): void {
    if (this.values) return;
    // Prefer the last workspace, falling back to a configured workspace when the last one was new.
    const suffix = index ? '-account-' + index : '';
    const choices: Settings[] = [];
    for (const mode of [...new Set([lastMode, 'paper', 'live'])]) {
      const path = join(this.root, mode + suffix + '.db');
      if (!existsSync(path)) continue;
      const store = new Store(path); try { if (store.get('settings')) choices.push(store.settings()); } finally { store.close(); }
    }
    const defaults = SettingsSchema.parse({});
    const configured = (s: Settings): boolean => JSON.stringify(shared(s)) !== JSON.stringify(shared(defaults));
    const selected = choices.find(configured) ?? choices[0] ?? { ...defaults, stock_account_index: index };
    this.save(selected);
  }
  apply(stored: Settings, mode: Settings['mode'], baseUrl: string, override?: Settings): Settings {
    return SettingsSchema.parse({ ...stored, ...this.values, ...override, mode, base_url: baseUrl, auto_execute: false });
  }
  save(settings: Settings): void {
    const values = shared(SettingsSchema.parse(settings));
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify({ version: 1, settings: values }), { mode: 0o600 });
    renameSync(temporary, this.path); this.values = values;
  }
}
