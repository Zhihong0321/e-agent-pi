// Admin-controlled limits for the queue: how many Pi at once, and per model provider how
// many calls at once and how many calls per minute. Saved in the settings table, applied to
// the live gates immediately - no deploy, nobody's running work is touched (lowering a limit
// only changes who is let in next). Empty / null means "no cap".
import { piGate } from './pi-gate.mjs';
import { llmLimits, llmStats, setLlmLimits, knownProviders } from './llm-gate.mjs';

export const QUEUE_SETTING = 'queue_limits';
const MAX_PI = 64;
const MAX_CONCURRENT = 1000;
const MAX_PER_MINUTE = 100_000;

function cap(value, max, label) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${label} must be a whole number from 1 to ${max}, or empty for no cap`);
  return n;
}

/** Validates admin input into the shape that is saved. Throws a plain message for the form. */
export function validateQueueLimits(input = {}) {
  const providers = {};
  for (const [id, value] of Object.entries(input.providers || {})) {
    const maxConcurrent = cap(value?.maxConcurrent, MAX_CONCURRENT, `${id}: concurrent calls`);
    const perMinute = cap(value?.perMinute, MAX_PER_MINUTE, `${id}: calls per minute`);
    if (maxConcurrent !== null || perMinute !== null) providers[id] = { maxConcurrent, perMinute };
  }
  return { maxPi: cap(input.maxPi, MAX_PI, 'Max Pi at once'), providers };
}

/** What was saved, tolerating a missing or damaged value (then: no overrides). */
export function parseSavedLimits(raw) {
  try {
    return validateQueueLimits(JSON.parse(raw || '{}'));
  } catch {
    return { maxPi: null, providers: {} };
  }
}

/** Put the limits on the live gates. A provider that is no longer listed goes back to no cap. */
export function applyQueueLimits(limits, { defaultMaxPi }) {
  piGate.setLimits({ maxConcurrent: limits.maxPi ?? defaultMaxPi });
  const ids = new Set([...knownProviders(), ...Object.keys(limits.providers)]);
  for (const id of ids) {
    const own = limits.providers[id];
    setLlmLimits(id, { maxConcurrent: own?.maxConcurrent ?? null, perMinute: own?.perMinute ?? null });
  }
}

/** Everything the settings page shows: what is saved, the defaults, and the live lines. */
export function queueReport(saved, { defaultMaxPi }) {
  const providers = {};
  const stats = llmStats();
  for (const id of new Set([...knownProviders(), ...Object.keys(saved.providers), ...Object.keys(stats)])) {
    providers[id] = { limits: llmLimits(id), live: stats[id] || null };
  }
  return { saved, defaults: { maxPi: defaultMaxPi }, pi: piGate.stats(), providers };
}
