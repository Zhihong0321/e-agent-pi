import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

const sessions = new Map();
let liveUser = { id: 'alice', username: 'alice', role: 'user' };
mock.module('./db.mjs', { namedExports: {
  getSession: async id => sessions.get(id),
  getPool: () => ({ query: async () => ({ rows: liveUser ? [{ token_hash: 'live-login' }] : [] }) }),
} });
mock.module('./users.mjs', { namedExports: { userByHash: async () => liveUser } });
const { diSessionUser } = await import('./di-session-user.mjs');

test('financial agent actor comes from the authenticated session and rejects foreign or revoked owners', async () => {
  sessions.set('invoice', { id: 'invoice', agentId: 'di-documents', userId: 'alice' });
  assert.equal((await diSessionUser('di-documents', 'invoice')).username, 'alice');
  await assert.rejects(diSessionUser('di-procurement', 'invoice'), /authenticated owner/);
  await assert.rejects(diSessionUser('di-documents', 'missing'), /authenticated owner/);
  sessions.set('child', { id: 'child', agentId: 'di-documents', userId: 'alice', parentSessionId: 'parent' });
  sessions.set('parent', { id: 'parent', agentId: 'orchestrator', userId: 'bob' });
  await assert.rejects(diSessionUser('di-documents', 'child'), /ownership mismatch/);
  sessions.set('parent', { id: 'parent', agentId: 'orchestrator', userId: 'alice' });
  assert.equal((await diSessionUser('di-documents', 'child')).id, 'alice');
  liveUser = null;
  await assert.rejects(diSessionUser('di-documents', 'invoice'), /no active login/);
});
