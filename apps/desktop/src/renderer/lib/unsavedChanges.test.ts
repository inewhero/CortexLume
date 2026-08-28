// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectStore } from '../store/projectStore';
import { confirmProjectTransition } from './unsavedChanges';

describe('unsaved project transitions', () => {
  const confirmUnsavedChanges = vi.fn();
  const save = vi.fn();

  beforeEach(() => {
    useProjectStore.getState().newProject();
    confirmUnsavedChanges.mockReset();
    save.mockReset();
    Object.defineProperty(window, 'cortexlume', {
      configurable: true,
      value: { project: { confirmUnsavedChanges, save } },
    });
  });

  it('does not prompt for a clean project', async () => {
    await expect(confirmProjectTransition()).resolves.toBe(true);
    expect(confirmUnsavedChanges).not.toHaveBeenCalled();
  });

  it('honors cancel and discard without saving', async () => {
    useProjectStore.getState().setProjectName('dirty');
    confirmUnsavedChanges.mockResolvedValueOnce('cancel');
    await expect(confirmProjectTransition()).resolves.toBe(false);
    confirmUnsavedChanges.mockResolvedValueOnce('discard');
    await expect(confirmProjectTransition()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps edits made during save dirty and blocks the pending transition', async () => {
    useProjectStore.getState().setProjectName('saved name');
    confirmUnsavedChanges.mockResolvedValue('save');
    save.mockImplementation(async () => {
      useProjectStore.getState().setProjectName('edited during save');
      return { path: 'C:\\saved.cortexlume' };
    });
    await expect(confirmProjectTransition()).resolves.toBe(false);
    expect(useProjectStore.getState().isProjectDirty()).toBe(true);
    expect(useProjectStore.getState().projectPath).toBe('C:\\saved.cortexlume');
  });

  it('allows only one concurrent transition to prompt and save', async () => {
    useProjectStore.getState().setProjectName('dirty');
    let resolveChoice!: (choice: 'save') => void;
    confirmUnsavedChanges.mockImplementation(() => new Promise((resolve) => { resolveChoice = resolve; }));
    save.mockResolvedValue({ path: 'C:\\saved.cortexlume' });

    const first = confirmProjectTransition();
    await Promise.resolve();
    const second = confirmProjectTransition();
    await expect(second).resolves.toBe(false);
    resolveChoice('save');
    await expect(first).resolves.toBe(true);
    expect(confirmUnsavedChanges).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('releases the transition gate after a failed save', async () => {
    useProjectStore.getState().setProjectName('dirty');
    confirmUnsavedChanges.mockResolvedValue('save');
    save.mockRejectedValueOnce(new Error('disk failure'));
    await expect(confirmProjectTransition()).rejects.toThrow('disk failure');

    save.mockResolvedValueOnce({ path: 'C:\\saved.cortexlume' });
    await expect(confirmProjectTransition()).resolves.toBe(true);
    expect(confirmUnsavedChanges).toHaveBeenCalledTimes(2);
  });
});
