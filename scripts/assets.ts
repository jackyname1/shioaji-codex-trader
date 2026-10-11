import { copyFileSync, mkdirSync, cpSync,readFileSync,writeFileSync } from 'node:fs';
mkdirSync('dist/src/desktop', { recursive: true });
for (const file of ['index.html','styles.css']) copyFileSync('src/desktop/'+file, 'dist/src/desktop/'+file);
const {version}=JSON.parse(readFileSync('package.json','utf8'));
writeFileSync('dist/src/desktop/index.html',readFileSync('dist/src/desktop/index.html','utf8').replace('__APP_VERSION__',version));
cpSync('src/desktop/assets','dist/src/desktop/assets',{recursive:true});
