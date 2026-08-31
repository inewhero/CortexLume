import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import packageLimits from './data/cross-process-limits.json';

describe('package-contained runtime data', () => {
  it('matches the repository authority exactly', async () => {
    const authorityPath = path.resolve(import.meta.dirname, '../../../config/cross-process-limits.json');
    const packagePath = path.resolve(import.meta.dirname, 'data/cross-process-limits.json');
    const [authorityBytes, packageBytes] = await Promise.all([readFile(authorityPath), readFile(packagePath)]);
    expect(packageBytes).toEqual(authorityBytes);
    const authority = JSON.parse(authorityBytes.toString('utf8'));
    expect(packageLimits).toEqual(authority);
  });
});
