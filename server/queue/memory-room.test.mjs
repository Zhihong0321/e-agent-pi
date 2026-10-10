import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForMemoryRoom } from './memory-room.mjs';

test('a start that finds no idle Pi to stop waits for memory instead of failing (kill point 2)', async () => {
  const readings = [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.5];
  let pauses = 0;
  const told = [];
  await waitForMemoryRoom({
    readRatio: async () => readings.shift(),
    hardLimit: 0.75,
    evictOne: async () => false, // nothing idle: only running turns hold memory
    pause: async () => { pauses += 1; },
    onWait: (ratio) => told.push(ratio),
  });
  assert.equal(pauses, 6, 'it kept looking for as long as memory stayed high - no round cap');
  assert.deepEqual(told, [0.9], 'logged once, not on every look');
});

test('a thousand looks later it is still waiting, and it still has no way to reject', async () => {
  let looks = 0;
  const result = await waitForMemoryRoom({
    readRatio: async () => (++looks > 1000 ? null : 0.99),
    hardLimit: 0.75,
    evictOne: async () => false,
    pause: async () => {},
  });
  assert.equal(result, undefined);
  assert.equal(looks, 1001);
});

test('idle Pis are stopped first, one at a time, and the start goes ahead as soon as there is room', async () => {
  const readings = [0.9, 0.8, 0.6];
  const evicted = [];
  await waitForMemoryRoom({
    readRatio: async () => readings.shift(),
    hardLimit: 0.75,
    evictOne: async (ratio) => { evicted.push(ratio); return true; },
    pause: async () => { throw new Error('should not wait while idle Pis can be stopped'); },
  });
  assert.deepEqual(evicted, [0.9, 0.8]);
});

test('an unknown memory limit never throttles', async () => {
  await waitForMemoryRoom({ readRatio: async () => null, hardLimit: 0.75, evictOne: async () => false, pause: async () => { throw new Error('no'); } });
});
