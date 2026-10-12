import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

/** PowerShell -EncodedCommand preserves spaces and Unicode without placing signing secrets in argv. */
export function readWindowsSignature(path,mode){
  if(process.platform!=='win32')throw new Error('Authenticode verification requires Windows.');
  if(!['none','pfx','store'].includes(mode))throw new Error('Invalid Windows signing mode.');
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
  const command=`& ${quote(resolve('scripts/sign-windows.ps1'))} -FilePath ${quote(resolve(path))} -Mode ${quote(mode)}`;
  const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
    {encoding:'utf8',env:process.env,timeout:120000,windowsHide:true,stdio:['ignore','pipe','pipe']});
  return JSON.parse(result.trim().replace(/^\uFEFF/,''));
}
