import {captureCommand} from './command-output.mjs';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {resetRelease} from './reset-release.mjs';
import {validateSignatureReport} from './signature-report.mjs';
import {verifyPublishedRelease} from './verify-published-release.mjs';

const repository = 'jackyname1/shioaji-codex-trader';
const commit = process.env.RELEASE_COMMIT;
const gh = (...args) => captureCommand('gh',args);
const api = (path, ...args) => {const response=gh('api', `repos/${repository}/${path}`, ...args);return response.trim()?JSON.parse(response):null;};
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (process.env.GH_REPO !== repository || process.env.GITHUB_REF !== 'refs/heads/main' || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
  throw new Error('Release publication requires the verified repository main commit.');
}
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(packageJson.version ?? '')) throw new Error('Release publication requires a valid package version.');
if (api('git/ref/heads/main').object.sha !== commit) throw new Error('A newer main commit exists; publish its verified build instead.');

const tag = `v${packageJson.version}`;
const directory = resolve('release');
const executable = `Shioaji-Codex-Trader-${packageJson.version}-Windows-x64.exe`;
const names = (await readdir(directory)).filter(name => name === executable || name==='WINDOWS-SIGNATURE.json' || /^(?:README|RELEASE_NOTES)\.md$/.test(name) || /^SYNTHETIC-[\w.-]+\.(?:png|json|csv)$/.test(name)).sort();
const required = [executable, 'README.md', 'RELEASE_NOTES.md', 'SYNTHETIC-demo-backtest.json', 'SYNTHETIC-historical-sample.csv', 'SYNTHETIC-ui-paper-1366.png', 'SYNTHETIC-ui-paper-1600.png', 'SYNTHETIC-ui-paper-1920.png', 'SYNTHETIC-ui-live.png', 'SYNTHETIC-ui-connection.png'];
if (required.some(name => !names.includes(name))) throw new Error('A verified release asset is missing.');
if ((await stat(resolve(directory, executable))).size < 50 * 1024 * 1024) throw new Error('The packaged Windows executable is incomplete.');
const report = JSON.parse(await readFile(resolve(directory, 'SYNTHETIC-demo-backtest.json'), 'utf8'));
if (report.status !== 'COMPLETED' || !report.metrics.filled_orders) throw new Error('The synthetic release demonstration did not pass.');
const digests = new Map();
for (const name of names) digests.set(name, createHash('sha256').update(await readFile(resolve(directory, name))).digest('hex'));
if(!names.includes('WINDOWS-SIGNATURE.json'))throw new Error('Windows signature verification report is missing.');
validateSignatureReport(JSON.parse(await readFile(resolve(directory,'WINDOWS-SIGNATURE.json'),'utf8')),packageJson.version,executable,digests.get(executable));
await writeFile(resolve(directory, 'SHA256SUMS.txt'), names.map(name => `${digests.get(name)}  ${name}`).join('\n') + '\n');
names.push('SHA256SUMS.txt');
digests.set('SHA256SUMS.txt', createHash('sha256').update(await readFile(resolve(directory, 'SHA256SUMS.txt'))).digest('hex'));

const releases = api('releases?per_page=100');
const existing = releases.find(release => release.tag_name === tag);
let tagObject;
try { tagObject = api(`git/ref/tags/${tag}`).object; }
catch (error) { if (!/HTTP 404|Not Found|status.?404/i.test(String(error.stderr ?? error.message))) throw error; }
for (let depth=0;tagObject?.type==='tag'&&depth<4;depth++) tagObject=api(`git/tags/${tagObject.sha}`).object;
const verifyAssets = async release => {
  for (const name of names) {
    const asset = release.assets.find(item => item.name === name);
    if (!asset || asset.size !== (await stat(resolve(directory, name))).size || asset.digest !== `sha256:${digests.get(name)}`) {
      throw new Error(`Release asset verification failed: ${name}`);
    }
  }
};
let resetConfig;
try{resetConfig=JSON.parse(await readFile('.github/release-reset.json','utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const resetPending=resetConfig?.version===packageJson.version&&releases.some(r=>resetConfig.remove_releases.some(old=>old.id===r.id)
  ||r.tag_name===`reset-${tag}-${commit.slice(0,12)}`);
if(resetPending){
  await resetRelease({api,gh,config:resetConfig,commit,tag,tagObject,releases,names,directory,verifyAssets});
}else{
if (tagObject && (tagObject.type !== 'commit' || tagObject.sha !== commit)) {
  throw new Error(`${tag} already points to another commit. Increment the package version for a new release.`);
}
if (existing && !existing.draft) {
  if (!tagObject) throw new Error('The published release has no verifiable Git tag. Create a new version.');
  // Windows builds and screenshot/demo timestamps can differ on a same-commit rerun.
  // Verify the existing immutable release against its own manifest; never replace it.
  verifyPublishedRelease(existing,{gh,repository,names,version:packageJson.version,executable});
  console.log(`Verified existing ${tag}; no published assets changed.`);
} else {
if (existing?.immutable) throw new Error('The release draft is immutable. Create a new version.');
if (!existing) {
  gh('release', 'create', tag, '--target', commit, '--prerelease', '--draft', '--title', `Shioaji Codex Trader ${tag} · Pre-release`, '--notes-file', resolve(directory, 'RELEASE_NOTES.md'));
}
// Each package version gets a separate release. Only an unpublished draft can resume an interrupted upload.
gh('release', 'upload', tag, ...names.map(name => resolve(directory, name)), '--clobber');
// The by-tag endpoint returns published releases; a new draft must be addressed by ID.
const uploaded = api('releases?per_page=100').find(release => release.tag_name === tag);
if (!uploaded) throw new Error('The uploaded release draft could not be found.');
const updated = api(`releases/${uploaded.id}`);
await verifyAssets(updated);
if (!tagObject) api('git/refs', '--method', 'POST', '-f', `ref=refs/tags/${tag}`, '-f', `sha=${commit}`);
gh('release', 'edit', tag, '--draft=false', '--prerelease=true', '--title', `Shioaji Codex Trader ${tag} · Pre-release`, '--notes-file', resolve(directory, 'RELEASE_NOTES.md'));
console.log(gh('release', 'view', tag, '--json', 'url,tagName,assets'));
}
}
