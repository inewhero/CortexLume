import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';

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

export class ScienceClient {
  private static readonly MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
  private child: ChildProcessWithoutNullStreams | null = null;
  private port: number | null = null;
  private token = '';
  private ready: Promise<void> | null = null;
  private generation = 0;
  private cancelStartup: (() => void) | null = null;

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

  stop(): void {
    this.generation += 1;
    const child = this.child;
    const cancelStartup = this.cancelStartup;
    this.child = null;
    this.port = null;
    this.ready = null;
    this.cancelStartup = null;
    cancelStartup?.();
    child?.kill();
  }

  async request<T>(pathname: string, payload?: unknown): Promise<T> {
    await this.start();
    if (!this.port) throw new Error('Science sidecar did not provide a port');
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise<T>((resolve, reject) => {
      const request = httpRequest({
        hostname: '127.0.0.1', port: this.port!, path: pathname,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
        },
        timeout: 30_000,
      }, (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.once('error', reject);
        const declaredLength = Number(response.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > ScienceClient.MAX_RESPONSE_BYTES) {
          response.destroy(new Error('Science service response exceeded the 16 MB limit'));
          return;
        }
        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > ScienceClient.MAX_RESPONSE_BYTES) {
            response.destroy(new Error('Science service response exceeded the 16 MB limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) return reject(new Error(`Science service ${status}: ${text}`));
          try { resolve(JSON.parse(text) as T); } catch (error) { reject(error); }
        });
      });
      request.once('timeout', () => request.destroy(new Error('Science service request timed out')));
      request.once('error', reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
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
