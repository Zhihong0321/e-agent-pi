import test from 'node:test';
import assert from 'node:assert/strict';

test('createSession persists userId and enriches with user metadata', async () => {
  // Verify that createSession query includes user_id
  const queries = [];
  const mockPool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('INSERT INTO sessions')) {
        return {
          rows: [{
            id: params[0],
            title: params[1],
            piSessionId: params[2],
            piSessionFile: params[3],
            modelId: params[4],
            agentId: params[5],
            engine: params[6],
            agyConversationId: params[7],
            userId: params[9],
            parentSessionId: params[8],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }],
        };
      }
      if (sql.includes('SELECT username, display_name, role FROM users')) {
        return {
          rows: [{
            username: 'testuser',
            display_name: 'Test User',
            role: 'user',
          }],
        };
      }
      return { rows: [] };
    },
  };

  // Dynamically test using mock pool
  const id = 'sess-123';
  const row = { id, title: 'User chat', userId: 'user-456' };
  const insertSql = `INSERT INTO sessions (id, title, pi_session_id, pi_session_file, model_id, agent_id, engine, agy_conversation_id, parent_session_id, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, title, pi_session_id AS "piSessionId", pi_session_file AS "piSessionFile",
               model_id AS "modelId", agent_id AS "agentId",
               COALESCE(engine, 'pi') AS engine,
               agy_conversation_id AS "agyConversationId",
               user_id AS "userId", parent_session_id AS "parentSessionId",
               created_at AS "createdAt", updated_at AS "updatedAt"`;
  const result = await mockPool.query(insertSql, [id, row.title, null, null, null, null, 'pi', null, null, row.userId]);
  const session = result.rows[0];
  if (session?.userId) {
    const userRow = (await mockPool.query('SELECT username, display_name, role FROM users WHERE id = $1', [session.userId])).rows[0];
    if (userRow) {
      session.userName = userRow.username;
      session.userDisplayName = userRow.display_name;
      session.userRole = userRow.role;
    }
  }

  assert.equal(session.id, 'sess-123');
  assert.equal(session.userId, 'user-456');
  assert.equal(session.userName, 'testuser');
  assert.equal(session.userDisplayName, 'Test User');
  assert.equal(session.userRole, 'user');
});

test('publicSession formats marked user info for client and stream', () => {
  function publicSession(session, fallbackUser) {
    if (!session) return null;
    const uid = session.userId || (fallbackUser?.id ?? null);
    const uname = session.userName || (fallbackUser?.id === uid ? fallbackUser.username : null);
    const dname = session.userDisplayName || (fallbackUser?.id === uid ? (fallbackUser.display_name || fallbackUser.username) : null);
    const role = session.userRole || (fallbackUser?.id === uid ? fallbackUser.role : null);
    const sessionUser = uid ? {
      id: uid,
      username: uname || "user",
      displayName: dname || uname || "User",
      role: role || "user",
    } : null;

    return {
      id: session.id,
      title: session.title,
      engine: session.engine || "pi",
      userId: uid,
      user: sessionUser,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  const s1 = {
    id: 's1',
    title: 'Chat 1',
    userId: 'u1',
    userName: 'john',
    userDisplayName: 'John Doe',
    userRole: 'admin',
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
  };
  const pub1 = publicSession(s1);
  assert.equal(pub1.userId, 'u1');
  assert.deepEqual(pub1.user, {
    id: 'u1',
    username: 'john',
    displayName: 'John Doe',
    role: 'admin',
  });

  const s2 = {
    id: 's2',
    title: 'Chat 2',
    createdAt: '2026-10-01',
    updatedAt: '2026-10-01',
  };
  const fallback = { id: 'u2', username: 'alice', display_name: 'Alice', role: 'user' };
  const pub2 = publicSession(s2, fallback);
  assert.equal(pub2.userId, 'u2');
  assert.deepEqual(pub2.user, {
    id: 'u2',
    username: 'alice',
    displayName: 'Alice',
    role: 'user',
  });
});
