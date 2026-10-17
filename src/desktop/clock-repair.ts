import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {win32} from 'node:path';

export type ClockRepairResult='synced'|'unsupported'|'denied'|'cancelled'|'timeout'|'failed';
export type ClockRepair=(elevated:boolean)=>Promise<ClockRepairResult>;
const execute=promisify(execFile);
// Fixed Windows commands only. No broker environment, user input or credentials.
export function clockRepairCommand(systemRoot:string,elevated:boolean):{binary:string;args:string[];timeout:number} {
  if(!win32.isAbsolute(systemRoot))throw new Error('Invalid Windows directory');
  const system=win32.join(systemRoot,'System32');
  if(!elevated)return {binary:win32.join(system,'w32tm.exe'),args:['/resync','/rediscover'],timeout:15000};
  const encode=(s:string)=>Buffer.from(s,'utf16le').toString('base64');
  const inner=encode('$ErrorActionPreference="Stop"; try { Start-Service W32Time; & "$env:SystemRoot\\System32\\w32tm.exe" /resync /rediscover; exit $LASTEXITCODE } catch { exit 1 }');
  const outer=encode(`try { $p=Start-Process -FilePath "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${inner}') -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }; exit 5 }`);
  return {binary:win32.join(system,'WindowsPowerShell','v1.0','powershell.exe'),args:['-NoProfile','-NonInteractive','-EncodedCommand',outer],timeout:45000};
}
export const repairWindowsClock:ClockRepair=async elevated=>{
  if(process.platform!=='win32')return 'unsupported';
  try {
    const command=clockRepairCommand(process.env.SystemRoot??'C:\\Windows',elevated);
    const env:NodeJS.ProcessEnv={};
    for(const key of ['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE'])if(process.env[key])env[key]=process.env[key];
    await execute(command.binary,command.args,{env,timeout:command.timeout,windowsHide:true,maxBuffer:32000});
    return 'synced';
  } catch(error) {
    const e=error as {code?:number|string;killed?:boolean};
    return e.killed?'timeout':e.code===1223?'cancelled':e.code===5?'denied':'failed';
  }
};
