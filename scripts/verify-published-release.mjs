import {createHash} from 'node:crypto';
import {validateSignatureReport} from './signature-report.mjs';

/** Same-commit reruns verify the immutable published manifest, not new timestamped fixtures. */
export function verifyPublishedRelease(release,{gh,repository,names,version,executable}){
  const assets=new Map();
  for(const asset of release.assets){
    if(assets.has(asset.name))throw new Error(`Release asset verification failed: duplicate ${asset.name}`);
    assets.set(asset.name,asset);
  }
  if(assets.size!==names.length||names.some(name=>!assets.has(name)))throw new Error('Release asset verification failed: asset set');
  const read=name=>{
    const asset=assets.get(name),data=gh('api',`repos/${repository}/releases/assets/${asset.id}`,'-H','Accept: application/octet-stream');
    if(Buffer.byteLength(data)!==asset.size||`sha256:${createHash('sha256').update(data).digest('hex')}`!==asset.digest)
      throw new Error(`Release asset verification failed: ${name}`);
    return data;
  };
  const manifest=read('SHA256SUMS.txt'),entries=new Map();
  for(const line of manifest.trimEnd().split('\n')){
    const match=/^([a-f0-9]{64})  ([A-Za-z0-9][\w.-]*)$/.exec(line);
    if(!match||entries.has(match[2])||match[2]==='SHA256SUMS.txt')throw new Error('Release asset verification failed: checksum manifest');
    entries.set(match[2],match[1]);
  }
  if(entries.size!==assets.size-1)throw new Error('Release asset verification failed: checksum coverage');
  for(const [name,digest] of entries){
    const asset=assets.get(name);
    if(!asset||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.digest!==`sha256:${digest}`)
      throw new Error(`Release asset verification failed: ${name}`);
  }
  if(assets.get(executable).size<50*1024*1024)throw new Error('Release asset verification failed: incomplete executable');
  validateSignatureReport(JSON.parse(read('WINDOWS-SIGNATURE.json')),version,executable,entries.get(executable));
}
