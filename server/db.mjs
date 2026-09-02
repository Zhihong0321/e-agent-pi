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
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
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
 * @param {{ role: string; content: string; modelId?: string | null }} row
 */
export async function insertMessage(row) {
  const result = await getPool().query(
    `INSERT INTO messages (role, content, model_id) VALUES ($1, $2, $3)
     RETURNING id, role, content, model_id AS "modelId", created_at AS "createdAt"`,
    [row.role, row.content, row.modelId ?? null],
  );
  return result.rows[0];
}

/**
 * @param {number} [limit]
 */
export async function listMessages(limit = 200) {
  const result = await getPool().query(
    `SELECT id, role, content, model_id AS "modelId", created_at AS "createdAt"
     FROM messages
     ORDER BY id ASC
     LIMIT $1`,
    [limit],
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
