import { readFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { z } from 'zod';

export async function bundledShioajiPath(root: string): Promise<string> {
  try {
    const manifest = z.object({ version: z.literal('1.7.7'), platform: z.literal(process.platform),
      arch: z.literal(process.arch), relative_path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')));
    const binary = await realpath(resolve(root, manifest.relative_path)), parent = await realpath(root);
    const path = relative(parent, binary);
    if (path.startsWith('..') || isAbsolute(path)) throw new Error('Invalid runtime path');
    if (createHash('sha256').update(await readFile(binary)).digest('hex') !== manifest.sha256) throw new Error('Runtime checksum mismatch');
    return binary;
  } catch { throw new Error('無法驗證內建 Shioaji，請重新下載完整的桌面程式'); }
}

export async function brokerOrigin(preferred = 18981): Promise<string> {
  const reserve = (port: number): Promise<number> => new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Invalid port')); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  return 'http://127.0.0.1:' + await reserve(preferred).catch(() => reserve(0));
}
