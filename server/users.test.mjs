import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureUsers, hashPassword, verifyPassword, sessionCookie, manageUsers, userManagementPrompt } from './users.mjs';

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
});
