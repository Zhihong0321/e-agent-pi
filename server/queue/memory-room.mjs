// A new Pi start waits for memory headroom; it never fails because the host is full.
// It first stops idle Pis (the caller's `evictOne`), and when none is left to stop it
// keeps looking until memory comes down. Running turns are never touched here, and
// there is no deadline or retry cap: the only way out is that there is room.

/**
 * @param {object} opts
 * @param {() => Promise<number | null>} opts.readRatio share of the memory limit in use; null = unknown (no throttling)
 * @param {number} opts.hardLimit start only below this share
 * @param {(ratio: number) => Promise<boolean>} opts.evictOne stop one idle Pi; false when there is none
 * @param {() => Promise<void>} opts.pause how long to wait before looking again
 * @param {(ratio: number) => void} [opts.onWait] told once when the start begins to wait
 */
export async function waitForMemoryRoom({ readRatio, hardLimit, evictOne, pause, onWait }) {
  let announced = false;
  for (;;) {
    const ratio = await readRatio();
    if (ratio == null || ratio < hardLimit) return;
    if (await evictOne(ratio)) continue;
    if (!announced) {
      announced = true;
      try { onWait?.(ratio); } catch { /* logging only */ }
    }
    await pause();
  }
}
