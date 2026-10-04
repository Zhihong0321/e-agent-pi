// Shared execution contracts: statuses, typed errors, completion proposal and
// tool-call envelopes. One canonical vocabulary for chat, specialists and
// background work. JS on purpose — runtime inputs are validated with zod and
// the same definitions generate the worker tool JSON schemas.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const RUN_STATUSES = ['queued', 'running', 'done', 'blocked', 'failed', 'cancelled'];
export const ERROR_KINDS = ['input', 'permission', 'availability', 'execution', 'uncertain'];
export const EFFECT_STATES = ['none', 'committed', 'partial', 'unknown'];
export const RUN_KINDS = ['chat', 'task'];

export const ERROR_CODES = {
  INPUT_INVALID: { kind: 'input', effectState: 'none' },
  NOT_FOUND: { kind: 'input', effectState: 'none' },
  CONFLICT: { kind: 'input', effectState: 'none' },
  PERMISSION_DENIED: { kind: 'permission', effectState: 'none' },
  SIGN_IN_REQUIRED: { kind: 'permission', effectState: 'none' },
  CAPACITY_UNAVAILABLE: { kind: 'availability', effectState: 'none' },
  DRAINING: { kind: 'availability', effectState: 'none' },
  OPERATION_DEADLINE: { kind: 'availability', effectState: 'unknown' },
  EXTERNAL_TIMEOUT: { kind: 'availability', effectState: 'unknown' },
  EXTERNAL_AUTH: { kind: 'permission', effectState: 'none' },
  EXTERNAL_ERROR: { kind: 'execution', effectState: 'unknown' },
  OUTCOME_UNKNOWN: { kind: 'uncertain', effectState: 'unknown' },
  COMPLETION_MISSING: { kind: 'execution', effectState: 'none' },
  COMPLETION_INVALID: { kind: 'execution', effectState: 'none' },
  DEPENDENCY_BLOCKED: { kind: 'execution', effectState: 'none' },
  EXECUTION_FAILED: { kind: 'execution', effectState: 'none' },
  CANCELLED: { kind: 'execution', effectState: 'none' },
  REQUEST_DEADLINE: { kind: 'availability', effectState: 'none' },
  MODEL_UNAVAILABLE: { kind: 'availability', effectState: 'none' },
  STALE_ATTEMPT: { kind: 'permission', effectState: 'none' },
};

export function execError(code, message, overrides = {}) {
  const base = ERROR_CODES[code] || ERROR_CODES.EXECUTION_FAILED;
  return {
    code,
    message: String(message || code).slice(0, 500),
    kind: overrides.kind || base.kind,
    effectState: overrides.effectState || base.effectState,
  };
}

export const FinishRunSchema = z.object({
  status: z.enum(['done', 'blocked', 'failed']),
  summary: z.string().trim().min(1).max(4000),
  outputs: z.record(z.string(), z.unknown()).optional(),
  sourceCallIds: z.array(z.string()).max(200).optional(),
  receiptIds: z.array(z.string()).max(200).optional(),
  artifactIds: z.array(z.string()).max(200).optional(),
  reasonCode: z.string().trim().max(80).optional(),
  missing: z.string().trim().max(1000).optional(),
});

export const BridgeCallSchema = z.object({
  callId: z.string().min(1).max(200),
  toolId: z.string().min(1).max(120),
  manifestRevision: z.string().min(8).max(64),
  args: z.unknown().optional(),
});

export const ToolManifestEntrySchema = z.object({
  id: z.string(),
  description: z.string(),
  kind: z.enum(['read', 'local_write', 'external', 'control']),
  inputSchema: z.record(z.string(), z.unknown()),
  mcpServer: z.string().optional(),
  mcpTool: z.string().optional(),
});

/** Deterministic JSON (sorted keys) so digests and revisions are stable. */
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Host-side HMAC key for argument digests; digests are one-way and not brute-forceable. */
let digestKey = null;
export function setDigestKey(key) {
  if (key) digestKey = key;
}
export function digestArgs(args) {
  if (!digestKey) digestKey = randomUUID();
  return createHmac('sha256', digestKey).update(stableStringify(args ?? {})).digest('hex');
}

const SECRET_KEYS = /pass(word)?|secret|token|api[_-]?key|credential/i;
/** Redacted view of tool arguments for persistence and events; secrets never stored raw. */
export function redactArgs(args, depth = 0) {
  if (depth > 6 || args == null || typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map((v) => redactArgs(v, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (SECRET_KEYS.test(key) && typeof value === 'string' && value) {
      out[key] = `[redacted:${digestArgs(value).slice(0, 8)}]`;
    } else {
      out[key] = redactArgs(value, depth + 1);
    }
  }
  return out;
}

export function manifestRevisionOf(manifest) {
  return createHash('sha256').update(stableStringify(manifest.tools.map((t) => [
    t.id, t.kind, t.mcpServer || null, stableStringify(t.inputSchema),
  ]))).update(manifest.mcpServers ? stableStringify(manifest.mcpServers.map((m) => m.slug)) : '')
    .digest('hex').slice(0, 16);
}

export function newId() {
  return randomUUID();
}
