import { getPool, getSession } from './db.mjs';
import { userByHash } from './users.mjs';

// Only the host opens this context. Tool arguments never select the acting user.
const activeTurns = new Map();

export async function authenticateExpenseSession(session, expectedUserId = session?.userId) {
  const stored = session?.id ? await getSession(session.id) : null;
  if (!stored || stored.agentId !== 'di-expenses' || !stored.userId) {
    throw new Error('Sign-in required: expense session has no authenticated owner');
  }
  if (stored.userId !== expectedUserId) throw new Error('Expense session ownership mismatch');
  if (stored.parentSessionId) {
    const parent = await getSession(stored.parentSessionId);
    if (!parent || parent.agentId !== 'orchestrator' || parent.userId !== stored.userId) {
      throw new Error('Expense delegation requires its owning orchestrator session');
    }
  }
  const login = (await getPool().query(
    'SELECT token_hash FROM user_sessions WHERE user_id=$1 AND expires_at>NOW() ORDER BY expires_at DESC LIMIT 1',
    [stored.userId],
  )).rows[0];
  const user = login ? await userByHash(login.token_hash) : null;
  if (!user || user.id !== stored.userId) throw new Error('Sign-in required: expense session owner has no active login');
  return { session: stored, loginHash: login.token_hash, user };
}

export async function withExpenseSession(session, run) {
  if (session?.agentId !== 'di-expenses') return run();
  const context = await authenticateExpenseSession(session);
  if (activeTurns.has(session.id)) throw new Error('Expense session already has an active turn');
  activeTurns.set(session.id, context);
  try { return await run(); }
  finally { activeTurns.delete(session.id); }
}

export async function expenseUserForSession(sessionId) {
  const context = activeTurns.get(sessionId);
  if (!context) throw new Error('Sign-in required: no active expense turn is attached to this tool connection');
  // Recheck ownership and the exact login selected when the turn began. Logout,
  // expiry or disabling the account revokes access even during an active turn.
  await authenticateExpenseSession(context.session, context.user.id);
  const user = await userByHash(context.loginHash);
  if (!user || user.id !== context.user.id) throw new Error('Sign-in required: expense login expired or was revoked');
  return user;
}
