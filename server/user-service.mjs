// The one user service. Agents, UI routes and Document Intelligence all create, change and
// list users and user categories through these functions; there is no second copy of this SQL.
//
// The *Core functions run inside a caller-supplied transaction so the agent dispatcher can commit
// the write and its journal receipt together. The plain functions open their own transaction.
// Every write needs a Superadmin actor vouched for by the host; arguments never choose the actor.
import { randomUUID } from 'node:crypto';
import { getPool } from './db.mjs';
import { hashPassword } from './users.mjs';
import { ACCESS_LEVELS, accessLabel, departmentKey, isSuperadmin, normalizeAccess } from './roles.mjs';

/** Columns of a user as code sees it: the row plus its category's name, access level and limits. */
export const USER_SELECT = `u.id, u.company_tenant_id, u.category_id, u.display_name, u.username, u.active,
  u.email, u.phone, u.position, u.department, u.location, u.notes, u.created_at, u.updated_at,
  (u.password_hash IS NOT NULL) AS has_password, c.name AS category, c.access, c.limits`;
export const USER_FROM = 'users u JOIN user_category c ON c.id = u.category_id';

const TEXT_FIELDS = ['position', 'department', 'email', 'phone', 'location', 'notes'];

/** A user as tools and pages see it. Never carries the password. */
export function publicUser(row) {
  return {
    id: row.id,
    name: row.display_name || row.username || '',
    username: row.username || null,
    category_id: row.category_id,
    category: row.category,
    access: row.access,
    access_label: accessLabel(row.access),
    limits: row.limits || {},
    active: Boolean(row.active),
    can_sign_in: Boolean(row.active && row.username && row.has_password),
    position: row.position || '',
    department: row.department || '',
    email: row.email || '',
    phone: row.phone || '',
    location: row.location || '',
    notes: row.notes || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicCategory(row) {
  return { id: row.id, name: row.name, access: row.access, access_label: accessLabel(row.access), limits: row.limits || {}, is_default: Boolean(row.is_default), users: Number(row.users) || 0 };
}

function fail(message, execCode) {
  return Object.assign(new Error(message), execCode ? { execCode } : {});
}

function text(input, key, max = key === 'notes' ? 2000 : 300) {
  if (input[key] === undefined) return undefined;
  if (input[key] === null) return null;
  if (typeof input[key] !== 'string') throw fail(`${key} must be text`);
  const value = input[key].trim();
  if (value.length > max) throw fail(`${key} is too long`);
  return value || null;
}

function email(value) {
  if (value == null) return value;
  const clean = value.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw fail('Invalid email');
  return clean;
}

function username(value) {
  if (value == null) return value;
  const clean = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(clean)) throw fail('Username must contain 1–64 letters, digits, dots, underscores or hyphens');
  return clean;
}

function requireActor(context) {
  const actor = context?.actorUser;
  if (!actor) throw fail('Sign-in required: no signed-in user is attached', 'SIGN_IN_REQUIRED');
  if (actor.active === false) throw fail('Current login is no longer active', 'PERMISSION_DENIED');
  return actor;
}

function requireSuperadmin(context) {
  const actor = requireActor(context);
  if (!isSuperadmin(actor)) throw fail('Only a Superadmin can manage users and categories', 'PERMISSION_DENIED');
  return actor;
}

/** Opens a transaction for one company, serialised against other user writes. */
export async function withCompanyTx(tenantId, fn) {
  if (!tenantId) throw fail('Company tenant is required');
  const tx = await getPool().connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('di.tenant_id',$1,true)", [tenantId]);
    await tx.query('SELECT pg_advisory_xact_lock(73009124)');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      throw fail(String(error.constraint || '').includes('username') ? 'Username already exists in this company' : 'A category with that name already exists');
    }
    throw error;
  } finally {
    tx.release();
  }
}

// ---------------------------------------------------------------- reads

/** One user of this company by id, or null. */
export async function getUser(db, tenantId, id) {
  const row = (await db.query(`SELECT ${USER_SELECT} FROM ${USER_FROM} WHERE u.id=$1 AND u.company_tenant_id=$2`, [String(id ?? ''), tenantId])).rows[0];
  return row || null;
}

/** Every user of the company, with a deterministic count so nobody has to add them up. */
export async function listUsers(tenantId, db = getPool()) {
  if (!tenantId) throw fail('Company tenant is required');
  const rows = (await db.query(`SELECT ${USER_SELECT} FROM ${USER_FROM} WHERE u.company_tenant_id=$1
    ORDER BY u.department NULLS LAST, u.display_name, u.id`, [tenantId])).rows;
  const users = rows.map(publicUser);
  const byCategory = {};
  for (const user of users) byCategory[user.category] = (byCategory[user.category] || 0) + 1;
  return {
    users,
    summary: {
      total: users.length,
      active: users.filter((u) => u.active).length,
      can_sign_in: users.filter((u) => u.can_sign_in).length,
      superadmins: users.filter((u) => u.active && u.access === 'superadmin').length,
      by_category: byCategory,
    },
  };
}

/** The company's categories with how many users each holds. */
export async function listCategories(tenantId, db = getPool()) {
  if (!tenantId) throw fail('Company tenant is required');
  await db.query('SELECT ensure_user_categories($1)', [tenantId]);
  const rows = (await db.query(`SELECT c.*, (SELECT COUNT(*) FROM users u WHERE u.category_id=c.id) AS users
    FROM user_category c WHERE c.company_tenant_id=$1 ORDER BY CASE c.access WHEN 'superadmin' THEN 0 WHEN 'department_head' THEN 1 ELSE 2 END, c.name`, [tenantId])).rows;
  return { categories: rows.map(publicCategory) };
}

async function findCategory(tx, tenantId, ref) {
  await tx.query('SELECT ensure_user_categories($1)', [tenantId]);
  if (ref === undefined || ref === null || ref === '') {
    return (await tx.query('SELECT * FROM user_category WHERE company_tenant_id=$1 AND is_default', [tenantId])).rows[0];
  }
  const key = String(ref).trim();
  const row = (await tx.query('SELECT * FROM user_category WHERE company_tenant_id=$1 AND (id=$2 OR lower(name)=lower($2))', [tenantId, key])).rows[0];
  if (row) return row;
  const names = (await tx.query('SELECT name FROM user_category WHERE company_tenant_id=$1 ORDER BY name', [tenantId])).rows.map((r) => r.name);
  throw fail(`No category "${key}" in this company. Categories: ${names.join(', ')}`);
}

/** Every company keeps at least one active user who can sign in as a Superadmin. */
async function assertSuperadminRemains(tx, tenantId) {
  const count = (await tx.query(`SELECT COUNT(*)::int AS n FROM ${USER_FROM}
    WHERE u.company_tenant_id=$1 AND u.active AND c.access='superadmin' AND u.username IS NOT NULL AND u.password_hash IS NOT NULL`, [tenantId])).rows[0].n;
  if (count < 1) throw fail("Cannot remove the company's last active Superadmin");
}

async function assertEmailFree(tx, tenantId, value, exceptId) {
  if (!value) return;
  const other = (await tx.query('SELECT id, display_name FROM users WHERE company_tenant_id=$1 AND lower(email)=lower($2) AND id<>$3 LIMIT 1',
    [tenantId, value, exceptId || ''])).rows[0];
  if (other) throw fail(`User already exists with that email: ${other.display_name} (${other.id}). Update that user instead.`);
}

// ---------------------------------------------------------------- user writes

/**
 * Create or update one user inside the caller's transaction.
 * create_user: name required; username + password let the user sign in; category defaults to the
 * company's default category. update_user: `id` from list_users; only the given fields change.
 */
export async function manageUserCore(tx, action, input = {}, context = {}) {
  if (!['create_user', 'update_user'].includes(action)) throw fail('Unknown user action');
  const tenantId = context.tenantId;
  if (!tenantId) throw fail('Company tenant is required');
  requireSuperadmin(context);

  const current = action === 'update_user'
    ? (await tx.query('SELECT * FROM users WHERE id=$1 AND company_tenant_id=$2 FOR UPDATE', [String(input.id ?? ''), tenantId])).rows[0]
    : null;
  if (action === 'update_user' && !current) throw fail('User not found in this company. Use an id from list_users.');

  const name = text(input, 'name', 100);
  if (action === 'create_user' && !name) throw fail('A user needs a name');
  if (action === 'update_user' && input.name !== undefined && !name) throw fail('A user needs a name');
  const fields = {};
  for (const key of TEXT_FIELDS) {
    const value = text(input, key);
    if (value !== undefined) fields[key] = key === 'email' ? email(value) : value;
  }
  const login = text(input, 'username', 64);
  const nextUsername = login !== undefined ? username(login) : current?.username ?? null;
  if (input.password !== undefined && input.password !== null && !nextUsername) throw fail('A password needs a username');
  const passwordHash = input.password === undefined || input.password === null ? (current?.password_hash ?? null) : hashPassword(input.password);
  if (input.active !== undefined && typeof input.active !== 'boolean') throw fail('active must be true or false');
  const active = input.active ?? current?.active ?? true;
  const category = input.category !== undefined || !current ? await findCategory(tx, tenantId, input.category) : null;
  const categoryId = category?.id ?? current.category_id;
  const access = category?.access ?? (await tx.query('SELECT access FROM user_category WHERE id=$1', [categoryId])).rows[0].access;
  const department = fields.department !== undefined ? fields.department : current?.department ?? null;
  if (access === 'department_head' && !departmentKey(department)) throw fail('A department head needs a department; set department too');
  await assertEmailFree(tx, tenantId, fields.email, current?.id);

  let row;
  if (!current) {
    row = (await tx.query(`INSERT INTO users (id, company_tenant_id, category_id, display_name, username, password_hash, active,
        email, phone, position, department, location, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, [
      randomUUID(), tenantId, categoryId, name, nextUsername, passwordHash, active,
      fields.email ?? null, fields.phone ?? null, fields.position ?? null, fields.department ?? null, fields.location ?? null, fields.notes ?? null,
    ])).rows[0];
  } else {
    const pick = (key) => (fields[key] !== undefined ? fields[key] : current[key]);
    row = (await tx.query(`UPDATE users SET category_id=$2, display_name=$3, username=$4, password_hash=$5, active=$6,
        email=$7, phone=$8, position=$9, department=$10, location=$11, notes=$12, updated_at=NOW()
      WHERE id=$1 RETURNING id`, [
      current.id, categoryId, name ?? current.display_name, nextUsername, passwordHash, active,
      pick('email'), pick('phone'), pick('position'), pick('department'), pick('location'), pick('notes'),
    ])).rows[0];
    const signInChanged = input.password != null || nextUsername !== current.username || active !== current.active || categoryId !== current.category_id;
    if (signInChanged) await tx.query('DELETE FROM user_sessions WHERE user_id=$1', [current.id]);
    await assertSuperadminRemains(tx, tenantId);
  }
  return { user: publicUser(await getUser(tx, tenantId, row.id)), created: !current };
}

/** Self-contained create/update for UI routes and the DI host. */
export function manageUser(action, input, context) {
  return withCompanyTx(context?.tenantId, (tx) => manageUserCore(tx, action, input, context));
}

// ---------------------------------------------------------------- category writes

/** Create a category, or change one by `id`: name, access level, limits, default for new users. */
export async function saveCategoryCore(tx, input = {}, context = {}) {
  const tenantId = context.tenantId;
  if (!tenantId) throw fail('Company tenant is required');
  requireSuperadmin(context);
  await tx.query('SELECT ensure_user_categories($1)', [tenantId]);
  const current = input.id
    ? (await tx.query('SELECT * FROM user_category WHERE id=$1 AND company_tenant_id=$2 FOR UPDATE', [String(input.id), tenantId])).rows[0]
    : null;
  if (input.id && !current) throw fail('Category not found in this company. Use an id from list_user_categories.');
  const name = text(input, 'name', 100);
  if (!current && !name) throw fail('A category needs a name');
  const access = input.access === undefined ? current?.access ?? 'user' : normalizeAccess(input.access);
  if (!access) throw fail(`access must be one of: ${ACCESS_LEVELS.join(', ')}`);
  let limits = current?.limits ?? {};
  if (input.limits !== undefined) {
    if (!input.limits || typeof input.limits !== 'object' || Array.isArray(input.limits)) throw fail('limits must be an object, e.g. {"max_discount_pct": 8}');
    for (const [key, value] of Object.entries(input.limits)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw fail(`Invalid limit name "${key}": use lower_snake_case`);
      if (value !== null && typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') throw fail(`Limit ${key} must be a number, text or true/false`);
    }
    limits = Object.fromEntries(Object.entries(input.limits).filter(([, value]) => value !== null));
  }
  const isDefault = input.is_default === undefined ? current?.is_default ?? false : input.is_default === true;
  if (current?.is_default && !isDefault) throw fail('Pick another default category instead: set is_default on that one');
  if (isDefault) await tx.query('UPDATE user_category SET is_default=FALSE WHERE company_tenant_id=$1 AND is_default AND id<>$2', [tenantId, current?.id || '']);

  if (current && access === 'department_head' && current.access !== 'department_head') {
    const missing = (await tx.query("SELECT COUNT(*)::int AS n FROM users WHERE category_id=$1 AND coalesce(btrim(department),'')=''", [current.id])).rows[0].n;
    if (missing) throw fail(`${missing} user(s) in this category have no department; a department head needs one`);
  }
  const row = current
    ? (await tx.query('UPDATE user_category SET name=$2, access=$3, limits=$4::jsonb, is_default=$5, updated_at=NOW() WHERE id=$1 RETURNING *',
      [current.id, name ?? current.name, access, JSON.stringify(limits), isDefault])).rows[0]
    : (await tx.query('INSERT INTO user_category (company_tenant_id, name, access, limits, is_default) VALUES ($1,$2,$3,$4::jsonb,$5) RETURNING *',
      [tenantId, name, access, JSON.stringify(limits), isDefault])).rows[0];
  if (current && current.access !== access) {
    await tx.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE category_id=$1)', [current.id]);
    await assertSuperadminRemains(tx, tenantId);
  }
  const users = (await tx.query('SELECT COUNT(*)::int AS n FROM users WHERE category_id=$1', [row.id])).rows[0].n;
  return { category: publicCategory({ ...row, users }), created: !current };
}

/** Delete an empty category. Users are moved first, so nobody is ever left without one. */
export async function deleteCategoryCore(tx, input = {}, context = {}) {
  const tenantId = context.tenantId;
  if (!tenantId) throw fail('Company tenant is required');
  requireSuperadmin(context);
  const current = (await tx.query('SELECT * FROM user_category WHERE id=$1 AND company_tenant_id=$2 FOR UPDATE', [String(input.id ?? ''), tenantId])).rows[0];
  if (!current) throw fail('Category not found in this company. Use an id from list_user_categories.');
  if (current.is_default) throw fail('The default category cannot be deleted; make another category the default first');
  const users = (await tx.query('SELECT COUNT(*)::int AS n FROM users WHERE category_id=$1', [current.id])).rows[0].n;
  if (users) throw fail(`${users} user(s) are in this category; move them to another category first`);
  await tx.query('DELETE FROM user_category WHERE id=$1', [current.id]);
  return { deleted: { id: current.id, name: current.name } };
}

export const saveCategory = (input, context) => withCompanyTx(context?.tenantId, (tx) => saveCategoryCore(tx, input, context));
export const deleteCategory = (input, context) => withCompanyTx(context?.tenantId, (tx) => deleteCategoryCore(tx, input, context));
