import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repository = 'jackyname1/shioaji-codex-trader';
const commit = process.env.RELEASE_COMMIT;
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const api = (path, ...args) => JSON.parse(gh('api', `repos/${repository}/${path}`, ...args));
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (process.env.GH_REPO !== repository || process.env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
  throw new Error('Release publication requires the verified repository main commit.');
}
if (packageJson.version !== '0.1.0') throw new Error('This workflow replaces the existing v0.1.0 pre-release.');
if (api('git/ref/heads/main').object.sha !== commit) throw new Error('A newer main commit exists; publish its verified build instead.');

const tag = 'v0.1.0';
const directory = resolve('release');
const executable = 'Shioaji-Codex-Trader-0.1.0-Windows-x64.exe';
const names = (await readdir(directory)).filter(name => name === executable || /^(?:README|RELEASE_NOTES)\.md$/.test(name) || /^SYNTHETIC-[\w.-]+\.(?:png|json|csv)$/.test(name)).sort();
const required = [executable, 'README.md', 'RELEASE_NOTES.md', 'SYNTHETIC-demo-backtest.json', 'SYNTHETIC-historical-sample.csv', 'SYNTHETIC-ui-paper-1366.png', 'SYNTHETIC-ui-paper-1600.png', 'SYNTHETIC-ui-paper-1920.png', 'SYNTHETIC-ui-live.png', 'SYNTHETIC-ui-connection.png'];
if (required.some(name => !names.includes(name))) throw new Error('A verified release asset is missing.');
if ((await stat(resolve(directory, executable))).size < 50 * 1024 * 1024) throw new Error('The packaged Windows executable is incomplete.');
const report = JSON.parse(await readFile(resolve(directory, 'SYNTHETIC-demo-backtest.json'), 'utf8'));
if (report.status !== 'COMPLETED' || !report.metrics.filled_orders) throw new Error('The synthetic release demonstration did not pass.');
const digests = new Map();
for (const name of names) digests.set(name, createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex'));
await writeFile(resolve(directory, 'SHA256SUMS.txt'), names.map(name => `${digests.get(name)}  ${name}`).join('\n') + '\n');
names.push('SHA256SUMS.txt');
digests.set('SHA256SUMS.txt', createHash('sha256').update(await readFile(resolve(directory, 'SHA256SUMS.txt'))).digest('hex'));

const releases = api('releases?per_page=100');
const existing = releases.find(release => release.tag_name === tag);
if (existing?.immutable) throw new Error('The existing release is immutable and cannot be replaced.');
if (!existing) {
  gh('release', 'create', tag, '--target', commit, '--prerelease', '--draft', '--title', `Shioaji Codex Trader ${tag} · Pre-release`, '--notes-file', resolve(directory, 'RELEASE_NOTES.md'));
}
// Keep the release identity and URL. Upload only after both Windows smoke tests pass.
gh('release', 'upload', tag, ...names.map(name => resolve(directory, name)), '--clobber');
const updated = api(`releases/tags/${tag}`);
for (const name of names) {
  const asset = updated.assets.find(item => item.name === name);
  if (!asset || asset.size !== (await stat(resolve(directory, name))).size || (asset.digest && asset.digest !== `sha256:${digests.get(name)}`)) {
    throw new Error(`Release asset verification failed: ${name}`);
  }
}
// Remove only obsolete assets belonging to this application's previous build.
for (const asset of updated.assets) {
  if (!names.includes(asset.name) && (/^Shioaji-Codex-Trader-.*-Windows-x64\.exe$/.test(asset.name) || /^SYNTHETIC-/.test(asset.name))) {
    gh('api', `repos/${repository}/releases/assets/${asset.id}`, '--method', 'DELETE');
  }
}
api(`git/refs/tags/${tag}`, '--method', 'PATCH', '-f', `sha=${commit}`, '-F', 'force=true');
gh('release', 'edit', tag, '--draft=false', '--prerelease=true', '--title', `Shioaji Codex Trader ${tag} · Pre-release`, '--notes-file', resolve(directory, 'RELEASE_NOTES.md'));
console.log(gh('release', 'view', tag, '--json', 'url,tagName,assets'));
