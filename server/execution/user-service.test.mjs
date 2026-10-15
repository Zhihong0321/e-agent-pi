// The one user table on real migrations (PGlite): users, categories, the agent tools' path
// (list_users id -> update_user), the Superadmin rules, and the upgrade from the old
// role/tier + di.company_member shape that production still has.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate, pgliteAdapter, withContext } from '../../document_inteligence/core/db.mjs';
import { createTestCompany } from '../../document_inteligence/test/company-fixture.mjs';

const poolHolder = { current: null };
mock.module('../db.mjs', {
  namedExports: {
    getPool: () => {
      if (!poolHolder.current) throw new Error('Test pool is not ready');
      return poolHolder.current;
    },
  },
});
const { ensureUsers } = await import('../users.mjs');
const service = await import('../user-service.mjs');
const { getOperation } = await import('./registry.mjs');

function shim(pglite) {
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
  return {
    query: async (sql, params) => { const release = await acquire(); try { return await query(sql, params); } finally { release(); } },
    connect: async () => { const release = await acquire(); return { query, release }; },
  };
}

async function makeDb() {
  const pglite = new PGlite();
  const pool = shim(pglite);
  await pool.query(`CREATE TABLE sessions (id text PRIMARY KEY, title text DEFAULT 'New chat', parent_session_id text, updated_at timestamptz DEFAULT NOW())`);
  await ensureUsers(pool);
  poolHolder.current = pool;
  const db = pgliteAdapter(pglite);
  await migrate(db);
  return { pool, db };
}

/** A company with a Superadmin who can sign in, as createCompany makes it. */
async function company(pool, db, name) {
  const tenantId = await createTestCompany(db, name);
  await pool.query('SELECT ensure_user_categories($1)', [tenantId]);
  const id = `owner-${name.replace(/\W/g, '')}`;
  await pool.query(`INSERT INTO users (id, company_tenant_id, category_id, display_name, username, password_hash)
    SELECT $1, $2, id, 'Owner', 'owner', 'x:y' FROM user_category WHERE company_tenant_id=$2 AND access='superadmin'`, [id, tenantId]);
  const owner = await service.getUser(pool, tenantId, id);
  return { tenantId, owner, as: { tenantId, actorUser: owner } };
}

test('a new company starts with Superadmin, Department head and Staff; new users get Staff', async () => {
  const { pool, db } = await makeDb();
  const a = await company(pool, db, 'Acme');
  const { categories } = await service.listCategories(a.tenantId);
  assert.deepEqual(categories.map((c) => [c.name, c.access, c.is_default]), [
    ['Superadmin', 'superadmin', false], ['Department head', 'department_head', false], ['Staff', 'user', true]]);
  const { user } = await service.manageUser('create_user', { name: 'Maya Tan', department: 'Sales', email: 'Maya@Acme.test' }, a.as);
  assert.equal(user.category, 'Staff');
  assert.equal(user.access, 'user');
  assert.equal(user.email, 'maya@acme.test');
  assert.equal(user.can_sign_in, false, 'no username and password: on record, cannot sign in');
  const listed = await service.listUsers(a.tenantId);
  assert.equal(listed.summary.total, 2);
  assert.equal(listed.summary.can_sign_in, 1);
  assert.deepEqual(listed.summary.by_category, { Superadmin: 1, Staff: 1 });
});

test('the id list_users returns is the id update_user takes (the "Company person not found" bug)', async () => {
  const { pool, db } = await makeDb();
  const a = await company(pool, db, 'Eternalgy');
  await service.manageUser('create_user', { name: 'Gan Zhi Hong', username: 'zhihong', password: '1234', position: 'Head of IT', department: 'IT' }, a.as);
  const list = getOperation('list_users');
  const update = getOperation('update_user');
  const { users } = await list.execute({ companyId: a.tenantId, userId: a.owner.id, user: a.owner });
  const zhihong = users.find((u) => u.username === 'zhihong');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = { tx: client, companyId: a.tenantId, userId: a.owner.id, user: a.owner };
    const { user } = await update.execute(ctx, update.inputSchema.parse({ id: zhihong.id, category: 'department head' }));
    await client.query('COMMIT');
    assert.equal(user.category, 'Department head');
    assert.equal(user.access, 'department_head');
    assert.equal(user.department, 'IT');
  } finally { client.release(); }
});

test('only a Superadmin writes; a department head needs a department; the last Superadmin stays', async () => {
  const { pool, db } = await makeDb();
  const a = await company(pool, db, 'Acme');
  const { user: staff } = await service.manageUser('create_user', { name: 'Ali', username: 'ali', password: '1234' }, a.as);
  const asStaff = { tenantId: a.tenantId, actorUser: await service.getUser(pool, a.tenantId, staff.id) };
  await assert.rejects(() => service.manageUser('create_user', { name: 'Sneaky' }, asStaff), /Only a Superadmin/);
  await assert.rejects(() => service.manageUser('update_user', { id: staff.id, category: 'Superadmin' }, asStaff), /Only a Superadmin/);
  await assert.rejects(() => service.saveCategory({ name: 'Owners', access: 'superadmin' }, asStaff), /Only a Superadmin/);
  await assert.rejects(() => service.manageUser('update_user', { id: staff.id, category: 'Department head' }, a.as), /needs a department/);
  await assert.rejects(() => service.manageUser('update_user', { id: a.owner.id, category: 'Staff' }, a.as), /last active Superadmin/);
  await assert.rejects(() => service.manageUser('update_user', { id: a.owner.id, active: false }, a.as), /last active Superadmin/);
  await assert.rejects(() => service.manageUser('create_user', { name: 'No Login', password: '1234' }, a.as), /password needs a username/);
  await assert.rejects(() => service.manageUser('update_user', { id: 'nobody' }, a.as), /User not found/);
  await service.manageUser('update_user', { id: staff.id, category: 'Superadmin' }, a.as);
  const stepped = await service.manageUser('update_user', { id: a.owner.id, category: 'Staff' }, a.as);
  assert.equal(stepped.user.access, 'user', 'with a second Superadmin, the first can step down');
});

test('usernames and emails are unique inside a company, not across companies; companies never see each other', async () => {
  const { pool, db } = await makeDb();
  const a = await company(pool, db, 'Acme');
  const b = await company(pool, db, 'Beta');
  await service.manageUser('create_user', { name: 'Bee', username: 'bee', password: '1234', email: 'bee@x.test' }, a.as);
  await assert.rejects(() => service.manageUser('create_user', { name: 'Bee 2', username: 'bee', password: '1234' }, a.as), /Username already exists/);
  await assert.rejects(() => service.manageUser('create_user', { name: 'Bee 3', email: 'BEE@x.test' }, a.as), /already exists with that email/);
  const other = await service.manageUser('create_user', { name: 'Bee B', username: 'bee', password: '1234', email: 'bee@x.test' }, b.as);
  assert.equal(other.user.username, 'bee');
  await assert.rejects(() => service.manageUser('update_user', { id: other.user.id, name: 'Hijack' }, a.as), /User not found/);
  assert.equal((await service.listUsers(a.tenantId)).users.some((u) => u.id === other.user.id), false);
  await assert.rejects(() => service.manageUser('update_user', { id: other.user.id, category: 'Superadmin' }, a.as), /User not found/);
});

test('categories carry limits; a category in use or the default cannot be deleted', async () => {
  const { pool, db } = await makeDb();
  const a = await company(pool, db, 'Acme');
  const { category: sales } = await service.saveCategory({ name: 'Sales', access: 'user', limits: { max_discount_pct: 8 } }, a.as);
  assert.deepEqual(sales.limits, { max_discount_pct: 8 });
  await assert.rejects(() => service.saveCategory({ name: 'sales' }, a.as), /already exists/);
  await assert.rejects(() => service.saveCategory({ id: sales.id, limits: { 'Max Discount': 1 } }, a.as), /lower_snake_case/);
  const { user } = await service.manageUser('create_user', { name: 'Tester', category: 'Sales' }, a.as);
  assert.equal(user.limits.max_discount_pct, 8);
  const head = (await service.listCategories(a.tenantId)).categories.find((c) => c.access === 'department_head');
  const raised = await service.saveCategory({ id: head.id, limits: { max_discount_pct: 11 } }, a.as);
  assert.equal(raised.category.limits.max_discount_pct, 11);
  await assert.rejects(() => service.deleteCategory({ id: sales.id }, a.as), /move them to another category/);
  const staff = (await service.listCategories(a.tenantId)).categories.find((c) => c.is_default);
  await assert.rejects(() => service.deleteCategory({ id: staff.id }, a.as), /default category cannot be deleted/);
  await service.manageUser('update_user', { id: user.id, category: 'Staff' }, a.as);
  assert.deepEqual((await service.deleteCategory({ id: sales.id }, a.as)).deleted.name, 'Sales');
  await service.saveCategory({ name: 'Interns', is_default: true }, a.as);
  const defaults = (await service.listCategories(a.tenantId)).categories.filter((c) => c.is_default).map((c) => c.name);
  assert.deepEqual(defaults, ['Interns'], 'exactly one default category');
});

test('agents read users of their own company only, and never the password hash', async (t) => {
  const { pool, db } = await makeDb();
  const roles = (await pool.query("SELECT 1 FROM pg_roles WHERE rolname='di_app'")).rows.length;
  if (!roles) return t.skip('this Postgres has no di_app role');
  const a = await company(pool, db, 'Acme');
  const b = await company(pool, db, 'Beta');
  const seen = await withContext(db, { tenantId: a.tenantId }, async (tx) => (await tx.query('SELECT id, company_tenant_id FROM users')).rows);
  assert.deepEqual(seen.map((r) => r.company_tenant_id), [a.tenantId]);
  await assert.rejects(() => withContext(db, { tenantId: b.tenantId }, (tx) => tx.query('SELECT password_hash FROM users')), /permission denied/);
});

test('upgrade: old role/tier users and di.company_member rows become one users table', async () => {
  const pglite = new PGlite();
  const pool = shim(pglite);
  const db = pgliteAdapter(pglite);
  // The production shape before this change.
  await pool.query(`CREATE TABLE sessions (id text PRIMARY KEY, title text, parent_session_id text, user_id text, updated_at timestamptz DEFAULT NOW());
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','department_head','user')), tier TEXT NOT NULL DEFAULT 'standard',
      active BOOLEAN NOT NULL DEFAULT TRUE, email TEXT, phone TEXT, position TEXT, department TEXT, location TEXT, notes TEXT,
      company_tenant_id TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE UNIQUE INDEX users_company_username_key ON users (COALESCE(company_tenant_id, ''), username);
    CREATE TABLE user_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  // DI migrations before this change, plus the retired company-member table and claim column.
  await db.exec(`CREATE SCHEMA di; CREATE TABLE di.schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`);
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = new URL('../../document_inteligence/sql/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql') && name < '014').sort()) {
    await db.exec(await readFile(new URL(file, dir), 'utf8'));
    await db.query('INSERT INTO di.schema_migrations (id) VALUES ($1)', [file]);
  }
  await db.exec(`CREATE TABLE di.company_member (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES di.tenant(id), name text NOT NULL,
      position text, department text, email text, phone text, location text, notes text, user_id text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
    ALTER TABLE di.expense_claim ADD COLUMN claimant_member_id uuid REFERENCES di.company_member(id);`);
  const tenantId = (await db.query("INSERT INTO di.tenant (name) VALUES ('Old Co') RETURNING id")).rows[0].id;
  await pool.query(`INSERT INTO users (id, username, display_name, password_hash, role, tier, company_tenant_id, email) VALUES
    ('u-admin','admin','Admin','x:y','admin','standard',$1,NULL),
    ('u-head','dee','Dee','x:y','department_head','standard',$1,'dee@old.test'),
    ('u-user','ali','Ali','x:y','user','premium',$1,NULL),
    ('u-orphan','ghost','Ghost','x:y','admin','standard',NULL,NULL)`, [tenantId]);
  await pool.query("INSERT INTO sessions (id, user_id) VALUES ('s-ghost', 'u-orphan')");
  await db.query("SELECT set_config('di.tenant_id', $1, false)", [tenantId]);
  await db.query(`INSERT INTO di.company_member (id, tenant_id, name, email, department, position, user_id) VALUES
    ('11111111-1111-1111-1111-111111111111', $1, 'Ali Linked', NULL, 'Sales', 'Rep', 'u-user'),
    ('22222222-2222-2222-2222-222222222222', $1, 'Dee By Email', 'DEE@old.test', 'Finance', 'Head', NULL),
    ('33333333-3333-3333-3333-333333333333', $1, 'Siti No Login', 'siti@old.test', 'Ops', 'Clerk', NULL)`, [tenantId]);
  const batch = (await db.query("INSERT INTO di.expense_batch (tenant_id, period_key, period_start, cutoff_date) VALUES ($1, '2026-10', '2026-09-26', '2026-10-25') RETURNING id", [tenantId])).rows[0].id;
  await db.query(`INSERT INTO di.expense_claim (tenant_id, number, batch_id, claimant_member_id, claimant_name, expense_date, merchant, category, amount)
    VALUES ($1, 'EXP-1', $2, '33333333-3333-3333-3333-333333333333', 'Siti No Login', '2026-10-01', 'Shop', 'meals', 10)`, [tenantId, batch]);

  poolHolder.current = pool;
  await ensureUsers(pool);
  await migrate(db);

  const users = (await pool.query(`SELECT u.id, u.username, u.display_name, u.department, u.email, c.name AS category, c.access
    FROM users u JOIN user_category c ON c.id = u.category_id ORDER BY u.id`)).rows;
  assert.deepEqual(users.map((u) => [u.id, u.category, u.access]), [
    ['33333333-3333-3333-3333-333333333333', 'Staff', 'user'],
    ['u-admin', 'Superadmin', 'superadmin'],
    ['u-head', 'Department head', 'department_head'],
    ['u-user', 'Staff', 'user'],
  ], 'roles became categories; the pre-company account is gone; the no-login person became a user');
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  assert.equal(byId['u-user'].department, 'Sales', 'a linked record filled the user\'s empty fields');
  assert.equal(byId['u-head'].department, 'Finance', 'a record matched by email filled that user');
  assert.equal(byId['33333333-3333-3333-3333-333333333333'].username, null);
  assert.equal(byId['33333333-3333-3333-3333-333333333333'].email, 'siti@old.test');
  const claim = (await pool.query('SELECT * FROM di.expense_claim')).rows[0];
  assert.equal(claim.claimant_user_id, '33333333-3333-3333-3333-333333333333', 'the claim points at the same person');
  assert.equal('claimant_member_id' in claim, false);
  assert.equal((await pool.query("SELECT to_regclass('di.company_member') AS t")).rows[0].t, null, 'the second people table is gone');
  const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='users'")).rows.map((r) => r.column_name);
  assert.equal(columns.includes('role') || columns.includes('tier'), false);
  assert.equal((await pool.query("SELECT user_id FROM sessions WHERE id='s-ghost'")).rows[0].user_id, null);
  await ensureUsers(pool);
  await migrate(db);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM user_category')).rows[0].n, 3, 'running again changes nothing');
});
