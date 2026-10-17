import type {Settings} from '../core/models.js';

export function connectionLabel(connection:{status:string;server_ready?:boolean;has_ca:boolean}):string {
  return connection.status+(connection.server_ready?' · '+(connection.has_ca?'CA 已載入':'實盤委託需有效 CA'):'');
}

export function actualOrdersBlock(mode:Settings['mode'],pending:boolean):boolean {
  return !['paper','demo'].includes(mode)&&pending;
}
export function reconnectBlocked(mode:Settings['mode'],pending:boolean,sameLogin:boolean):boolean{return actualOrdersBlock(mode,pending)&&!sameLogin;}
export function connectionView(server:boolean,workspace:boolean,busy:boolean,stage:string,issue:string){
  const ready=server&&workspace;
  const phase=busy?'connecting':ready?'ready':issue?'failed':server?'workspace':'idle';
  const status=busy?(stage||'正在建立 Shioaji 連線'):ready?'Shioaji 已連線 · 工作台就緒':issue
    ?(server?'本機服務已登入；'+issue:issue):server?'Shioaji 本機服務就緒，工作台正在恢復':'請先登入 Shioaji';
  return {phase,status,server_ready:server,workspace_ready:ready};
}
