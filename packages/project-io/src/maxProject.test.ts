import { describe, expect, it } from 'vitest';
import { CROSS_PROCESS_LIMITS, CortexLumeProjectSchema } from '@cortexlume/contracts';
import { createProjectArchive, readProjectArchive } from './index';
import { maximumVerifiedProject } from './maxProjectFixture';

describe('maximum verified project result budget', () => {
  it('round-trips exactly at the shared boundary with complete verified provenance', () => {
    const project = maximumVerifiedProject();
    expect(project.verifiedResults).toHaveLength(CROSS_PROCESS_LIMITS.projectionResults);
    expect(project.verifiedResults.every((result) => (
      result.status === 'verified' && result.qcFlags.includes('surface_model_verified')
    ))).toBe(true);
    const opened = readProjectArchive(createProjectArchive(project));
    expect(opened.verifiedResults).toHaveLength(CROSS_PROCESS_LIMITS.projectionResults);
    expect(opened.verifiedResults.every((result) => result.status === 'verified')).toBe(true);
  }, 30_000);

  it('rejects one result above the shared boundary at the contract', () => {
    const project = maximumVerifiedProject();
    const oversized = { ...project, verifiedResults: [...project.verifiedResults, project.verifiedResults[0]!] };
    expect(CortexLumeProjectSchema.safeParse(oversized).success).toBe(false);
    expect(() => createProjectArchive(oversized)).toThrow();
  }, 30_000);
});
