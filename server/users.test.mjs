import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureUsers, hashPassword, verifyPassword, sessionCookie, expenseIdentityPrompt, resolveIdentity } from './users.mjs';
import { USER_SCHEMA_SQL } from './user-schema.mjs';

test('passwords use unique salts and reject incorrect, missing or oversized input', () => {
  const first = hashPassword('1234');
  assert.notEqual(first, hashPassword('1234'));
  assert.equal(verifyPassword('1234', first), true);
  assert.equal(verifyPassword('wrong', first), false);
  assert.equal(verifyPassword('a'.repeat(257), first), false);
  assert.equal(verifyPassword('1234', null), false, 'a user without a password cannot sign in');
  assert.throws(() => hashPassword('123'));
});

test('boot builds the one user schema and never seeds an account', async () => {
  const calls = [];
  await ensureUsers({ query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } });
  assert.equal(calls[0].sql, USER_SCHEMA_SQL);
  assert.match(USER_SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS user_category/);
  assert.match(USER_SCHEMA_SQL, /category_id TEXT NOT NULL REFERENCES user_category\(id\)/);
  const usersTable = USER_SCHEMA_SQL.slice(USER_SCHEMA_SQL.indexOf('CREATE TABLE IF NOT EXISTS users'), USER_SCHEMA_SQL.indexOf('-- Upgrade'));
  assert.doesNotMatch(usersTable, /\b(tier|role)\b/, 'category replaces role and tier');
  assert.match(calls[1].sql, /ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users\(id\)/);
  assert.equal(calls.some((call) => /INSERT INTO users/.test(call.sql)), false, 'no default admin/1234 account');
});

test('cookies are HttpOnly, SameSite strict, and secure over HTTPS', () => {
  assert.match(sessionCookie({ headers: {}, socket: {} }, 'token'), /HttpOnly; SameSite=Strict/);
  assert.match(sessionCookie({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }, 'token'), /; Secure$/);
  assert.match(sessionCookie({ headers: {}, socket: {} }, '', 0), /Max-Age=0/);
});

test('expense identity codes are random per turn, and only honoured while fresh', async () => {
  const req = { headers: { cookie: 'demo_session=tok123' } };
  const mint = () => expenseIdentityPrompt(req, { username: 'sam', access: 'user', category: 'Staff' });
  const first = mint();
  const code = first.match(/identity="([a-f0-9]{32})"/)[1];
  assert.match(first, /\[Expense identity: sam \(Staff\)/);
  assert.match(expenseIdentityPrompt(req, { username: 'root', access: 'superadmin' }), /root \(Superadmin\)/);
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
