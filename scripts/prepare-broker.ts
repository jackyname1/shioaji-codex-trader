import { readFile, writeFile, mkdir, mkdtemp, rm, readdir, cp, chmod } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Download during development/build only; the installed app needs no external runtime.
const lock = JSON.parse(await readFile(new URL('./shioaji-runtime.lock.json', import.meta.url), 'utf8')) as {
  version: string; repository: string; assets: Record<string, { name: string; sha256: string }>;
};
const option = (name: string, fallback: string): string => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const platform = option('platform', process.platform), arch = option('arch', process.arch);
const asset = lock.assets[`${platform}-${arch}`];
if (!asset) throw new Error(`No bundled Shioaji runtime for ${platform}-${arch}`);
const root = resolve('resources/shioaji'), executable = platform === 'win32' ? 'shioaji.exe' : 'shioaji';
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
try {
  const stored = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
  if (stored.version === lock.version && stored.platform === platform && stored.arch === arch && stored.archive_sha256 === asset.sha256
      && hash(await readFile(join(root, stored.relative_path))) === stored.sha256) {
    console.log(`Bundled Shioaji ${lock.version} is already verified.`); process.exit(0);
  }
} catch { /* First build or a damaged download. */ }
const temporary = await mkdtemp(join(tmpdir(), 'trader-broker-'));
try {
  const url = `https://github.com/${lock.repository}/releases/download/v${lock.version}/${asset.name}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Official runtime download returned ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (hash(bytes) !== asset.sha256) throw new Error('Official Shioaji archive SHA-256 does not match the pinned release');
  const archive = join(temporary, asset.name), extracted = join(temporary, 'extracted');
  await writeFile(archive, bytes); await mkdir(extracted);
  if (platform === 'win32') await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Expand-Archive -LiteralPath $env:TRADER_BROKER_ARCHIVE -DestinationPath $env:TRADER_BROKER_EXTRACTED'], {
    env: { ...process.env, TRADER_BROKER_ARCHIVE: archive, TRADER_BROKER_EXTRACTED: extracted }, timeout: 60000, windowsHide: true,
  });
  else await promisify(execFile)('tar', ['-xzf', archive, '-C', extracted], { timeout: 60000 });
  async function binaries(path: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) out.push(...await binaries(next));
      else if (entry.isFile() && entry.name === executable) out.push(next);
    }
    return out;
  }
  const found = await binaries(extracted);
  if (found.length !== 1) throw new Error('Official archive must contain exactly one Shioaji executable');
  await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
  await cp(extracted, join(root, 'runtime'), { recursive: true });
  const relativePath = join('runtime', relative(extracted, found[0]!));
  if (platform !== 'win32') await chmod(join(root, relativePath), 0o755);
  await writeFile(join(root, 'runtime.json'), JSON.stringify({ version: lock.version, platform, arch,
    relative_path: relativePath, sha256: hash(await readFile(found[0]!)), archive_sha256: asset.sha256, source: url }, null, 2));
  console.log(`Bundled and SHA-256 verified official Shioaji ${lock.version} (${platform}-${arch}).`);
} finally { await rm(temporary, { recursive: true, force: true }); }
