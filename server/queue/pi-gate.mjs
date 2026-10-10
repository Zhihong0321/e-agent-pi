// The Pi gate: at most N Pi processes / agent turns run at once on this host.
// Every start path takes its slot here and hands it back when the turn ends:
// v2 chat runs and specialist tasks (execution/runner.mjs), the legacy warm
// pool and prewarm (index.mjs), legacy jobs (via the same chat path) and agy.
// A turn that cannot start yet waits in line - see gate.mjs for the contract.
//
// Warm idle slots are not "active": only a running turn holds a slot.
import { createGate } from './gate.mjs';

function defaultLimit() {
  const n = Number(process.env.PI_POOL_SIZE);
  return Number.isFinite(n) && n >= 1 ? Math.min(16, Math.floor(n)) : 3;
}

let gate = createGate({ maxConcurrent: defaultLimit() });

/** Stable handle: callers keep this object, tests may swap the gate behind it. */
export const piGate = {
  acquire: (opts) => gate.acquire(opts),
  run: (fn, opts) => gate.run(fn, opts),
  setLimits: (limits) => gate.setLimits(limits),
  stats: () => gate.stats(),
};

export function resetPiGateForTests(limits = {}) {
  gate = createGate({ maxConcurrent: defaultLimit(), ...limits });
}
