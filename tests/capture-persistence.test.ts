import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

test('Windows capture manifests bind all eight allowlisted images, dimensions, source tree and Git/SHA256 digests',async()=>{
  const {captureFiles,captureManifest}=await import(pathToFileURL(resolve('scripts/save-windows-captures.mjs')).href);
  const root=mkdtempSync(join(tmpdir(),'capture-manifest-'));
  try{
    for(const name of captureFiles){const bytes=Buffer.alloc(32);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);
      bytes.writeUInt32BE(name.includes('codex-history')?1920:1600,16);bytes.writeUInt32BE(name.includes('codex-history')?1080:960,20);writeFileSync(join(root,name),bytes);}
    const manifest=captureManifest(root,'0.2.2','a'.repeat(40),'b'.repeat(40),123);
    assert.equal(manifest.images.length,8);assert.equal(manifest.source_commit,'a'.repeat(40));assert.equal(manifest.source_tree,'b'.repeat(40));
    for(const image of manifest.images){const bytes=readFileSync(join(root,image.source_file));
      assert.equal(image.sha256,createHash('sha256').update(bytes).digest('hex'));
      assert.equal(image.git_blob_sha,createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex'));
      assert.match(image.path,/^docs\/capture-bundles\/v0.2.2\/SYNTHETIC-ui-/);}
    const bytes=readFileSync(join(root,captureFiles[0]));bytes[31]=1;writeFileSync(join(root,captureFiles[0]),bytes);
    assert.notEqual(captureManifest(root,'0.2.2','a'.repeat(40),'b'.repeat(40),123).bundle_sha256,manifest.bundle_sha256);
    bytes.writeUInt32BE(1366,16);writeFileSync(join(root,captureFiles[0]),bytes);
    assert.throws(()=>captureManifest(root,'0.2.2','a'.repeat(40),'b'.repeat(40),123),/dimensions/);
    assert.throws(()=>captureManifest(root,'../other','a'.repeat(40),'b'.repeat(40),123),/provenance/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('capture persistence refuses forks and non-PR refs before launching Git or making GitHub requests',()=>{
  for(const [repo,ref]of [['other/fork','refs/pull/24/merge'],['jackyname1/shioaji-codex-trader','refs/heads/main']]){
    const result=spawnSync(process.execPath,['scripts/save-windows-captures.mjs'],{encoding:'utf8',timeout:5000,
      env:{PATH:'',SystemRoot:process.env.SystemRoot,GH_REPO:'jackyname1/shioaji-codex-trader',GITHUB_EVENT_NAME:'pull_request',
        CAPTURE_HEAD_REPOSITORY:repo,GITHUB_REF:ref,CAPTURE_SOURCE_COMMIT:'a'.repeat(40),GITHUB_RUN_ATTEMPT:'1'}});
    assert.notEqual(result.status,0);assert.match(result.stderr,/same-repository verified PR/);assert.doesNotMatch(result.stderr,/ENOENT/);
  }
});
