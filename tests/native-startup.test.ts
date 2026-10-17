import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,type SpawnOptions} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {NativeConnection,ConnectionInputSchema,brokerEnvironment} from '../src/desktop/credentials.js';
import {NativeStartup} from '../src/desktop/native-startup.js';
import {activateWindow} from '../src/desktop/window-activation.js';
import {connectionLabel} from '../src/desktop/connection-state.js';

const input=ConnectionInputSchema.parse({api_key:'SYNTHETIC_PRIVATE_KEY',secret_key:'SYNTHETIC_PRIVATE_SECRET'});
const root=()=>mkdtempSync(join(tmpdir(),'native-startup-'));
function fixture(folder:string,options:{output?:string;failures?:number;health?:object;http?:number;spawnError?:boolean}={}) {
  let launches=0;const children:ReturnType<typeof spawn>[]=[];const environments:NodeJS.ProcessEnv[]=[];
  const native=new NativeConnection(folder,async()=>'/SYNTHETIC/native',{
    origin:async()=>'http://127.0.0.1:19998',run:async()=>({stdout:'--no-open'}),pollMs:1,timeoutMs:60,
    launch:((_binary:string,_args:readonly string[],opts:Parameters<typeof spawn>[2])=>{
      launches++;environments.push(opts?.env??{});
      const child=Object.assign(new EventEmitter(),{exitCode:null as number|null,signalCode:null as string|null,stdout:new PassThrough(),stderr:new PassThrough(),
        kill:()=>{child.exitCode=0;setImmediate(()=>child.emit('exit',0,null));return true;}});
      children.push(child as unknown as ReturnType<typeof spawn>);
      if(launches<=(options.failures??0))setImmediate(()=>{
        const output=options.output??'Unknown native failure SYNTHETIC_PRIVATE_ACCOUNT';
        child.stderr.write(output.slice(0,7));child.stderr.write(output.slice(7));
        if(options.spawnError)child.emit('error',new Error('SYNTHETIC_PRIVATE_PATH'));
        else{child.exitCode=17;child.emit('exit',17,null);}
      });
      return child;
    }) as unknown as typeof spawn,
    fetcher:async(url)=>{
      if(launches<=(options.failures??0))throw new Error('SYNTHETIC_PRIVATE_NETWORK');
      if(String(url).endsWith('/info'))return Response.json({simulation:false,version:'1.7.8'});
      return Response.json(options.health??{status:'degraded',token_stale:false,ca_expired:false,simulation:false}, {status:options.http??200});
    },
  });
  return {native,children,environments,get launches(){return launches;}};
}
test('native error classification handles fragmented pipes and emits fixed messages without raw output',()=>{
  for(const [output,expected] of [
    ['Ca Password Incorrect','CA_PASSWORD'],['Ca has expired!','CA_EXPIRED'],['Failed to load certificate from file','CA_INVALID'],
    ['Sign data is timeout','SIGN_TIME'],['Public IP not available','PUBLIC_IP'],['No available token slot','SESSION_BUSY'],
    ['Invalid token format','SESSION_INVALID'],['Address already in use (os error 10048)','PORT_IN_USE'],
    ['invalid peer certificate: UnknownIssuer','NETWORK_TLS'],['dns error','NETWORK_DNS'],['invalid api key','AUTH_REJECTED'],
  ] as const){
    const startup=new NativeStartup();startup.consume('stderr','SYNTHETIC_PRIVATE_KEY '+output.slice(0,5));
    startup.consume('stdout','unrelated output');startup.consume('stderr',output.slice(5)+' SYNTHETIC_PRIVATE_ACCOUNT');
    const message=startup.failure('PROCESS_EXIT');assert.equal(startup.code,expected);assert.ok(!message.includes('SYNTHETIC_'));
  }
});
test('a real isolated subprocess exit is diagnosed without exposing stderr or credential arguments',async()=>{
  const folder=root(),script=join(folder,'native-fixture.cjs');let args:readonly string[]=[];
  writeFileSync(script,"process.stderr.write('SYNTHETIC_PRIVATE_ACCOUNT '+process.env.SJ_SEC_KEY+' Sign data is timeout');process.exit(17);");
  const native=new NativeConnection(folder,async()=>process.execPath,{
    origin:async()=>'http://127.0.0.1:19998',run:async()=>({stdout:'--no-open'}),timeoutMs:5000,pollMs:5,
    launch:((_binary:string,arguments_:readonly string[],options:SpawnOptions)=>{args=arguments_;return spawn(process.execPath,[script],options);}) as unknown as typeof spawn,
    fetcher:async(url)=>{throw new Error('offline');},
  });
  try{
    await assert.rejects(native.start(input),/SIGN_TIME/);
    const diagnostic=native.diagnostics();assert.equal(diagnostic.startup?.process_exit_code,17);assert.equal(diagnostic.startup?.code,'SIGN_TIME');
    assert.ok(!JSON.stringify([diagnostic,args]).includes('SYNTHETIC_PRIVATE'));assert.equal(native.connected,false);
  }finally{await native.close();rmSync(folder,{recursive:true,force:true});}
});
test('an explicit CA failure retries once without the CA, preserves saved input and never claims a loaded CA',async()=>{
  for(const output of ['Ca Password Incorrect','Ca has expired!','Failed to load certificate from file']){
    const folder=root(),path=join(folder,'SYNTHETIC.pfx');writeFileSync(path,'synthetic certificate');
    const f=fixture(folder,{output,failures:1});const credentials={...input,ca_path:path,ca_password:'SYNTHETIC_CA_PASSWORD'};
    try{
      assert.deepEqual(await f.native.start(credentials),credentials);assert.equal(f.launches,2);assert.equal(f.native.connected,true);
      assert.equal(f.environments[0]?.SJ_CA_PATH,path);assert.equal(f.environments[1]?.SJ_CA_PATH,undefined);
      assert.equal(f.environments[1]?.SJ_CA_PASSWD,undefined);assert.equal(f.native.hasCa,false);
      assert.equal(f.native.diagnostics().startup?.ca_fallback,true);assert.match(f.native.diagnostics().startup!.issue,/實盤需重新核對有效 CA/);
      assert.ok(!JSON.stringify(f.native.diagnostics()).includes('SYNTHETIC_'));
      // A later explicit login must load a replacement CA, even at the same path/password.
      await f.native.start(credentials);assert.equal(f.launches,3);assert.equal(f.environments[2]?.SJ_CA_PATH,path);
      assert.equal(f.native.hasCa,true);assert.equal(f.native.diagnostics().startup?.ca_fallback,false);
    }finally{await f.native.close();rmSync(folder,{recursive:true,force:true});}
  }
});
test('an unknown exit, permission failure or unsuccessful CA recovery never becomes a login loop',async()=>{
  for(const options of [{failures:1},{failures:1,spawnError:true},{failures:1,output:'invalid api key'},
    {failures:2,output:'Ca Password Incorrect'}]){
    const folder=root(),path=join(folder,'SYNTHETIC.pfx');writeFileSync(path,'synthetic certificate');const f=fixture(folder,options);
    try{
      await assert.rejects(f.native.start({...input,ca_path:path,ca_password:'SYNTHETIC_CA_PASSWORD'}));
      assert.equal(f.launches,options.failures===2?2:1);assert.equal(f.native.connected,false);assert.equal(f.native.hasCa,false);
      if('spawnError' in options)assert.equal(f.native.diagnostics().startup?.process_exit_code,null,'intentional cleanup must not overwrite the startup failure');
      assert.ok(!JSON.stringify(f.native.diagnostics()).includes('SYNTHETIC_'));
    }finally{await f.native.close();rmSync(folder,{recursive:true,force:true});}
  }
});
test('health readiness failures keep their cause and count every failed HTTP probe exactly once',async()=>{
  for(const health of [{status:'healthy',session_recovering:true},{status:'degraded',token_stale:true},{status:'unhealthy'},{unexpected:'SYNTHETIC_PRIVATE_RESPONSE'}]){
    const folder=root(),f=fixture(folder,{health});
    try{await assert.rejects(f.native.start(input),/SESSION_RECOVERING|TOKEN_STALE|HEALTH_UNHEALTHY|HEALTH_SCHEMA/);assert.equal(f.launches,1);}
    finally{await f.native.close();rmSync(folder,{recursive:true,force:true});}
  }
  for(const http of [503,0]){
    const folder=root(),f=fixture(folder,{http});
    try{await assert.rejects(f.native.start(input),/STARTUP_TIMEOUT/);const row=f.native.diagnostics().endpoints.find(e=>e.endpoint==='/health')!;
      assert.ok(row.attempts>1);assert.equal(row.attempts,row.failures);assert.equal(row.successes,0);
    }finally{await f.native.close();rmSync(folder,{recursive:true,force:true});}
  }
});
test('a service exit after readiness clears connectivity and only exports a known process signal',async()=>{
  const folder=root(),f=fixture(folder);
  try{await f.native.start(input);f.children[0]!.emit('exit',null,'SIGTERM');
    assert.equal(f.native.connected,false);assert.equal(f.native.phase,'failed');
    assert.equal(f.native.diagnostics().startup?.code,'PROCESS_EXIT');assert.equal(f.native.diagnostics().startup?.process_signal,'SIGTERM');
    const startup=new NativeStartup();startup.exited(null,'SYNTHETIC_PRIVATE_SIGNAL');assert.ok(!startup.failure('PROCESS_EXIT').includes('SYNTHETIC_'));
  }finally{await f.native.close();rmSync(folder,{recursive:true,force:true});}
});

test('a signing rejection stops immediately without changing OS time, elevating, discarding CA or looping',async()=>{
  const folder=root(),f=fixture(folder,{output:'Sign data is timeout',failures:1});
  try{await assert.rejects(f.native.start(input),/SIGN_TIME/);assert.equal(f.launches,1);
    assert.ok(!JSON.stringify(f.native.diagnostics()).includes('clock_'));assert.equal(f.native.connected,false);
  }finally{await f.native.close();rmSync(folder,{recursive:true,force:true});}
});
test('recovered startup messages cannot misclassify a later exit or a failed login as a CA fault',()=>{
  const startup=new NativeStartup();startup.consume('stderr','Sign data is timeout');startup.ready();startup.exited(1,null);
  assert.match(startup.failure('PROCESS_EXIT'),/PROCESS_EXIT/);assert.equal(startup.code,'PROCESS_EXIT');
  assert.equal(connectionLabel({status:'SIGN_TIME',has_ca:false,server_ready:false}),'SIGN_TIME');
  assert.match(connectionLabel({status:'已連線',has_ca:false,server_ready:true}),/實盤委託需有效 CA/);
  const calls:string[]=[];activateWindow({isDestroyed:()=>false,isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')});
  assert.deepEqual(calls,['restore','show','focus']);
});
test('Pro-compatible launch keeps SDK/Windows client settings, overrides local HTTP auth, and excludes unrelated secrets',()=>{
  const env=brokerEnvironment({APPDATA:'SYNTHETIC_APPDATA',LOCALAPPDATA:'SYNTHETIC_LOCAL',SJ_PROXY:'SYNTHETIC_PROXY',TZ:'Asia/Taipei',
    SJ_HOME_PATH:'SYNTHETIC_EXPLICIT_SDK_HOME',SJ_HTTP_AUTH:'true',SJ_HTTP_TLS_KEY:'SYNTHETIC_UNRELATED_TLS',OPENAI_API_KEY:'SYNTHETIC_OTHER_KEY'},input);
  assert.equal(env.APPDATA,'SYNTHETIC_APPDATA');assert.equal(env.LOCALAPPDATA,'SYNTHETIC_LOCAL');assert.equal(env.TZ,'Asia/Taipei');
  assert.equal(env.SJ_PROXY,'SYNTHETIC_PROXY');assert.equal(env.SJ_HOME_PATH,'SYNTHETIC_EXPLICIT_SDK_HOME');
  assert.equal(env.SJ_HTTP_AUTH,'false');assert.equal(env.SJ_HTTP_TLS_KEY,undefined);assert.equal(env.OPENAI_API_KEY,undefined);
  assert.equal(brokerEnvironment({},input).SJ_HOME_PATH,undefined);
});
test('API listener and broker session are separate gates, and an old or simulated API never becomes ready',async()=>{
  for(const info of [{version:'1.7.8',simulation:false},{version:'1.7.7',simulation:false},{version:'1.7.8',simulation:true}]){
    const folder=root(),paths:string[]=[];let healthCalls=0;

    const native=new NativeConnection(folder,async()=>'/SYNTHETIC/native',{
      run:async()=>({stdout:'--no-open'}),origin:async()=>'http://127.0.0.1:19998',timeoutMs:100,pollMs:1,
      launch:((_binary:string,_args:readonly string[],options:Parameters<typeof spawn>[2])=>{
        assert.equal(options?.env?.SJ_HOME_PATH,undefined);assert.equal(options?.env?.SJ_HTTP_AUTH,'false');
        const process=Object.assign(new EventEmitter(),{exitCode:null as number|null,stdout:new PassThrough(),stderr:new PassThrough(),
          kill:()=>{process.exitCode=0;setImmediate(()=>process.emit('exit',0,null));return true;}});return process;
      }) as unknown as typeof spawn,
      fetcher:async url=>{const path=new URL(String(url)).pathname;paths.push(path);
        return path.endsWith('/info')?Response.json(info):Response.json({status:'degraded',session_recovering:++healthCalls<3});},
    });
    try{
      if(info.version==='1.7.8'&&!info.simulation){await native.start(input);assert.equal(native.connected,true);assert.equal(healthCalls,3);}
      else{await assert.rejects(native.start(input),/版本不符/);assert.equal(healthCalls,0);assert.equal(native.connected,false);}
      assert.equal(paths[0],'/api/v1/info');assert.equal(native.diagnostics().bundled_version,'1.7.8');
    }finally{await native.close();rmSync(folder,{recursive:true,force:true});}
  }
});
test('a local HTTP auth rejection is distinct from rejected broker credentials and does not loop',async()=>{
  for(const denied of ['info','health']){
    const folder=root();let requests=0;
    const native=new NativeConnection(folder,async()=>'/SYNTHETIC/native',{
      run:async()=>({stdout:'--no-open'}),origin:async()=>'http://127.0.0.1:19998',timeoutMs:500,pollMs:1,
      launch:(()=>{const child=Object.assign(new EventEmitter(),{exitCode:null as number|null,stdout:new PassThrough(),stderr:new PassThrough(),
        kill:()=>{child.exitCode=0;setImmediate(()=>child.emit('exit',0,null));return true;}});return child;}) as unknown as typeof spawn,
      fetcher:async url=>{requests++;return String(url).endsWith('/'+denied)?new Response('',{status:401}):Response.json({simulation:false,version:'1.7.8'});},
    });
    try{await assert.rejects(native.start(input),/HTTP_AUTH/);assert.equal(requests,denied==='info'?1:2);assert.equal(native.connected,false);}
    finally{await native.close();rmSync(folder,{recursive:true,force:true});}
  }
});
test('a forced shutdown waits for exit, and an unkillable owned child blocks the next login',async()=>{
  for(const stuck of [false,true]){
    const folder=root();let launches=0,exited=false;
    let child:EventEmitter & {exitCode:number|null;stdout:PassThrough;stderr:PassThrough;kill:(signal?:string)=>boolean};
    const native=new NativeConnection(folder,async()=>'/SYNTHETIC/native',{
      run:async()=>({stdout:'--no-open'}),origin:async()=>'http://127.0.0.1:19998',timeoutMs:50,pollMs:1,shutdownMs:10,
      launch:(()=>{launches++;assert.ok(launches===1||exited,'new login must wait for the prior exit');
        child=Object.assign(new EventEmitter(),{exitCode:null as number|null,stdout:new PassThrough(),stderr:new PassThrough(),kill:(signal?:string)=>{
          if(signal==='SIGKILL'&&!stuck)setTimeout(()=>{exited=true;child.exitCode=0;child.emit('exit',0,null);},3);return true;}});return child;
      }) as unknown as typeof spawn,fetcher:async url=>Response.json(String(url).endsWith('/info')?{simulation:false,version:'1.7.8'}:{status:'healthy'}),
    });
    try{await native.start(input);
      if(stuck){await assert.rejects(native.start({...input,secret_key:'SYNTHETIC_NEW'}),/程序尚未結束/);assert.equal(launches,1);}
      else{await native.start({...input,secret_key:'SYNTHETIC_NEW'});assert.equal(launches,2);assert.equal(native.connected,true);}
    }finally{child!.exitCode=0;child!.emit('exit',0,null);await native.close();rmSync(folder,{recursive:true,force:true});}
  }
});

test('a child already terminated by a signal does not block a fresh login',async()=>{
  const folder=root(),f=fixture(folder);
  try{await f.native.start(input);const prior=f.children[0]!;
    Object.defineProperty(prior,'signalCode',{value:'SIGTERM',writable:true});prior.emit('exit',null,'SIGTERM');
    Object.defineProperty(prior,'exitCode',{value:null,writable:true});
    await f.native.start(input);assert.equal(f.launches,2);assert.equal(f.native.connected,true);
  }finally{await f.native.close();rmSync(folder,{recursive:true,force:true});}
});
