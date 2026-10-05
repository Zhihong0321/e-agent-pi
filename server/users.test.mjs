import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureUsers, hashPassword, verifyPassword, sessionCookie, manageUsers, userManagementPrompt, expenseIdentityPrompt, resolveIdentity } from './users.mjs';

test('passwords use unique salts and reject incorrect or oversized input', () => {
  const first = hashPassword('1234');
  assert.notEqual(first, hashPassword('1234'));
  assert.equal(verifyPassword('1234', first), true);
  assert.equal(verifyPassword('wrong', first), false);
  assert.equal(verifyPassword('a'.repeat(257), first), false);
  assert.throws(() => hashPassword('123'));
});

test('bootstrap creates tables and seeds admin only when the user table is empty', async () => {
  const calls = [];
  let released = false;
  const tx = { query: async (sql, params) => { calls.push({ sql, params }); }, release: () => { released = true; } };
  await ensureUsers({ query: tx.query, connect: async () => tx });
  assert.match(calls[0].sql, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(calls[0].sql, /REFERENCES users\(id\)/);
  assert.match(calls[2].sql, /pg_advisory_xact_lock/);
  const seed = calls.find(call => call.sql.includes('INSERT INTO users'));
  assert.match(seed.sql, /WHERE NOT EXISTS\(SELECT 1 FROM users\)/);
  assert.equal(verifyPassword('1234', seed.params[1]), true);
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.equal(released, true);
});

test('bootstrap rolls back and releases on failure', async () => {
  const calls = [];
  let released = false;
  const tx = { query: async sql => { calls.push(sql); if (sql.includes('INSERT INTO')) throw new Error('db failed'); }, release: () => { released = true; } };
  await assert.rejects(ensureUsers({ query: async () => {}, connect: async () => tx }), /db failed/);
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

test('cookies are HttpOnly, SameSite strict, and secure over HTTPS', () => {
  assert.match(sessionCookie({ headers: {}, socket: {} }, 'token'), /HttpOnly; SameSite=Strict/);
  assert.match(sessionCookie({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }, 'token'), /; Secure$/);
  assert.match(sessionCookie({ headers: {}, socket: {} }, '', 0), /Max-Age=0/);
});

test('AI management refuses missing or fabricated admin authorization', async () => {
  await assert.rejects(manageUsers('create_user', { username: 'new', password: '1234' }), /current admin login/);
  await assert.rejects(manageUsers('list_users', { admin_capability: 'invented' }), /current admin login/);
  assert.doesNotMatch(userManagementPrompt({}, { role: 'user' }), /admin_capability=/);
  assert.match(userManagementPrompt({ headers: { cookie: 'demo_session=admin-token' } }, { role: 'admin', username: 'admin' }), /list_people/);
});

test('user bootstrap schema includes unified person profile fields without exposing password columns', async () => {
  const calls = [];
  const tx = { query: async (sql, params) => { calls.push({ sql, params }); }, release: () => {} };
  await ensureUsers({ query: tx.query, connect: async () => tx });
  const schema = calls[0].sql;
  assert.match(schema, /email TEXT/);
  assert.match(schema, /department TEXT/);
  assert.match(schema, /company_tenant_id TEXT/);
  assert.doesNotMatch(userManagementPrompt({ headers: { cookie: 'demo_session=admin-token' } }, { role: 'admin', username: 'admin' }), /password_hash/);
});

test('expense identity codes are random per turn, and only honoured while fresh', async () => {
  const req = { headers: { cookie: 'demo_session=tok123' } };
  const mint = () => expenseIdentityPrompt(req, { username: 'sam', role: 'user' });
  const first = mint();
  const code = first.match(/identity="([a-f0-9]{32})"/)[1];
  assert.match(first, /\[Expense identity: sam \(User\)/);
  assert.match(expenseIdentityPrompt(req, { username: 'root', role: 'admin' }), /root \(Superadmin\)/);
  assert.notEqual(code, mint().match(/identity="([a-f0-9]{32})"/)[1]);
  assert.equal(await resolveIdentity('invented'), null);
  assert.equal(await resolveIdentity(undefined), null);
  assert.equal(await resolveIdentity(first), null, 'the whole prompt line is not a code');
  // a real code is recognised, so it goes on to look the user up (no database in this test)
  await assert.rejects(resolveIdentity(code), /Database is not connected/);
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 3600000;
  try { assert.equal(await resolveIdentity(code), null, 'expired codes are refused before any lookup'); }
  finally { Date.now = realNow; }
});
