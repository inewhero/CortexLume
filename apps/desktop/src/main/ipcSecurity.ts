/**
 * Renderer IPC boundary helpers kept independent of Electron so the security
 * policy can be tested with small in-memory event/window doubles.
 */

export interface IpcInvokeEventLike {
  sender: unknown;
  senderFrame: unknown;
}

export interface MainWindowLike {
  webContents: {
    mainFrame: unknown;
  };
}

export interface IpcAuditRecord {
  channel: string;
  outcome: 'success' | 'rejected' | 'error';
  duration: number;
  bytes: number;
}

export interface TrustedIpcHandlerOptions {
  maxPayloadBytes: number;
  getMainWindow: () => MainWindowLike | null;
  logError: (channel: string, error: unknown) => void;
  audit: (record: IpcAuditRecord) => void;
  rendererError?: string;
}

export type IpcArgumentParser<TArgs> = (rawArgs: unknown[]) => TArgs;
export type TrustedIpcHandler<TArgs, TResult> = (
  event: IpcInvokeEventLike,
  args: TArgs,
) => TResult | Promise<TResult>;

/**
 * Wrap an IPC handler with the common sender, byte-budget, parse, error and
 * audit policy.  The parser is normally a Zod tuple schema's ``parse`` method.
 */
export function createTrustedIpcHandler<TArgs, TResult>(
  channel: string,
  parseArgs: IpcArgumentParser<TArgs>,
  handler: TrustedIpcHandler<TArgs, TResult>,
  options: TrustedIpcHandlerOptions,
): (event: IpcInvokeEventLike, ...rawArgs: unknown[]) => Promise<TResult> {
  if (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 0) {
    throw new Error(`Invalid IPC payload limit for ${channel}`);
  }
  const rendererError = options.rendererError ?? 'IPC request failed.';

  return async (event, ...rawArgs) => {
    const startedAt = Date.now();
    let bytes = 0;
    let outcome: IpcAuditRecord['outcome'] = 'success';
    let handlerStarted = false;
    try {
      const mainWindow = options.getMainWindow();
      if (!mainWindow
        || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) {
        throw new Error('Rejected IPC request from an untrusted renderer.');
      }

      let serialized: string;
      try {
        serialized = JSON.stringify(rawArgs);
      } catch (error) {
        throw new Error('IPC arguments are not serializable.', { cause: error });
      }
      bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > options.maxPayloadBytes) {
        throw new Error(`IPC payload exceeds its ${options.maxPayloadBytes}-byte limit.`);
      }

      const args = parseArgs(rawArgs);
      handlerStarted = true;
      return await handler(event, args);
    } catch (error) {
      if (!handlerStarted) outcome = 'rejected';
      else outcome = 'error';
      options.logError(channel, error);
      throw new Error(rendererError);
    } finally {
      options.audit({
        channel,
        outcome,
        duration: Math.max(0, Date.now() - startedAt),
        bytes,
      });
    }
  };
}
