import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunClock } from './run-clock.mjs';

function harness({ limitMs, isWaiting = () => false }) {
  let time = 0;
  let tick = null;
  let expired = 0;
  const clock = createRunClock({
    limitMs, isWaiting: () => isWaiting(time), onExpire: () => { expired += 1; }, checkEveryMs: 1000,
    now: () => time, setTimer: (fn) => { tick = fn; return 1; }, clearTimer: () => { tick = null; },
  });
  return { clock, expired: () => expired, advance(ms) { for (let t = 0; t < ms; t += 1000) { time += 1000; tick?.(); } } };
}

test('a run that really runs past its limit expires', () => {
  const h = harness({ limitMs: 120_000 });
  h.advance(119_000);
  assert.equal(h.expired(), 0);
  h.advance(2_000);
  assert.equal(h.expired(), 1);
});

test('time waiting in a provider\'s line does not spend the budget', () => {
  const h = harness({ limitMs: 120_000, isWaiting: (t) => t > 10_000 && t <= 3_610_000 }); // an hour in line
  h.advance(3_700_000);
  assert.ok(h.clock.spentMs() < 120_000 + 1, 'only the ~100 s of real running time was spent');
  assert.equal(h.expired(), 0);
  h.advance(60_000);
  assert.equal(h.expired(), 1, 'and the budget is enforced once it really has run that long');
});
