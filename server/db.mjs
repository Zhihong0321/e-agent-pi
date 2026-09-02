import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

/** @type {pg.Pool | undefined} */
let pool;

export function dbReady() {
  return Boolean(pool);
}

export function getPool() {
  if (!pool) throw new Error("Database is not connected");
  return pool;
}

export async function connectDb() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const local = /localhost|127\.0\.0\.1/i.test(connectionString);
  pool = new Pool({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: false },
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New chat',
      pi_session_id TEXT,
      pi_session_file TEXT,
      model_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      session_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS git_syncs (
      id SERIAL PRIMARY KEY,
      sha TEXT,
      status TEXT NOT NULL,
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS debug_events (
      id SERIAL PRIMARY KEY,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS session_id TEXT`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS messages_session_id_idx ON messages (session_id)`);
  await migrateLegacyMessages();
}

async function migrateLegacyMessages() {
  if (!pool) return;
  const orphans = await pool.query(`SELECT COUNT(*)::int AS n FROM messages WHERE session_id IS NULL`);
  if (!orphans.rows[0]?.n) return;

  await pool.query(
    `INSERT INTO sessions (id, title) VALUES ('legacy', 'Previous chat')
     ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(`UPDATE messages SET session_id = 'legacy' WHERE session_id IS NULL`);
  await pool.query(`UPDATE sessions SET updated_at = NOW() WHERE id = 'legacy'`);
}

export async function closeDb() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

/**
 * @param {string} key
 * @returns {Promise<string | null>}
 */
export async function getSetting(key) {
  const result = await getPool().query("SELECT value FROM settings WHERE key = $1", [key]);
  return result.rows[0]?.value ?? null;
}

/**
 * @param {string} key
 * @param {string} value
 */
export async function setSetting(key, value) {
  await getPool().query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value],
  );
}

/**
 * @param {{ id?: string; title?: string; piSessionId?: string | null; piSessionFile?: string | null; modelId?: string | null; agentId?: string | null }} [row]
 */
export async function createSession(row = {}) {
  const id = row.id || randomUUID();
  const title = row.title?.trim() || "New chat";
  const result = await getPool().query(
    `INSERT INTO sessions (id, title, pi_session_id, pi_session_file, model_id, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, title, pi_session_id AS "piSessionId", pi_session_file AS "piSessionFile",
               model_id AS "modelId", agent_id AS "agentId", created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, title, row.piSessionId ?? null, row.piSessionFile ?? null, row.modelId ?? null, row.agentId ?? null],
  );
  return result.rows[0];
}

/**
 * @param {string} id
 */
export async function getSession(id) {
  const result = await getPool().query(
    `SELECT id, title, pi_session_id AS "piSessionId", pi_session_file AS "piSessionFile",
            model_id AS "modelId", agent_id AS "agentId", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM sessions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function listSessions(agentId) {
  const values = [];
  const where = agentId ? (values.push(agentId), "WHERE s.agent_id = $1") : "";
  const result = await getPool().query(
    `SELECT s.id, s.title,
            s.pi_session_id AS "piSessionId",
            s.pi_session_file AS "piSessionFile",
            s.model_id AS "modelId",
            s.agent_id AS "agentId",
            s.created_at AS "createdAt",
            s.updated_at AS "updatedAt",
            (
              SELECT m.content FROM messages m
              WHERE m.session_id = s.id
              ORDER BY m.id DESC LIMIT 1
            ) AS preview,
            (
              SELECT COUNT(*)::int FROM messages m WHERE m.session_id = s.id
            ) AS "messageCount"
     FROM sessions s
     ${where}
     ORDER BY s.updated_at DESC`,
    values,
  );
  return result.rows;
}

export async function countSessions() {
  const result = await getPool().query(`SELECT COUNT(*)::int AS n FROM sessions`);
  return result.rows[0]?.n ?? 0;
}

/**
 * @param {string} id
 * @param {{ title?: string; piSessionId?: string | null; piSessionFile?: string | null; modelId?: string | null; agentId?: string | null }} patch
 */
export async function updateSession(id, patch) {
  const fields = [];
  const values = [];
  let i = 1;
  if (patch.title !== undefined) {
    fields.push(`title = $${i++}`);
    values.push(patch.title);
  }
  if (patch.piSessionId !== undefined) {
    fields.push(`pi_session_id = $${i++}`);
    values.push(patch.piSessionId);
  }
  if (patch.piSessionFile !== undefined) {
    fields.push(`pi_session_file = $${i++}`);
    values.push(patch.piSessionFile);
  }
  if (patch.modelId !== undefined) {
    fields.push(`model_id = $${i++}`);
    values.push(patch.modelId);
  }
  if (patch.agentId !== undefined) {
    fields.push(`agent_id = $${i++}`);
    values.push(patch.agentId);
  }
  if (!fields.length) return getSession(id);
  fields.push("updated_at = NOW()");
  values.push(id);
  const result = await getPool().query(
    `UPDATE sessions SET ${fields.join(", ")} WHERE id = $${i}
     RETURNING id, title, pi_session_id AS "piSessionId", pi_session_file AS "piSessionFile",
               model_id AS "modelId", agent_id AS "agentId", created_at AS "createdAt", updated_at AS "updatedAt"`,
    values,
  );
  return result.rows[0] ?? null;
}

/**
 * @param {string} id
 */
export async function deleteSession(id) {
  await getPool().query(`DELETE FROM messages WHERE session_id = $1`, [id]);
  const result = await getPool().query(`DELETE FROM sessions WHERE id = $1 RETURNING id`, [id]);
  return Boolean(result.rows[0]);
}

/**
 * @param {{ sessionId: string; role: string; content: string; modelId?: string | null }} row
 */
export async function insertMessage(row) {
  const result = await getPool().query(
    `INSERT INTO messages (session_id, role, content, model_id) VALUES ($1, $2, $3, $4)
     RETURNING id, session_id AS "sessionId", role, content, model_id AS "modelId", created_at AS "createdAt"`,
    [row.sessionId, row.role, row.content, row.modelId ?? null],
  );
  await getPool().query(`UPDATE sessions SET updated_at = NOW() WHERE id = $1`, [row.sessionId]);
  return result.rows[0];
}

/**
 * @param {string} sessionId
 * @param {number} [limit]
 */
export async function listMessages(sessionId, limit = 200) {
  if (!sessionId) return [];
  const result = await getPool().query(
    `SELECT id, session_id AS "sessionId", role, content, model_id AS "modelId", created_at AS "createdAt"
     FROM messages
     WHERE session_id = $1
     ORDER BY id ASC
     LIMIT $2`,
    [sessionId, limit],
  );
  return result.rows;
}

/**
 * @param {{ sha?: string | null; status: string; message?: string | null }} row
 */
export async function insertGitSync(row) {
  const result = await getPool().query(
    `INSERT INTO git_syncs (sha, status, message) VALUES ($1, $2, $3)
     RETURNING id, sha, status, message, created_at AS "createdAt"`,
    [row.sha ?? null, row.status, row.message ?? null],
  );
  return result.rows[0];
}

export async function latestGitSync() {
  const result = await getPool().query(
    `SELECT id, sha, status, message, created_at AS "createdAt"
     FROM git_syncs
     ORDER BY id DESC
     LIMIT 1`,
  );
  return result.rows[0] ?? null;
}
