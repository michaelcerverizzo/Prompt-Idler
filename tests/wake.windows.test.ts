import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test, type TestContext } from 'node:test';

const windowsOnly = { skip: process.platform !== 'win32', timeout: 25000 };

/** Actual Windows PowerShell + Win32 integration. Does not require elevation. */
function startHelper(context: TestContext) {
  const child = spawn(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(__dirname, '../scripts/wake-helper.ps1')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let sequence = 0;
  let buffer = '';
  let failure: Error | undefined;
  const pending = new Map<number, {
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const fail = (error: Error) => {
    failure = error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  // Only inspect the JSON protocol. PowerShell stderr can include host details.
  child.stderr.resume();
  child.stdin.on('error', () => fail(new Error('Windows helper input pipe failed.')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line) as { id: number; ok: boolean };
        const request = pending.get(response.id);
        assert.ok(request, 'Received an unexpected helper response.');
        assert.equal(response.ok, true, 'Win32 rejected the requested execution state.');
        clearTimeout(request.timer);
        pending.delete(response.id);
        request.resolve();
      } catch {
        fail(new Error('Windows helper returned an invalid or negative acknowledgement.'));
      }
    }
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.on('error', () => {
      fail(new Error('Windows PowerShell helper could not start.'));
      resolveExit({ code: null, signal: null });
    });
    child.on('close', (code, signal) => {
      if (pending.size) fail(new Error('Windows helper exited before acknowledging the request.'));
      resolveExit({ code, signal });
    });
  });
  context.after(() => {
    child.stdin.end();
    child.kill();
    fail(new Error('Test finished.'));
  });
  return {
    child,
    exit,
    send(payload: Record<string, unknown>): Promise<void> {
      if (failure) return Promise.reject(failure);
      const id = ++sequence;
      return new Promise<void>((resolveAck, reject) => {
        const timer = setTimeout(() => fail(new Error('Windows helper acknowledgement timed out.')), 8000);
        pending.set(id, { resolve: resolveAck, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
      });
    },
  };
}

test('Windows helper acknowledges system wake, display changes, release, and stop', windowsOnly, async (context) => {
  const helper = startHelper(context);
  await helper.send({ command: 'set', awake: true, display: false });
  await helper.send({ command: 'ping' });
  await helper.send({ command: 'set', awake: true, display: true });
  await helper.send({ command: 'set', awake: true, display: false });
  await helper.send({ command: 'set', awake: false, display: false });
  await helper.send({ command: 'stop' });
  assert.deepEqual(await helper.exit, { code: 0, signal: null });
});

test('Windows helper exits promptly when its input pipe closes', windowsOnly, async (context) => {
  const helper = startHelper(context);
  await helper.send({ command: 'set', awake: true, display: false });
  const closedAt = performance.now();
  helper.child.stdin.end();
  assert.deepEqual(await helper.exit, { code: 0, signal: null });
  assert.ok(performance.now() - closedAt < 5000, 'EOF should release the helper without waiting for its watchdog.');
});

test('Windows watchdog exits after heartbeat loss even with stdin still open', windowsOnly, async (context) => {
  const helper = startHelper(context);
  await helper.send({ command: 'set', awake: true, display: true });
  const acknowledgedAt = performance.now();
  // Deliberately keep stdin open and send no further requests or heartbeats.
  assert.equal(helper.child.stdin.writableEnded, false);
  assert.deepEqual(await helper.exit, { code: 0, signal: null });
  const elapsed = performance.now() - acknowledgedAt;
  assert.ok(elapsed >= 14000, 'The watchdog should allow its 15-second heartbeat window.');
  assert.ok(elapsed < 20000, 'The watchdog must not block indefinitely on stdin.');
});
