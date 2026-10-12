import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {validateSignatureReport} from './signature-report.mjs';

if(process.platform!=='win32')throw new Error('Windows packaging and Authenticode verification require a Windows runner.');
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const mode=process.env.WINDOWS_SIGNING_PFX_BASE64?'pfx':process.env.WINDOWS_SIGNING_CERTIFICATE_SHA1?'store':'none';
if(process.env.WINDOWS_SIGNING_REQUIRED==='true'&&mode==='none')throw new Error('A trusted code-signing certificate is required but has not been configured.');
// Only our two EXEs are signed. Vendor Shioaji/Codex binaries retain their original bytes and runtime checksums.
const builderEnv={...process.env,CSC_IDENTITY_AUTO_DISCOVERY:'false'};
for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','WIN_CSC_LINK','WIN_CSC_KEY_PASSWORD','WINDOWS_SIGNING_PFX_BASE64','WINDOWS_SIGNING_PFX_PASSWORD'])delete builderEnv[key];
const builder=args=>execFileSync(process.execPath,['node_modules/electron-builder/cli.js',...args,'--publish','never'],{stdio:'inherit',env:builderEnv});
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const verifyVendor=()=>{
  const root=resolve('release/win-unpacked/resources/shioaji'),manifest=JSON.parse(readFileSync(join(root,'runtime.json'),'utf8'));
  const path=resolve(root,manifest.relative_path);
  if(!path.startsWith(root+'\\')||hash(path)!==manifest.sha256)throw new Error('Bundled Shioaji was modified during packaging/signing.');
};
const sign=path=>{
  const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve('scripts/sign-windows.ps1'),
    '-FilePath',resolve(path),'-Mode',mode],{encoding:'utf8',env:process.env,timeout:120000,windowsHide:true,stdio:['ignore','pipe','pipe']});
  return JSON.parse(result.trim().replace(/^\uFEFF/,''));
};
builder(['--win','dir','--x64']);
verifyVendor();
const inner=resolve('release/win-unpacked/Shioaji Codex Trader.exe'),innerReport=sign(inner),innerHash=hash(inner);
builder(['--win','portable','--x64','--prepackaged',resolve('release/win-unpacked')]);
if(hash(inner)!==innerHash)throw new Error('The signed app executable changed during portable packaging.');
verifyVendor();
const filename=`Shioaji-Codex-Trader-${pkg.version}-Windows-x64.exe`,outer=resolve('release',filename),outerReport=sign(outer);
const report={version:pkg.version,mode,publisher:mode==='none'?null:outerReport.publisher,files:[innerReport,outerReport]};
validateSignatureReport(report,pkg.version,filename,hash(outer));
writeFileSync('release/WINDOWS-SIGNATURE.json',JSON.stringify(report,null,2)+'\n');
console.log(mode==='none'?'Windows signing is not configured; the release remains explicitly unsigned.':'Both application and portable EXEs have valid timestamped publisher signatures.');
