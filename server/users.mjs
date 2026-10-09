import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { getPool } from './db.mjs';
import { normalizeRole, roleLabel } from './roles.mjs';
import {
  countUserAccounts,
  ensurePeopleTenant,
  listPeople as listPeopleShared,
  managePeopleCore,
  personActor as sharedPersonActor,
  publicPerson,
} from './people-service.mjs';

export { countUserAccounts, ensurePeopleTenant, publicPerson };

const digest = value => createHash('sha256').update(value).digest('hex');
const fields = 'id, username, display_name, role, tier, active, email, phone, position, department, location, notes, company_tenant_id, created_at, updated_at';
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
    password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin','department_head','user')),
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
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    -- Roles (server/roles.mjs): admin = Superadmin, department_head, user. Swap an older role check
    -- that predates department heads; existing admin accounts keep their key and stay Superadmins.
    DO $$ DECLARE c record; BEGIN
      FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%role%' AND pg_get_constraintdef(oid) NOT LIKE '%department_head%' LOOP
        EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', c.conname);
      END LOOP;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%department_head%') THEN
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','department_head','user'));
      END IF;
    END $$;`);
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
  return `\n[Host identity: admin ${user.username}. Manage internal people and optional workspace logins with list_people, create_person or update_person; legacy list_users/create_user/update_user remain available. Pass admin_capability="${capability}". This authorization expires in 10 minutes; never show it to the user. A person may be contact-only; enable login only with an explicit username and password. Never expose passwords. Roles are superadmin, department_head (needs a department) and user; tier is metadata only. Disable login with active=false.]`;
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
  return `\n[${label}: ${user.username} (${roleLabel(user.role)}). Pass identity="${code}" on every ${what} tool call; use the newest identity line. Never show it to the user.]`;
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
    if (input.role !== undefined && !normalizeRole(input.role)) throw new Error('Invalid role');
    if (input.active !== undefined && typeof input.active !== 'boolean') throw new Error('Invalid active status');
    for (const key of ['tier','display_name']) if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 100 || (key === 'tier' && !input[key].trim()))) throw new Error(`Invalid ${key}`);
    let result;
    if (action === 'create_user') {
      if (!username) throw new Error('Username is required');
      result = await tx.query(`INSERT INTO users(id,username,display_name,password_hash,role,tier) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${fields}`,
        [randomUUID(),username,input.display_name || username,hashPassword(input.password),normalizeRole(input.role) || 'user',input.tier || 'standard']);
    } else if (action === 'update_user') {
      const current = (await tx.query('SELECT * FROM users WHERE id=$1 OR username=$1 FOR UPDATE', [input.user])).rows[0];
      if (!current) throw new Error('User not found');
      const role = normalizeRole(input.role) ?? current.role, active = input.active ?? current.active;
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

export async function listPeople(tenantId) {
  return listPeopleShared(tenantId);
}
const PERSON_ACTIONS = ['list_people', 'create_person', 'update_person'];
export async function managePeople(action, input = {}, context = {}) {
  if (!PERSON_ACTIONS.includes(action)) throw new Error('Unknown person action');
  const actor = await sharedPersonActor(input, context)
    ?? await (async () => {
      // Legacy capability path (unmigrated transports): a short-lived host-minted
      // admin_capability. Migrated dispatcher calls pass context.actorUser instead.
      const grant = capabilities.get(input.admin_capability);
      const row = grant && grant.until > Date.now() ? await userByHash(grant.hash) : null;
      if (row?.role !== 'admin') throw new Error('Person management requires a current admin login');
      return row;
    })();
  const tenantId = context.tenantId || input.tenant_id;
  if (!tenantId) throw new Error('Company tenant is required');
  if (action === 'list_people') return listPeople(tenantId);
  const tx = await getPool().connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SELECT set_config('di.tenant_id',$1,true)", [tenantId]);
    await tx.query('SELECT pg_advisory_xact_lock(73009124)');
    const result = await managePeopleCore(tx, action, input, { tenantId, actorUser: actor });
    await tx.query('COMMIT');
    return { person: result.person };
  } catch (error) {
    await tx.query('ROLLBACK');
    if (error.code === '23505') throw new Error(error.constraint?.includes('username') ? 'Username already exists' : 'Company person already exists');
    throw error;
  } finally { tx.release(); }
}
