import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

test('publisher captures and parses release collections larger than the default process buffer',async()=>{
  const {captureCommand}=await import(pathToFileURL(resolve('scripts/command-output.mjs')).href);
  const output=captureCommand(process.execPath,['-e',`process.stdout.write(JSON.stringify(Array.from({length:16},(_,id)=>({id,assets:Array.from({length:34},(_,asset)=>({name:'fixture-'+asset,metadata:'x'.repeat(2200)}))}))))`]);
  assert.ok(Buffer.byteLength(output)>1024*1024);
  const releases=JSON.parse(output);assert.equal(releases.length,16);assert.equal(releases[15].assets.length,34);
});
