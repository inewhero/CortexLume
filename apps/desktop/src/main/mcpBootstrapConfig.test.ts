import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configuredRoots,
  MCP_ROOT_CONFIGURATION_ERROR,
  requireConfiguredRoots,
} from './mcpBootstrapConfig';

describe('MCP bootstrap root configuration', () => {
  it('combines explicit roots and environment roots while ignoring empty values', () => {
    const first = path.join(os.tmpdir(), 'cortexlume-first-root');
    const second = path.join(os.tmpdir(), 'cortexlume-second-root');
    const roots = configuredRoots(
      ['node', '--mcp-root=', `--mcp-root=${first}`],
      { CORTEXLUME_MCP_ROOTS: `${second}${path.delimiter}` },
    );
    expect(roots).toEqual([path.resolve(first), path.resolve(second)]);
  });

  it('fails closed when no root was configured', () => {
    expect(() => requireConfiguredRoots(['node'], {})).toThrow(MCP_ROOT_CONFIGURATION_ERROR);
  });
});
