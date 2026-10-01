import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWindowIcon } from './windowIcon';

describe('window icons', () => {
  it('uses a native PNG outside ASAR in packaged Linux', () => {
    expect(resolveWindowIcon('linux', true, '/opt/Cortex Lume/resources/app.asar', '/opt/Cortex Lume/resources'))
      .toEqual({ icon: path.join('/opt/Cortex Lume/resources', 'icon.png') });
  });
  it('keeps development icons for every platform', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      expect(resolveWindowIcon(platform, false, '/work/desktop', '/electron/resources'))
        .toEqual({ icon: path.join('/work/desktop', 'assets', 'icon.png') });
    }
  });
  it('preserves packaged Windows and macOS native icon handling', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      expect(resolveWindowIcon(platform, true, '/app', '/resources')).toEqual({});
    }
  });
});
