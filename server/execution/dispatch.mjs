// Host dispatcher: validates every worker tool call against the run's stored
// binding, enforces access and deduplication, executes the registered
// operation, and journals the call with its effect receipts. The model can
// never construct identity, company, profile, parent or attempt — all of it is
// resolved from the attempt-scoped worker token's stored binding.
import { createHash } from 'node:crypto';
import { getPool } from '../db.mjs';
import {
  BridgeCallSchema, digestArgs, execError, newId, redactArgs,
} from './contracts.mjs';
import { getOperation } from './registry.mjs';
import * as store from './store.mjs';

const bindings = new Map(); // workerTokenHash -> live binding

function tokenHashOf(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

export function bindAttempt(binding) {
  const tokenHash = tokenHashOf(binding.token);
  bindings.set(tokenHash, { ...binding, tokenHash });
  return tokenHash;
}

export function getBindingByToken(token) {
  return bindings.get(tokenHashOf(token)) || null;
}

export function revokeAttempt(attemptId) {
  for (const [hash, binding] of bindings) {
    if (binding.attemptId === attemptId) bindings.delete(hash);
  }
}

export function setAttemptStopRequested(attemptId, stopRequested = true) {
  for (const binding of bindings.values()) {
    if (binding.attemptId === attemptId) binding.stopRequested = stopRequested;
  }
}

/** A newer attempt generation owns the run; the old owner cannot commit anything. */
export function revokeOldGenerations(attemptId, currentGeneration) {
  for (const binding of bindings.values()) {
    if (binding.attemptId === attemptId && binding.generation < currentGeneration) binding.revoked = true;
  }
}

export function disableAttemptWrites(attemptId) {
  for (const binding of bindings.values()) {
    if (binding.attemptId === attemptId) binding.writesDisabled = true;
  }
}

export function activeBindingCount() {
  return bindings.size;
}

export function resetDispatcherForTests() {
  bindings.clear();
}

// ---------------------------------------------------------------- execution

/**
 * One worker tool call through the bridge.
 * @returns {Promise<{ok: true, callId, data, effects}|{ok: false, callId, error, effects}>}
 */
export async function dispatchTool(binding, rawBody, services = {}) {
  const parsed = BridgeCallSchema.safeParse(rawBody || {});
  if (!parsed.success) {
    return { ok: false, callId: rawBody?.callId || 'unknown', effects: [], error: execError('INPUT_INVALID', 'Malformed tool call') };
  }
  const { callId, toolId, manifestRevision, args } = parsed.data;
  // Resolve the LIVE binding for this token; anything else (revoked process,
  // unknown token, stale reference) is a stale attempt.
  const live = getBindingByToken(binding?.token);
  if (!live) {
    return { ok: false, callId, effects: [], error: execError('STALE_ATTEMPT', 'This attempt token is no longer valid') };
  }
  binding = live;
  const ctxBase = {
    runRef: binding.runRef,
    runKind: binding.runKind,
    attemptId: binding.attemptId,
    requestId: callId,
    sessionId: binding.sessionId,
    parentRunId: binding.parentRunId || null,
    userId: binding.userId,
    companyId: binding.companyId,
    profileId: binding.profileId,
    leaseGeneration: binding.generation,
  };

  try {
    if (binding.manifestRevision !== manifestRevision) {
      return toolError(callId, execError('INPUT_INVALID', 'Tool manifest does not match this attempt; the run must restart to pick up tool changes'));
    }
    if (binding.revoked || binding.generation !== binding.expectedGeneration) {
      return toolError(callId, execError('STALE_ATTEMPT', 'A newer attempt owns this work'));
    }
    if (toolId === 'finish_run') {
      // Checked before stopRequested so a repeated identical proposal still gets its ack.
      if (!services.onFinishRun) return toolError(callId, execError('EXECUTION_FAILED', 'Completion protocol is not wired'));
      return services.onFinishRun(binding, callId, args ?? {});
    }
    if (binding.stopRequested) {
      return toolError(callId, execError('CANCELLED', 'Cancellation was requested for this run; no new calls are accepted'));
    }

    const op = getOperation(toolId, binding.profileId);
    if (!op) return toolError(callId, execError('NOT_FOUND', `Unknown operation: ${toolId}`));
    if (binding.manifestToolIds && !binding.manifestToolIds.includes(toolId)) {
      return toolError(callId, execError('PERMISSION_DENIED', `${toolId} is not available to this profile`));
    }
    if (op.effect !== 'read' && op.effect !== 'control' && binding.writesDisabled) {
      return toolError(callId, execError('PERMISSION_DENIED', 'Business writes are disabled for this attempt (completion-only repair)'));
    }

    // Fresh authorization inputs for every call (spec §7.4), including
    // transport replays: a logout/deactivation cannot be bypassed by replaying
    // a previously successful result.
    const user = binding.userId && services.userLookup ? await services.userLookup(binding.userId, binding) : null;
    const ctx = { ...ctxBase, user };
    if (op.access?.user && !user) return toolError(callId, execError('SIGN_IN_REQUIRED', 'Sign-in required for this operation'));
    if (Array.isArray(op.access?.roles) && (!user || !op.access.roles.includes(user.role))) {
      return toolError(callId, execError('PERMISSION_DENIED', 'This operation requires a permitted host role'));
    }
    if (op.access?.company && !ctx.companyId) return toolError(callId, execError('PERMISSION_DENIED', 'A company context is required for this operation'));
    if (Array.isArray(op.access?.profileIds) && !op.access.profileIds.includes(ctx.profileId)) {
      return toolError(callId, execError('PERMISSION_DENIED', 'This operation is not available to this profile'));
    }
    const parsedArgs = op.inputSchema.safeParse(args ?? {});
    if (!parsedArgs.success) {
      const issues = parsedArgs.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      return toolError(callId, execError('INPUT_INVALID', `Invalid input for ${toolId}: ${issues}`));
    }

    // Reserve a call identity before invoking any effect. A concurrent retry
    // either replays the completed row or waits for its owner to settle.
    const digest = digestArgs(args ?? {});
    const callMeta = { attemptId: binding.attemptId, id: callId, runRef: binding.runRef, runKind: binding.runKind,
      operationId: op.id, operationVersion: op.version, manifestRevision: binding.manifestRevision,
      argumentDigest: digest, argsRedacted: redactArgs(args ?? {}) };
    const existing = await store.getToolCall(binding.attemptId, callId);
    if (existing) {
      if (existing.argumentDigest !== digest || existing.operationId !== op.id || existing.operationVersion !== op.version) {
        return toolError(callId, execError('CONFLICT', 'This call id was already used with different operation or arguments'));
      }
      if (existing.status === 'running') {
        const settled = await store.waitForToolCall(binding.attemptId, callId, Math.min(30_000, binding.deadlineAt ? Math.max(1, new Date(binding.deadlineAt).getTime() - Date.now()) : 30_000));
        if (!settled || settled.status === 'running') return toolError(callId, execError('CONFLICT', 'This call is still in progress; inspect its persisted status before retrying'));
        return settled.status === 'ok'
          ? { ok: true, callId, data: settled.result, effects: settled.receipts || [] }
          : { ok: false, callId, effects: settled.receipts || [], error: settled.error };
      }
      return existing.status === 'ok'
        ? { ok: true, callId, data: existing.result, effects: existing.receipts || [] }
        : { ok: false, callId, effects: existing.receipts || [], error: existing.error };
    }
    const reserved = await store.reserveToolCall(callMeta);
    if (reserved !== 'reserved') {
      const winner = await store.getToolCall(binding.attemptId, callId);
      if (winner?.argumentDigest !== digest || winner?.operationId !== op.id || winner?.operationVersion !== op.version) {
        return toolError(callId, execError('CONFLICT', 'This call id was already used with different operation or arguments'));
      }
      return winner?.status === 'ok'
        ? { ok: true, callId, data: winner.result, effects: winner.receipts || [] }
        : toolError(callId, winner?.error || execError('CONFLICT', 'This call is already in progress'));
    }
    await store.recordEvent({ kind: 'tool.started', sessionId: binding.sessionId, runRef: binding.runRef, attemptId: binding.attemptId,
      data: { callId, operation: toolId, args: redactArgs(args ?? {}) } });
    services.onToolEvent?.({ phase: 'start', callId, name: toolId, attemptId: binding.attemptId });

    const outcome = await executeOperation(op, ctx, parsedArgs.data, binding, callId, services);
    services.onToolEvent?.({ phase: 'end', callId, name: toolId, ok: outcome.ok, attemptId: binding.attemptId });
    return outcome;
  } catch (error) {
    return toolError(callId, error?.execCode
      ? execError(error.execCode, error.message)
      : execError('EXECUTION_FAILED', error?.message || 'Operation failed'));
  }
}

async function executeOperation(op, ctx, args, binding, callId, services) {
  const timeoutMs = Math.max(1000, op.timeoutMs || 30_000);
  if (op.sameTx) return executeSameTx(op, ctx, args, binding, callId, services, timeoutMs);
  try {
    const result = await withTimeout(op.execute(ctx, args, services), timeoutMs, op);
    return journalAndRespond(op, binding, callId, args, result);
  } catch (error) {
    const execErr = error?.execCode ? execError(error.execCode, error.message) : execError('EXECUTION_FAILED', error?.message || 'Operation failed');
    return journalFailure(op, ctx, binding, callId, args, readControlFailure(op, execErr), services);
  }
}

/** Business write, effect journal and tool-call result commit in the SAME transaction. */
async function executeSameTx(op, ctx, args, binding, callId, services, timeoutMs) {
  const pool = services.pool || getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (ctx.companyId) {
      await client.query("SELECT set_config('di.tenant_id',$1,true), set_config('di.actor',$2,true), set_config('di.actor_user_id',$3,true)",
        [ctx.companyId, ctx.user?.username || 'agent', ctx.userId || '']);
    }
    const executePromise = op.execute({ ...ctx, tx: client }, args, services);
    let result;
    try {
      result = await withTimeout(executePromise, timeoutMs, op);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    const receipts = receiptsForOperation(op, result);
    const effectState = effectStateFor(op, result);
    const call = {
      attemptId: binding.attemptId, id: callId, runRef: binding.runRef, runKind: binding.runKind,
      operationId: op.id, operationVersion: op.version, manifestRevision: binding.manifestRevision,
      argumentDigest: digestArgs(args), argsRedacted: redactArgs(args),
      status: 'ok', effectState, result, receipts,
    };
    await store.updateToolCall(call, client);
    await store.recordEvent({ kind: 'tool.finished', sessionId: binding.sessionId, runRef: binding.runRef, attemptId: binding.attemptId,
      data: { callId, operation: op.id, status: 'ok', effectState, receipts } }, client);
    await client.query('COMMIT');
    return { ok: true, callId, data: result, effects: receipts };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    const execErr = error?.execCode ? execError(error.execCode, error.message) : execError('EXECUTION_FAILED', error?.message || 'Operation failed');
    return journalFailure(op, ctx, binding, callId, args, readControlFailure(op, execErr), services);
  } finally {
    client.release();
  }
}

/** A timed-out read or control call did not write. Unknown is only for writes. */
function readControlFailure(op, execErr) {
  if ((op.effect === 'read' || op.effect === 'control') && execErr?.effectState === 'unknown') {
    return { ...execErr, effectState: 'none' };
  }
  return execErr;
}

async function journalFailure(op, _ctx, binding, callId, args, execErr) {
  const call = {
    attemptId: binding.attemptId, id: callId, runRef: binding.runRef, runKind: binding.runKind,
    operationId: op.id, operationVersion: op.version, manifestRevision: binding.manifestRevision,
    argumentDigest: digestArgs(args), argsRedacted: redactArgs(args),
    status: 'error', effectState: execErr.effectState, error: execErr, receipts: [],
  };
  await store.updateToolCall(call).catch(() => {});
  await store.recordEvent({ kind: 'tool.finished', sessionId: binding.sessionId, runRef: binding.runRef, attemptId: binding.attemptId,
    data: { callId, operation: op.id, status: 'error', error: execErr } }).catch(() => {});
  return toolError(callId, execErr);
}

async function journalAndRespond(op, binding, callId, args, result) {
  const receipts = receiptsForOperation(op, result);
  const effectState = effectStateFor(op, result);
  await store.updateToolCall({
    attemptId: binding.attemptId, id: callId, runRef: binding.runRef, runKind: binding.runKind,
    operationId: op.id, operationVersion: op.version, manifestRevision: binding.manifestRevision,
    argumentDigest: digestArgs(args), argsRedacted: redactArgs(args),
    status: 'ok', effectState, result, receipts,
  });
  await store.recordEvent({ kind: 'tool.finished', sessionId: binding.sessionId, runRef: binding.runRef, attemptId: binding.attemptId,
    data: { callId, operation: op.id, status: 'ok', effectState, receipts } });
  return { ok: true, callId, data: result, effects: receipts };
}

async function withTimeout(promise, timeoutMs, op) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(`${op.id} exceeded its ${Math.round(timeoutMs / 1000)}s deadline`), { execCode: 'OPERATION_DEADLINE' }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function toolError(callId, error) {
  return { ok: false, callId, effects: [], error };
}

/** Receipts are host-issued references to what an operation actually produced. */
export function receiptsForOperation(op, result) {
  if (op.effect === 'read' || op.effect === 'control') return [];
  if (Array.isArray(result?.effects)) return result.effects;
  const receipts = [];
  const reference = result?.person?.member_id || result?.person?.user_id
    || (result?.revision != null ? `company_profile:rev${result.revision}` : null);
  if (reference) {
    receipts.push({ id: newId(), operationId: op.id, kind: 'record', reference,
      revision: result?.revision != null ? String(result.revision) : undefined });
  }
  for (const file of Array.isArray(result?.shared_files) ? result.shared_files : []) {
    receipts.push({ id: newId(), operationId: op.id, kind: 'file', reference: file?.id || file?.url || String(file) });
  }
  if (result?.pdf?.url && !result?.pdf?.error) {
    receipts.push({ id: newId(), operationId: op.id, kind: 'file', reference: result.pdf.url });
  }
  return receipts;
}

function effectStateFor(op, result) {
  if (op.effect === 'read' || op.effect === 'control') return 'none';
  const partial = Boolean(result?.pdf?.error) || /could not be made|PDF could not/i.test(String(result?.note || ''));
  return partial ? 'partial' : 'committed';
}
