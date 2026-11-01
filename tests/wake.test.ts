import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { test } from 'node:test';
import { WakeController } from '../src/wake';

function helper(acknowledge = true) {
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  const requests: Array<Record<string, unknown>> = [];
  let killed = false;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
      requests.push(request);
      if (acknowledge) queueMicrotask(() => stdout.write(`${JSON.stringify({ id: request.id, ok: true })}\n`));
      callback();
    },
  });
  Object.assign(process, {
    stdin, stdout, stderr,
    kill: () => { killed = true; queueMicrotask(() => process.emit('exit', 0)); return true; },
  });
  return { process, requests, get killed() { return killed; } };
}

test('does not spawn for initial idle; acknowledges wake and display changes, then clears on disposal', async () => {
  const fake = helper();
  let spawned = 0;
  const errors: string[] = [];
  const controller = new WakeController('unused', (error) => errors.push(error), {
    spawnHelper: () => { spawned++; return fake.process; },
  });
  await controller.setAwake(false, false);
  assert.equal(spawned, 0);
  await controller.setAwake(true, false);
  await controller.setAwake(true, true);
  await controller.setAwake(false, true);
  await controller.dispose();
  assert.equal(spawned, 1);
  assert.deepEqual(fake.requests.map(({ id: _id, ...rest }) => rest), [
    { command: 'set', awake: true, display: false },
    { command: 'set', awake: true, display: true },
    { command: 'set', awake: false, display: false },
    { command: 'stop' },
  ]);
  assert.equal(fake.killed, true);
  assert.deepEqual(errors, []);
  await assert.rejects(controller.setAwake(true, false), /disposed/);
});

test('waits for acknowledgement rather than claiming wakefulness immediately', async () => {
  const fake = helper(false);
  const controller = new WakeController('unused', () => {}, { spawnHelper: () => fake.process });
  let resolved = false;
  const operation = controller.setAwake(true, false).then(() => { resolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  const id = fake.requests[0]!.id;
  fake.process.stdout.emit('data', `{"id":${id},`);
  fake.process.stdout.emit('data', '"ok":true}\n');
  await operation;
  assert.equal(resolved, true);
  fake.process.emit('exit', 1);
  await controller.dispose();
});

test('missing acknowledgement kills helper and reports failure', async () => {
  const fake = helper(false);
  const errors: string[] = [];
  const controller = new WakeController('unused', (error) => errors.push(error), {
    spawnHelper: () => fake.process,
    acknowledgementTimeoutMs: 15,
  });
  await assert.rejects(controller.setAwake(true, false), /did not respond/);
  assert.equal(fake.killed, true);
  assert.equal(errors.length, 1);
  await controller.dispose();
});

test('unexpected helper exit rejects pending requests', async () => {
  const fake = helper(false);
  const errors: string[] = [];
  const controller = new WakeController('unused', (error) => errors.push(error), { spawnHelper: () => fake.process });
  const operation = controller.setAwake(true, false);
  await new Promise((resolve) => setImmediate(resolve));
  fake.process.emit('exit', 1);
  await assert.rejects(operation, /exited/);
  assert.equal(errors.length, 1);
  await controller.dispose();
});

test('heartbeat runs while helper is alive and stops on dispose', async () => {
  const fake = helper();
  const controller = new WakeController('unused', () => {}, {
    spawnHelper: () => fake.process,
    heartbeatIntervalMs: 5,
  });
  await controller.setAwake(true, false);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(fake.requests.some((request) => request.command === 'ping'));
  await controller.dispose();
  const count = fake.requests.length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(fake.requests.length, count);
});

test('negative acknowledgement releases helper and reports failure', async () => {
  const fake = helper(false);
  const errors: string[] = [];
  const controller = new WakeController('unused', (error) => errors.push(error), { spawnHelper: () => fake.process });
  const operation = controller.setAwake(true, true);
  await new Promise((resolve) => setImmediate(resolve));
  fake.process.stdout.emit('data', `${JSON.stringify({ id: fake.requests[0]!.id, ok: false })}\n`);
  await assert.rejects(operation, /rejected/);
  assert.equal(fake.killed, true);
  assert.equal(errors.length, 1);
  await controller.dispose();
});
