import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

export type ProcessState={state:'running';startedAt?:number}|{state:'absent'|'unknown'};

/** Query a Windows PID without requesting termination rights or sending a signal. */
export function windowsProcessState(pid:number):ProcessState {
  if(!Number.isSafeInteger(pid)||pid<=0||pid>0x7fffffff)return {state:'unknown'};
  // The current process is known alive; avoid a slow external probe under Windows CI load.
  // No start timestamp is asserted, so this cannot authorize PID-reuse lock reclamation.
  if(pid===process.pid)return {state:'running'};
  // Query .NET directly: no Get-Process/ConvertTo-Json module autoload on a cold or busy host.
  // GetProcessById(int) reports an expired local PID with ArgumentException; other failures remain unknown.
  const script=`try {
    $item = [System.Diagnostics.Process]::GetProcessById(${pid})
    $started = 'null'
    try { $started = ([DateTimeOffset]$item.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds().ToString([Globalization.CultureInfo]::InvariantCulture) } catch {}
    '{"state":"running","startedAt":' + $started + '}'
  } catch {
    $cause = $_.Exception
    while ($cause.InnerException) { $cause = $cause.InnerException }
    if ($cause -is [System.ArgumentException]) { '{"state":"absent"}' }
    else { '{"state":"unknown"}' }
  }`;
  try {
    const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    // PowerShell 7 callers can otherwise inject incompatible PS7 management modules.
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='PSMODULEPATH'));
    const output=execFileSync(executable,['-NoProfile','-NonInteractive','-Command',script],
      {encoding:'utf8',env,windowsHide:true,timeout:15000,maxBuffer:4096,stdio:['ignore','pipe','pipe']});
    const result=JSON.parse(output.trim().replace(/^\uFEFF/,'')) as {state?:unknown;startedAt?:unknown};
    if(result.state==='absent')return {state:'absent'};
    if(result.state==='running')return {state:'running',...(typeof result.startedAt==='number'&&Number.isSafeInteger(result.startedAt)&&result.startedAt>0?{startedAt:result.startedAt}:{})};
  }catch{/* Missing tools, timeout, permissions and malformed output never prove a lock is stale. */}
  return {state:'unknown'};
}

export function processState(pid:number,platform:NodeJS.Platform=process.platform):ProcessState {
  if(platform==='win32')return windowsProcessState(pid);
  try {process.kill(pid,0);return {state:'running'};}
  catch(error){return {state:(error as NodeJS.ErrnoException).code==='ESRCH'?'absent':'unknown'};}
}
