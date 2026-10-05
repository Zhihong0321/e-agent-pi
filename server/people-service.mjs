// Shared people service: one home for company people + their optional logins.
// The agent dispatcher, the UI routes and the DI host all call these same
// functions; there is no second copy of this SQL anywhere.
//
// managePeopleCore runs inside a caller-supplied transaction so a dispatcher can
// commit the business write and its journal receipt in the SAME transaction.
// managePeople keeps the legacy self-contained wrapper for existing callers.
import { randomUUID } from 'node:crypto';
import { getPool } from './db.mjs';
import { hashPassword } from './users.mjs';
import { departmentKey, isSuperadmin, normalizeRole, roleLabel } from './roles.mjs';

export const personTextFields = ['name', 'position', 'department', 'email', 'phone', 'location', 'notes'];
const personSelect = `m.id AS member_id, m.user_id,
  COALESCE(m.name, u.display_name, u.username) AS name,
  COALESCE(m.position, u.position) AS position, COALESCE(m.department, u.department) AS department,
  COALESCE(m.email, u.email) AS email, COALESCE(m.phone, u.phone) AS phone,
  COALESCE(m.location, u.location) AS location, COALESCE(m.notes, u.notes) AS notes,
  m.created_at AS member_created_at, m.updated_at AS member_updated_at,
  u.username, u.display_name, u.role, u.tier, u.active AS login_active,
  u.created_at AS user_created_at, u.updated_at AS user_updated_at`;

function personText(input, key) {
  if (input[key] === undefined) return undefined;
  if (typeof input[key] !== 'string') throw new Error(`${key} must be text`);
  const value = input[key].trim();
  if (value.length > (key === 'notes' ? 2000 : 300)) throw new Error(`${key} is too long`);
  return value || null;
}

function personEmail(value) {
  if (value == null) return value;
  const email = String(value).trim().toLowerCase();
  if (email && !/^([^\s@]+)@([^\s@]+)\.([^\s@]+)$/.test(email)) throw new Error('Invalid person email');
  return email || null;
}

export function publicPerson(row) {
  const hasLogin = Boolean(row.user_id);
  return {
    id: row.member_id || row.user_id || null,
    member_id: row.member_id || null,
    user_id: row.user_id || null,
    name: row.name || row.display_name || row.username || '',
    display_name: row.display_name || row.name || row.username || '',
    position: row.position || '',
    department: row.department || '',
    email: row.email || '',
    phone: row.phone || '',
    location: row.location || '',
    notes: row.notes || '',
    username: row.username || null,
    role: row.role || null,
    role_label: row.role ? roleLabel(row.role) : null,
    tier: row.tier || null,
    has_login: hasLogin,
    login_active: hasLogin ? Boolean(row.login_active) : false,
    created_at: row.member_created_at || row.user_created_at || null,
    updated_at: row.member_updated_at || row.user_updated_at || null,
  };
}

/**
 * Who is acting. The host may pass `actorUser` when it already authenticated the
 * user (the execution dispatcher); tool arguments can never select an actor.
 */
export async function personActor(input, context) {
  if (context?.actorUser) {
    if (context.actorUser.active === false) throw new Error('Current login is no longer active');
    return context.actorUser;
  }
  if (context?.trustedAgent) return { role: 'user', active: true };
  if (context?.actorUserId) {
    const row = (await getPool().query('SELECT id, role, active FROM users WHERE id=$1', [context.actorUserId])).rows[0];
    if (!row?.active) throw new Error('Current login is no longer active');
    return row;
  }
  return null;
}

function accountRequested(input) {
  return ['username', 'password', 'role', 'tier', 'active', 'user', 'user_id', 'login_enabled'].some((key) => input[key] !== undefined);
}

async function assertMemberEmail(tx, tenantId, email, memberId, phone, name) {
  const excluded = memberId || '00000000-0000-0000-0000-000000000000';
  const duplicate = (await tx.query(`SELECT id, name FROM di.company_member
    WHERE tenant_id=$1 AND deleted_at IS NULL AND id<>$2
      AND (($3::text IS NOT NULL AND lower(email)=lower($3))
        OR ($4::text IS NOT NULL AND phone=$4 AND lower(name)=lower($5))) LIMIT 1`, [tenantId, excluded, email || null, phone || null, name || ''])).rows[0];
  if (duplicate) throw new Error(`Company member already exists: ${duplicate.name} (${duplicate.id}). Update that record instead.`);
}

async function findUser(tx, ref) {
  if (!ref) return null;
  return (await tx.query('SELECT * FROM users WHERE id=$1 OR username=$1 FOR UPDATE', [String(ref)])).rows[0] || null;
}

async function userForPerson(tx, input, member) {
  const ref = input.user_id ?? input.user ?? member?.user_id;
  return ref ? findUser(tx, ref) : null;
}

function validateAccount(input, current) {
  const username = input.username === undefined ? current?.username : String(input.username).trim().toLowerCase();
  if (username !== undefined && username !== null && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(username)) throw new Error('Username must contain 1–64 letters, digits, dots, underscores or hyphens');
  if (input.role !== undefined && !normalizeRole(input.role)) throw new Error('Invalid role: use superadmin, department_head or user');
  if (input.active !== undefined && typeof input.active !== 'boolean') throw new Error('Invalid active status');
  if (input.login_enabled !== undefined && typeof input.login_enabled !== 'boolean') throw new Error('Invalid login status');
  for (const key of ['tier', 'display_name']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 100 || (key === 'tier' && !input[key].trim()))) throw new Error(`Invalid ${key}`);
  return username;
}

/** A department head acts for one department, so the role needs one to mean anything. */
function assertHeadHasDepartment(role, department) {
  if (role === 'department_head' && !departmentKey(department)) throw new Error('A department head needs a department; set department too');
}

async function protectAdminChange(tx, current, role, active) {
  if (current?.role === 'admin' && current.active && (role !== 'admin' || !active)) {
    const count = (await tx.query("SELECT COUNT(*)::int AS count FROM users WHERE role='admin' AND active")).rows[0].count;
    if (count <= 1) throw new Error('Cannot disable or demote the last active admin');
  }
}

export async function withTenantPool(tenantId, fn) {
  const tx = await getPool().connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('di.tenant_id',$1,true)", [tenantId]);
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

export async function listPeople(tenantId) {
  if (!tenantId) throw new Error('Company tenant is required');
  const result = await withTenantPool(tenantId, (tx) => tx.query(`
    SELECT ${personSelect}
      FROM di.company_member m
      LEFT JOIN users u ON u.id=m.user_id
     WHERE m.tenant_id=$1::uuid AND m.deleted_at IS NULL
    UNION ALL
    SELECT NULL::uuid AS member_id, u.id AS user_id, u.display_name AS name, u.position, u.department,
           u.email, u.phone, u.location, u.notes, NULL::timestamptz AS member_created_at,
           NULL::timestamptz AS member_updated_at, u.username, u.display_name, u.role, u.tier,
           u.active AS login_active, u.created_at AS user_created_at, u.updated_at AS user_updated_at
      FROM users u
     WHERE u.company_tenant_id=$1::text
       AND NOT EXISTS (
         SELECT 1 FROM di.company_member m
          WHERE m.user_id=u.id AND m.tenant_id=$1::uuid AND m.deleted_at IS NULL
       )
     ORDER BY department NULLS LAST, name`, [tenantId]));
  return { people: result.rows.map(publicPerson), has_more: false };
}

/** Deterministic account census for the company tenant (read-only operation). */
export async function countUserAccounts(tenantId) {
  if (!tenantId) throw new Error('Company tenant is required');
  const result = await withTenantPool(tenantId, (tx) => tx.query(`
    SELECT
      (SELECT COUNT(*)::int FROM di.company_member WHERE tenant_id=$1::uuid AND deleted_at IS NULL) AS company_people,
      (SELECT COUNT(*)::int FROM di.company_member WHERE tenant_id=$1::uuid AND deleted_at IS NULL AND user_id IS NOT NULL) AS with_logins,
      (SELECT COUNT(*)::int FROM users WHERE company_tenant_id=$1::text) AS login_accounts,
      (SELECT COUNT(*)::int FROM users WHERE company_tenant_id=$1::text AND active) AS logins_active,
      (SELECT COUNT(*)::int FROM users WHERE company_tenant_id=$1::text AND role='admin') AS logins_admin`, [tenantId]));
  const row = result.rows[0] || {};
  const people = Number(row.company_people) || 0;
  const withLogins = Number(row.with_logins) || 0;
  return {
    company_people: people,
    with_logins: withLogins,
    contact_only: people - withLogins,
    login_accounts: Number(row.login_accounts) || 0,
    logins_active: Number(row.logins_active) || 0,
    logins_admin: Number(row.logins_admin) || 0,
  };
}

export async function backfillPeopleLinks(tenantId) {
  if (!tenantId) return { linked: 0 };
  const result = await withTenantPool(tenantId, (tx) => tx.query(`WITH candidates AS (
    SELECT m.id AS member_id, min(u.id) AS user_id
      FROM di.company_member m JOIN users u ON lower(u.email)=lower(m.email)
     WHERE m.tenant_id=$1::uuid AND m.deleted_at IS NULL AND m.user_id IS NULL AND m.email IS NOT NULL
       AND u.company_tenant_id=$1::text
     GROUP BY m.id HAVING count(u.id)=1
  ) UPDATE di.company_member m SET user_id=c.user_id
      FROM candidates c
     WHERE m.id=c.member_id AND NOT EXISTS (
       SELECT 1 FROM di.company_member other WHERE other.tenant_id=$1::uuid AND other.user_id=c.user_id
         AND other.deleted_at IS NULL AND other.id<>m.id
     )`, [tenantId]));
  return { linked: result.rowCount || 0 };
}

export async function ensurePeopleTenant(tenantId) {
  if (!tenantId) return { assigned: 0, linked: 0 };
  const assigned = await getPool().query(
    'UPDATE users SET company_tenant_id=$1 WHERE company_tenant_id IS NULL',
    [tenantId],
  );
  const links = await backfillPeopleLinks(tenantId);
  return { assigned: assigned.rowCount || 0, ...links };
}

/**
 * One person create/update/list, inside the caller's transaction (tenant
 * already selected via set_config). `context.actorUser` is the host-vouched
 * actor; without it the caller must resolve authorization itself.
 */
export async function managePeopleCore(tx, action, input = {}, context = {}) {
  if (!['create_person', 'update_person'].includes(action)) throw new Error('Unknown person action');
  const tenantId = context.tenantId || input.tenant_id;
  if (!tenantId) throw new Error('Company tenant is required');

  const actor = context.actorUser || (context.trustedAgent ? { role: 'user', active: true }
    : context.actorUserId
      ? (await (async () => {
          const row = (await tx.query('SELECT id, role, active FROM users WHERE id=$1', [context.actorUserId])).rows[0];
          if (!row?.active) throw new Error('Current login is no longer active');
          return row;
        })())
      : null);
  if (!actor) throw new Error('Person management requires an authenticated actor');

  const memberId = input.person_id ?? input.member_id ?? input.id;
  let member = memberId ? (await tx.query('SELECT * FROM di.company_member WHERE id=$1::uuid AND tenant_id=$2::uuid AND deleted_at IS NULL FOR UPDATE', [memberId, tenantId])).rows[0] : null;
  if (memberId && !member) throw new Error('Company person not found');
  let user = await userForPerson(tx, input, member);
  if (user?.company_tenant_id && user.company_tenant_id !== tenantId) throw new Error('That login belongs to another company');
  if (accountRequested(input) && !isSuperadmin(actor)) throw new Error('Logins and roles can only be managed by a Superadmin');
  if (input.user !== undefined || input.user_id !== undefined) {
    if (!user) throw new Error('User account not found');
    const linked = (await tx.query('SELECT * FROM di.company_member WHERE user_id=$1 AND deleted_at IS NULL FOR UPDATE', [user.id])).rows;
    if (linked.some((row) => row.id !== member?.id && row.tenant_id !== tenantId)) throw new Error('That login already belongs to another company');
    const sameTenant = linked.filter((row) => row.tenant_id === tenantId && row.id !== member?.id);
    if (sameTenant.length > 1) throw new Error('That login is linked to multiple company people');
    if (!member && sameTenant[0]) member = sameTenant[0];
  }

  const patch = {};
  for (const key of personTextFields) {
    const value = personText(input, key);
    if (value !== undefined) patch[key] = key === 'email' ? personEmail(value) : value;
  }
  if (input.display_name !== undefined) patch.name = patch.name ?? personText(input, 'display_name');
  const name = patch.name ?? member?.name ?? user?.display_name ?? user?.username;
  if (!name) throw new Error('A company person needs a name');
  patch.name = name;
  const email = patch.email !== undefined ? patch.email : (member?.email ?? user?.email ?? null);
  const phone = patch.phone !== undefined ? patch.phone : (member?.phone ?? user?.phone ?? null);
  await assertMemberEmail(tx, tenantId, email, member?.id, phone, name);

  const wantsNewLogin = !user && (input.username !== undefined || input.password !== undefined || input.login_enabled === true);
  if (wantsNewLogin) {
    if (input.username === undefined || input.password === undefined) throw new Error('Username and password are required to enable login');
    const username = validateAccount(input);
    const role = normalizeRole(input.role) || 'user';
    assertHeadHasDepartment(role, patch.department ?? member?.department);
    user = (await tx.query(`INSERT INTO users(id, username, display_name, password_hash, role, tier, active, email, phone, position, department, location, notes, company_tenant_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [
      randomUUID(), username, input.display_name ?? name, hashPassword(input.password), role, input.tier || 'standard', input.active ?? true,
      email, patch.phone ?? member?.phone ?? null, patch.position ?? member?.position ?? null, patch.department ?? member?.department ?? null,
      patch.location ?? member?.location ?? null, patch.notes ?? member?.notes ?? null, tenantId,
    ])).rows[0];
  } else if (user) {
    const username = validateAccount(input, user);
    const previousRole = user.role;
    const previousActive = user.active;
    const role = normalizeRole(input.role) ?? previousRole;
    const active = input.login_enabled === false ? false : (input.active ?? previousActive);
    assertHeadHasDepartment(role, patch.department !== undefined ? patch.department : (member?.department ?? user.department));
    await protectAdminChange(tx, user, role, active);
    const passwordHash = input.password === undefined ? user.password_hash : hashPassword(input.password);
    user = (await tx.query(`UPDATE users SET username=$2, display_name=$3, password_hash=$4, role=$5, tier=$6, active=$7,
        email=$8, phone=$9, position=$10, department=$11, location=$12, notes=$13, company_tenant_id=$14, updated_at=NOW() WHERE id=$1 RETURNING *`, [
      user.id, username ?? user.username, input.display_name ?? (patch.name ?? user.display_name), passwordHash, role, input.tier ?? user.tier, active,
      email, patch.phone ?? user.phone ?? null, patch.position ?? user.position ?? null, patch.department ?? user.department ?? null,
      patch.location ?? user.location ?? null, patch.notes ?? user.notes ?? null, user.company_tenant_id || tenantId,
    ])).rows[0];
    if (input.password !== undefined || !active || role !== previousRole || active !== previousActive) await tx.query('DELETE FROM user_sessions WHERE user_id=$1', [user.id]);
  }

  if (member) {
    const updates = { ...patch, ...(user ? { user_id: user.id } : {}) };
    const keys = Object.keys(updates);
    if (keys.length) {
      const values = keys.map((key) => updates[key]);
      const set = keys.map((key, index) => `${key}=$${index + 1}`).join(', ');
      member = (await tx.query(`UPDATE di.company_member SET ${set}, updated_at=NOW() WHERE id=$${values.length + 1} RETURNING *`, [...values, member.id])).rows[0];
    }
  } else {
    const columns = [...Object.keys(patch), ...(user ? ['user_id'] : [])];
    const values = [...Object.keys(patch).map((key) => patch[key]), ...(user ? [user.id] : [])];
    member = (await tx.query(`INSERT INTO di.company_member (tenant_id, ${columns.join(', ')}) VALUES ($1::uuid, ${columns.map((_, index) => `$${index + 2}`).join(', ')}) RETURNING *`, [tenantId, ...values])).rows[0];
  }
  return { person: publicPerson({ ...member, member_id: member.id, user_id: member.user_id, ...user, login_active: user?.active }), created: action === 'create_person' };
}
