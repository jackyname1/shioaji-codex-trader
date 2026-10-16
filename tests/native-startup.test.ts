import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,type SpawnOptions} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {NativeConnection,ConnectionInputSchema} from '../src/desktop/credentials.js';
import {NativeStartup} from '../src/desktop/native-startup.js';

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
    fetcher:async()=>{
      if(launches<=(options.failures??0))throw new Error('SYNTHETIC_PRIVATE_NETWORK');
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
    fetcher:async()=>{throw new Error('offline');},
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
