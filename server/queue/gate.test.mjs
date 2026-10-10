import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGate } from './gate.mjs';

// Fake clock + wake-up scheduler so "a minute" or "a day" costs nothing.
function fakeTime(start = 1_000_000) {
  let current = start;
  const timers = [];
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    now: () => current,
    schedule(fn, ms) {
      const timer = { at: current + ms, fn, live: true };
      timers.push(timer);
      return () => { timer.live = false; };
    },
    pendingTimers: () => timers.filter((t) => t.live).length,
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        current = Math.max(current, due.at);
        due.fn();
        await flush();
      }
      current = target;
      await flush();
    },
    flush,
  };
}

const PENDING = Symbol('pending');
const settled = (promise) => Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve(PENDING)))]);

test('admits up to maxConcurrent at once and keeps the rest in FIFO order', async () => {
  const gate = createGate({ maxConcurrent: 2 });
  const order = [];
  const releases = [];
  const jobs = [1, 2, 3, 4].map((id) => gate.acquire().then((release) => { order.push(id); releases.push(release); }));
  await settled(Promise.all(jobs));
  assert.deepEqual(order, [1, 2]);
  assert.equal(gate.stats().queued, 2);
  releases[0]();
  await settled(jobs[2]);
  assert.deepEqual(order, [1, 2, 3]);
  releases[1]();
  await settled(jobs[3]);
  assert.deepEqual(order, [1, 2, 3, 4]);
  assert.equal(gate.stats().active, 2);
});

test('a waiter held for 60 s (and a day) is never rejected and runs the moment a slot frees', async () => {
  const time = fakeTime();
  const gate = createGate({ maxConcurrent: 1, now: time.now, schedule: time.schedule });
  const release = await gate.acquire();
  let outcome = PENDING;
  const waiter = gate.acquire().then((r) => { outcome = 'ran'; return r; }, (error) => { outcome = error; });
  await time.advance(60_000);
  assert.equal(outcome, PENDING, 'still waiting after 60 s');
  await time.advance(24 * 60 * 60 * 1000);
  assert.equal(outcome, PENDING, 'still waiting after a day');
  assert.equal(time.pendingTimers(), 0, 'no timer exists on a concurrency-only wait');
  release();
  await waiter;
  assert.equal(outcome, 'ran');
  assert.ok(gate.stats().lastWaitMs >= 24 * 60 * 60 * 1000);
});

test('there is no maximum queue depth: a thousand waiters all run, none rejected', async () => {
  const gate = createGate({ maxConcurrent: 3 });
  let running = 0;
  let peak = 0;
  let done = 0;
  const rejected = [];
  await Promise.all(Array.from({ length: 1000 }, (_, id) => gate.run(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    done += 1;
  }).catch((error) => rejected.push([id, error]))));
  assert.deepEqual(rejected, []);
  assert.equal(done, 1000);
  assert.equal(peak, 3);
  assert.equal(gate.stats().active, 0);
});

test('cancelling removes only that waiter; it never held a slot and the others keep their order', async () => {
  const gate = createGate({ maxConcurrent: 1 });
  const release = await gate.acquire();
  const order = [];
  const controller = new AbortController();
  const a = gate.acquire().then((r) => { order.push('a'); return r; });
  const b = gate.acquire({ signal: controller.signal });
  const c = gate.acquire().then((r) => { order.push('c'); return r; });
  assert.equal(gate.stats().queued, 3);
  controller.abort();
  await assert.rejects(b, { name: 'AbortError' });
  assert.equal(gate.stats().queued, 2);
  release();
  (await a)();
  (await c)();
  assert.deepEqual(order, ['a', 'c']);
  assert.equal(gate.stats().active, 0);
});

test('an already-aborted signal never enters the line; aborting after admission does nothing', async () => {
  const gate = createGate({ maxConcurrent: 1 });
  const dead = new AbortController();
  dead.abort();
  await assert.rejects(gate.acquire({ signal: dead.signal }), { name: 'AbortError' });
  assert.equal(gate.stats().queued, 0);

  const live = new AbortController();
  const release = await gate.acquire({ signal: live.signal });
  live.abort();
  assert.equal(gate.stats().active, 1, 'running work is not evicted by a late abort');
  release();
  assert.equal(gate.stats().active, 0);
});

test('release is idempotent: a double release cannot admit two waiters', async () => {
  const gate = createGate({ maxConcurrent: 1 });
  const release = await gate.acquire();
  const second = gate.acquire();
  const third = gate.acquire();
  release();
  release();
  const r2 = await second;
  assert.equal(await settled(third), PENDING);
  assert.equal(gate.stats().active, 1);
  r2();
  (await third)();
});

test('when the gate throws, the request still runs (fail open)', async () => {
  const faults = [];
  let broken = false;
  const gate = createGate({
    maxConcurrent: 1,
    now: () => { if (broken) throw new Error('clock exploded'); return 1; },
    onError: (error) => faults.push(error.message),
  });
  broken = true;
  let ran = false;
  await gate.run(async () => { ran = true; });
  assert.equal(ran, true);
  assert.ok(faults.length >= 1);
  assert.equal(gate.stats().queued, 0);
});

test('a throw while others are waiting lets those through too instead of stalling them', async () => {
  let broken = false;
  const gate = createGate({
    maxConcurrent: 1,
    perMinute: 100,
    now: () => { if (broken) throw new Error('boom'); return 5; },
    onError: () => {},
  });
  const release = await gate.acquire();
  const waiting = [gate.acquire(), gate.acquire()];
  broken = true;
  release(); // pump runs, now() throws, line is flushed open
  const results = await Promise.all(waiting);
  assert.equal(results.length, 2);
  assert.equal(gate.stats().queued, 0);
});

test('a throwing scheduler or throwing observers do not stop a request', async () => {
  const time = fakeTime();
  const gate = createGate({
    perMinute: 1,
    now: time.now,
    schedule: () => { throw new Error('no timers today'); },
    onError: () => { throw new Error('observer broke too'); },
  });
  await gate.acquire(); // takes the only start in the window
  let ran = false;
  await gate.run(async () => { ran = true; }); // would need a wake-up timer; scheduler throws -> fail open
  assert.equal(ran, true);

  const g2 = createGate({ maxConcurrent: 1, onError: () => {} });
  const hold = await g2.acquire();
  const p = g2.acquire({ onPosition: () => { throw new Error('bad callback'); } });
  hold();
  await p;
});

test('per-minute rate: never more than N starts in any rolling 60 s, nothing rejected', async () => {
  const time = fakeTime();
  const gate = createGate({ perMinute: 3, now: time.now, schedule: time.schedule });
  const startedAt = [];
  const jobs = Array.from({ length: 8 }, () => gate.acquire().then((release) => { startedAt.push(time.now()); release(); }));
  await time.flush();
  assert.equal(startedAt.length, 3, 'three go straight through, five wait');
  assert.equal(gate.stats().queued, 5);
  assert.equal(time.pendingTimers(), 1);
  await time.advance(59_999);
  assert.equal(startedAt.length, 3, 'window has not moved yet');
  await time.advance(1);
  assert.equal(startedAt.length, 6);
  await time.advance(60_000);
  assert.equal(startedAt.length, 8);
  await Promise.all(jobs);
  for (let i = 0; i < startedAt.length; i += 1) {
    const inWindow = startedAt.filter((t) => t >= startedAt[i] && t < startedAt[i] + 60_000);
    assert.ok(inWindow.length <= 3, `window starting at start #${i} holds ${inWindow.length}`);
  }
  assert.equal(time.pendingTimers(), 0, 'no wake-up left once the line is empty');
});

test('rate and concurrency both apply, and a free slot does not bypass the rate', async () => {
  const time = fakeTime();
  const gate = createGate({ maxConcurrent: 2, perMinute: 2, now: time.now, schedule: time.schedule });
  const r1 = await gate.acquire();
  const r2 = await gate.acquire();
  r1(); r2(); // both slots free, but two starts already used this minute
  let third = PENDING;
  gate.acquire().then(() => { third = 'ran'; });
  await time.flush();
  assert.equal(third, PENDING);
  await time.advance(60_000);
  assert.equal(third, 'ran');
});

test('raising limits at runtime admits waiters; lowering them never touches running work', async () => {
  const gate = createGate({ maxConcurrent: 1 });
  const first = await gate.acquire();
  const waiters = [gate.acquire(), gate.acquire(), gate.acquire()];
  await settled(waiters[0]);
  assert.equal(gate.stats().queued, 3);
  gate.setLimits({ maxConcurrent: 4 });
  await Promise.all(waiters);
  assert.equal(gate.stats().active, 4);
  gate.setLimits({ maxConcurrent: 1 });
  assert.equal(gate.stats().active, 4, 'lowering the cap evicts nobody');
  const late = gate.acquire();
  first();
  assert.equal(await settled(late), PENDING, 'new work waits until running drops below the new cap');
  (await waiters[0])();
  (await waiters[1])();
  (await waiters[2])();
  (await late)();
  assert.equal(gate.stats().active, 0);
});

test('invalid or missing limits mean "no cap", never a stall', async () => {
  for (const bad of [undefined, null, 0, -3, NaN, 'x']) {
    const gate = createGate({ maxConcurrent: bad, perMinute: bad });
    const releases = await Promise.all(Array.from({ length: 50 }, () => gate.acquire()));
    assert.equal(releases.length, 50);
    assert.equal(gate.stats().maxConcurrent, null);
  }
});

test('onPosition reports "Queued, position N" and moves up as the line drains', async () => {
  const gate = createGate({ maxConcurrent: 1 });
  const release = await gate.acquire();
  const seen = [];
  const a = gate.acquire({ onPosition: (position) => seen.push(['a', position]) });
  const b = gate.acquire({ onPosition: (position) => seen.push(['b', position]) });
  await time_flush();
  assert.deepEqual(seen, [['a', 1], ['b', 2]]);
  release();
  const releaseA = await a;
  assert.deepEqual(seen.at(-1), ['b', 1]);
  releaseA();
  (await b)();
});

test('stats expose queue length and wait time for the status snapshot', async () => {
  const time = fakeTime();
  const gate = createGate({ maxConcurrent: 1, now: time.now, schedule: time.schedule });
  const release = await gate.acquire();
  gate.acquire();
  await time.advance(5_000);
  const stats = gate.stats();
  assert.equal(stats.queued, 1);
  assert.equal(stats.active, 1);
  assert.equal(stats.oldestWaitMs, 5_000);
  assert.equal(stats.maxConcurrent, 1);
  release();
  await time.flush();
  assert.equal(gate.stats().lastWaitMs, 5_000);
  assert.equal(gate.stats().admittedTotal, 2);
});

test('run releases the slot when the job throws, and passes the job error through unchanged', async () => {
  const gate = createGate({ maxConcurrent: 1 });
  const providerError = Object.assign(new Error('provider is down'), { status: 503 });
  await assert.rejects(gate.run(async () => { throw providerError; }), (error) => error === providerError);
  assert.equal(gate.stats().active, 0);
  assert.equal(await gate.run(async () => 'next'), 'next');
});

function time_flush() { return new Promise((resolve) => setImmediate(resolve)); }
