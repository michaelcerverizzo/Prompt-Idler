import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityTracker } from '../src/activity';

test('overlapping requests remain awake until all finish; duplicate and unknown ends are harmless', () => {
  const tracker = new ActivityTracker();
  tracker.start('a', 0); tracker.start('b', 1); tracker.start('a', 2);
  assert.equal(tracker.snapshot(3).automatic, 2);
  tracker.end('a'); tracker.end('a'); tracker.end('unknown');
  assert.equal(tracker.snapshot(4).awake, true);
  tracker.end('b');
  assert.equal(tracker.snapshot(5).awake, false);
});

test('stale requests expire by original start; manual timer has an independent lifetime', () => {
  const tracker = new ActivityTracker();
  tracker.start('a', 0); tracker.start('a', 500);
  tracker.start('b', 900); tracker.startManual(100);
  assert.equal(tracker.expire(1000, 1000), 1);
  assert.equal(tracker.snapshot(1000).automatic, 1);
  tracker.end('b');
  assert.equal(tracker.snapshot(1000).awake, true);
  assert.equal(tracker.snapshot(1_800_100).awake, false);
});

test('stopping manual mode preserves automatic requests; disabling clears both', () => {
  const tracker = new ActivityTracker();
  tracker.start('a', 0); tracker.startManual(0); tracker.stopManual();
  assert.equal(tracker.snapshot(1).awake, true);
  tracker.startManual(1); tracker.clear();
  assert.deepEqual(tracker.snapshot(2), { automatic: 0, manual: false, manualUntil: 0, awake: false });
});
