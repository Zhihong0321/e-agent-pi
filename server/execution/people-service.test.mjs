// Vertical slice acceptance: real people handlers + real DI migrations on an
// embedded Postgres (PGlite). Covers empty, contact-only, login-only and linked
// records, identifier domains (uuid member ids vs textual user ids), and the
// shared people service used by both UI routes and agent tools.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate, pgliteAdapter } from '../../document_inteligence/core/db.mjs';
import { ensureDefaultTenant, seedTenant } from '../../document_inteligence/core/seed.mjs';

// Inject the embedded Postgres as the service's pool before importing the
// modules under test (they read getPool() from server/db.mjs).
const poolHolder = { current: null };
mock.module('../db.mjs', {
  namedExports: {
    getPool: () => {
      if (!poolHolder.current) throw new Error('Test pool is not ready');
      return poolHolder.current;
    },
  },
});
const { ensureUsers, managePeople } = await import('../users.mjs');
const { countUserAccounts, listPeople, managePeopleCore } = await import('../people-service.mjs');

const admin = { id: 'user-admin', role: 'admin', active: true, username: 'admin' };

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
  await ensureUsers(pool);
  poolHolder.current = pool;
  const db = pgliteAdapter(pglite);
  await migrate(db);
  const tenantId = await ensureDefaultTenant(db);
  await seedTenant(db, tenantId);
  return { pool, tenantId };
}

/** Runs managePeopleCore inside a real transaction with the tenant pinned, as the dispatcher will. */
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

const asAdmin = (tenantId) => ({ tenantId, actorUser: admin });

test('people service on real migrations: empty, contact-only, login-only and linked records', async () => {
  const { pool, tenantId } = await makeDb();
  await pool.query(`INSERT INTO users (id, username, display_name, password_hash, role, company_tenant_id)
    VALUES ('u-1','maya','Maya Tan','x:y','user',$1)`, [tenantId]);

  // Empty: no members yet; only the login-only user exists.
  let people = await listPeople(tenantId);
  assert.equal(people.people.length, 1, 'login-only user is listed');
  assert.equal(people.people[0].id, 'u-1', 'identifier stays the textual host user id');
  assert.equal(people.people[0].has_login, true);
  let count = await countUserAccounts(tenantId);
  assert.deepEqual([count.company_people, count.with_logins, count.contact_only, count.login_accounts], [0, 0, 0, 1]);

  // Contact-only person.
  const created = await inTx(pool, tenantId, 'create_person',
    { name: 'Daniel Lee', position: 'Ops', department: 'Operations', email: 'daniel@acme.test' }, asAdmin(tenantId));
  assert.ok(created.person.member_id, 'contact-only person gets a uuid member id');
  assert.equal(created.person.has_login, false);
  assert.match(String(created.person.member_id), /^[0-9a-f-]{36}$/);

  people = await listPeople(tenantId);
  assert.equal(people.people.length, 2);
  count = await countUserAccounts(tenantId);
  assert.deepEqual([count.company_people, count.with_logins, count.contact_only], [1, 0, 1]);

  // Link the login-only user to the member — one linked row, no duplication.
  const linked = await inTx(pool, tenantId, 'update_person',
    { person_id: created.person.member_id, user_id: 'u-1' }, asAdmin(tenantId));
  assert.equal(linked.person.user_id, 'u-1');
  assert.equal(linked.person.has_login, true);
  people = await listPeople(tenantId);
  assert.equal(people.people.length, 1, 'linked person is not duplicated');
  assert.equal(people.people[0].name, 'Daniel Lee');
  assert.equal(people.people[0].username, 'maya');
  count = await countUserAccounts(tenantId);
  assert.deepEqual([count.company_people, count.with_logins, count.contact_only, count.login_accounts], [1, 1, 0, 1]);
});

test('people service refuses duplicates, login creation without credentials, and cross-tenant logins', async () => {
  const { pool, tenantId } = await makeDb();
  const first = await inTx(pool, tenantId, 'create_person', { name: 'Amy', email: 'amy@acme.test' }, asAdmin(tenantId));

  await assert.rejects(() => inTx(pool, tenantId, 'create_person',
    { name: 'Different Name', email: 'AMY@acme.test' }, asAdmin(tenantId)), /already exists/);

  await assert.rejects(() => inTx(pool, tenantId, 'create_person',
    { name: 'Bob', username: 'bob' }, asAdmin(tenantId)), /Username and password are required/);

  await assert.rejects(() => inTx(pool, tenantId, 'create_person',
    { name: 'Bob', username: 'bob', password: '1234' }, { ...asAdmin(tenantId), actorUser: { ...admin, role: 'user' } }),
    /Login access can only be managed by an admin/);

  // A login that belongs to another company is refused.
  await pool.query(`INSERT INTO users (id, username, display_name, password_hash, role, company_tenant_id)
    VALUES ('u-other','carol','Carol','x:y','user','00000000-0000-0000-0000-000000000001')`);
  await assert.rejects(() => inTx(pool, tenantId, 'create_person',
    { name: 'Carol Same', user_id: 'u-other' }, asAdmin(tenantId)), /belongs to another company/);

  // Passwords are never returned by the service.
  const withLogin = await inTx(pool, tenantId, 'create_person',
    { name: 'Dave', username: 'dave', password: '1234' }, asAdmin(tenantId));
  assert.ok(!JSON.stringify(withLogin).includes('password_hash'));
  assert.equal(withLogin.person.username, 'dave');
  assert.ok(first.person.id);
});

test('same business result through the legacy managePeople wrapper and the dispatcher path', async () => {
  const { pool, tenantId } = await makeDb();
  await pool.query(`INSERT INTO users (id, username, display_name, password_hash, role, company_tenant_id)
    VALUES ('u-admin','root','Root','x:y','admin',$1)`, [tenantId]);
  const viaWrapper = await managePeople('create_person', { name: 'Eve', department: 'Sales' }, { tenantId, actorUserId: 'u-admin' });
  const viaCore = await inTx(pool, tenantId, 'create_person', { name: 'Eve Two', department: 'Sales' }, asAdmin(tenantId));
  assert.equal(viaWrapper.person.department, 'Sales');
  assert.equal(viaCore.person.department, 'Sales');
  const people = await listPeople(tenantId);
  assert.equal(people.people.length, 3, 'two members plus the root login-only row');
});
