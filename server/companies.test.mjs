// A company is created together with its Superadmin, and keeps at least one. Real DI migrations
// on an embedded Postgres (PGlite); only the pool is injected.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate, pgliteAdapter } from '../document_inteligence/core/db.mjs';

const poolHolder = { current: null };
mock.module('./db.mjs', {
  namedExports: { getPool: () => { if (!poolHolder.current) throw new Error('Test pool is not ready'); return poolHolder.current; } },
});
const { ensureUsers } = await import('./users.mjs');
const { createCompany, listCompanies, companiesWithoutSuperadmin } = await import('./companies.mjs');
const { managePeopleCore } = await import('./people-service.mjs');

async function makeDb() {
  const pglite = new PGlite();
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  };
  const query = async (sql, params) => {
    const result = params?.length ? await pglite.query(sql, params) : (await pglite.exec(sql)).at(-1);
    return { rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const pool = {
    query: async (sql, params) => { const release = await acquire(); try { return await query(sql, params); } finally { release(); } },
    connect: async () => { const release = await acquire(); return { query, release }; },
  };
  await pool.query(`CREATE TABLE sessions (id text PRIMARY KEY, title text DEFAULT 'New chat', parent_session_id text, updated_at timestamptz DEFAULT NOW())`);
  await pool.query(`CREATE TABLE agents (id text PRIMARY KEY)`);
  await pool.query(`INSERT INTO agents(id) VALUES ('orchestrator'),('di-documents'),('di-expenses'),('website'),('proposal')`);
  await ensureUsers(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_agents (user_id TEXT REFERENCES users(id) ON DELETE CASCADE, agent_id TEXT, PRIMARY KEY (user_id, agent_id))`);
  poolHolder.current = pool;
  await migrate(pgliteAdapter(pglite));
  return pool;
}

async function inTx(pool, tenantId, action, input, context) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('di.tenant_id',$1,true)", [tenantId]);
    const result = await managePeopleCore(client, action, input, context);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const platformActor = { id: 'platform', role: 'admin', active: true, username: 'platform' };

test('a new company comes with its Superadmin and the company agents only', async () => {
  const pool = await makeDb();
  const made = await createCompany({ name: 'Alpha Sdn Bhd', username: 'Alpha-Admin', password: 'correct horse' }, pool);
  assert.match(made.tenantId, /^[0-9a-f-]{36}$/);
  assert.equal(made.username, 'alpha-admin');
  const user = (await pool.query('SELECT role, active, company_tenant_id FROM users WHERE id=$1', [made.userId])).rows[0];
  assert.deepEqual([user.role, user.active, user.company_tenant_id], ['admin', true, made.tenantId]);
  const agents = (await pool.query('SELECT agent_id FROM user_agents WHERE user_id=$1 ORDER BY agent_id', [made.userId])).rows.map((row) => row.agent_id);
  assert.deepEqual(agents, ['di-documents', 'di-expenses', 'orchestrator'], 'platform agents are not assigned');
  const seeded = (await pool.query('SELECT COUNT(*)::int AS n FROM di.tax_code WHERE tenant_id=$1', [made.tenantId])).rows[0].n;
  assert.ok(seeded > 0, 'the company has its default records');
  assert.deepEqual(await companiesWithoutSuperadmin(pool), []);
  assert.equal((await listCompanies(pool)).find((c) => c.id === made.tenantId).superadmins, 1);
});

test('a failed creation leaves no company behind', async () => {
  const pool = await makeDb();
  await createCompany({ name: 'Alpha', username: 'taken', password: 'correct horse' }, pool);
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM di.tenant')).rows[0].n;
  await assert.rejects(() => createCompany({ name: 'Beta', username: 'taken', password: 'correct horse' }, pool), /Username already exists/);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM di.tenant')).rows[0].n, before);
  for (const bad of [{ name: '', username: 'x', password: 'correct horse' }, { name: 'C', username: 'Bad Name!', password: 'correct horse' }, { name: 'C', username: 'ok', password: 'short' }]) {
    await assert.rejects(() => createCompany(bad, pool));
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM di.tenant')).rows[0].n, before);
});

test('a company that loses its Superadmin is reported', async () => {
  const pool = await makeDb();
  const made = await createCompany({ name: 'Alpha', username: 'alpha', password: 'correct horse' }, pool);
  await pool.query('UPDATE users SET active=false WHERE id=$1', [made.userId]);
  assert.deepEqual((await companiesWithoutSuperadmin(pool)).map((c) => c.id), [made.tenantId]);
});

test("each company keeps its own last Superadmin: another company's admin does not count", async () => {
  const pool = await makeDb();
  const a = await createCompany({ name: 'Alpha', username: 'alpha', password: 'correct horse' }, pool);
  const b = await createCompany({ name: 'Beta', username: 'beta', password: 'correct horse' }, pool);
  const ctx = (tenantId) => ({ tenantId, actorUser: platformActor });
  await assert.rejects(() => inTx(pool, a.tenantId, 'update_person', { user_id: a.userId, role: 'user' }, ctx(a.tenantId)), /last active Superadmin/);
  await assert.rejects(() => inTx(pool, b.tenantId, 'update_person', { user_id: b.userId, active: false }, ctx(b.tenantId)), /last active Superadmin/);
  // With a second Superadmin the first may step down.
  await pool.query("INSERT INTO users(id,username,display_name,password_hash,role,company_tenant_id) VALUES ('a2','alpha2','Alpha Two','x:y','admin',$1)", [a.tenantId]);
  const stepped = await inTx(pool, a.tenantId, 'update_person', { user_id: a.userId, role: 'user' }, ctx(a.tenantId));
  assert.equal(stepped.person.role, 'user');
  assert.equal((await pool.query('SELECT role FROM users WHERE id=$1', [b.userId])).rows[0].role, 'admin');
});
