/**
 * Idle extras die. The most recently used slot(s) stay warm so the next
 * message does not pay a full Pi cold start. Pinned agents are never evicted
 * by the idle sweep.
 *
 * @typedef {{ client?: unknown; booting?: unknown; busy?: boolean; lastUsedAt?: number; agentId?: string; agentSlug?: string }} IdleSlot
 */

/**
 * @param {IdleSlot} slot
 * @param {Set<string> | Iterable<string> | undefined} pinned
 */
export function isPinnedSlot(slot, pinned) {
  if (!pinned) return false;
  const set = pinned instanceof Set ? pinned : new Set(pinned);
  if (!set.size) return false;
  return Boolean((slot?.agentId && set.has(slot.agentId)) || (slot?.agentSlug && set.has(slot.agentSlug)));
}

/**
 * Live = has a client, is not booting, is not mid-turn.
 * @param {IdleSlot[]} slots
 */
function liveSlots(slots) {
  return (slots || []).filter((slot) => slot?.client && !slot.booting && !slot.busy);
}

/**
 * @param {IdleSlot[]} slots
 * @param {{ now?: number; idleMs?: number; keepWarm?: number; pinned?: Set<string> | Iterable<string> }} [opts]
 */
export function pickIdleSlots(slots, { now = Date.now(), idleMs = 180_000, keepWarm = 1, pinned } = {}) {
  const keep = Math.max(1, Math.floor(keepWarm) || 1);
  const live = liveSlots(slots);
  if (live.length <= keep) return [];
  const newestFirst = [...live].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const warm = new Set(newestFirst.slice(0, keep));
  return newestFirst.filter(
    (slot) => !warm.has(slot) && !isPinnedSlot(slot, pinned) && now - (slot.lastUsedAt || 0) >= idleMs,
  );
}

/**
 * Slots that may be stopped right now to free memory, least recently used
 * first. Ignores idleMs: this is for memory pressure, not idleness. The
 * `keepWarm` newest live slots and pinned agents are protected; `exclude`
 * is the slot about to be started (never evict what we are booting for).
 *
 * @param {IdleSlot[]} slots
 * @param {{ keepWarm?: number; pinned?: Set<string> | Iterable<string>; exclude?: unknown }} [opts]
 */
export function pickEvictable(slots, { keepWarm = 0, pinned, exclude } = {}) {
  const keep = Math.max(0, Math.floor(keepWarm) || 0);
  const live = liveSlots(slots).filter((slot) => slot !== exclude);
  const newestFirst = [...live].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const warm = new Set(newestFirst.slice(0, keep));
  return newestFirst
    .filter((slot) => !warm.has(slot) && !isPinnedSlot(slot, pinned))
    .reverse();
}

/**
 * Fraction of the container memory limit in use by anonymous memory (page
 * cache the kernel can drop is not pressure). Returns null when the cgroup
 * does not expose a limit, in which case callers must not throttle.
 *
 * @param {{ used?: number | null; limit?: number | null; inactiveFile?: number | null }} mem
 */
export function memoryPressure(mem) {
  if (mem?.used == null || mem?.limit == null) return null;
  const used = Number(mem.used);
  const limit = Number(mem.limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  const cache = Number(mem?.inactiveFile);
  const working = Number.isFinite(cache) && cache > 0 ? Math.max(0, used - cache) : used;
  return Math.min(1, working / limit);
}
