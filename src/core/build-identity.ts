import {readFileSync} from 'node:fs';
export function buildIdentity():{version:string;source_commit:string|null;source_tree:string|null;dirty:boolean|null}{
  try{return JSON.parse(readFileSync(new URL('./build-info.json',import.meta.url),'utf8'));}
  catch{return {version:'unknown',source_commit:null,source_tree:null,dirty:null};}
}
