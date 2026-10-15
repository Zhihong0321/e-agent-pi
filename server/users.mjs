// Sign-in: company code + username + password, one method for every user. The user schema
// itself lives in server/user-schema.mjs; creating and changing users is server/user-service.mjs.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { getPool } from './db.mjs';
import { accessLabel } from './roles.mjs';
import { ensureUserSchema } from './user-schema.mjs';
import { USER_FROM, USER_SELECT } from './user-service.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 4 || password.length > 256) throw new Error('Password must contain 4–256 characters');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256 || !stored) return false;
  const [salt, hash] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** The user schema plus the link from a chat session to the user who owns it. */
export async function ensureUsers(pool) {
  await ensureUserSchema(pool);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id);
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);`);
  // A delegated chat belongs to whoever owns the chat that started it.
  await pool.query(`UPDATE sessions child SET user_id = parent.user_id FROM sessions parent
    WHERE child.parent_session_id = parent.id AND child.user_id IS NULL AND parent.user_id IS NOT NULL`);
}
function cookieToken(req) {
  return String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('demo_session='))?.slice(13) || '';
}
/** The signed-in user for a session token: the user row plus its category, access level and limits. */
export async function userByHash(hash) {
  const result = await getPool().query(`SELECT ${USER_SELECT} FROM ${USER_FROM}
    JOIN user_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>NOW() AND u.active`, [hash]);
  return result.rows[0] || null;
}
export async function requestUser(req) { return cookieToken(req) ? userByHash(digest(cookieToken(req))) : null; }
export function sessionCookie(req, token, maxAge = 604800) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `demo_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
const attempts = new Map();
// Sign-in names a company: `company` + `username`, or the one-field form `company/username`.
function loginParts(input) {
  let company = String(input.company ?? '').trim().toLowerCase();
  let username = String(input.username ?? '').trim().toLowerCase();
  if (!company && username.includes('/')) [company, username] = [username.slice(0, username.indexOf('/')).trim(), username.slice(username.indexOf('/') + 1).trim()];
  return { company, username };
}
export async function loginUser(req, input) {
  const key = req.socket.remoteAddress || 'local';
  const now = Date.now();
  for (const [ip, entry] of attempts) if (entry.until < now) attempts.delete(ip);
  const attempt = attempts.get(key) || { count: 0, until: now + 900000 };
  if (attempt.count >= 10) throw new Error('Too many login attempts. Try again in 15 minutes.');
  attempt.count++; attempts.set(key, attempt);
  const { company, username } = loginParts(input);
  const row = company && username ? (await getPool().query(
    `SELECT u.id, u.active, u.password_hash FROM users u JOIN di.tenant t ON t.id::text=u.company_tenant_id
      WHERE t.code=$1 AND t.deleted_at IS NULL AND u.username=$2`, [company, username])).rows[0] : null;
  const valid = verifyPassword(input.password, row?.password_hash || dummyHash);
  if (!row?.active || !row.password_hash || !valid) throw new Error('Invalid company code, username or password');
  attempts.delete(key);
  const token = randomBytes(32).toString('hex');
  await getPool().query('DELETE FROM user_sessions WHERE expires_at<=NOW()');
  await getPool().query(`INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')`, [digest(token), row.id]);
  return { token, user: await userByHash(digest(token)) };
}
const dummyHash = hashPassword(randomBytes(32).toString('hex'));
export async function logoutUser(req) { await getPool().query('DELETE FROM user_sessions WHERE token_hash=$1', [digest(cookieToken(req))]); }

// Who is chatting, as seen by agents that act per user (the Expenses Clerk). The model is handed a
// random code for this turn and passes it back; the host resolves it to the signed-in user, so the
// model can't claim to be someone else. Ending the session or disabling the user ends the code too.
const identities = new Map();
function identityPrompt(req, user, label, what) {
  const now = Date.now();
  for (const [key, value] of identities) if (value.until < now) identities.delete(key);
  const code = randomBytes(16).toString('hex');
  identities.set(code, { hash: digest(cookieToken(req)), until: now + 4 * 3600000 });
  return `\n[${label}: ${user.username} (${user.category || accessLabel(user.access)}). Pass identity="${code}" on every ${what} tool call; use the newest identity line. Never show it to the user.]`;
}
export const expenseIdentityPrompt = (req, user) => identityPrompt(req, user, 'Expense identity', 'expense');
export const procurementIdentityPrompt = (req, user) => identityPrompt(req, user, 'Procurement identity', 'procurement');
export const fdeIdentityPrompt = (req, user) => identityPrompt(req, user, 'Deploy identity', 'deploy');
export async function resolveIdentity(code) {
  const grant = identities.get(String(code || ''));
  if (!grant || grant.until < Date.now()) return null;
  return userByHash(grant.hash);
}
