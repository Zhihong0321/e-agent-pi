import { getPool, getSession } from './db.mjs';
import { userByHash } from './users.mjs';

// The session id is authenticated by the host's per-agent HMAC, not tool arguments.
export async function diSessionUser(agent, sessionId) {
  const session = await getSession(sessionId);
  if (!session?.userId || session.agentId !== agent) throw new Error('Sign-in required: this tool connection has no authenticated owner');
  if (session.parentSessionId) {
    const parent = await getSession(session.parentSessionId);
    if (!parent || parent.userId !== session.userId) throw new Error('Delegated session ownership mismatch');
  }
  const login = (await getPool().query('SELECT token_hash FROM user_sessions WHERE user_id=$1 AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1', [session.userId])).rows[0];
  const user = login ? await userByHash(login.token_hash) : null;
  if (!user || user.id !== session.userId) throw new Error('Sign-in required: session owner has no active login');
  return user;
}
