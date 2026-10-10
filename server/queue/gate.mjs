// Gate: lets N jobs through at once (and at most `perMinute` starts in any 60 s)
// and keeps everyone else in a plain FIFO line.
//
// Never-kill contract (job-queue-manager-plan.md):
//  - a waiter has no timeout and the line has no maximum depth;
//  - a waiter leaves the line only when it is admitted or its caller cancels it
//    (AbortSignal) - load never rejects it;
//  - the gate never touches work that already started (lowering a limit only
//    affects who is admitted next);
//  - if the gate's own code throws, the request is let through (fail open).
//
// Pure: no IO. The clock and the wake-up scheduler are injectable. The only
// timer is the refill wake-up for the per-minute window; it admits the head of
// the line when a slot of the window frees up and never expires a waiter.

const WINDOW_MS = 60_000;

/** A limit below 1 or not a finite number means "no cap". */
function limitOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : Infinity;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('Cancelled while waiting in line'), { name: 'AbortError' });
}

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

const noop = () => {};

/**
 * @param {object} [options]
 * @param {number} [options.maxConcurrent] jobs running at once (default: no cap)
 * @param {number} [options.perMinute] job starts per rolling 60 s (default: no cap)
 * @param {() => number} [options.now]
 * @param {(fn: () => void, ms: number) => (() => void)} [options.schedule] returns a canceller
 * @param {(error: unknown) => void} [options.onError] told about internal faults; the request still runs
 */
export function createGate(options = {}) {
  const now = options.now || Date.now;
  const schedule = options.schedule || defaultSchedule;
  const reportError = (error) => { try { options.onError?.(error); } catch { /* observer must not matter */ } };

  let maxConcurrent = limitOf(options.maxConcurrent);
  let perMinute = limitOf(options.perMinute);
  let active = 0;
  let admittedTotal = 0;
  let lastWaitMs = 0;
  let cancelWake = null;
  const starts = []; // start times inside the rolling window (only kept while perMinute is capped)
  const line = []; // FIFO of waiters

  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      pump();
    };
  }

  function detach(waiter) {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
  }

  function admit(waiter, at) {
    detach(waiter);
    active += 1;
    admittedTotal += 1;
    lastWaitMs = Math.max(0, at - waiter.enqueuedAt);
    if (Number.isFinite(perMinute)) starts.push(at);
    waiter.resolve(makeRelease());
  }

  /** Lets everyone through; used when the gate's own code is faulty. */
  function failOpen(error) {
    reportError(error);
    if (cancelWake) { try { cancelWake(); } catch { /* nothing to cancel */ } cancelWake = null; }
    for (const waiter of line.splice(0)) {
      detach(waiter);
      waiter.resolve(noop);
    }
  }

  function notifyPositions() {
    line.forEach((waiter, index) => {
      const position = index + 1;
      if (!waiter.onPosition || waiter.position === position) return;
      waiter.position = position;
      try { waiter.onPosition(position, line.length); } catch (error) { reportError(error); }
    });
  }

  function pump() {
    try {
      if (cancelWake) { cancelWake(); cancelWake = null; }
      while (line.length && active < maxConcurrent) {
        const at = now();
        if (Number.isFinite(perMinute)) {
          while (starts.length && starts[0] <= at - WINDOW_MS) starts.shift();
          if (starts.length >= perMinute) {
            // Wake when the oldest start leaves the window. Not a deadline on anyone.
            cancelWake = schedule(pump, Math.max(1, starts[0] + WINDOW_MS - at));
            break;
          }
        }
        admit(line.shift(), at);
      }
      notifyPositions();
    } catch (error) {
      failOpen(error);
    }
  }

  /**
   * Resolves with a `release` function once the job may start. Call `release`
   * exactly when the job ends (idempotent). Rejects only when `signal` is
   * aborted by the caller while still waiting.
   * @param {{ signal?: AbortSignal, onPosition?: (position: number, queued: number) => void }} [opts]
   * @returns {Promise<() => void>}
   */
  function acquire(opts = {}) {
    return new Promise((resolve, reject) => {
      try {
        const { signal, onPosition } = opts;
        if (signal?.aborted) { reject(abortError(signal)); return; }
        const waiter = { resolve, signal, onPosition, enqueuedAt: now(), position: 0, onAbort: null };
        if (signal) {
          waiter.onAbort = () => {
            const index = line.indexOf(waiter);
            if (index === -1) return; // already admitted: the job is running, cancelling it is the caller's business
            line.splice(index, 1);
            reject(abortError(signal));
            pump(); // positions behind it move up; the slot it never held is not freed
          };
          signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
        line.push(waiter);
        pump();
      } catch (error) {
        failOpen(error);
        resolve(noop);
      }
    });
  }

  /** Runs `fn` once admitted; releases the slot however `fn` ends. */
  async function run(fn, opts) {
    const release = await acquire(opts);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Change limits at runtime. Running jobs are untouched; only the next admissions change. */
  function setLimits(limits = {}) {
    if ('maxConcurrent' in limits) maxConcurrent = limitOf(limits.maxConcurrent);
    if ('perMinute' in limits) {
      perMinute = limitOf(limits.perMinute);
      if (!Number.isFinite(perMinute)) starts.length = 0;
    }
    pump();
  }

  function stats() {
    let oldestWaitMs = 0;
    try { if (line.length) oldestWaitMs = Math.max(0, now() - line[0].enqueuedAt); } catch { /* snapshot only */ }
    return {
      active,
      queued: line.length,
      maxConcurrent: Number.isFinite(maxConcurrent) ? maxConcurrent : null,
      perMinute: Number.isFinite(perMinute) ? perMinute : null,
      oldestWaitMs,
      lastWaitMs,
      admittedTotal,
    };
  }

  return { acquire, run, setLimits, stats };
}
