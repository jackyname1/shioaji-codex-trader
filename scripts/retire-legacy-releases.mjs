import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

// One-time release reset requested for this repository. Git tags remain intact.
const repository = 'jackyname1/shioaji-codex-trader';
const previousRun = 38044838020;
const previousCommit = 'c42b308793fdaf0564802133735d8fb71018a72b';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
if (version !== '0.1.0') {
  console.log('The v0.1.0 release reset does not apply to this version.');
  process.exit(0);
}
if (process.env.GH_REPO !== repository) throw new Error('Release reset repository mismatch');

function api(path, method = 'GET') {
  try {
    const output = execFileSync('gh', ['api', '--method', method, `repos/${repository}/${path}`], {
      encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim() ? JSON.parse(output) : undefined;
  } catch (error) {
    if (method === 'GET' && /\(HTTP 404\)/.test(String(error.stderr))) return undefined;
    throw error;
  }
}

// The merge started an older v0.5.0 publisher. Wait for that exact run so it
// cannot recreate a superseded release after the cleanup finishes.
for (let attempt = 0; ; attempt++) {
  const run = api(`actions/runs/${previousRun}`);
  if (!run || run.head_sha !== previousCommit) throw new Error('Previous workflow identity mismatch');
  if (run.status === 'completed') break;
  if (attempt >= 30) throw new Error('Previous publisher is still active; retry the cleanup after it finishes');
  console.log('Waiting for the previous publisher to finish.');
  await setTimeout(10000);
}

const current = api('releases/tags/v0.1.0');
const assets = current?.assets ?? [];
if (!current || current.draft || !current.prerelease ||
    !assets.some(asset => asset.name === 'Shioaji-Codex-Trader-0.1.0-Windows-x64.exe' && asset.state === 'uploaded' && asset.size > 0) ||
    !assets.some(asset => asset.name === 'SHA256SUMS.txt' && asset.state === 'uploaded')) {
  throw new Error('Published v0.1.0 Windows assets must be available before removing previous releases');
}

const previous = [];
for (const [id, tag] of [[408221462, 'v0.3.0'], [408805031, 'v0.4.0']]) {
  const release = api(`releases/${id}`);
  if (!release) continue;
  if (release.id !== id || release.tag_name !== tag) throw new Error('Previous release identity mismatch');
  previous.push(release);
}
const mergedRelease = api('releases/tags/v0.5.0');
if (mergedRelease) {
  if (mergedRelease.target_commitish !== previousCommit) throw new Error('v0.5.0 belongs to a different commit; cleanup stopped');
  previous.push(mergedRelease);
}
for (const release of previous) {
  api(`releases/${release.id}`, 'DELETE');
  console.log(`Removed superseded release ${release.tag_name}.`);
}
console.log(`v0.1.0 Pre-release is available: ${current.html_url}`);
