import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';

export interface ScienceCommand {
  command: string;
  args: string[];
  cwd: string;
  assetRoot: string;
}

export class ScienceClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private port: number | null = null;
  private token = '';
  private ready: Promise<void> | null = null;

  constructor(
    private readonly configuration: () => ScienceCommand,
    private readonly log: (message: string) => void = () => undefined,
    private readonly startupTimeoutMs = 20_000,
  ) {}

  start(): Promise<void> {
    if (this.ready) return this.ready;
    const ready = this.startProcess();
    this.ready = ready;
    void ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.port = null;
    this.ready = null;
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
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
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

  private async startProcess(): Promise<void> {
    this.token = randomBytes(32).toString('hex');
    const configuration = this.configuration();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(configuration.command, configuration.args, {
        cwd: configuration.cwd,
        windowsHide: true,
        env: { ...process.env, CORTEXLUME_TOKEN: this.token, CORTEXLUME_ASSET_DIR: configuration.assetRoot },
      });
      this.child = child;
      let buffer = '';
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error('Science sidecar startup timed out'));
      }, this.startupTimeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
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
      child.once('error', (error) => finish(error));
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = null; this.port = null; this.ready = null;
        finish(new Error(`Science sidecar exited before becoming ready (${signal ?? code ?? 'unknown'}).`));
      });
    });
  }
}
