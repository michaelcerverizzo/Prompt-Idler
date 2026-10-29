import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join } from 'node:path';

export interface WakeControllerOptions {
  spawnHelper?: () => ChildProcessWithoutNullStreams;
  acknowledgementTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

/** Owns one helper process. Windows combines requests from separate VS Code windows. */
export class WakeController {
  private child: ChildProcessWithoutNullStreams | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private sequence = 0;
  private disposed = false;
  private stopping = false;
  private queue: Promise<void> = Promise.resolve();
  private pending = new Map<number, {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private readonly helperPath: string,
    private readonly onError: (message: string) => void,
    private readonly options: WakeControllerOptions = {},
  ) {}

  setAwake(awake: boolean, keepDisplayOn: boolean): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.disposed) throw new Error('Wake controller is disposed.');
      if (!awake && !this.child) return;
      this.ensureHelper();
      await this.command({ command: 'set', awake, display: awake && keepDisplayOn });
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.queue;
    if (!this.child) return;
    this.stopping = true;
    try {
      // The helper clears the Windows request before acknowledging stop.
      await this.command({ command: 'stop' });
    } catch {
      // Process exit also releases its thread's execution state.
    } finally {
      this.close(new Error('Wake controller stopped.'));
    }
  }

  private ensureHelper(): void {
    if (this.child) return;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.options.spawnHelper?.() ?? spawn(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      this.onError('Could not start the Windows wake helper.');
      throw new Error('Could not start the Windows wake helper.');
    }
    this.child = child;
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      buffered += chunk;
      if (buffered.length > 65536) {
        this.fail('Windows wake helper returned an invalid response.');
        return;
      }
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line) as { id?: number; ok?: boolean };
          const request = response.id === undefined ? undefined : this.pending.get(response.id);
          if (!request) continue;
          if (response.ok !== true) {
            this.fail('Windows rejected the wake request.');
            return;
          }
          clearTimeout(request.timer);
          this.pending.delete(response.id!);
          request.resolve();
        } catch {
          this.fail('Windows wake helper returned an invalid response.');
          return;
        }
      }
    });
    // Drain stderr, but do not expose command output or environment details.
    child.stderr.resume();
    child.stdin.on('error', () => {
      if (this.child === child) this.fail('Lost connection to the Windows wake helper.');
    });
    child.on('error', () => {
      if (this.child === child) this.fail('Could not start the Windows wake helper.');
    });
    child.on('exit', () => {
      if (this.child === child) this.fail('Windows wake helper exited.');
    });
    this.heartbeat = setInterval(() => {
      if (this.stopping || !this.child) return;
      void this.command({ command: 'ping' }).catch(() => undefined);
    }, this.options.heartbeatIntervalMs ?? 3000);
    this.heartbeat.unref();
  }

  private command(payload: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('Windows wake helper is unavailable.'));
    const id = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail('Windows wake helper did not respond.');
      }, this.options.acknowledgementTimeoutMs ?? 10000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
        if (error && this.child === child) this.fail('Lost connection to the Windows wake helper.');
      });
    });
  }

  private fail(message: string): void {
    this.close(new Error(message));
    if (!this.stopping) this.onError(message);
  }

  private close(error: Error): void {
    const child = this.child;
    this.child = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    child?.stdin.end();
    child?.kill();
  }
}
