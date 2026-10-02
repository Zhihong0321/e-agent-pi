import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Exercise the production persistence functions without connecting to a live DB.
const calls = [];
let rows = [];
const pool = {
  query: async (sql, params) => { calls.push({ sql, params }); return { rows }; },
  end: async () => {},
};
mock.module('pg', { defaultExport: { Pool: class { constructor() { return pool; } } } });
mock.module('./users.mjs', { namedExports: { ensureUsers: async () => {} } });
mock.module('./activity.mjs', { namedExports: { ensureActivitySchema: async () => {} } });
const db = await import('./db.mjs');
const originalUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgres://test@localhost/ownership_test';
await db.connectDb();
if (originalUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = originalUrl;
test.after(() => db.closeDb());
test.beforeEach(() => { calls.length = 0; rows = []; });

test('user session lists filter by owner in SQL and hide child sessions', async () => {
  await db.listSessions(undefined, 'alice');
  assert.deepEqual(calls[0].params, ['alice']);
  assert.match(calls[0].sql, /s\.user_id = \$1/);
  assert.match(calls[0].sql, /s\.parent_session_id IS NULL/);
  assert.doesNotMatch(calls[0].sql, /OR.*user_id IS NULL/);
});

test('agent filters retain the user scope with independent query parameters', async () => {
  await db.listSessions('orchestrator', 'bob');
  assert.deepEqual(calls[0].params, ['bob', 'orchestrator']);
  assert.match(calls[0].sql, /s\.user_id = \$1 AND s\.agent_id = \$2/);
});

test('session lookup checks both id and owner and never claims unowned chats', async () => {
  assert.equal(await db.getSession('chat-1', 'alice'), null);
  assert.deepEqual(calls[0].params, ['chat-1', 'alice']);
  assert.match(calls[0].sql, /WHERE s\.id = \$1 AND s\.user_id = \$2/);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].sql, /UPDATE|INSERT/);
});

test('operator reads remain available without a user scope', async () => {
  await db.getSession('chat-1');
  assert.deepEqual(calls[0].params, ['chat-1']);
  assert.doesNotMatch(calls[0].sql, /s\.user_id = \$2/);
  await db.listSessions('orchestrator');
  assert.deepEqual(calls[1].params, ['orchestrator']);
  assert.doesNotMatch(calls[1].sql, /s\.user_id = \$/);
});

test('chat ownership is inserted atomically, including parent ownership inheritance', async () => {
  rows = [{ id: 'chat-1', userId: 'alice' }];
  await db.createSession({ id: 'chat-1', userId: 'alice' });
  assert.equal(calls[0].params[9], 'alice');
  assert.match(calls[0].sql, /parent_session_id, user_id/);
  calls.length = 0;
  rows = [];
  await db.createSession({ id: 'child-1', parentSessionId: 'chat-1' });
  assert.equal(calls[0].params[8], 'chat-1');
  assert.equal(calls[0].params[9], null);
  assert.match(calls[0].sql, /COALESCE\(\$10, \(SELECT user_id FROM sessions WHERE id = \$9\)\)/);
});
