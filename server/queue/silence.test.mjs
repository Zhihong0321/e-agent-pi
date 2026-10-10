import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSilenceWatch } from './silence.mjs';

function harness({ isWaiting = () => false, limitMs = 300_000 } = {}) {
  let time = 0;
  let tick = null;
  let silent = 0;
  const watch = createSilenceWatch({
    onSilent: () => { silent += 1; },
    isWaiting: () => isWaiting(time),
    limitMs,
    checkEveryMs: 5000,
    now: () => time,
    setTimer: (fn) => { tick = fn; return 1; },
    clearTimer: () => { tick = null; },
  });
  return {
    watch,
    silentCount: () => silent,
    advance(ms) { for (let t = 0; t < ms; t += 5000) { time += 5000; tick?.(); } },
    now: () => time,
  };
}

test('a Pi that really goes quiet for the limit is reported (kill point 5 still catches real hangs)', () => {
  const h = harness();
  h.advance(295_000);
  assert.equal(h.silentCount(), 0);
  h.advance(10_000);
  assert.equal(h.silentCount(), 1);
  h.advance(60_000);
  assert.equal(h.silentCount(), 1, 'reported once');
});

test('activity resets the clock', () => {
  const h = harness();
  h.advance(250_000);
  h.watch.bump();
  h.advance(250_000);
  assert.equal(h.silentCount(), 0);
});

test('time spent waiting at an LLM gate does not count, however long (kill point 5)', () => {
  const h = harness({ isWaiting: (t) => t < 3_600_000 }); // queued for an hour
  h.advance(3_600_000);
  assert.equal(h.silentCount(), 0, 'an hour in line is not silence');
});

test('the limit counts again from the moment the wait ends', () => {
  const h = harness({ isWaiting: (t) => t < 1_000_000 });
  h.advance(1_000_000 + 290_000);
  assert.equal(h.silentCount(), 0, 'under the limit since the wait ended');
  h.advance(10_000);
  assert.equal(h.silentCount(), 1);
});

test('if the waiting check itself fails, silence is counted as before', () => {
  const h = harness({ isWaiting: () => { throw new Error('boom'); } });
  h.advance(305_000);
  assert.equal(h.silentCount(), 1);
});

test('stop cancels the watchdog', () => {
  const h = harness();
  h.watch.stop();
  h.advance(600_000);
  assert.equal(h.silentCount(), 0);
});
