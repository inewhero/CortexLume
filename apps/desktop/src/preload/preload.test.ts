import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exposeInMainWorld, invoke, on, removeListener } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

describe('desktop preload export contract', () => {
  beforeEach(() => {
    exposeInMainWorld.mockClear();
    invoke.mockReset();
  });

  it('maps DesktopApi.export.atlasViewer to the dedicated IPC channel', async () => {
    vi.resetModules();
    await import('./preload');
    expect(exposeInMainWorld).toHaveBeenCalledOnce();
    const api = exposeInMainWorld.mock.calls[0]![1] as {
      export: { atlasViewer(project: unknown, options: unknown): Promise<unknown> };
    };
    const project = { id: 'project' };
    const options = { operationId: 'atlasviewer-test' };
    invoke.mockResolvedValue({ directory: 'output', files: ['probe.SD'], warnings: [] });
    await api.export.atlasViewer(project, options);
    expect(invoke).toHaveBeenCalledWith('export:atlasviewer', project, options);
  });

  it('maps saved project path reveal to the dedicated IPC channel', async () => {
    vi.resetModules();
    await import('./preload');
    const api = exposeInMainWorld.mock.calls[0]![1] as {
      project: { reveal(projectPath: string): Promise<unknown> };
    };
    invoke.mockResolvedValue(true);
    await api.project.reveal('E:\\study.cortexlume');
    expect(invoke).toHaveBeenCalledWith('project:reveal', 'E:\\study.cortexlume');
  });

  it('maps transparent scientific screenshot saves to the dedicated IPC channel', async () => {
    vi.resetModules();
    await import('./preload');
    const api = exposeInMainWorld.mock.calls[0]![1] as {
      screenshot: { save(projectPath: string, png: string, width: number, height: number): Promise<unknown> };
    };
    invoke.mockResolvedValue({ fileName: 'capture.png' });
    await api.screenshot.save('E:\\study.cortexlume', 'iVBORw==', 1200, 800);
    expect(invoke).toHaveBeenCalledWith('screenshot:save', 'E:\\study.cortexlume', 'iVBORw==', 1200, 800);
  });
});
