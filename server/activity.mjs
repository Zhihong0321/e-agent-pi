import { getPool } from "./db.mjs";

const MAX_TEXT = 1200;

function clip(value) {
  if (value == null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function redactActivity(value) {
  const text = clip(value);
  if (!text) return null;
  return text.replace(/("?(?:api[_-]?key|token|password|secret|authorization|cookie)"?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^,}\s]+)/gi, "$1[REDACTED]");
}

export async function ensureActivitySchema(pool = getPool()) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_events (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      session_id TEXT,
      parent_session_id TEXT,
      agent_id TEXT,
      agent_name TEXT,
      engine TEXT,
      model_id TEXT,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      tool_call_id TEXT,
      detail TEXT,
      result TEXT,
      error TEXT,
      status TEXT,
      duration_ms INTEGER,
      metadata JSONB
    );
    CREATE INDEX IF NOT EXISTS activity_events_occurred_idx ON activity_events (occurred_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS activity_events_user_idx ON activity_events (user_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS activity_events_agent_idx ON activity_events (agent_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS activity_events_session_idx ON activity_events (session_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS activity_events_type_idx ON activity_events (event_type, occurred_at DESC);
  `);
}

export async function recordActivity(event) {
  if (!event?.eventType) return null;
  try {
    const result = await getPool().query(
      `INSERT INTO activity_events
       (user_id, session_id, parent_session_id, agent_id, agent_name, engine, model_id,
        event_type, tool_name, tool_call_id, detail, result, error, status, duration_ms, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id, occurred_at AS "occurredAt"`,
      [
        event.userId || null,
        event.sessionId || null,
        event.parentSessionId || null,
        event.agentId || null,
        clip(event.agentName),
        clip(event.engine),
        clip(event.modelId),
        clip(event.eventType),
        clip(event.toolName),
        clip(event.toolCallId),
        redactActivity(event.detail),
        redactActivity(event.result),
        redactActivity(event.error),
        clip(event.status),
        Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
        event.metadata && typeof event.metadata === "object" ? event.metadata : null,
      ],
    );
    return result.rows[0] || null;
  } catch {
    // Activity logging must never interrupt an agent turn.
    return null;
  }
}

export async function listActivity({ limit = 100, before, userId, isAdmin = false, agentId, eventType, toolName, status, sessionId, since, until } = {}) {
  const values = [];
  const clauses = [];
  const add = (value) => { values.push(value); return `$${values.length}`; };
  const bounded = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 250);
  if (!isAdmin && userId) clauses.push(`e.user_id = ${add(userId)}`);
  else if (isAdmin && userId) clauses.push(`e.user_id = ${add(userId)}`);
  if (agentId) clauses.push(`e.agent_id = ${add(agentId)}`);
  if (eventType) clauses.push(`e.event_type = ${add(eventType)}`);
  if (toolName) clauses.push(`e.tool_name ILIKE ${add(`%${toolName}%`)}`);
  if (status) clauses.push(`e.status = ${add(status)}`);
  if (sessionId) clauses.push(`e.session_id = ${add(sessionId)}`);
  if (since) clauses.push(`e.occurred_at >= ${add(since)}`);
  if (until) clauses.push(`e.occurred_at <= ${add(until)}`);
  // Cursor is encoded as `timestamp|id`; use separate parameters for PostgreSQL row comparison.
  if (before) {
    const [at, id] = String(before).split("|");
    clauses.push(`(e.occurred_at, e.id) < (${add(at)}, ${add(Number(id) || 0)})`);
  }
  const result = await getPool().query(
    `SELECT e.id, e.occurred_at AS "occurredAt", e.user_id AS "userId", COALESCE(u.display_name, u.username) AS "userName",
            e.session_id AS "sessionId", e.parent_session_id AS "parentSessionId", e.agent_id AS "agentId", e.agent_name AS "agentName",
            e.engine, e.model_id AS "modelId", e.event_type AS "eventType", e.tool_name AS "toolName", e.tool_call_id AS "toolCallId",
            e.detail, e.result, e.error, e.status, e.duration_ms AS "durationMs", e.metadata
       FROM activity_events e LEFT JOIN users u ON u.id=e.user_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${bounded + 1}`,
    values,
  );
  const rows = result.rows;
  const hasMore = rows.length > bounded;
  const events = rows.slice(0, bounded);
  const last = events.at(-1);
  return { events, nextCursor: hasMore && last ? `${new Date(last.occurredAt).toISOString()}|${last.id}` : null };
}
