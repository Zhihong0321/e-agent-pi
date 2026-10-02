import { getPool } from './db.mjs';

export async function chatLogs({ search = '', before, beforeId = '', sessionId, after = 0, userId } = {}, pool = getPool()) {
  if (sessionId) {
    const session = await pool.query('SELECT id, title FROM sessions WHERE id=$1 AND ($2::text IS NULL OR user_id=$2)', [sessionId, userId || null]);
    if (!session.rows.length) return { session: null, messages: [], nextAfter: null };
    const result = await pool.query(`SELECT id, role, content, model_id AS "modelId", created_at AS "createdAt"
      FROM messages WHERE session_id=$1 AND id>$2 ORDER BY id ASC LIMIT 201`,
    [sessionId, Math.max(0, Number(after) || 0)]);
    const messages = result.rows.slice(0, 200);
    return { session: session.rows[0], messages, nextAfter: result.rows.length > 200 ? messages.at(-1).id : null };
  }
  const result = await pool.query(`SELECT s.id, s.title, s.agent_id AS "agentId", s.engine,
      s.updated_at AS "updatedAt", s.parent_session_id AS "parentSessionId",
      COALESCE(u.display_name, u.username, s.user_id) AS "userName",
      (SELECT COUNT(*)::int FROM messages m WHERE m.session_id=s.id) AS "messageCount"
    FROM sessions s LEFT JOIN users u ON u.id=s.user_id
    WHERE ($1='' OR s.title ILIKE '%' || $1 || '%' OR s.agent_id ILIKE '%' || $1 || '%'
      OR u.username ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%')
      AND ($2::timestamptz IS NULL OR s.updated_at<$2 OR (s.updated_at=$2 AND s.id<$3))
      AND ($4::text IS NULL OR s.user_id=$4)
    ORDER BY s.updated_at DESC, s.id DESC LIMIT 101`, [String(search).slice(0, 200), before || null, beforeId, userId || null]);
  const sessions = result.rows.slice(0, 100);
  return { sessions, nextBefore: result.rows.length > 100 ? sessions.at(-1).updatedAt : null, nextBeforeId: result.rows.length > 100 ? sessions.at(-1).id : null };
}
