import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const repository='jackyname1/shioaji-codex-trader',version=JSON.parse(readFileSync('package.json','utf8')).version;
const source=process.env.VALIDATION_SOURCE_COMMIT,run=process.env.GITHUB_RUN_ID;
if(process.env.GH_REPO!==repository||process.env.GITHUB_EVENT_NAME!=='pull_request'||
  process.env.VALIDATION_HEAD_REPOSITORY!==repository||!/^[a-f0-9]{40}$/.test(source??'')||!/^\d+$/.test(run??''))
  throw new Error('Validation persistence requires a same-repository pull request');
const api=(path,body)=>JSON.parse(execFileSync('gh',['api','repos/'+repository+'/'+path,...(body?['--method','POST','--input','-']:[])],
  {encoding:'utf8',input:body?JSON.stringify(body):undefined,stdio:['pipe','pipe','pipe']}));
const files=['observed-comparison.json','synthetic-comparison.json','parameter-sensitivity.json','stress-comparison.json'];
const root='docs/validation-bundles/v'+version;
const sourceCommit=api('git/commits/'+source),elements=[],reports=[];
const checkedTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
if(checkedTree!==sourceCommit.tree.sha)throw new Error('The tested merge tree differs from the declared source tree');
for(const name of files){
  const bytes=readFileSync('validation-output/'+name);
  const value=JSON.parse(bytes.toString('utf8'));
  if(value.version!==version||value.source_commit!==source)throw new Error('Report source/version mismatch');
  reports.push({name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  elements.push({path:root+'/'+name,mode:'100644',type:'blob',content:bytes.toString('utf8')});
}
const manifest={version,source_commit:source,source_tree:sourceCommit.tree.sha,workflow_run_id:Number(run),
  digest:createHash('sha256').update(JSON.stringify(reports.map(r=>[r.name,r.sha256]))).digest('hex'),reports};
elements.push({path:root+'/manifest.json',mode:'100644',type:'blob',content:JSON.stringify(manifest,null,2)+'\n'});
const tree=api('git/trees',{base_tree:sourceCommit.tree.sha,tree:elements});
const commit=api('git/commits',{message:'validation: verified v'+version+' strategy comparisons for '+source.slice(0,12),
  tree:tree.sha,parents:[source]});
const branch='validation/v'+version+'/'+source.slice(0,12)+'-'+run;
api('git/refs',{ref:'refs/heads/'+branch,sha:commit.sha});
console.log(JSON.stringify({branch,commit:commit.sha,tree:tree.sha,manifest:root+'/manifest.json',...manifest}));
