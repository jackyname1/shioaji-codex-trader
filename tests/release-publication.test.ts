import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,openSync,ftruncateSync,closeSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Replace the gh process inside an isolated Node worker. No repository, network or release is mutated.
const worker=String.raw`
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {readFileSync,readdirSync,statSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const kind=process.argv[2],commit=process.env.RELEASE_COMMIT;let created=false;
const data=name=>{
  if(name==='SHA256SUMS.txt')return readdirSync('release').filter(n=>n!==name).sort().map(n=>createHash('sha256').update(data(n)).digest('hex')+'  '+n).join('\n')+'\n';
  if(kind==='published-rebuilt'&&name==='SYNTHETIC-demo-backtest.json')return Buffer.from(JSON.stringify({status:'COMPLETED',metrics:{filled_orders:1},created_at:'previous build'}));
  return readFileSync('release/'+name);
};
const assets=()=>readdirSync('release').map((name,index)=>({id:100+index,name,size:Buffer.byteLength(data(name)),
  digest:'sha256:'+createHash('sha256').update(data(name)).digest('hex')}));
let release=()=>({id:123,tag_name:'v0.2.1',draft:kind==='new',assets:assets()});
createRequire(import.meta.url)('node:child_process').execFileSync=(binary,args)=>{
  if(binary!=='gh')throw new Error('External process forbidden');
  appendFileSync('calls.jsonl',JSON.stringify(args)+'\n');
  if(args[0]==='api'){
    const path=args[1];
    if(path.endsWith('git/ref/heads/main'))return JSON.stringify({object:{type:'commit',sha:commit}});
    if(path.endsWith('releases?per_page=100'))return JSON.stringify(kind==='new'&&!created?[]:[release()]);
    if(path.endsWith('git/ref/tags/v0.2.1')){
      if(kind==='new'){const error=new Error('HTTP 404');error.stderr='Not Found';throw error;}
      return JSON.stringify({object:{type:'commit',sha:kind==='published-other'?'b'.repeat(40):commit}});
    }
    if(path.endsWith('releases/123'))return JSON.stringify(release());
    if(path.includes('releases/assets/')){const asset=assets().find(a=>a.id===Number(path.split('/').at(-1)));return data(asset.name).toString('utf8');}
    if(path.endsWith('git/refs')&&args.includes('POST'))return JSON.stringify({object:{type:'commit',sha:commit}});
  }
  if(args[0]==='release'){
    if(args[1]==='create')created=true;
    if(['create','upload','edit'].includes(args[1]))return '';
    if(args[1]==='view')return JSON.stringify({tagName:'v0.2.1'});
  }
  throw new Error('Unexpected isolated gh operation');
};
syncBuiltinESMExports();
if(kind==='published-modified'){
  // The fixture's remote asset digest differs from this verified build.
  const fn=release;release=()=>{const r=fn();r.assets[0].digest='sha256:'+'0'.repeat(64);return r;};
}
await import(process.argv[1]);
`;

test('new versions publish separately; same-commit rebuilds verify the published manifest without replacing assets',()=>{
  const script=pathToFileURL(resolve('scripts/publish-release.mjs')).href;
  for(const kind of ['published-other','published-modified','published-identical','published-rebuilt','new']){
    const root=mkdtempSync(join(tmpdir(),'release-policy-'));mkdirSync(join(root,'release'));
    const executable=join(root,'release','Shioaji-Codex-Trader-0.2.1-Windows-x64.exe');
    const fd=openSync(executable,'w');ftruncateSync(fd,50*1024*1024+1);closeSync(fd);
    writeFileSync(join(root,'package.json'),JSON.stringify({version:'0.2.1'}));
    writeFileSync(join(root,'release','WINDOWS-SIGNATURE.json'),JSON.stringify({version:'0.2.1',mode:'none',publisher:null,files:[
      {name:'Shioaji Codex Trader.exe',sha256:'b'.repeat(64),status:'NotSigned'},
      {name:'Shioaji-Codex-Trader-0.2.1-Windows-x64.exe',sha256:createHash('sha256').update(readFileSync(executable)).digest('hex'),status:'NotSigned'}]}));
    for(const name of ['README.md','RELEASE_NOTES.md','SYNTHETIC-historical-sample.csv',
      'SYNTHETIC-ui-paper-1366.png','SYNTHETIC-ui-paper-1600.png','SYNTHETIC-ui-paper-1920.png','SYNTHETIC-ui-live.png','SYNTHETIC-ui-connection.png'])writeFileSync(join(root,'release',name),'isolated fixture');
    writeFileSync(join(root,'release','SYNTHETIC-demo-backtest.json'),JSON.stringify({status:'COMPLETED',metrics:{filled_orders:1}}));
    try{
      const result=spawnSync(process.execPath,['--input-type=module','--eval',worker,script,kind],{cwd:root,encoding:'utf8',timeout:20000,
        env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,GH_REPO:'jackyname1/shioaji-codex-trader',GITHUB_REF:'refs/heads/main',RELEASE_COMMIT:'a'.repeat(40)}});
      const calls=readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[]);
      const mutations=calls.filter(args=>args.includes('--method')||args[0]==='release'&&['create','upload','edit'].includes(args[1]!));
      if(kind.startsWith('published-')&&!['published-identical','published-rebuilt'].includes(kind)){
        assert.notEqual(result.status,0);assert.equal(mutations.length,0);assert.match(result.stderr,/Increment the package version|asset verification failed/);
      }else{
        assert.equal(result.status,0,result.stderr);
        if(kind.startsWith('published-'))assert.equal(mutations.length,0);
        else{assert.ok(mutations.some(args=>args[1]==='create'&&args[2]==='v0.2.1'));assert.equal(mutations.length,4);}
      }
      assert.ok(!calls.some(args=>args.some(a=>a.includes('force=true')||a.includes('v0.2.0'))));
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});
