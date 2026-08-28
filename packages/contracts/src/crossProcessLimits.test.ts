import { describe, expect, it } from 'vitest';
import sharedCrossProcessLimits from '../../../config/cross-process-limits.json';
import { CROSS_PROCESS_LIMITS } from './index';

describe('cross-process limit contract', () => {
  it('uses every value from the canonical shared asset', () => {
    expect(CROSS_PROCESS_LIMITS).toEqual(sharedCrossProcessLimits);
  });
});
