// Thin database seam so the same domain code runs on the host's pg Pool and on
// PGlite in tests. Everything an agent does goes through withContext(), which
// drops to the di_app role and pins the tenant for row-level security.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sql");

/** @param {import("pg").Pool} pool */
export function pgAdapter(pool) {
  return {
    query: (sql, params) => pool.query(sql, params),
    exec: (sql) => pool.query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn({ query: (sql, params) => client.query(sql, params), exec: (sql) => client.query(sql) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** @param {any} pglite */
export function pgliteAdapter(pglite) {
  return {
    query: (sql, params) => pglite.query(sql, params),
    exec: (sql) => pglite.exec(sql),
    transaction: (fn) =>
      pglite.transaction((tx) => fn({ query: (sql, params) => tx.query(sql, params), exec: (sql) => tx.exec(sql) })),
  };
}

/** Applies sql/*.sql once each, in name order, under an advisory lock. */
export async function migrate(db) {
  await db.exec(`CREATE SCHEMA IF NOT EXISTS di;
    CREATE TABLE IF NOT EXISTS di.schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());`);
  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied = [];
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('di.migrate'))");
    const done = new Set((await tx.query("SELECT id FROM di.schema_migrations")).rows.map((r) => r.id));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(SQL_DIR, file), "utf8");
      await tx.exec(sql);
      await tx.query("INSERT INTO di.schema_migrations (id) VALUES ($1)", [file]);
      applied.push(file);
    }
  });
  return applied;
}

/** True when the connecting user may SET ROLE di_app. */
export async function roleAvailable(db) {
  const { rows } = await db.query(
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'di_app')
        THEN pg_has_role(current_user, 'di_app', 'MEMBER') ELSE false END AS ok`,
  );
  return Boolean(rows[0]?.ok);
}

/**
 * Runs fn in one transaction as di_app, scoped to a tenant.
 * @param {ReturnType<typeof pgAdapter>} db
 * @param {{ tenantId: string, actor?: string, agent?: string, asRole?: boolean }} ctx
 * @param {(tx: { query: Function }) => Promise<any>} fn
 */
export function withContext(db, ctx, fn) {
  if (!ctx?.tenantId) throw new Error("withContext needs a tenantId");
  return db.transaction(async (tx) => {
    if (ctx.asRole !== false) await tx.query("SET LOCAL ROLE di_app");
    await tx.query(
      `SELECT set_config('di.tenant_id', $1, true), set_config('di.actor', $2, true), set_config('di.agent', $3, true)`,
      [ctx.tenantId, ctx.actor || "owner", ctx.agent || ""],
    );
    return fn(tx);
  });
}
