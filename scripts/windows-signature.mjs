import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

/** PowerShell -EncodedCommand preserves spaces and Unicode without placing signing secrets in argv. */
export function readWindowsSignature(path,mode){
  if(process.platform!=='win32')throw new Error('Authenticode verification requires Windows.');
  if(!['none','pfx','store'].includes(mode))throw new Error('Invalid Windows signing mode.');
  const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
  const command=`& ${quote(resolve('scripts/sign-windows.ps1'))} -FilePath ${quote(resolve(path))} -Mode ${quote(mode)}`;
  // PowerShell 7 -> Node -> Windows PowerShell otherwise inherits incompatible PS7 modules.
  // See Microsoft about_PSModulePath: remove this variable only from the child's environment.
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='PSMODULEPATH'));
  const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
    {encoding:'utf8',env,timeout:120000,windowsHide:true,stdio:['ignore','pipe','pipe']});
  return JSON.parse(result.trim().replace(/^\uFEFF/,''));
}
