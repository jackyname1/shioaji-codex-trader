import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,StoreOpenError} from '../src/core/store.js';
import {processState,windowsProcessState} from '../src/core/store-process.js';
import {workspaceFailure} from '../src/desktop/workspace-profile.js';
import {order} from './helpers.js';

function root(t:TestContext){const directory=fs.mkdtempSync(join(tmpdir(),'store-recovery-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return join(directory,'live.db');}
function restoreMocks(t:TestContext){t.mock.restoreAll();syncBuiltinESMExports();}
function trackMocks(t:TestContext){t.after(()=>restoreMocks(t));syncBuiltinESMExports();}
const denied=()=>Object.assign(new Error('SYNTHETIC_PRIVATE_PATH'),{code:'EPERM'});

test('Windows opens the original journal without a chmod metadata write; POSIX permission errors still block',t=>{
  const path=root(t),prior=new Store(path),intent=order({local_id:'SYNTHETIC_HISTORY',tag:'SYN001',status:'FILLED'});
  prior.insertIntent(intent);prior.close();let calls=0;
  t.mock.method(fs,'chmodSync',()=>{calls++;throw denied();});trackMocks(t);
  const windows=new Store(path,{platform:'win32'});
  try{assert.deepEqual(windows.orders(),[intent]);windows.set('durable_probe',{kept:true});assert.equal(calls,0);}finally{windows.close();}
  assert.throws(()=>new Store(path,{platform:'linux'}),e=>e instanceof StoreOpenError&&e.operation==='permissions'&&e.code==='EPERM');
  assert.equal(calls,1);assert.equal(fs.existsSync(path+'.lock.pid'),false);
  restoreMocks(t);const retry=new Store(path);try{assert.deepEqual(retry.get('durable_probe'),{kept:true});assert.deepEqual(retry.orders(),[intent]);}finally{retry.close();}
});

test('an EPERM while writing a new lock closes the handle and removes only that incomplete lock',t=>{
  const path=root(t),prior=new Store(path);prior.insertIntent(order());prior.close();const before=fs.readFileSync(path);
  const open=fs.openSync,write=fs.writeFileSync;let descriptor=-1;
  t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{const fd=open(...args);if(args[0]===path+'.lock.pid')descriptor=fd;return fd;});
  t.mock.method(fs,'writeFileSync',(...args:Parameters<typeof fs.writeFileSync>)=>{if(typeof args[0]==='number')throw denied();return write(...args);});trackMocks(t);
  assert.throws(()=>new Store(path),e=>e instanceof StoreOpenError&&e.operation==='lock_create'&&e.code==='EPERM');
  assert.ok(descriptor>=0);assert.throws(()=>fs.fstatSync(descriptor),{code:'EBADF'});
  assert.equal(fs.existsSync(path+'.lock.pid'),false);assert.deepEqual(fs.readFileSync(path),before);
  restoreMocks(t);const retry=new Store(path);assert.equal(retry.orders().length,1);retry.close();
});

test('an incomplete lock write never removes a lock that was replaced by another process',t=>{
  const path=root(t),write=fs.writeFileSync;
  const replacement=JSON.stringify({pid:process.pid,nonce:'SYNTHETIC_OTHER_OWNER'});
  t.mock.method(fs,'writeFileSync',(...args:Parameters<typeof fs.writeFileSync>)=>{
    if(typeof args[0]==='number'){fs.unlinkSync(path+'.lock.pid');write(path+'.lock.pid',replacement);throw denied();}return write(...args);
  });trackMocks(t);
  // Windows refuses to unlink an open file on some hosts. This replacement race
  // is also covered below, after closing the completed lock.
  if(process.platform==='win32')return;
  assert.throws(()=>new Store(path),StoreOpenError);assert.equal(fs.readFileSync(path+'.lock.pid','utf8'),replacement);
});

test('a terminated owner is safely reclaimed and pretty-printed legacy lock bytes are accepted',t=>{
  const path=root(t),prior=new Store(path);prior.insertIntent(order());prior.close();
  const finished=childProcess.spawnSync(process.execPath,['-e',''],{encoding:'utf8'});assert.equal(finished.status,0);assert.ok(finished.pid>0);
  fs.writeFileSync(path+'.lock.pid',JSON.stringify({pid:finished.pid,nonce:'SYNTHETIC_EXITED'},null,2));
  const reopened=new Store(path);try{assert.equal(reopened.orders().length,1);}finally{reopened.close();}
  assert.equal(fs.existsSync(path+'.lock.pid'),false);
});

test('a transient unlink EPERM after SQLite closes can recover in the same process, while active stores stay locked',t=>{
  const path=root(t),prior=new Store(path);prior.insertIntent(order());
  const unlink=fs.unlinkSync;t.mock.method(fs,'unlinkSync',(target:fs.PathLike)=>{if(target===path+'.lock.pid')throw denied();return unlink(target);});trackMocks(t);
  prior.close();assert.equal(fs.existsSync(path+'.lock.pid'),true);restoreMocks(t);
  const retry=new Store(path);try{assert.equal(retry.orders().length,1);assert.throws(()=>new Store(path),/執行中的程式/);}finally{retry.close();}
  assert.equal(fs.existsSync(path+'.lock.pid'),false);
});

test('Windows EPERM when exclusively opening an existing hidden lock still requires confirmed stale ownership',t=>{
  const path=root(t),lock=path+'.lock.pid',open=fs.openSync;
  fs.writeFileSync(lock,JSON.stringify({pid:123,nonce:'SYNTHETIC_HIDDEN'}));let first=true;
  t.mock.method(fs,'openSync',(...args:Parameters<typeof fs.openSync>)=>{if(args[0]===lock&&first){first=false;throw denied();}return open(...args);});trackMocks(t);
  const recovered=new Store(path,{platform:'win32',probeProcess:()=>({state:'absent'})});recovered.close();
  fs.writeFileSync(lock,JSON.stringify({pid:123,nonce:'SYNTHETIC_RUNNING'}));const before=fs.readFileSync(lock);first=true;
  assert.throws(()=>new Store(path,{platform:'win32',probeProcess:()=>({state:'running'})}),/執行中的程式/);assert.deepEqual(fs.readFileSync(lock),before);
});

test('a reused Windows PID is reclaimed only when its new start is provably later than the lock',t=>{
  const path=root(t);fs.writeFileSync(path+'.lock.pid',JSON.stringify({pid:123,nonce:'SYNTHETIC_OLD'}));
  const modified=fs.statSync(path+'.lock.pid').mtimeMs;
  const reopened=new Store(path,{platform:'win32',probeProcess:()=>({state:'running',startedAt:Math.ceil(modified)+6000})});reopened.close();
  fs.writeFileSync(path+'.lock.pid',JSON.stringify({pid:123,nonce:'SYNTHETIC_ACTIVE'}));const kept=fs.readFileSync(path+'.lock.pid');
  assert.throws(()=>new Store(path,{platform:'win32',probeProcess:()=>({state:'running',startedAt:modified-6000})}),/執行中的程式/);
  assert.deepEqual(fs.readFileSync(path+'.lock.pid'),kept);
});

test('unknown, running and unidentifiable lock owners keep the original bytes and fail closed',t=>{
  const path=root(t),lock=path+'.lock.pid';
  for(const owner of [{state:'unknown' as const},{state:'running' as const}]){
    fs.writeFileSync(lock,JSON.stringify({pid:123,nonce:'SYNTHETIC_LOCK'}));const kept=fs.readFileSync(lock);
    assert.throws(()=>new Store(path,{platform:'win32',probeProcess:()=>owner}),e=>e instanceof StoreOpenError&&e.operation==='lock_owner');
    assert.deepEqual(fs.readFileSync(lock),kept);
  }
  for(const value of ['',null,{pid:123},{pid:0,nonce:'x'}]){
    fs.writeFileSync(lock,typeof value==='string'?value:JSON.stringify(value));const kept=fs.readFileSync(lock);
    assert.throws(()=>new Store(path),e=>e instanceof StoreOpenError&&e.code==='LOCK_INVALID');assert.deepEqual(fs.readFileSync(lock),kept);
  }
});

test('a lock updated during an owner probe is never removed',t=>{
  const path=root(t),lock=path+'.lock.pid';fs.writeFileSync(lock,JSON.stringify({pid:123,nonce:'SYNTHETIC_OLD'}));
  const replacement=JSON.stringify({pid:process.pid,nonce:'SYNTHETIC_NEW'});
  assert.throws(()=>new Store(path,{probeProcess:()=>{fs.writeFileSync(lock,replacement);return {state:'absent'};}}),e=>e instanceof StoreOpenError&&e.code==='LOCK_CHANGED');
  assert.equal(fs.readFileSync(lock,'utf8'),replacement);
});

test('Windows PID probes use bounded read-only PowerShell and treat ambiguous results as unknown',t=>{
  let output='{"state":"running","startedAt":123456}',calls=0;
  t.mock.method(childProcess,'execFileSync',(file:string,args:string[],options:Record<string,unknown>)=>{
    calls++;assert.match(file,/System32[\\/]WindowsPowerShell/);assert.ok(args.includes('-NoProfile'));assert.match(args.at(-1)!,/\[System.Diagnostics.Process\]::GetProcessById\(123\)/);
    assert.match(args.at(-1)!,/\$cause -is \[System.ArgumentException\]/);
    assert.ok(!/Stop-Process|Get-Process|ConvertTo-Json|\.Kill\(/.test(args.at(-1)!));assert.equal(options.timeout,15000);assert.equal(options.windowsHide,true);
    assert.ok(!Object.keys(options.env as object).some(key=>key.toUpperCase()==='PSMODULEPATH'));
    if(output==='throw')throw denied();if(output==='timeout')throw Object.assign(new Error('isolated timeout'),{code:'ETIMEDOUT'});return output;
  });trackMocks(t);
  assert.deepEqual(windowsProcessState(123),{state:'running',startedAt:123456});
  output='{"state":"absent"}';assert.deepEqual(processState(123,'win32'),{state:'absent'});
  output='{"state":"running","startedAt":null}';assert.deepEqual(windowsProcessState(123),{state:'running'});
  for(const value of ['{}','SYNTHETIC_SECRET','{"state":"unknown"}','throw','timeout']){output=value;assert.deepEqual(windowsProcessState(123),{state:'unknown'});}
  const before=calls;assert.deepEqual(windowsProcessState(-1),{state:'unknown'});assert.equal(calls,before);
});

test('native PID probes recognize this owner and an exited child on the current operating system',()=>{
  assert.equal(processState(process.pid).state,'running');
  const finished=childProcess.spawnSync(process.execPath,['-e',''],{encoding:'utf8'});assert.equal(finished.status,0);
  assert.equal(processState(finished.pid).state,'absent');
});

test('local EPERM diagnostics name the failing operation without exporting raw paths',()=>{
  const diagnostic=workspaceFailure('live','database',new StoreOpenError('lock_create',denied()));
  assert.equal(diagnostic.code,'EPERM');assert.equal(diagnostic.operation,'lock_create');assert.match(diagnostic.issue,/建立資料庫鎖/);
  assert.ok(!JSON.stringify(diagnostic).includes('SYNTHETIC'));assert.ok(!JSON.stringify(new StoreOpenError('write',denied())).includes('SYNTHETIC'));
});
