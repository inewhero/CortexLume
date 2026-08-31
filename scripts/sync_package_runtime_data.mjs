import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await mkdir(path.join(root, 'packages/contracts/src/data'), { recursive: true });
await copyFile(
  path.join(root, 'config/cross-process-limits.json'),
  path.join(root, 'packages/contracts/src/data/cross-process-limits.json'),
);
