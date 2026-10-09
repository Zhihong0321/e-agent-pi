import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { chatLogs } from './chat-logs.mjs';

test('chat logs search, delegation, timestamp ties and full transcript pagination', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE users (id text, username text, display_name text, company_tenant_id text);
      CREATE TABLE sessions (id text, title text, agent_id text, engine text, updated_at timestamptz, user_id text, parent_session_id text);
      CREATE TABLE messages (id serial, session_id text, role text, content text, model_id text, created_at timestamptz DEFAULT now());
      INSERT INTO users VALUES ('u', 'alice', 'Alice', 'co-a');
      INSERT INTO sessions SELECT 's-' || lpad(n::text, 3, '0'), 'Chat ' || n, 'worker', 'pi', '2026-10-02', 'u', 'parent' FROM generate_series(1, 105) n;
      INSERT INTO messages (session_id, role, content) SELECT 's-001', 'assistant', 'message ' || n FROM generate_series(1, 205) n;`);
    const first = await chatLogs({ search: 'Alice' }, db);
    assert.equal(first.sessions.length, 100);
    assert.equal(first.sessions[0].parentSessionId, 'parent');
    const second = await chatLogs({ before: first.nextBefore, beforeId: first.nextBeforeId }, db);
    assert.equal(second.sessions.length, 5);
    assert.equal(new Set([...first.sessions, ...second.sessions].map(s => s.id)).size, 105);
    const messages = await chatLogs({ sessionId: 's-001' }, db);
    assert.equal(messages.messages.length, 200);
    const rest = await chatLogs({ sessionId: 's-001', after: messages.nextAfter }, db);
    assert.equal(rest.messages.length, 5);
    assert.equal(rest.nextAfter, null);
    assert.equal((await chatLogs({ sessionId: 'missing' }, db)).session, null);
    assert.equal((await chatLogs({ search: "' OR true --" }, db)).sessions.length, 0);
    assert.equal((await chatLogs({ userId: 'other-user' }, db)).sessions.length, 0);
    assert.equal((await chatLogs({ sessionId: 's-001', userId: 'other-user' }, db)).session, null);
    assert.equal((await chatLogs({ sessionId: 's-001', userId: 'u' }, db)).messages.length, 200);
  } finally { await db.close(); }
});
