import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const {validateSignatureReport}=await import(pathToFileURL(resolve('scripts/signature-report.mjs')).href);
const executable='Shioaji-Codex-Trader-0.1.1-Windows-x64.exe',digest='a'.repeat(64);
function signed(){return {version:'0.1.1',mode:'store',publisher:'CN=Verified test identity',files:[
  {name:'Shioaji Codex Trader.exe',sha256:'b'.repeat(64),status:'Valid',timestamped:true,code_signing:true,publisher:'CN=Verified test identity',thumbprint:'c'.repeat(40)},
  {name:executable,sha256:digest,status:'Valid',timestamped:true,code_signing:true,publisher:'CN=Verified test identity',thumbprint:'c'.repeat(40)}]};}
test('a verified publisher requires both actual EXE signatures, trusted timestamps and the same signing identity',()=>{
  assert.equal(validateSignatureReport(signed(),'0.1.1',executable,digest),true);
  for(const kind of ['timestamp','status','eku','identity','payload','version']){const r=signed();
    if(kind==='timestamp')r.files[0]!.timestamped=false;
    if(kind==='status')r.files[1]!.status='NotTrusted';
    if(kind==='eku')r.files[0]!.code_signing=false;
    if(kind==='identity')r.files[0]!.thumbprint='d'.repeat(40);
    if(kind==='payload')r.files[1]!.sha256='e'.repeat(64);
    if(kind==='version')r.version='0.1.0';
    assert.throws(()=>validateSignatureReport(r,'0.1.1',executable,digest));
  }
});
test('unsigned metadata can never claim a verified publisher or borrow another application certificate',()=>{
  const r:Record<string,unknown>=signed();r.mode='none';r.publisher=null;
  r.files=(signed().files).map(f=>({...f,status:'NotSigned',timestamped:false,code_signing:false,publisher:null,thumbprint:null}));
  assert.equal(validateSignatureReport(r,'0.1.1',executable,digest),false);
  r.publisher='A company name in package.json';assert.throws(()=>validateSignatureReport(r,'0.1.1',executable,digest));
  r.publisher=null;(r.files as {status:string}[])[0]!.status='Valid';assert.throws(()=>validateSignatureReport(r,'0.1.1',executable,digest));
});
