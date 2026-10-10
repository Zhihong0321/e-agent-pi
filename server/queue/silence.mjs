// "Went silent" watchdog for a Pi turn: if the process emits nothing for `limitMs` it is
// considered stuck. Time spent waiting in a provider's line (llm-gate.mjs) is not silence -
// a Pi whose model call is queued has nothing to say - so it does not count: while
// `isWaiting()` is true the clock keeps resetting, and it starts counting again from the
// moment the wait ends.

/**
 * @param {object} opts
 * @param {() => void} opts.onSilent called once when the limit is reached
 * @param {() => boolean} [opts.isWaiting] true while this turn waits at an LLM gate
 * @param {number} [opts.limitMs]
 * @param {number} [opts.checkEveryMs]
 * @param {() => number} [opts.now]
 * @param {(fn: () => void, ms: number) => unknown} [opts.setTimer] interval starter, replaceable in tests
 * @param {(handle: unknown) => void} [opts.clearTimer]
 */
export function createSilenceWatch({
  onSilent, isWaiting = () => false, limitMs = 300_000, checkEveryMs = 5000,
  now = Date.now, setTimer = setInterval, clearTimer = clearInterval,
}) {
  let lastActivity = now();
  let fired = false;
  const timer = setTimer(() => {
    if (fired) return;
    let waiting = false;
    try { waiting = Boolean(isWaiting()); } catch { /* if we cannot tell, count the silence as before */ }
    if (waiting) { lastActivity = now(); return; }
    if (now() - lastActivity >= limitMs) {
      fired = true;
      onSilent();
    }
  }, checkEveryMs);
  timer?.unref?.();
  return {
    /** The process did something. */
    bump() { lastActivity = now(); },
    stop() { clearTimer(timer); },
  };
}
