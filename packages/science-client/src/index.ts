import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CROSS_PROCESS_LIMITS } from '@cortexlume/contracts';

/**
 * NIfTI files are staged here before a request is sent to the local science
 * sidecar.  Keeping one deterministic, private directory lets the Python
 * service enforce the same realpath containment rule for every caller.
 */
export const NIFTI_TEMP_DIRECTORY = path.join(os.tmpdir(), 'cortexlume-nifti');
export const NIFTI_MAX_FILE_BYTES = 128 * 1024 * 1024;

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('NIfTI staging path escaped its temporary directory');
  }
}

/**
 * Copy a bounded NIfTI source into the sidecar's private temporary directory,
 * run a request against the staged path, and always remove the staged file.
 * The copy is performed by the filesystem rather than read into a Node
 * Buffer, so the request body remains a small JSON path reference.
 */
export async function withStagedNiftiFile<T>(
  sourcePath: string,
  operation: (stagedPath: string, sourceFileName: string) => Promise<T>,
): Promise<T> {
  const configuredRoot = path.resolve(NIFTI_TEMP_DIRECTORY);
  await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  const configuredRootStats = await lstat(configuredRoot);
  if (!configuredRootStats.isDirectory() || configuredRootStats.isSymbolicLink()) {
    throw new Error('NIfTI staging directory must be a real directory');
  }
  const root = await realpath(configuredRoot);

  const source = await realpath(sourcePath);
  const sourceFileName = path.basename(source);
  if (!/\.nii(?:\.gz)?$/i.test(sourceFileName)) {
    throw new Error('NIfTI target path must end in .nii or .nii.gz.');
  }
  const sourceStats = await stat(source);
  if (!sourceStats.isFile()) throw new Error('NIfTI target is not a regular file.');
  if (sourceStats.size > NIFTI_MAX_FILE_BYTES) {
    throw new Error('NIfTI target exceeds the 128 MB import limit.');
  }

  const extension = sourceFileName.toLowerCase().endsWith('.nii.gz') ? '.nii.gz' : '.nii';
  const stagedPath = path.join(root, `${randomUUID()}${extension}`);
  assertContained(root, stagedPath);
  try {
    await copyFile(source, stagedPath, fsConstants.COPYFILE_EXCL);
    const stagedRealpath = await realpath(stagedPath);
    if (!samePath(stagedRealpath, stagedPath)) {
      throw new Error('NIfTI staging file must not be a symbolic link');
    }
    const stagedStats = await stat(stagedRealpath);
    if (!stagedStats.isFile()) throw new Error('NIfTI staging file is not regular.');
    if (stagedStats.size > NIFTI_MAX_FILE_BYTES) {
      throw new Error('NIfTI target exceeds the 128 MB import limit.');
    }
    return await operation(stagedRealpath, sourceFileName);
  } finally {
    await rm(stagedPath, { force: true });
  }
}

export interface ScienceCommand {
  command: string;
  args: string[];
  cwd: string;
  assetRoot: string;
}

export interface ScienceRequestOptions {
  /** Abort the HTTP request when a project operation is cancelled. */
  signal?: AbortSignal | undefined;
  /** Per-request timeout; callers may pass the remaining operation budget. */
  timeoutMs?: number | undefined;
}

type ReleaseRequestLease = () => void;

interface QueuedRequestLease {
  resolve: (release: ReleaseRequestLease) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal | undefined;
  onAbort?: (() => void) | undefined;
}

export class ScienceClient {
  static readonly MAX_REQUEST_BYTES = CROSS_PROCESS_LIMITS.scienceRequestBytes;
  static readonly MAX_RESPONSE_BYTES = CROSS_PROCESS_LIMITS.scienceResponseBytes;
  private child: ChildProcessWithoutNullStreams | null = null;
  private port: number | null = null;
  private token = '';
  private ready: Promise<void> | null = null;
  private generation = 0;
  private cancelStartup: (() => void) | null = null;
  /** Requests retain a shared lease until their HTTP response settles. */
  private activeRequests = 0;
  /** A planning section owns this lock while the sidecar is stopped. */
  private exclusiveActive = false;
  private stopRequested = false;
  private readonly queuedRequests: QueuedRequestLease[] = [];
  private readonly queuedExclusives: Array<() => Promise<void>> = [];

  constructor(
    private readonly configuration: () => ScienceCommand,
    private readonly log: (message: string) => void = () => undefined,
    private readonly startupTimeoutMs = 20_000,
  ) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const generation = ++this.generation;
    const ready = this.startProcess(generation);
    this.ready = ready;
    void ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  }

  /**
   * Run a section that must not overlap a sidecar request.  New requests are
   * queued while the section is waiting for active requests to drain and while
   * the callback is running.  This is intentionally part of ScienceClient so
   * callers that share a client cannot accidentally stop the sidecar beneath a
   * request started by another caller.
   */
  withExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queuedExclusives.push(async () => {
        try {
          resolve(await operation());
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.exclusiveActive = false;
          this.pumpLifecycle();
        }
      });
      this.pumpLifecycle();
    });
  }

  stop(): void {
    // Do not invalidate startup or kill the process while an HTTP request (or
    // its startup handshake) still owns a lease.  The stop is performed as
    // soon as the last lease is released, before a queued request is granted.
    this.stopRequested = true;
    this.pumpLifecycle();
  }

  private performStop(): void {
    this.generation += 1;
    const child = this.child;
    const cancelStartup = this.cancelStartup;
    this.child = null;
    this.port = null;
    this.ready = null;
    this.cancelStartup = null;
    cancelStartup?.();
    child?.kill();
    this.stopRequested = false;
    this.pumpLifecycle();
  }

  private acquireRequestLease(signal?: AbortSignal): Promise<ReleaseRequestLease> {
    if (signal?.aborted) return Promise.reject(new Error('Science service request cancelled'));
    return new Promise<ReleaseRequestLease>((resolve, reject) => {
      const queued: QueuedRequestLease = {
        resolve: (release) => {
          if (queued.signal && queued.onAbort) queued.signal.removeEventListener('abort', queued.onAbort);
          resolve(release);
        },
        reject: (error) => {
          if (queued.signal && queued.onAbort) queued.signal.removeEventListener('abort', queued.onAbort);
          reject(error);
        },
        signal,
      };
      if (signal) {
        queued.onAbort = () => {
          const index = this.queuedRequests.indexOf(queued);
          if (index < 0) return;
          this.queuedRequests.splice(index, 1);
          queued.reject(new Error('Science service request cancelled'));
          this.pumpLifecycle();
        };
        signal.addEventListener('abort', queued.onAbort, { once: true });
      }
      this.queuedRequests.push(queued);
      this.pumpLifecycle();
    });
  }

  private grantRequestLease(queued: QueuedRequestLease): void {
    this.activeRequests += 1;
    let released = false;
    queued.resolve(() => {
      if (released) return;
      released = true;
      this.activeRequests -= 1;
      this.pumpLifecycle();
    });
  }

  private pumpLifecycle(): void {
    if (this.exclusiveActive || this.activeRequests > 0) return;
    if (this.stopRequested) {
      this.performStop();
      return;
    }
    const exclusive = this.queuedExclusives.shift();
    if (exclusive) {
      this.exclusiveActive = true;
      void exclusive();
      return;
    }
    // No exclusive section is pending, so all waiting requests may share the
    // sidecar.  If an exclusive arrives later it waits for these leases.
    while (this.queuedRequests.length > 0) {
      const queued = this.queuedRequests.shift();
      if (queued) this.grantRequestLease(queued);
    }
  }

  /**
   * Wait for the sidecar handshake without allowing startup to outlive a
   * cancelled request.  ``start`` remains independently usable by callers
   * that want to manage the sidecar lifecycle themselves; request callers
   * get an abort race and ask the lease-aware stop path to clean up once any
   * other in-flight requests have drained.
   */
  private waitForStart(signal?: AbortSignal): Promise<void> {
    const startup = this.start();
    if (!signal) return startup;
    if (signal.aborted) {
      this.stop();
      return Promise.reject(new Error('Science service request cancelled'));
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => {
        this.stop();
        finish(new Error('Science service request cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      startup.then(
        () => finish(),
        (error) => finish(error instanceof Error ? error : new Error(String(error))),
      );
      if (signal.aborted) onAbort();
    });
  }

  async request<T>(pathname: string, payload?: unknown, options: ScienceRequestOptions = {}): Promise<T> {
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const bodyBytes = body === undefined ? 0 : Buffer.byteLength(body, 'utf8');
    if (bodyBytes > ScienceClient.MAX_REQUEST_BYTES) {
      throw new Error(
        `Science service request exceeds the ${ScienceClient.MAX_REQUEST_BYTES}-byte limit (${bodyBytes} bytes)`,
      );
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Science service request timeout must be positive');
    }
    if (options.signal?.aborted) throw new Error('Science service request cancelled');
    const release = await this.acquireRequestLease(options.signal);
    try {
      await this.waitForStart(options.signal);
      // Startup is asynchronous and can outlive the caller's operation.  The
      // signal may have been aborted while the sidecar was booting; in that
      // case do not open an HTTP connection or trigger any request-side effect.
      if (options.signal?.aborted) throw new Error('Science service request cancelled');
      if (!this.port) throw new Error('Science sidecar did not provide a port');
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: T) => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(value as T);
        };
        const onAbort = () => {
          const error = new Error('Science service request cancelled');
          request.destroy(error);
          // Node normally emits the same error asynchronously, but settling
          // here also makes cancellation deterministic if the transport has
          // already detached its error listeners during teardown.
          finish(error);
        };
        const request = httpRequest({
          hostname: '127.0.0.1', port: this.port!, path: pathname,
          method: body === undefined ? 'GET' : 'POST',
          // Planning is deliberately synchronous and can block the MCP event
          // loop past uvicorn's keep-alive timeout. Do not let Node reuse a
          // server-closed idle socket for the next science request.
          agent: false,
          headers: {
            Authorization: `Bearer ${this.token}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
          },
          timeout: timeoutMs,
        }, (response) => {
          const chunks: Buffer[] = [];
          let receivedBytes = 0;
          response.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
          const declaredLength = Number(response.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > ScienceClient.MAX_RESPONSE_BYTES) {
            response.destroy(new Error(
              `Science service response exceeded the 16 MB limit (${declaredLength} > ${ScienceClient.MAX_RESPONSE_BYTES} bytes)`,
            ));
            return;
          }
          response.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.byteLength;
            if (receivedBytes > ScienceClient.MAX_RESPONSE_BYTES) {
              response.destroy(new Error(
                `Science service response exceeded the 16 MB limit (${receivedBytes} > ${ScienceClient.MAX_RESPONSE_BYTES} bytes)`,
              ));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const status = response.statusCode ?? 500;
            if (status < 200 || status >= 300) return finish(new Error(`Science service ${status}: ${text}`));
            try { finish(undefined, JSON.parse(text) as T); } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          });
        });
        request.once('timeout', () => request.destroy(new Error('Science service request timed out')));
        request.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
        options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        if (body !== undefined) request.write(body);
        request.end();
      });
    } finally {
      release();
    }
  }

  private async startProcess(generation: number): Promise<void> {
    this.token = randomBytes(32).toString('hex');
    const configuration = this.configuration();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(configuration.command, configuration.args, {
        cwd: configuration.cwd,
        windowsHide: true,
        env: {
          ...process.env,
          CORTEXLUME_TOKEN: this.token,
          CORTEXLUME_ASSET_DIR: configuration.assetRoot,
          CORTEXLUME_NIFTI_TEMP_DIR: NIFTI_TEMP_DIRECTORY,
        },
      });
      this.child = child;
      let buffer = '';
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.cancelStartup === cancel) this.cancelStartup = null;
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => {
        if (this.child === child) {
          this.child = null;
          this.port = null;
        }
        finish(new Error('Science sidecar startup cancelled'));
      };
      this.cancelStartup = cancel;
      timeout = setTimeout(() => {
        if (this.generation !== generation || this.child !== child) return;
        child.kill();
        finish(new Error('Science sidecar startup timed out'));
      }, this.startupTimeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.generation !== generation || this.child !== child) return;
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('CORTEXLUME_READY ')) continue;
          try {
            const event = JSON.parse(line.slice('CORTEXLUME_READY '.length)) as { port?: unknown };
            if (!Number.isInteger(event.port) || Number(event.port) < 1 || Number(event.port) > 65_535) {
              throw new Error('Science sidecar reported an invalid port');
            }
            this.port = Number(event.port);
            finish();
          } catch (error) {
            child.kill();
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      child.stderr.on('data', (chunk: Buffer) => this.log(`[science] ${chunk.toString('utf8').trimEnd()}`));
      child.once('error', (error) => {
        if (this.generation !== generation || this.child !== child) return;
        this.child = null;
        this.port = null;
        finish(error);
      });
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null; this.port = null; this.ready = null;
        finish(new Error(`Science sidecar exited before becoming ready (${signal ?? code ?? 'unknown'}).`));
      });
    });
  }
}
