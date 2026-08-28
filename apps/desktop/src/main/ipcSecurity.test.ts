import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v3';
import {
  createTrustedIpcHandler,
  type IpcAuditRecord,
  type MainWindowLike,
} from './ipcSecurity';
import { ProjectOperationManager } from './projectOperation';

function boundary() {
  const mainFrame = {};
  const webContents = { mainFrame };
  const mainWindow: MainWindowLike = { webContents };
  const audits: IpcAuditRecord[] = [];
  const errors: unknown[] = [];
  return {
    webContents,
    mainFrame,
    mainWindow,
    audits,
    errors,
    options: {
      maxPayloadBytes: 128,
      getMainWindow: () => mainWindow,
      logError: (_channel: string, error: unknown) => errors.push(error),
      audit: (record: IpcAuditRecord) => audits.push(record),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('trusted IPC boundary', () => {
  it.each([
    ['wrong webContents', () => ({ sender: {}, senderFrame: {} })],
    ['subframe', (fixture: ReturnType<typeof boundary>) => ({ sender: fixture.webContents, senderFrame: {} })],
  ])('rejects %s before invoking the handler', async (_name, eventFactory) => {
    const fixture = boundary();
    const handler = vi.fn();
    const wrapped = createTrustedIpcHandler(
      'test:sender',
      (rawArgs) => z.tuple([]).parse(rawArgs),
      handler,
      fixture.options,
    );

    await expect(wrapped(eventFactory(fixture))).rejects.toThrow('IPC request failed.');
    expect(handler).not.toHaveBeenCalled();
    expect(fixture.audits[0]).toMatchObject({ channel: 'test:sender', outcome: 'rejected' });
    expect(fixture.errors[0]).toBeInstanceOf(Error);
  });

  it('rejects an oversized serialized payload before side effects', async () => {
    const fixture = boundary();
    const sideEffect = vi.fn();
    const wrapped = createTrustedIpcHandler(
      'test:oversize',
      (rawArgs) => z.tuple([z.string()]).parse(rawArgs),
      (_event, args) => { sideEffect(args[0]); return true; },
      { ...fixture.options, maxPayloadBytes: 8 },
    );

    await expect(wrapped({ sender: fixture.webContents, senderFrame: fixture.mainFrame }, 'secret-payload'))
      .rejects.toThrow('IPC request failed.');
    expect(sideEffect).not.toHaveBeenCalled();
    expect(fixture.audits[0]).toMatchObject({ channel: 'test:oversize', outcome: 'rejected' });
    expect(fixture.audits[0]!.bytes).toBeGreaterThan(8);
  });

  it('normalizes optional tuple values before the handler', async () => {
    const fixture = boundary();
    const handler = vi.fn((_event, args: [string, number]) => args);
    const wrapped = createTrustedIpcHandler(
      'test:normalize',
      (rawArgs) => z.tuple([
        z.string().trim(),
        z.number().int().min(1).optional().default(20),
      ]).parse(rawArgs) as [string, number],
      handler,
      fixture.options,
    );

    await expect(wrapped({ sender: fixture.webContents, senderFrame: fixture.mainFrame }, ' query ', undefined))
      .resolves.toEqual(['query', 20]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fixture.audits[0]).toMatchObject({ channel: 'test:normalize', outcome: 'success' });
  });

  it('redacts handler diagnostics from the renderer and audit record', async () => {
    const fixture = boundary();
    const wrapped = createTrustedIpcHandler(
      'test:redaction',
      (rawArgs) => z.tuple([z.string()]).parse(rawArgs),
      () => { throw new Error('database secret: renderer-secret'); },
      fixture.options,
    );

    await expect(wrapped({ sender: fixture.webContents, senderFrame: fixture.mainFrame }, 'renderer-secret'))
      .rejects.toThrow('IPC request failed.');
    expect(JSON.stringify(fixture.audits)).not.toContain('renderer-secret');
    expect(Object.keys(fixture.audits[0]!)).toEqual(['channel', 'outcome', 'duration', 'bytes']);
    expect(fixture.audits[0]).toMatchObject({ channel: 'test:redaction', outcome: 'error' });
    expect(String(fixture.errors[0])).toContain('renderer-secret');
  });

  it('routes a trusted operations:cancel invocation to a running operation', async () => {
    const fixture = boundary();
    const progress: string[] = [];
    const manager = new ProjectOperationManager((event) => progress.push(event.phase));
    const operationId = 'ipc-cancel-integration';
    const running = manager.run('export', { operationId }, async () => (
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('work interrupted')), 100))
    ));
    const cancel = createTrustedIpcHandler(
      'operations:cancel',
      (rawArgs) => z.tuple([z.string().min(1)]).parse(rawArgs),
      (_event, [id]) => manager.cancel(id),
      fixture.options,
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(cancel(
      { sender: fixture.webContents, senderFrame: fixture.mainFrame },
      operationId,
    )).resolves.toBe(true);
    await expect(running).rejects.toThrow('cancelled');
    expect(progress).toEqual(['started', 'cancelled']);
    expect(fixture.audits[0]).toMatchObject({ channel: 'operations:cancel', outcome: 'success' });
  });
});
