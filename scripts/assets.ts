import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist/src/desktop', { recursive: true });
copyFileSync('src/desktop/index.html', 'dist/src/desktop/index.html');
