import { copyFileSync, mkdirSync, cpSync } from 'node:fs';
mkdirSync('dist/src/desktop', { recursive: true });
for (const file of ['index.html','styles.css']) copyFileSync('src/desktop/'+file, 'dist/src/desktop/'+file);
cpSync('src/desktop/assets','dist/src/desktop/assets',{recursive:true});
