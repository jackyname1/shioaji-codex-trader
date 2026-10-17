import {execFileSync} from 'node:child_process';
import { copyFileSync, mkdirSync, cpSync,readFileSync,writeFileSync } from 'node:fs';
mkdirSync('dist/src/desktop', { recursive: true });
for (const file of ['index.html','styles.css']) copyFileSync('src/desktop/'+file, 'dist/src/desktop/'+file);
const {version}=JSON.parse(readFileSync('package.json','utf8'));
writeFileSync('dist/src/desktop/index.html',readFileSync('dist/src/desktop/index.html','utf8').replace('__APP_VERSION__',version));
cpSync('src/desktop/assets','dist/src/desktop/assets',{recursive:true});

let source_commit=null,source_tree=null,dirty=null;
try{source_commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();source_tree=execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim();
  dirty=!!execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim();}catch{/* Source archive: identity remains explicitly unknown. */}
mkdirSync('dist/src/core',{recursive:true});writeFileSync('dist/src/core/build-info.json',JSON.stringify({version,source_commit,source_tree,dirty}));
