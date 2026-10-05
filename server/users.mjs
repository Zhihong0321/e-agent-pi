import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { getPool } from './db.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fields = 'id, username, display_name, role, tier, active, email, phone, position, department, location, notes, created_at, updated_at';
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 4 || password.length > 256) throw new Error('Password must contain 4–256 characters');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function ensureUsers(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','user')),
    tier TEXT NOT NULL DEFAULT 'standard', active BOOLEAN NOT NULL DEFAULT TRUE,
    email TEXT, phone TEXT, position TEXT, department TEXT, location TEXT, notes TEXT,
    company_tenant_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS position TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS company_tenant_id TEXT;
    CREATE INDEX IF NOT EXISTS users_email_idx ON users (lower(email)) WHERE email IS NOT NULL;
    CREATE TABLE IF NOT EXISTS user_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);`);
  // A transaction lock makes first-account bootstrap safe across simultaneous host starts.
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(73009124)');
    await tx.query(`INSERT INTO users(id,username,display_name,password_hash,role)
      SELECT $1,'admin','Admin',$2,'admin' WHERE NOT EXISTS(SELECT 1 FROM users)`, [randomUUID(), hashPassword('1234')]);
    await tx.query(`UPDATE sessions child SET user_id = parent.user_id FROM sessions parent
      WHERE child.parent_session_id = parent.id AND child.user_id IS NULL AND parent.user_id IS NOT NULL`);
    await tx.query(`UPDATE sessions SET user_id = (SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1)
      WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE role='admin')`);
    await tx.query('COMMIT');
  } catch (error) { await tx.query('ROLLBACK'); throw error; }
  finally { tx.release(); }
}
function cookieToken(req) {
  return String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('demo_session='))?.slice(13) || '';
}
export async function userByHash(hash) {
  const result = await getPool().query(`SELECT ${fields.split(', ').map(f => `u.${f}`).join(', ')} FROM users u
    JOIN user_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active`, [hash]);
  return result.rows[0] || null;
}
export async function requestUser(req) { return cookieToken(req) ? userByHash(digest(cookieToken(req))) : null; }
export function sessionCookie(req, token, maxAge = 604800) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `demo_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
const attempts = new Map();
export async function loginUser(req, input) {
  const key = req.socket.remoteAddress || 'local';
  const now = Date.now();
  for (const [ip, entry] of attempts) if (entry.until < now) attempts.delete(ip);
  const attempt = attempts.get(key) || { count: 0, until: now + 900000 };
  if (attempt.count >= 10) throw new Error('Too many login attempts. Try again in 15 minutes.');
  attempt.count++; attempts.set(key, attempt);
  const row = (await getPool().query('SELECT * FROM users WHERE username=$1', [String(input.username || '').trim().toLowerCase()])).rows[0];
  const valid = verifyPassword(input.password, row?.password_hash || dummyHash);
  if (!row?.active || !valid) throw new Error('Invalid username or password');
  attempts.delete(key);
  const token = randomBytes(32).toString('hex');
  await getPool().query('DELETE FROM user_sessions WHERE expires_at<=NOW()');
  await getPool().query(`INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')`, [digest(token), row.id]);
  return { token, user: await userByHash(digest(token)) };
}
const dummyHash = hashPassword(randomBytes(32).toString('hex'));
export async function logoutUser(req) { await getPool().query('DELETE FROM user_sessions WHERE token_hash=$1', [digest(cookieToken(req))]); }

const capabilities = new Map();
export function userManagementPrompt(req, user) {
  if (user.role !== 'admin') return '\n[Host identity: regular user. User administration is unavailable.]';
  const now = Date.now();
  for (const [key, value] of capabilities) if (value.until < now) capabilities.delete(key);
  const capability = randomBytes(32).toString('hex');
  capabilities.set(capability, { hash: digest(cookieToken(req)), until: now + 600000 });
  return `\n[Host identity: admin ${user.username}. Manage internal people and optional workspace logins with list_people, create_person or update_person; legacy list_users/create_user/update_user remain available. Pass admin_capability="${capability}". This authorization expires in 10 minutes; never show it to the user. A person may be contact-only; enable login only with an explicit username and password. Never expose passwords. Roles are admin/user; tier is metadata only. Disable login with active=false.]`;
}
// Who is chatting, as seen by agents that act per user (the Expenses Clerk). The model is handed a
// random code for this turn and passes it back; the host resolves it to the signed-in user, so the
// model can't claim to be someone else. Ending the session or disabling the user ends the code too.
const identities = new Map();
function identityPrompt(req, user, label, what) {
  const now = Date.now();
  for (const [key, value] of identities) if (value.until < now) identities.delete(key);
  const code = randomBytes(16).toString('hex');
  identities.set(code, { hash: digest(cookieToken(req)), until: now + 4 * 3600000 });
  return `\n[${label}: ${user.username} (${user.role === 'admin' ? 'admin' : 'regular user'}). Pass identity="${code}" on every ${what} tool call; use the newest identity line. Never show it to the user.]`;
}
export const expenseIdentityPrompt = (req, user) => identityPrompt(req, user, 'Expense identity', 'expense');
export const procurementIdentityPrompt = (req, user) => identityPrompt(req, user, 'Procurement identity', 'procurement');
export const fdeIdentityPrompt = (req, user) => identityPrompt(req, user, 'Deploy identity', 'deploy');
export async function resolveIdentity(code) {
  const grant = identities.get(String(code || ''));
  if (!grant || grant.until < Date.now()) return null;
  return userByHash(grant.hash);
}
export async function manageUsers(action, input = {}, context = {}) {
  const grant = capabilities.get(input.admin_capability);
  const actor = grant && grant.until > Date.now() ? await userByHash(grant.hash) : null;
  if (actor?.role !== 'admin') throw new Error('User management requires a current admin login');
  if (context.tenantId && (action === 'create_user' || action === 'update_user')) {
    const personInput = { ...input, name: input.name ?? input.display_name ?? input.username };
    return managePeople(action === 'create_user' ? 'create_person' : 'update_person', personInput, context);
  }
  if (action === 'list_users') return { users: (await getPool().query(`SELECT ${fields} FROM users ORDER BY created_at,id`)).rows };
  const tx = await getPool().connect();
  try {
    await tx.query('BEGIN');
    await tx.query('SELECT pg_advisory_xact_lock(73009124)');
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : undefined;
    if (username !== undefined && !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(username)) throw new Error('Username must contain 1–64 letters, digits, dots, underscores or hyphens');
    if (input.role !== undefined && !['admin','user'].includes(input.role)) throw new Error('Invalid role');
    if (input.active !== undefined && typeof input.active !== 'boolean') throw new Error('Invalid active status');
    for (const key of ['tier','display_name']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 100 || (key === 'tier' && !input[key].trim()))) throw new Error(`Invalid ${key}`);
    let result;
    if (action === 'create_user') {
      if (!username) throw new Error('Username is required');
      result = await tx.query(`INSERT INTO users(id,username,display_name,password_hash,role,tier) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${fields}`,
        [randomUUID(),username,input.display_name || username,hashPassword(input.password),input.role || 'user',input.tier || 'standard']);
    } else if (action === 'update_user') {
      const current = (await tx.query('SELECT * FROM users WHERE id=$1 OR username=$1 FOR UPDATE', [input.user])).rows[0];
      if (!current) throw new Error('User not found');
      const role = input.role ?? current.role, active = input.active ?? current.active;
      if (current.role === 'admin' && current.active && (role !== 'admin' || !active)) {
        const count = (await tx.query("SELECT COUNT(*)::int AS count FROM users WHERE role='admin' AND active")).rows[0].count;
        if (count <= 1) throw new Error('Cannot disable or demote the last active admin');
      }
      result = await tx.query(`UPDATE users SET username=$2,display_name=$3,password_hash=$4,role=$5,tier=$6,active=$7,updated_at=NOW() WHERE id=$1 RETURNING ${fields}`,
        [current.id,username ?? current.username,input.display_name ?? current.display_name,input.password === undefined ? current.password_hash : hashPassword(input.password),role,input.tier ?? current.tier,active]);
      if (input.password !== undefined || !active || role !== current.role) await tx.query('DELETE FROM user_sessions WHERE user_id=$1', [current.id]);
    } else throw new Error('Unknown user action');
    await tx.query('COMMIT');
    return { user: result.rows[0] };
  } catch (error) { await tx.query('ROLLBACK'); if (error.code === '23505') throw new Error('Username already exists'); throw error; }
  finally { tx.release(); }
}

const personTextFields = ['name', 'position', 'department', 'email', 'phone', 'location', 'notes'];
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

function publicPerson(row) {
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
    tier: row.tier || null,
    has_login: hasLogin,
    login_active: hasLogin ? Boolean(row.login_active) : false,
    created_at: row.member_created_at || row.user_created_at || null,
    updated_at: row.member_updated_at || row.user_updated_at || null,
  };
}

async function personActor(input, context) {
  if (context?.trustedAgent) return { role: 'user', active: true };
  if (context?.actorUserId) {
    const row = (await getPool().query('SELECT id, role, active FROM users WHERE id=$1', [context.actorUserId])).rows[0];
    if (!row?.active) throw new Error('Current login is no longer active');
    return row;
  }
  const grant = capabilities.get(input.admin_capability);
  const row = grant && grant.until > Date.now() ? await userByHash(grant.hash) : null;
  if (row?.role !== 'admin') throw new Error('Person management requires a current admin login');
  return row;
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
  if (input.role !== undefined && !['admin', 'user'].includes(input.role)) throw new Error('Invalid role');
  if (input.active !== undefined && typeof input.active !== 'boolean') throw new Error('Invalid active status');
  if (input.login_enabled !== undefined && typeof input.login_enabled !== 'boolean') throw new Error('Invalid login status');
  for (const key of ['tier', 'display_name']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 100 || (key === 'tier' && !input[key].trim()))) throw new Error(`Invalid ${key}`);
  return username;
}

async function protectAdminChange(tx, current, role, active) {
  if (current?.role === 'admin' && current.active && (role !== 'admin' || !active)) {
    const count = (await tx.query("SELECT COUNT(*)::int AS count FROM users WHERE role='admin' AND active")).rows[0].count;
    if (count <= 1) throw new Error('Cannot disable or demote the last active admin');
  }
}

async function withTenantPool(tenantId, fn) {
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

export async function managePeople(action, input = {}, context = {}) {
  if (!['list_people', 'create_person', 'update_person'].includes(action)) throw new Error('Unknown person action');
  const actor = await personActor(input, context);
  const tenantId = context.tenantId || input.tenant_id;
  if (!tenantId) throw new Error('Company tenant is required');
  if (action === 'list_people') return listPeople(tenantId);

  const tx = await getPool().connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('di.tenant_id',$1,true)", [tenantId]);
    await tx.query('SELECT pg_advisory_xact_lock(73009124)');
    const memberId = input.person_id ?? input.member_id ?? input.id;
    let member = memberId ? (await tx.query('SELECT * FROM di.company_member WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE', [memberId, tenantId])).rows[0] : null;
    if (memberId && !member) throw new Error('Company person not found');
    let user = await userForPerson(tx, input, member);
    if (user?.company_tenant_id && user.company_tenant_id !== tenantId) throw new Error('That login belongs to another company');
    if (accountRequested(input) && actor.role !== 'admin') throw new Error('Login access can only be managed by an admin');
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
      user = (await tx.query(`INSERT INTO users(id, username, display_name, password_hash, role, tier, active, email, phone, position, department, location, notes, company_tenant_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`, [
        randomUUID(), username, input.display_name ?? name, hashPassword(input.password), input.role || 'user', input.tier || 'standard', input.active ?? true,
        email, patch.phone ?? member?.phone ?? null, patch.position ?? member?.position ?? null, patch.department ?? member?.department ?? null,
        patch.location ?? member?.location ?? null, patch.notes ?? member?.notes ?? null, tenantId,
      ])).rows[0];
    } else if (user) {
      const username = validateAccount(input, user);
      const previousRole = user.role;
      const previousActive = user.active;
      const role = input.role ?? previousRole;
      const active = input.login_enabled === false ? false : (input.active ?? previousActive);
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
      member = (await tx.query(`INSERT INTO di.company_member (tenant_id, ${columns.join(', ')}) VALUES ($1, ${columns.map((_, index) => `$${index + 2}`).join(', ')}) RETURNING *`, [tenantId, ...values])).rows[0];
    }
    await tx.query('COMMIT');
    return { person: publicPerson({ ...member, member_id: member.id, user_id: member.user_id, ...user, login_active: user?.active }) };
  } catch (error) {
    await tx.query('ROLLBACK');
    if (error.code === '23505') throw new Error(error.constraint?.includes('username') ? 'Username already exists' : 'Company person already exists');
    throw error;
  } finally { tx.release(); }
}
