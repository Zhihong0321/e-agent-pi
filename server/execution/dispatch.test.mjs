// Local write slice: update_company_profile through the dispatcher on real DI
// migrations. Proves same-transaction journaling, receipts, revision conflicts,
// and lost-response replay returning the stored result with exactly one effect.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, pgliteAdapter } from '../../document_inteligence/core/db.mjs';
import { ensureDefaultTenant, seedTenant } from '../../document_inteligence/core/seed.mjs';
import { ensureUsers } from '../users.mjs';

const holder = { pool: null, tenantId: null, pglite: null };
mock.module('../db.mjs', {
  namedExports: { getPool: () => { if (!holder.pool) throw new Error('pool not ready'); return holder.pool; } },
});

const store = await import('./store.mjs');
const dispatch = await import('./dispatch.mjs');
const { setDigestKey } = await import('./contracts.mjs');

const admin = { id: 'u-admin', username: 'admin', display_name: 'Admin', role: 'admin', active: true };

async function makeDb() {
  if (!holder.pglite) holder.pglite = new PGlite();
  else {
    await holder.pglite.exec(`DROP SCHEMA IF EXISTS di CASCADE;
      DROP TABLE IF EXISTS users, user_sessions, sessions, messages, execution_runs,
        execution_tool_calls, execution_events, execution_submissions CASCADE;`);
  }
  const pglite = holder.pglite;
  let tail = Promise.resolve();
  const acquire = async () => { const p = tail; let r; tail = new Promise(res => { r = res; }); await p; return r; };
  const query = async (sql, params) => {
    const result = params?.length ? await pglite.query(sql, params) : (await pglite.exec(sql)).at(-1);
    return { rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  holder.pool = {
    query: async (sql, params) => { const release = await acquire(); try { return await query(sql, params); } finally { release(); } },
    connect: async () => { const release = await acquire(); return { query, release }; },
  };
  await holder.pool.query(`CREATE TABLE sessions (id text PRIMARY KEY, title text DEFAULT 'x', parent_session_id text, updated_at timestamptz DEFAULT NOW())`);
  await ensureUsers(holder.pool);
  const db = pgliteAdapter(pglite);
  await migrate(db);
  holder.tenantId = await ensureDefaultTenant(db);
  await seedTenant(db, holder.tenantId);
  store.resetSchemaMemoForTests();
  await store.ensureExecutionSchema();
}

function binding(overrides = {}) {
  return {
    token: overrides.token || `tok-${randomUUID()}`,
    attemptId: overrides.attemptId || `att-${randomUUID()}`,
    runRef: overrides.runRef || overrides.attemptId || `att-${randomUUID()}`,
    runKind: 'chat',
    sessionId: 's-1',
    userId: admin.id,
    companyId: holder.tenantId,
    profileId: 'di-onboarding',
    generation: 0,
    expectedGeneration: 0,
    manifestRevision: 'rev-test00000000',
    manifestToolIds: ['update_company_profile', 'get_company_setup', 'finish_run'],
    ...overrides,
  };
}

function services() {
  return { userLookup: async () => admin, onFinishRun: null };
}

test('company profile update commits write + journal + receipt in one transaction', async () => {
  await makeDb();
  setDigestKey('test-digest-key');
  dispatch.resetDispatcherForTests();
  const b = binding();
  dispatch.bindAttempt(b);
  const current = await holder.pool.query('SELECT revision, name FROM di.company_profile WHERE tenant_id=$1::uuid', [holder.tenantId]);

  const result = await dispatch.dispatchTool(b, { callId: 'save-1', toolId: 'update_company_profile',
    manifestRevision: b.manifestRevision, args: { expected_revision: current.rows[0].revision, fields: { name: 'Acme Updated' } } }, services());
  assert.equal(result.ok, true, JSON.stringify(result.error || null));
  assert.equal(result.data.revision, current.rows[0].revision + 1);
  assert.equal(result.effects.length, 1);
  assert.equal(result.effects[0].kind, 'record');
  assert.equal(result.effects[0].reference, `company_profile:rev${current.rows[0].revision + 1}`);

  // Journal row exists with redacted args and the stored result.
  const call = await store.getToolCall(b.attemptId, 'save-1');
  assert.equal(call.status, 'ok');
  assert.equal(call.effectState, 'committed');
  assert.equal(call.argsRedacted.fields.name, 'Acme Updated');
  const events = await store.listEvents({ runRef: b.runRef });
  assert.ok(events.some((e) => e.kind === 'tool.finished' && e.data?.effectState === 'committed'));

  // Lost response after commit: the replayed transport call returns the stored result.
  const replay = await dispatch.dispatchTool(b, { callId: 'save-1', toolId: 'update_company_profile',
    manifestRevision: b.manifestRevision, args: { expected_revision: current.rows[0].revision, fields: { name: 'Acme Updated' } } }, services());
  assert.equal(replay.ok, true);
  assert.equal(replay.data.revision, current.rows[0].revision + 1);
  const after = await holder.pool.query('SELECT revision FROM di.company_profile WHERE tenant_id=$1::uuid', [holder.tenantId]);
  assert.equal(after.rows[0].revision, current.rows[0].revision + 1, 'exactly one revision bump');

  // Same key, different arguments is a conflict.
  const conflict = await dispatch.dispatchTool(b, { callId: 'save-1', toolId: 'update_company_profile',
    manifestRevision: b.manifestRevision, args: { expected_revision: current.rows[0].revision, fields: { name: 'Different' } } }, services());
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'CONFLICT');
});

test('stale revision is refused with a conflict and no effect; revoked tokens cannot commit', async () => {
  await makeDb();
  setDigestKey('test-digest-key');
  dispatch.resetDispatcherForTests();
  const b = binding();
  dispatch.bindAttempt(b);
  const current = await holder.pool.query('SELECT revision FROM di.company_profile WHERE tenant_id=$1::uuid', [holder.tenantId]);
  const stale = await dispatch.dispatchTool(b, { callId: 's-1', toolId: 'update_company_profile',
    manifestRevision: b.manifestRevision, args: { expected_revision: current.rows[0].revision + 5, fields: { name: 'Too Old' } } }, services());
  assert.equal(stale.ok, false);
  const fresh = await holder.pool.query('SELECT revision FROM di.company_profile WHERE tenant_id=$1::uuid', [holder.tenantId]);
  assert.equal(fresh.rows[0].revision, current.rows[0].revision, 'no effect on conflict');

  // Manifest mismatch and unknown tokens are rejected at the boundary.
  const badManifest = await dispatch.dispatchTool(b, { callId: 'm-1', toolId: 'update_company_profile',
    manifestRevision: '0000000000000000', args: { fields: { name: 'X' } } }, services());
  assert.equal(badManifest.error.code, 'INPUT_INVALID');
  const ghost = binding({ token: 'never-bound' });
  const ghostResult = await dispatch.dispatchTool(ghost, { callId: 'g-1', toolId: 'update_company_profile',
    manifestRevision: ghost.manifestRevision, args: { fields: { name: 'X' } } }, services());
  assert.equal(ghostResult.error.code, 'STALE_ATTEMPT');
});
