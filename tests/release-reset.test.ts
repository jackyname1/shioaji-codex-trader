import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Execute the actual reset policy with an in-memory GitHub API; never contact or mutate GitHub.
const {resetRelease}=await import(pathToFileURL(resolve('scripts/reset-release.mjs')).href) as {resetRelease:(context:Record<string,unknown>)=>Promise<void>};
function fixture(options:{badAssets?:boolean;immutable?:boolean;movedMain?:boolean;changedTag?:boolean;alreadyPublished?:boolean;staged?:boolean;invalidStage?:string}={}){
  const root=mkdtempSync(join(tmpdir(),'release-reset-')),commit='a'.repeat(40),oldCommit='b'.repeat(40),events:string[]=[];
  writeFileSync(join(root,'RELEASE_NOTES.md'),'Isolated verified build');
  let tagObject={type:'commit',sha:options.changedTag?'c'.repeat(40):options.alreadyPublished?commit:oldCommit};
  let releases:any[]=[{id:11,tag_name:'v0.1.0',draft:false,immutable:!!options.immutable,assets:[]},
    {id:12,tag_name:'v0.2.0',draft:false,assets:[]},{id:13,tag_name:'v0.2.3',draft:false,assets:[]}];
  if(options.alreadyPublished)releases=[{id:20,tag_name:'v0.1.0',draft:false,assets:[{digest:'valid'}]},...releases.slice(1)];
  const stageCommit=options.staged?'e'.repeat(40):commit;
  const stageTag=`reset-v0.1.0-${stageCommit.slice(0,12)}`;
  if(options.staged)releases.push({id:20,tag_name:options.invalidStage==='tag'?'unexpected':stageTag,
    target_commitish:options.invalidStage==='commit'?'f'.repeat(40):stageCommit,draft:options.invalidStage!=='published',
    immutable:options.invalidStage==='immutable',assets:[{digest:'valid'}]});
  const api=(path:string,...args:string[]):any=>{
    if(path==='releases?per_page=100')return structuredClone(releases);
    if(path==='git/ref/heads/main')return {object:{type:'commit',sha:options.movedMain?'d'.repeat(40):commit}};
    if(path==='git/ref/tags/v0.1.0')return {object:{...tagObject}};
    if(path==='git/refs/tags/v0.1.0'&&args.includes('PATCH')){events.push('retag');tagObject={type:'commit',sha:commit};return {object:{...tagObject}};}
    const id=Number(path.split('/')[1]);
    if(path.startsWith('releases/')&&args.includes('DELETE')){events.push('delete:'+id);releases=releases.filter(r=>r.id!==id);return null;}
    if(path.startsWith('releases/')&&args.includes('PATCH')){
      const payload=JSON.parse(readFileSync(args[args.indexOf('--input')+1]!, 'utf8'));events.push('publish');
      const index=releases.findIndex(r=>r.id===id);releases[index]={...releases[index],...payload};return structuredClone(releases[index]);
    }
    if(path.startsWith('releases/'))return structuredClone(releases.find(r=>r.id===id));
    throw new Error('Unexpected isolated API operation: '+path);
  };
  const gh=(...args:string[]):string=>{
    if(args[0]!=='release')throw new Error('External operation forbidden');
    if(args[1]==='create'){events.push('stage');releases.push({id:20,tag_name:stageTag,draft:true,assets:[]});return '';}
    if(args[1]==='upload'){events.push('upload');releases.find(r=>r.tag_name===stageTag).assets=[{digest:options.badAssets?'bad':'valid'}];return '';}
    if(args[1]==='view')return JSON.stringify({tagName:'v0.1.0'});
    throw new Error('Unexpected isolated release operation');
  };
  const verifyAssets=async(r:any)=>{events.push('verify:'+r.id);assert.ok(r.assets.length&&r.assets[0].digest==='valid','Replacement asset verification failed');};
  const context={api,gh,commit,tag:'v0.1.0',tagObject,releases:structuredClone(releases),names:['verified.exe'],directory:root,verifyAssets,
    config:{version:'0.1.0',expected_tag_commit:oldCommit,...(options.staged?{resume_staging_release:{id:20,tag:stageTag,source_commit:stageCommit}}:{}),remove_releases:[{id:11,tag:'v0.1.0'},{id:12,tag:'v0.2.0'},{id:13,tag:'v0.2.3'}]}};
  return {context,events,root,state:()=>({releases,tagObject})};
}
for(const options of [{badAssets:true},{immutable:true},{movedMain:true},{changedTag:true}]){
  test('release reset leaves old releases/tags intact when '+Object.keys(options)[0],async()=>{
    const f=fixture(options);try{await assert.rejects(()=>resetRelease(f.context));
      assert.equal(f.events.some(e=>e.startsWith('delete:')||e==='retag'||e==='publish'),false);
      assert.ok(f.state().releases.some(r=>r.id===11));
    }finally{rmSync(f.root,{recursive:true,force:true});}
  });
}
test('release reset verifies a staged build, publishes its replacement, then deletes only the reviewed old releases',async()=>{
  const f=fixture();try{await resetRelease(f.context);
    assert.ok(f.events.indexOf('verify:20')<f.events.indexOf('delete:11'));
    assert.ok(f.events.indexOf('publish')<f.events.indexOf('delete:12'));assert.ok(f.events.indexOf('publish')<f.events.indexOf('delete:13'));
    assert.equal(f.state().releases.length,1);assert.equal(f.state().releases[0].id,20);assert.equal(f.state().releases[0].tag_name,'v0.1.0');
    assert.equal(f.state().tagObject.sha,'a'.repeat(40));
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test('an interrupted cleanup resumes from the verified published replacement without reuploading or retagging it',async()=>{
  const f=fixture({alreadyPublished:true});try{await resetRelease(f.context);
    assert.equal(f.events.some(e=>['stage','upload','retag','publish'].includes(e)),false);
    assert.equal(f.state().releases.length,1);assert.equal(f.state().releases[0].id,20);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

test('a reviewed draft from the previous verified commit is reuploaded and verified before any old release deletion',async()=>{
  const f=fixture({staged:true});try{await resetRelease(f.context);
    assert.equal(f.events.includes('stage'),false);assert.ok(f.events.includes('upload'));
    assert.ok(f.events.indexOf('verify:20')<f.events.indexOf('delete:11'));
    assert.equal(f.state().releases.length,1);assert.equal(f.state().releases[0].target_commitish,'a'.repeat(40));
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
for(const invalidStage of ['tag','commit','published','immutable'])test('a changed staging '+invalidStage+' blocks resume before uploads or deletion',async()=>{
  const f=fixture({staged:true,invalidStage});try{await assert.rejects(()=>resetRelease(f.context));assert.deepEqual(f.events,[]);}
  finally{rmSync(f.root,{recursive:true,force:true});}
});
