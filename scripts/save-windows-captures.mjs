import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const repository='jackyname1/shioaji-codex-trader';
export const captureFiles=['SYNTHETIC-ui-paper-1600.png','SYNTHETIC-ui-capital-profile.png','SYNTHETIC-ui-smart-conditions-1600.png',
  'SYNTHETIC-ui-realtime-1600.png','SYNTHETIC-ui-live.png','SYNTHETIC-ui-connection.png','SYNTHETIC-ui-codex-history.png'];
const hash=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest('hex');
export function captureManifest(root,version,source,tree,run){
  if(!/^\d+\.\d+\.\d+$/.test(version)||![source,tree].every(x=>/^[a-f0-9]{40}$/.test(x))||!/^\d+$/.test(String(run)))
    throw new Error('Invalid capture provenance');
  const images=captureFiles.map(name=>{
    const bytes=readFileSync(join(root,name));
    if(bytes.length<24||bytes.length>2*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Invalid GUI capture: '+name);
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    if(width!==(name.includes('codex-history')?1920:1600)||height!==(name.includes('codex-history')?1080:960))throw new Error('Unexpected capture dimensions: '+name);
    return {source_file:name,path:`docs/capture-bundles/v${version}/${name}`,width,height,size_bytes:bytes.length,sha256:hash(bytes),
      git_blob_sha:hash(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes]),'sha1')};
  });
  return {app_version:version,platform:'Windows x64',fixture:'isolated synthetic GUI smoke test; no user credentials or brokerage orders',
    source_commit:source,source_tree:tree,workflow_run_id:Number(run),images,
    bundle_sha256:hash(Buffer.from(JSON.stringify(images.map(x=>[x.source_file,x.sha256]))))};
}
export async function saveWindowsCaptures(){
  const source=process.env.CAPTURE_SOURCE_COMMIT,run=process.env.GITHUB_RUN_ID,attempt=process.env.GITHUB_RUN_ATTEMPT;
  if(process.env.GH_REPO!==repository||process.env.GITHUB_EVENT_NAME!=='pull_request'
    ||process.env.CAPTURE_HEAD_REPOSITORY!==repository||!/^refs\/pull\/\d+\/merge$/.test(process.env.GITHUB_REF??'')
    ||!/^[a-f0-9]{40}$/.test(source??'')||!/^\d+$/.test(attempt??''))throw new Error('Capture persistence requires a same-repository verified PR');
  const version=JSON.parse(readFileSync('package.json','utf8')).version;
  const checkoutTree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  const temp=mkdtempSync(join(tmpdir(),'synthetic-captures-'));
  let counter=0;
  const api=(path,body)=>{
    const args=['api',`repos/${repository}/${path}`];
    if(body){const file=join(temp,`${counter++}.json`);writeFileSync(file,JSON.stringify(body));args.push('--method','POST','--input',file);}
    return JSON.parse(execFileSync('gh',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
  };
  try{
    if(api(`git/commits/${source}`).tree.sha!==checkoutTree)throw new Error('PR checkout differs from capture source tree');
    const manifest=captureManifest('release',version,source,checkoutTree,run),entries=[];
    for(const image of manifest.images){const blob=api('git/blobs',{encoding:'base64',content:readFileSync(join('release',image.source_file)).toString('base64')});
      if(blob.sha!==image.git_blob_sha)throw new Error('Capture blob digest mismatch');entries.push({path:image.path,mode:'100644',type:'blob',sha:blob.sha});}
    entries.push({path:`docs/capture-bundles/v${version}/manifest.json`,mode:'100644',type:'blob',content:JSON.stringify(manifest,null,2)+'\n'});
    const tree=api('git/trees',{base_tree:checkoutTree,tree:entries});
    const commit=api('git/commits',{message:`ci: verified Windows GUI captures v${version}`,parents:[source],tree:tree.sha});
    const branch=`ci/screenshots-v${version}-${source.slice(0,12)}-r${run}-${attempt}`;
    api('git/refs',{ref:'refs/heads/'+branch,sha:commit.sha});
    console.log(JSON.stringify({capture_branch:branch,capture_commit:commit.sha,capture_tree:tree.sha,bundle_sha256:manifest.bundle_sha256,images:manifest.images.length}));
  }finally{rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await saveWindowsCaptures();
