import { describe, expect, it } from 'vitest';
import { LayoutDefinitionSchema, ProjectionSettingsSchema } from './index';

describe('LayoutDefinitionSchema', () => {
  it('rejects non-UUID optode identifiers', () => {
    const parsed = LayoutDefinitionSchema.safeParse({
      id: crypto.randomUUID(),
      version: 1,
      name: 'test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gridSpacingMm: 5,
      optodes: [{ id: 'S1', label: 'S1', type: 'source', uvMm: [0, 0] }],
      pairs: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('migrates legacy projection modes to scalp and cortex', () => {
    expect(ProjectionSettingsSchema.parse({ mode: 'surface' }).mode).toBe('scalp');
    expect(ProjectionSettingsSchema.parse({ mode: 'anatomical_depth' }).mode).toBe('cortex');
    expect(ProjectionSettingsSchema.parse({ mode: 'scalp' }).optodeRadiusMm).toBe(3.6);
  });
});
