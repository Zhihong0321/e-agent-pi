/**
 * Idle extras die. The most recently used slot(s) stay warm so the next
 * message does not pay a full Pi cold start.
 *
 * @param {{ client?: unknown; booting?: unknown; busy?: boolean; lastUsedAt?: number }[]} slots
 * @param {{ now?: number; idleMs?: number; keepWarm?: number }} [opts]
 */
export function pickIdleSlots(slots, { now = Date.now(), idleMs = 180_000, keepWarm = 1 } = {}) {
  const keep = Math.max(1, Math.floor(keepWarm) || 1);
  const live = (slots || []).filter((slot) => slot?.client && !slot.booting && !slot.busy);
  if (live.length <= keep) return [];
  const newestFirst = [...live].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  const warm = new Set(newestFirst.slice(0, keep));
  return newestFirst.filter((slot) => !warm.has(slot) && now - (slot.lastUsedAt || 0) >= idleMs);
}
