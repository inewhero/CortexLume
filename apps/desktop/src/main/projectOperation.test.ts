import { describe, expect, it } from 'vitest';
import type { ProjectOperationProgress } from '@cortexlume/contracts';
import { ProjectOperationManager } from './projectOperation';

describe('project operation lifecycle', () => {
  it('cancels a running operation, emits observable progress, and removes state', async () => {
    const progress: ProjectOperationProgress[] = [];
    const manager = new ProjectOperationManager((event) => progress.push(event));
    const operationId = 'cancel-integration';
    const running = manager.run('annotation', { operationId }, async () => (
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('work interrupted')), 100))
    ));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.cancel(operationId)).toBe(true);
    await expect(running).rejects.toThrow('cancelled');
    expect(manager.cancel(operationId)).toBe(false);
    expect(progress.map((event) => event.phase)).toEqual(['started', 'cancelled']);
  });

  it('enforces the overall deadline even when a task itself keeps running', async () => {
    const progress: ProjectOperationProgress[] = [];
    const manager = new ProjectOperationManager((event) => progress.push(event));
    const running = manager.run('export', { operationId: 'deadline-integration', timeoutMs: 10 }, async () => (
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('work timed out')), 100))
    ));
    await expect(running).rejects.toThrow('overall time budget');
    expect(progress.map((event) => event.phase)).toEqual(['started', 'deadline-exceeded']);
  });

  it('does not allow duplicate operation IDs while the first run is active', async () => {
    const manager = new ProjectOperationManager();
    const running = manager.run('export', { operationId: 'duplicate-integration' }, async () => (
      new Promise<void>((resolve) => setTimeout(resolve, 30))
    ));
    expect(() => manager.start('export', { operationId: 'duplicate-integration' })).toThrow('already running');
    await running;
  });
});
