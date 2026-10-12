import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {connectionView,actualOrdersBlock,reconnectBlocked} from '../src/desktop/connection-state.js';
import {ConnectionSmoke} from '../src/desktop/connection-smoke.js';
import {ConnectionInputSchema,CredentialVault} from '../src/desktop/credentials.js';
import {mergeDiagnostics} from '../src/broker/diagnostics.js';
import {TradingService} from '../src/core/service.js';
import {Store} from '../src/core/store.js';
import {simulationView} from '../src/desktop/workspace.js';
import type {DesktopState} from '../src/desktop/shared.js';

test('a ready native service with no working engine never becomes a ready trading connection',()=>{
  const view=connectionView(true,false,false,'','交易工作台載入失敗');
  assert.equal(view.workspace_ready,false);assert.equal(view.phase,'failed');assert.match(view.status,/工作台載入失敗/);
  assert.equal(connectionView(true,true,false,'','').phase,'ready');
  assert.equal(simulationView({workspace_mode:'live',runtime:null} as DesktopState),false);
});
test('local paper orders permit mode switching while actual pending orders retain their guard',()=>{
  assert.equal(actualOrdersBlock('paper',true),false);assert.equal(actualOrdersBlock('demo',true),false);
  assert.equal(actualOrdersBlock('live',true),true);assert.equal(actualOrdersBlock('readonly',true),true);
  assert.equal(reconnectBlocked('live',true,true),false);assert.equal(reconnectBlocked('live',true,false),true);
});
test('a failed service constructor releases its database so the same process can retry',()=>{
  const root=mkdtempSync(join(tmpdir(),'login-constructor-')),path=join(root,'paper.db');
  try{assert.throws(()=>new TradingService(path,'paper',()=>{throw new Error('fixture initialization');}),/fixture initialization/);
    const retry=new Store(path);retry.close();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('a saved login remains encrypted and diagnosable when native readiness fails, then reuses its owned session',async()=>{
  const root=mkdtempSync(join(tmpdir(),'login-native-')),fixture=new ConnectionSmoke(),native=fixture.native(root);
  const storage={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(Buffer.from(s).map(n=>n^42)),decryptString:(b:Buffer)=>Buffer.from(b.map(n=>n^42)).toString()};
  const vault=new CredentialVault(join(root,'vault'),storage),input=ConnectionInputSchema.parse({api_key:'  SYNTHETIC_KEY \n',secret_key:' SYNTHETIC_SECRET '});
  try{assert.equal(input.api_key,'SYNTHETIC_KEY');await vault.save(input);fixture.simulation=true;
    await assert.rejects(native.start(input),/未取得正式行情/);assert.equal((await vault.status()).remembered,true);
    assert.equal(native.diagnostics().startup?.phase,'failed');assert.ok(native.diagnostics().endpoints.some(e=>e.endpoint==='/info'));
    fixture.simulation=false;await native.start((await vault.read())!);const launches=fixture.launches;
    assert.equal(native.sameLogin(input),true);assert.equal(native.sameLogin({...input,api_key:'ANOTHER_KEY'}),false);
    await native.start((await vault.read())!);assert.equal(fixture.launches,launches);assert.equal(native.connected,true);
    assert.ok(!JSON.stringify(native.diagnostics()).includes('SYNTHETIC_'));assert.equal(fixture.mutations,0);
  }finally{await native.close();rmSync(root,{recursive:true,force:true});}
});
test('startup and account endpoint histories retain the newest failure while combining request counts',async()=>{
  const root=mkdtempSync(join(tmpdir(),'login-diag-')),fixture=new ConnectionSmoke(),native=fixture.native(root);
  try{await native.start({api_key:'SYNTHETIC_KEY',secret_key:'SYNTHETIC_SECRET'});
    const n=native.diagnostics(),health=n.endpoints.find(e=>e.endpoint==='/health')!;
    const combined=mergeDiagnostics(n,{...n,endpoints:[{...health,attempts:2,successes:1,failures:1,last_attempt_at:'2099-01-01T00:00:00Z',issue:'HTTP 503',http_status:503}]});
    const row=combined.endpoints.find(e=>e.endpoint==='/health')!;assert.equal(row.issue,'HTTP 503');assert.equal(row.attempts,health.attempts+2);assert.equal(row.failures,1);
  }finally{await native.close();rmSync(root,{recursive:true,force:true});}
});
test('an unavailable CA file preserves market login without claiming a loaded certificate or placing orders',async()=>{
  const root=mkdtempSync(join(tmpdir(),'login-ca-')),fixture=new ConnectionSmoke(),native=fixture.native(root);
  try{await native.start({api_key:'SYNTHETIC_KEY',secret_key:'SYNTHETIC_SECRET',ca_path:join(root,'missing.pfx'),ca_password:'SYNTHETIC_PASSWORD'});
    assert.equal(native.connected,true);assert.equal(native.hasCa,false);assert.match(native.diagnostics().startup!.issue,/有效 CA/);
    assert.equal(fixture.mutations,0);assert.ok(!JSON.stringify(native.diagnostics()).includes('SYNTHETIC_'));
  }finally{await native.close();rmSync(root,{recursive:true,force:true});}
});
