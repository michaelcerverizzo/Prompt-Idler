import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CopilotDetector, parseActivityMarker } from '../src/detection';

function marker(type = 'turn_start', span = 'abcdef0123456789', turnId = '0', ts = Date.now() + 1) {
  return JSON.stringify({ v: 1, ts, sid: 'session-1', type, spanId: `${type}-${span}-${turnId}`, attrs: { turnId } }) + '\n';
}

test('verified JSONL turn pairs share identity; unsupported and ordinary logs ignored', () => {
  const start = parseActivityMarker(marker());
  const end = parseActivityMarker(marker('turn_end'));
  assert.equal(start?.kind, 'start');
  assert.equal(end?.kind, 'end');
  assert.equal(start?.id, end?.id);
  for (const value of ['null', '[]', '{', 'request done: requestId: [123]', marker().replace('"v":1', '"v":2'), marker().replace('"turnId":"0"', '"turnId":null')]) {
    assert.equal(parseActivityMarker(value), undefined);
  }
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-idler-'));
  const dir = path.join(root, 'session-1');
  await fs.mkdir(dir);
  const file = path.join(dir, 'main.jsonl');
  const events: string[] = [];
  const statuses: string[] = [];
  const detector = new CopilotDetector(root, {
    onStart: id => events.push(`start:${id}`),
    onEnd: id => events.push(`end:${id}`),
    onStatus: value => statuses.push(value),
  }, root);
  t.after(async () => { detector.dispose(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, dir, file, detector, events, statuses };
}

test('existing history and historical partial line are skipped; split new lines parsed once', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, marker() + '{"type":');
  await f.detector.poll();
  await fs.appendFile(f.file, '"turn_start"}\n' + marker().slice(0, 45));
  await f.detector.poll();
  assert.deepEqual(f.events, []);
  assert.match(f.statuses.at(-1)!, /^Detection unavailable/);
  const full = marker();
  // Timestamp differences affect only suffix, split before the timestamp isn't needed.
  await fs.appendFile(f.file, full.slice(45));
  await f.detector.poll();
  assert.equal(f.events.length, 1);
  await fs.appendFile(f.file, marker() + marker('turn_end') + marker('turn_end'));
  await f.detector.poll();
  assert.equal(f.events.length, 2);
  assert.match(f.statuses.at(-1)!, /^Detection available \(partial\)/);
});

test('a lifecycle schema change clears compatibility until a supported start is observed', async t => {
  const f = await fixture(t);
  await f.detector.poll();
  await fs.writeFile(f.file, marker());
  await f.detector.poll();
  assert.match(f.statuses.at(-1)!, /^Detection available/);
  await fs.appendFile(f.file, marker('turn_start', 'changed').replace('"v":1', '"v":2'));
  await f.detector.poll();
  assert.match(f.statuses.at(-1)!, /^Detection unavailable/);
  assert.equal(f.events.length, 1);
  await fs.appendFile(f.file, marker('turn_end'));
  await f.detector.poll();
  assert.match(f.statuses.at(-1)!, /^Detection unavailable/);
  await fs.appendFile(f.file, marker('turn_start', 'newspan'));
  await f.detector.poll();
  assert.match(f.statuses.at(-1)!, /^Detection available/);
});

test('new files after activation read from zero; concurrent turns end independently', async t => {
  const f = await fixture(t);
  await f.detector.poll();
  await fs.writeFile(f.file, marker() + marker('turn_start', 'abcdefabcdef'));
  await f.detector.poll();
  assert.equal(f.events.length, 2);
  await fs.appendFile(f.file, marker('turn_end', 'abcdefabcdef'));
  await f.detector.poll();
  assert.equal(f.events.length, 3);
  assert.equal(f.events[2], f.events[1].replace('start:', 'end:'));
  await fs.appendFile(f.file, marker('turn_end'));
  await f.detector.poll();
  assert.equal(f.events.length, 4);
});

test('rotation and truncation do not replay starts; old records in new files ignored', async t => {
  const f = await fixture(t);
  await f.detector.poll();
  const first = marker();
  await fs.writeFile(f.file, first);
  await f.detector.poll();
  await fs.rename(f.file, path.join(f.dir, 'main.old'));
  await fs.writeFile(f.file, marker('turn_start', 'historical', '0', 1) + first + marker('turn_end'));
  await f.detector.poll();
  assert.equal(f.events.length, 2);
  await fs.writeFile(f.file, first);
  await f.detector.poll();
  assert.equal(f.events.length, 2);
});

test('unknown end does not start activity and disposed detector emits nothing', async t => {
  const f = await fixture(t);
  await f.detector.poll();
  await fs.writeFile(f.file, marker('turn_end'));
  await f.detector.poll();
  assert.deepEqual(f.events, []);
  f.detector.dispose();
  await fs.appendFile(f.file, marker());
  await f.detector.poll();
  assert.deepEqual(f.events, []);
});

test('missing log directory is unavailable, and new supported logs recover', async t => {
  const f = await fixture(t);
  await fs.rm(f.root, { recursive: true });
  await f.detector.poll();
  assert.match(f.statuses.at(-1)!, /^Detection unavailable/);
  await fs.mkdir(f.dir, { recursive: true });
  await fs.writeFile(f.file, marker());
  await f.detector.poll();
  assert.equal(f.events.length, 1);
  assert.match(f.statuses.at(-1)!, /^Detection available/);
});
