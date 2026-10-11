import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';

/** A bounded, one-time release-series reset requested by the repository owner. */
export async function resetRelease({api,gh,config,commit,tag,tagObject,releases,names,directory,verifyAssets}) {
  if(config.version!=='0.1.0'||tag!=='v0.1.0'||!Array.isArray(config.remove_releases)||!config.remove_releases.length
    ||!config.remove_releases.every(r=>Number.isSafeInteger(r.id)&&/^v\d+\.\d+\.\d+$/.test(r.tag)))
    throw new Error('Release reset configuration is invalid.');
  const permitted=new Map(config.remove_releases.map(r=>[r.id,r.tag]));
  const stageTag=`reset-${tag}-${commit.slice(0,12)}`;
  let replacement=releases.find(r=>r.tag_name===tag&&r.id!==config.remove_releases.find(x=>x.tag===tag)?.id);
  const staged=releases.find(r=>r.tag_name===stageTag);
  for(const release of releases){
    if(permitted.has(release.id)){
      if(permitted.get(release.id)!==release.tag_name||release.immutable)throw new Error('An old release changed or is immutable; no release was removed.');
    }else if(release.id!==staged?.id&&release.id!==replacement?.id)throw new Error('An unexpected release exists; no release was removed.');
  }
  if(!tagObject||tagObject.type!=='commit'||![config.expected_tag_commit,commit].includes(tagObject.sha))
    throw new Error('The release reset tag changed; no release was removed.');
  if(replacement&&!replacement.draft){
    if(tagObject.sha!==commit)throw new Error('The replacement tag does not match this build.');
    await verifyAssets(replacement);
  }else{
    if(staged?.immutable||staged&&!staged.draft)throw new Error('The staging release is not an editable draft.');
    if(!staged)gh('release','create',stageTag,'--target',commit,'--prerelease','--draft','--title',`Shioaji Codex Trader ${tag} · verified staging`,
      '--notes-file',resolve(directory,'RELEASE_NOTES.md'));
    gh('release','upload',stageTag,...names.map(n=>resolve(directory,n)),'--clobber');
    const draft=api('releases?per_page=100').find(r=>r.tag_name===stageTag);
    if(!draft?.draft)throw new Error('The verified staging draft is missing.');
    // No old release or tag changes until every uploaded replacement asset matches the tested build.
    await verifyAssets(api(`releases/${draft.id}`));
    const current=api('git/ref/heads/main').object;
    if(current.sha!==commit)throw new Error('Main moved during upload; old releases were not removed.');
    const currentTag=api(`git/ref/tags/${tag}`).object;
    if(currentTag.type!=='commit'||![config.expected_tag_commit,commit].includes(currentTag.sha))throw new Error('The reset tag moved during upload.');
    const old=releases.find(r=>r.tag_name===tag&&permitted.has(r.id));
    if(old)api(`releases/${old.id}`,'--method','DELETE');
    if(currentTag.sha!==commit)api(`git/refs/tags/${tag}`,'--method','PATCH','-f',`sha=${commit}`,'-F','force=true');
    const payload=join(tmpdir(),`release-reset-${randomUUID()}.json`);
    await writeFile(payload,JSON.stringify({tag_name:tag,target_commitish:commit,name:`Shioaji Codex Trader ${tag} · Pre-release`,
      body:await readFile(resolve(directory,'RELEASE_NOTES.md'),'utf8'),prerelease:true,draft:false}),{mode:0o600});
    try{replacement=api(`releases/${draft.id}`,'--method','PATCH','--input',payload);}finally{await unlink(payload);}
    if(replacement?.draft||replacement?.tag_name!==tag)throw new Error('The replacement release was not published.');
    await verifyAssets(replacement);
  }
  // Delete only the explicitly reviewed old release IDs, after the replacement is available.
  for(const old of api('releases?per_page=100'))if(permitted.has(old.id)){
    if(old.id===replacement.id)continue;
    if(permitted.get(old.id)!==old.tag_name||old.immutable)throw new Error('An old release changed during cleanup.');
    api(`releases/${old.id}`,'--method','DELETE');
  }
  const final=api('releases?per_page=100');
  if(final.length!==1||final[0].id!==replacement.id||final[0].tag_name!==tag||final[0].draft)throw new Error('Release reset cleanup is incomplete.');
  await verifyAssets(final[0]);
  console.log(`Published verified ${tag}; removed the explicitly listed older releases.`);
  console.log(gh('release','view',tag,'--json','url,tagName,assets'));
}
