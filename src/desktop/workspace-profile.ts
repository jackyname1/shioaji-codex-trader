import {join} from 'node:path';
import {BrokerError} from '../broker/health.js';
import {Store,StoreOpenError,type StoreOperation} from '../core/store.js';
import {TradingService} from '../core/service.js';
import {SettingsSchema,type Settings} from '../core/models.js';
import {optimizationSettings,costAwareSettings} from '../core/adaptive.js';
import {replayCapitalSettings} from '../core/capital.js';
import type {DesktopSettings} from './settings.js';

export type WorkspaceStage='closing'|'database'|'settings'|'engine'|'preferences'|'api';
export interface WorkspaceDiagnostic {
  mode:'paper'|'live';stage:WorkspaceStage;state:'loading'|'ready'|'read_only'|'failed';code:string;issue:string;
  operation?:StoreOperation;
}
const labels:Record<WorkspaceStage,string>={closing:'結束原工作台',database:'開啟本機資料庫',settings:'讀取本機設定',
  engine:'建立交易工作台',preferences:'保存桌面偏好',api:'讀取 Shioaji 資料'};
const storageLabels:Record<StoreOperation,string>={directory:'準備紀錄資料夾',lock_create:'建立資料庫鎖',lock_read:'讀取資料庫鎖',
  lock_owner:'核對鎖擁有者',lock_remove:'清理已結束程式的鎖',database_open:'開啟 SQLite',permissions:'設定檔案權限',schema:'載入資料表',write:'驗證紀錄保存'};
export function workspaceFailure(mode:Settings['mode'],stage:WorkspaceStage,error:unknown):WorkspaceDiagnostic {
  const e=error&&typeof error==='object'?error as {code?:unknown;errcode?:unknown;name?:unknown;message?:unknown}:{};
  const message=typeof e.message==='string'?e.message:'';
  let code='LOCAL_WORKSPACE',reason='本機工作台初始化失敗';
  if(error instanceof BrokerError){code='WORKSPACE_INITIALIZATION';reason=error.message;}
  else if(message==='每種交易模式須使用獨立資料庫'){code='MODE_MISMATCH';reason='這份本機紀錄屬於另一種交易模式';}
  else if(message==='資料庫版本不同，請使用獨立的 TypeScript 資料庫'){code='SCHEMA_VERSION';reason='本機資料庫版本尚未相容';}
  else if(message==='這個資料庫已有執行中的程式'){code='WORKSPACE_IN_USE';reason='本機資料庫仍由另一個執行中的程式使用';}
  else if(e.code==='LOCK_OWNER_UNKNOWN'){code='LOCK_OWNER_UNKNOWN';reason='無法確認原程式是否已結束；確認舊版已從系統匣結束後，按「重試本機紀錄」';}
  else if(e.code==='LOCK_INVALID'){code='LOCK_INVALID';reason='本機資料庫鎖內容不完整，已保留原檔案';}
  else if(e.code==='LOCK_CHANGED'){code='LOCK_CHANGED';reason='資料庫鎖已由另一個程式更新，請稍後重試';}
  else if(typeof e.code==='string'&&['EACCES','EPERM','EROFS','ENOSPC','ENOENT','ERR_SQLITE_ERROR','ERR_INVALID_STATE'].includes(e.code)){
    code=e.code;reason=code==='ENOSPC'?'本機儲存空間不足':code==='ERR_SQLITE_ERROR'?'本機資料庫無法讀取或寫入':
      code==='ERR_INVALID_STATE'?'本機資料庫已關閉':'本機檔案目前無法讀取或保存';
    if(code==='ERR_SQLITE_ERROR'&&typeof e.errcode==='number'&&Number.isSafeInteger(e.errcode))code+='_'+e.errcode;
  }else if(e.name==='ZodError'||e.name==='$ZodError'){code='SAVED_DATA_FORMAT';reason='本機保存的設定或紀錄格式尚未相容';}
  else if(typeof e.name==='string'&&['TypeError','ReferenceError','RangeError','SyntaxError','AbortError'].includes(e.name))code=e.name;
  const operation=error instanceof StoreOpenError?error.operation:undefined;
  if(operation&&['EPERM','EACCES','EROFS'].includes(code))reason=operation==='lock_remove'?'已確認原程式結束，但系統暫時不允許清理舊鎖；請按「重試本機紀錄」':
    operation==='lock_create'||operation==='directory'?'紀錄資料夾目前不允許建立檔案；恢復資料夾寫入權限後，按「重試本機紀錄」':
    '本機紀錄目前無法讀取或保存；恢復檔案存取後，按「重試本機紀錄」';
  return {mode:mode==='live'?'live':'paper',stage,state:'failed',code,...(operation?{operation}:{}),
    issue:`${mode==='live'?'實盤':'模擬'}工作台：${labels[stage]}${operation?'／'+storageLabels[operation]:''}未完成（${code}）；${reason}`};
}
export class WorkspaceProfileError extends BrokerError {
  constructor(readonly diagnostic:WorkspaceDiagnostic){super(diagnostic.issue);}
}
export function openWorkspace(root:string,mode:Settings['mode'],baseUrl:string,common:DesktopSettings,
  override?:Settings,createMarket?:ConstructorParameters<typeof TradingService>[2],automaticLive=false,
  createReaderMarket?:ConstructorParameters<typeof TradingService>[2]){
  let stage:WorkspaceStage='database';
  const index=override?.stock_account_index??common.accountIndex;
  const path=join(root,`${mode}${index?'-account-'+index:''}.db`);
  try {
    const store=new Store(path);
    try {
      stage='settings';
      const priorMode=store.get<string>('database_mode');
      if(priorMode&&priorMode!==mode&&!(priorMode==='readonly'&&mode==='live'))throw new Error('每種交易模式須使用獨立資料庫');
      if(store.get('account_fingerprint')&&store.get('account_identity_version')!==2&&!store.get('legacy_account_origin'))
        store.set('legacy_account_origin',store.settings().base_url);
      const saved=store.get<Record<string,unknown>>('settings');
      let next=common.apply(store.settings(),mode,baseUrl,override);
      if(mode==='paper'&&!override&&saved?.adaptive_entries===undefined)next=optimizationSettings(costAwareSettings(saved?next:replayCapitalSettings(next,'active'),true),'integrated');
      store.saveSettings(next);
    }finally{store.close();}
    stage='engine';
    const service=new TradingService(path,mode,createMarket,{automaticLive});
    return {service,diagnostic:{mode:mode==='live'?'live':'paper',stage:'api',state:'loading',code:'',issue:''} as WorkspaceDiagnostic};
  }catch(error){
    const diagnostic=workspaceFailure(mode,stage,error);
    if(mode!=='live')throw new WorkspaceProfileError(diagnostic);
    // Preserve the original file and all intents. A damaged journal permits account reads, never submissions.
    const settings=common.apply(SettingsSchema.parse({mode}),mode,baseUrl,override);
    const issue=diagnostic.issue+'；已保留原紀錄，帳務可讀，實盤委託暫停';
    const service=new TradingService(':memory:','live',createReaderMarket,{settings,persistenceIssue:issue});
    return {service,diagnostic:{...diagnostic,state:'read_only',issue} as WorkspaceDiagnostic};
  }
}
