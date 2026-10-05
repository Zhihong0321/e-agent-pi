// Execution persistence: run records, tool-call journal, durable events and
// submission deduplication. Additive migrations on the existing Postgres;
// specialists keep living in orchestrator_plans/tasks/attempts (extended),
// conversational runs get their own execution_runs record.
import { getPool } from '../db.mjs';

let poolOverride = null;
export function setExecutionPool(pool) {
  poolOverride = pool;
}
function db() {
  return poolOverride || getPool();
}

let ready;
export function ensureExecutionSchema() {
  if (!ready) ready = migrateExecutionSchema().catch((error) => { ready = undefined; throw error; });
  return ready;
}

export function resetSchemaMemoForTests() {
  ready = undefined;
}

async function migrateExecutionSchema() {
  const pool = db();
  // Base delegation tables, in case the execution schema initializes before the
  // legacy orchestrator migration runs (idempotent, same columns).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orchestrator_plans (
      id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      summary TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orchestrator_tasks (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES orchestrator_plans(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL DEFAULT '',
      depends_on TEXT[] NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      child_session_id TEXT,
      result TEXT,
      error TEXT,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orchestrator_attempts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES orchestrator_tasks(id) ON DELETE CASCADE,
      child_session_id TEXT, status TEXT NOT NULL, result TEXT, error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS execution_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      company_id TEXT,
      profile_id TEXT NOT NULL,
      profile_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      submission_key TEXT NOT NULL,
      submission_digest TEXT,
      kind TEXT NOT NULL DEFAULT 'chat',
      status TEXT NOT NULL DEFAULT 'queued',
      outcome JSONB,
      error JSONB,
      attempt_id TEXT,
      generation INT NOT NULL DEFAULT 0,
      deadline_at TIMESTAMPTZ,
      stop_requested BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS execution_runs_submission_idx
      ON execution_runs (session_id, submission_key);
    CREATE INDEX IF NOT EXISTS execution_runs_session_idx ON execution_runs (session_id, created_at);

    CREATE TABLE IF NOT EXISTS execution_tool_calls (
      attempt_id TEXT NOT NULL,
      id TEXT NOT NULL,
      run_ref TEXT NOT NULL,
      run_kind TEXT NOT NULL DEFAULT 'chat',
      operation_id TEXT NOT NULL,
      operation_version INT NOT NULL DEFAULT 1,
      manifest_revision TEXT NOT NULL DEFAULT '',
      argument_digest TEXT NOT NULL,
      args_redacted JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL,
      effect_state TEXT NOT NULL DEFAULT 'none',
      result JSONB,
      error JSONB,
      receipts JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (attempt_id, id)
    );

    CREATE TABLE IF NOT EXISTS execution_events (
      id BIGSERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      session_id TEXT,
      run_ref TEXT,
      attempt_id TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS execution_events_run_idx ON execution_events (run_ref, id);

    CREATE TABLE IF NOT EXISTS execution_submissions (
      owner_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      submission_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_id, session_id, submission_key)
    );

    ALTER TABLE execution_runs ADD COLUMN IF NOT EXISTS submission_digest TEXT;
    ALTER TABLE orchestrator_plans ADD COLUMN IF NOT EXISTS executor_version TEXT NOT NULL DEFAULT 'v1';
    ALTER TABLE orchestrator_plans ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
    ALTER TABLE orchestrator_plans ADD COLUMN IF NOT EXISTS company_id TEXT;
    ALTER TABLE orchestrator_plans ADD COLUMN IF NOT EXISTS submission_key TEXT;
    ALTER TABLE orchestrator_plans ADD COLUMN IF NOT EXISTS request_deadline_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_plans_submission_idx
      ON orchestrator_plans (parent_session_id, submission_key) WHERE submission_key IS NOT NULL;

    ALTER TABLE orchestrator_tasks ADD COLUMN IF NOT EXISTS executor_version TEXT NOT NULL DEFAULT 'v1';
    ALTER TABLE orchestrator_tasks ADD COLUMN IF NOT EXISTS profile_snapshot JSONB;
    ALTER TABLE orchestrator_tasks ADD COLUMN IF NOT EXISTS output_contract TEXT NOT NULL DEFAULT 'generic';
    ALTER TABLE orchestrator_tasks ADD COLUMN IF NOT EXISTS generation INT NOT NULL DEFAULT 0;
    ALTER TABLE orchestrator_tasks ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
    ALTER TABLE orchestrator_tasks ADD COLUMN IF NOT EXISTS stop_requested BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE orchestrator_tasks ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS generation INT NOT NULL DEFAULT 0;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS stop_requested BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS worker_token_hash TEXT;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS manifest_revision TEXT;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS run_kind TEXT NOT NULL DEFAULT 'task';
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS run_ref TEXT;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS profile_id TEXT;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS user_id TEXT;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS company_id TEXT;
    ALTER TABLE orchestrator_attempts ADD COLUMN IF NOT EXISTS session_id TEXT;
  `);
}

// ---------------------------------------------------------------- events

export async function recordEvent({ kind, sessionId = null, runRef = null, attemptId = null, data = {} }, client) {
  const pool = client || db();
  await pool.query(
    `INSERT INTO execution_events (kind, session_id, run_ref, attempt_id, data) VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [kind, sessionId, runRef, attemptId, JSON.stringify(data || {})],
  );
}

export async function listEvents({ sessionId, runRef, after = 0, limit = 200 }) {
  const clauses = ['id > $1'];
  const values = [after];
  if (sessionId) { values.push(sessionId); clauses.push(`session_id = $${values.length}`); }
  if (runRef) { values.push(runRef); clauses.push(`run_ref = $${values.length}`); }
  const result = await db().query(
    `SELECT id, kind, session_id AS "sessionId", run_ref AS "runRef", attempt_id AS "attemptId", data, created_at AS "createdAt"
     FROM execution_events WHERE ${clauses.join(' AND ')} ORDER BY id ASC LIMIT ${Math.min(1000, Math.max(1, limit))}`,
    values,
  );
  return result.rows;
}

// ---------------------------------------------------------------- chat runs

export async function createChatRun({ id, sessionId, userId, companyId, profileId, profileSnapshot, submissionKey, submissionDigest, deadlineAt }) {
  await db().query(
    `INSERT INTO execution_runs (id, session_id, user_id, company_id, profile_id, profile_snapshot, submission_key, submission_digest, kind, status, deadline_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'chat','queued',$9)`,
    [id, sessionId, userId, companyId, profileId, JSON.stringify(profileSnapshot || {}), submissionKey, submissionDigest || null, deadlineAt],
  );
}

export async function getChatRun(id) {
  const result = await db().query(`SELECT id, session_id AS "sessionId", user_id AS "userId", company_id AS "companyId",
    profile_id AS "profileId", profile_snapshot AS "profileSnapshot", submission_key AS "submissionKey", submission_digest AS "submissionDigest", kind,
    status, outcome, error, attempt_id AS "attemptId", generation, deadline_at AS "deadlineAt",
    stop_requested AS "stopRequested", created_at AS "createdAt", finished_at AS "finishedAt"
    FROM execution_runs WHERE id=$1`, [id]);
  return result.rows[0] || null;
}

/** The submission dedup lookup — same session + key returns the existing run. */
export async function findChatRunBySubmission(sessionId, submissionKey) {
  const result = await db().query(`SELECT id, session_id AS "sessionId", user_id AS "userId", company_id AS "companyId",
    profile_id AS "profileId", profile_snapshot AS "profileSnapshot", submission_key AS "submissionKey", submission_digest AS "submissionDigest", kind,
    status, outcome, error, attempt_id AS "attemptId", generation, deadline_at AS "deadlineAt",
    stop_requested AS "stopRequested", created_at AS "createdAt", finished_at AS "finishedAt"
    FROM execution_runs WHERE session_id=$1 AND submission_key=$2`, [sessionId, submissionKey]);
  return result.rows[0] || null;
}

/**
 * History for chats saved before Pi answers were stored: an assistant message whose
 * transcript has no text takes the summary recorded on the finished run that was active
 * when the message was created. Nothing is rewritten in storage.
 */
export async function withRecordedAnswers(sessionId, messages) {
  const transcripts = new Map();
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content !== 'string' || message.content[0] !== '{') continue;
    try {
      const transcript = JSON.parse(message.content);
      if (transcript?.v === 1 && !transcript.text && !transcript.streaming) transcripts.set(message, transcript);
    } catch { /* plain text message */ }
  }
  if (!transcripts.size) return messages;
  const runs = (await db().query(
    `SELECT created_at AS "createdAt", finished_at AS "finishedAt", outcome FROM execution_runs
     WHERE session_id=$1 AND kind='chat' AND status='done' AND outcome IS NOT NULL ORDER BY created_at`, [sessionId])).rows;
  return messages.map((message) => {
    const transcript = transcripts.get(message);
    if (!transcript) return message;
    const at = new Date(message.createdAt).getTime();
    const run = runs.find((r) => new Date(r.createdAt).getTime() <= at && (!r.finishedAt || new Date(r.finishedAt).getTime() >= at));
    const summary = run?.outcome?.summary;
    return summary ? { ...message, content: JSON.stringify({ ...transcript, text: summary }) } : message;
  });
}

export async function updateChatRun(id, patch, expectedGeneration) {
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, column] of [
    ['status', 'status'], ['outcome', 'outcome'], ['error', 'error'], ['attemptId', 'attempt_id'],
    ['deadlineAt', 'deadline_at'], ['stopRequested', 'stop_requested'],
  ]) {
    if (patch[key] === undefined) continue;
    fields.push(`${column} = $${i++}`);
    values.push(patch[key] === undefined ? null : typeof patch[key] === 'object' && patch[key] !== null ? JSON.stringify(patch[key]) : patch[key]);
  }
  fields.push(`generation = generation + 1`);
  if (!fields.length) return getChatRun(id);
  fields.push('updated_at = NOW()');
  values.push(id);
  const condition = expectedGeneration === undefined ? '' : ` AND generation = $${i + 1}`;
  if (expectedGeneration !== undefined) values.push(expectedGeneration);
  const result = await db().query(
    `UPDATE execution_runs SET ${fields.join(', ')} WHERE id = $${i}${condition} RETURNING generation`,
    values,
  );
  if (!result.rows.length) return null;
  return getChatRun(id);
}

export async function hasActiveChatRun(sessionId) {
  const result = await db().query(
    `SELECT id FROM execution_runs WHERE session_id=$1 AND status IN ('queued','running') LIMIT 1`, [sessionId]);
  return result.rows[0]?.id || null;
}

// ---------------------------------------------------------------- tool calls

/** Reserve a call identity before invoking any business effect. */
export async function reserveToolCall(call, client) {
  const pool = client || db();
  const result = await pool.query(
    `INSERT INTO execution_tool_calls
       (attempt_id, id, run_ref, run_kind, operation_id, operation_version, manifest_revision,
        argument_digest, args_redacted, status, effect_state, receipts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'running','none','[]'::jsonb)
     ON CONFLICT (attempt_id, id) DO NOTHING RETURNING id`,
    [call.attemptId, call.id, call.runRef, call.runKind, call.operationId, call.operationVersion || 1,
      call.manifestRevision || '', call.argumentDigest, JSON.stringify(call.argsRedacted || {})],
  );
  return result.rows.length ? 'reserved' : 'existing';
}

export async function updateToolCall(call, client) {
  const pool = client || db();
  await pool.query(
    `UPDATE execution_tool_calls SET operation_id=$3, operation_version=$4, manifest_revision=$5,
       argument_digest=$6, args_redacted=$7::jsonb, status=$8, effect_state=$9,
       result=$10::jsonb, error=$11::jsonb, receipts=$12::jsonb
     WHERE attempt_id=$1 AND id=$2`,
    [call.attemptId, call.id, call.operationId, call.operationVersion || 1, call.manifestRevision || '',
      call.argumentDigest, JSON.stringify(call.argsRedacted || {}), call.status, call.effectState,
      call.result === undefined ? null : JSON.stringify(call.result ?? null), call.error ? JSON.stringify(call.error) : null,
      JSON.stringify(call.receipts || [])],
  );
}

/** Idempotent insert: returns 'stored' when a call with the same key already exists. */
export async function recordToolCall(call, client) {
  const pool = client || db();
  const result = await pool.query(
    `INSERT INTO execution_tool_calls
       (attempt_id, id, run_ref, run_kind, operation_id, operation_version, manifest_revision,
        argument_digest, args_redacted, status, effect_state, result, error, receipts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)
     ON CONFLICT (attempt_id, id) DO NOTHING
     RETURNING id`,
    [call.attemptId, call.id, call.runRef, call.runKind, call.operationId, call.operationVersion || 1,
      call.manifestRevision || '', call.argumentDigest, JSON.stringify(call.argsRedacted || {}),
      call.status, call.effectState, call.result === undefined ? null : JSON.stringify(call.result ?? null),
      call.error ? JSON.stringify(call.error) : null, JSON.stringify(call.receipts || [])],
  );
  return result.rows.length ? 'inserted' : 'stored';
}

export async function getToolCall(attemptId, callId) {
  const result = await db().query(
    `SELECT attempt_id AS "attemptId", id, run_ref AS "runRef", run_kind AS "runKind", operation_id AS "operationId",
       operation_version AS "operationVersion", manifest_revision AS "manifestRevision", argument_digest AS "argumentDigest",
       args_redacted AS "argsRedacted", status, effect_state AS "effectState", result, error, receipts, created_at AS "createdAt"
     FROM execution_tool_calls WHERE attempt_id=$1 AND id=$2`, [attemptId, callId]);
  return result.rows[0] || null;
}

export async function waitForToolCall(attemptId, callId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await getToolCall(attemptId, callId);
    if (!row || row.status !== 'running') return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return getToolCall(attemptId, callId);
}

export async function listToolCalls(attemptId) {
  const result = await db().query(
    `SELECT attempt_id AS "attemptId", id, run_ref AS "runRef", run_kind AS "runKind", operation_id AS "operationId",
       status, effect_state AS "effectState", result, error, receipts, created_at AS "createdAt"
     FROM execution_tool_calls WHERE attempt_id=$1 ORDER BY created_at, id`, [attemptId]);
  return result.rows;
}

export async function countToolCalls(attemptId) {
  const result = await db().query(`SELECT COUNT(*)::int AS n FROM execution_tool_calls WHERE attempt_id=$1`, [attemptId]);
  return result.rows[0]?.n || 0;
}

// ---------------------------------------------------------------- attempts

export async function startAttempt({ attemptId, runRef, runKind, profileId, sessionId, userId, companyId, generation, workerTokenHash, manifestRevision, deadlineAt, taskId }) {
  if (runKind === 'task') {
    await db().query(
      `INSERT INTO orchestrator_attempts (id, task_id, status, generation, lease_until, deadline_at, worker_token_hash, manifest_revision, run_kind, run_ref, profile_id, user_id, company_id, session_id)
       VALUES ($1,$2,'running',$3,NOW() + INTERVAL '120 seconds',$4,$5,$6,'task',$7,$8,$9,$10,$11)`,
      [attemptId, taskId, generation, deadlineAt, workerTokenHash, manifestRevision, runRef, profileId, userId, companyId, sessionId],
    );
    return;
  }
  // Chat attempts are the execution_runs row itself; token hash lives only in memory.
  await updateChatRun(runRef, { attemptId });
}

export async function heartbeatAttempt(attemptId, runKind) {
  if (runKind === 'task') {
    await db().query(
      `UPDATE orchestrator_attempts SET lease_until = NOW() + INTERVAL '120 seconds' WHERE id=$1 AND status='running'`,
      [attemptId],
    );
  }
}

export async function finishAttempt({ attemptId, runKind, status, result, error }) {
  if (runKind === 'task') {
    await db().query(
      `UPDATE orchestrator_attempts SET status=$2, result=$3, error=$4, finished_at=NOW() WHERE id=$1`,
      [attemptId, status, result ?? null, error ? JSON.stringify(error) : null],
    );
  }
}

// ---------------------------------------------------------------- reconciliation

/** Attempts that were running when a previous host died: they are never replayed blindly. */
export async function listInterruptedAttempts() {
  const tasks = await db().query(
    `SELECT t.id AS run_ref, t.status, a.id AS attempt_id, a.generation
     FROM orchestrator_tasks t JOIN orchestrator_attempts a ON a.task_id=t.id
     WHERE t.executor_version='v2' AND t.status='running'
       AND (a.lease_until IS NULL OR a.lease_until < NOW()) AND a.status='running'`);
  const chats = await db().query(
    `SELECT id AS run_ref, status, attempt_id, generation FROM execution_runs
     WHERE status='running' AND updated_at < NOW() - INTERVAL '5 minutes'`);
  return [...tasks.rows, ...chats.rows];
}
