// Authenticated routes for the execution system: the worker bridge (one
// endpoint, attempt-scoped bearer) and UI status recovery from persisted
// records. Mounted from server/index.mjs; no scheduling lives here.
import { dispatchTool, getBindingByToken } from './dispatch.mjs';
import { admissionState, activeAttemptCount, dispatchServices } from './runner.mjs';
import { dbReady } from '../db.mjs';
import { piGate } from '../queue/pi-gate.mjs';
import { llmStats } from '../queue/llm-gate.mjs';

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

/**
 * POST /api/internal/execution/tool — the one worker bridge endpoint.
 * Identity, company, profile, parent and attempt are resolved from the token's
 * stored binding; body fields can never override them.
 */
export async function handleExecutionToolRoute(req, res, { readBody, json }) {
  const token = bearerToken(req);
  const binding = token && getBindingByToken(token);
  if (!binding) {
    json(res, 401, { ok: false, error: { code: 'STALE_ATTEMPT', message: 'Unknown or expired attempt token' } });
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    json(res, 400, { ok: false, error: { code: 'INPUT_INVALID', message: 'Malformed request body' } });
    return;
  }
  const result = await dispatchTool(binding, body, dispatchServices());
  // Tool-level failures stay 200: the result payload carries the typed error.
  json(res, 200, result);
}

/**
 * GET /api/execution/runs?sessionId=&after= — persisted truth for the UI.
 * Requires the signed-in user (or a host API key) and returns only that
 * session's records, so refreshing or reconnecting recovers state without
 * rerunning anything.
 */
export async function handleExecutionStatusRoute(req, res, url, { json, user, authorized }) {
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    json(res, 400, { error: 'sessionId is required' });
    return;
  }
  if (!dbReady()) {
    json(res, 503, { error: 'Database is not connected' });
    return;
  }
  if (!user && !authorized(req)) {
    json(res, 401, { error: 'Please sign in' });
    return;
  }
  if (user) {
    const { getSession } = await import('../db.mjs');
    const session = await getSession(sessionId, user.id);
    if (!session) {
      json(res, 404, { error: 'Session not found' });
      return;
    }
  }
  const { runStatusForSession } = await import('./runner.mjs');
  const status = await runStatusForSession(sessionId, { after: Number(url.searchParams.get('after')) || 0 });
  json(res, 200, status);
}

/** Health: admission state, capacity and registry facts (no credential data). */
export function executionHealth({ maxConcurrent } = {}) {
  return {
    admission: admissionState(),
    activeAttempts: activeAttemptCount(),
    maxConcurrent: maxConcurrent || null,
    // The lines: how many are running, how many are waiting, and how long the oldest has waited.
    queue: { pi: piGate.stats(), llm: llmStats() },
  };
}
