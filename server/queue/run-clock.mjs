// A run limit that measures running time only. Used where a job has a time budget but its
// model calls may spend part of that time waiting in a provider's line (llm-gate.mjs):
// while `isWaiting()` is true the budget is not spent.

/**
 * @param {object} opts
 * @param {number} opts.limitMs running time allowed
 * @param {() => void} opts.onExpire called once when the budget is spent
 * @param {() => boolean} [opts.isWaiting] true while the job waits at an LLM gate
 * @param {number} [opts.checkEveryMs]
 * @param {() => number} [opts.now]
 * @param {(fn: () => void, ms: number) => unknown} [opts.setTimer]
 * @param {(handle: unknown) => void} [opts.clearTimer]
 */
export function createRunClock({
  limitMs, onExpire, isWaiting = () => false, checkEveryMs = Math.min(5000, Math.max(5, Math.floor(limitMs / 4))),
  now = Date.now, setTimer = setInterval, clearTimer = clearInterval,
}) {
  let spent = 0;
  let last = now();
  let expired = false;
  const timer = setTimer(() => {
    const at = now();
    const delta = at - last;
    last = at;
    let waiting = false;
    try { waiting = Boolean(isWaiting()); } catch { /* if we cannot tell, the time counts */ }
    if (!waiting) spent += delta;
    if (!expired && spent >= limitMs) {
      expired = true;
      onExpire();
    }
  }, checkEveryMs);
  timer?.unref?.();
  return {
    /** Running time used so far, not counting time spent waiting in line. */
    spentMs: () => spent,
    stop() { clearTimer(timer); },
  };
}
