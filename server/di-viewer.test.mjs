import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { viewerQuery, handleDiViewer } from "./di-viewer.mjs";

test("viewer rejects unauthenticated API and redirects page to settings", async () => {
  for (const [path, expected] of [["/db-viewer/api/config", 401], ["/db-viewer/", 302]]) {
    let status;
    const res = { writeHead(code) { status = code; }, end() {} };
    await handleDiViewer({ method: "GET", headers: {} }, res, new URL(path, "http://localhost"));
    assert.equal(status, expected);
  }
});

test("failed queries roll back and discard the connection", async () => {
  const calls = [];
  let discarded = false;
  const client = {
    async query(query) {
      calls.push(query);
      if (typeof query === "object") throw new Error("query rejected");
    },
    release(value) { discarded = value; },
  };
  await assert.rejects(viewerQuery({ connect: async () => client }, "SELECT 1"), /query rejected/);
  assert.equal(calls[0], "BEGIN READ ONLY");
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(calls.find((q) => typeof q === "object").queryMode, "extended");
  assert.equal(discarded, true);
});

test("live PostgreSQL viewer reads DI and rejects writes and statement escape", { skip: !process.env.DATABASE_URL }, async () => {
  const connectionString = process.env.DATABASE_URL;
  const pool = new pg.Pool({ connectionString, ssl: /localhost|127\.0\.0\.1/i.test(connectionString) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  try {
    const tables = await viewerQuery(pool, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'di'");
    assert.ok(tables.rows.length, "DI tables exist in this database");
    const result = await viewerQuery(pool, "SELECT $1::text AS value;", ["viewer works"]);
    assert.equal(result.rows[0].value, "viewer works");
    const limit = await viewerQuery(pool, "SELECT generate_series(1, 1002) AS n");
    assert.equal(limit.rows.length, 1000);
    assert.equal(limit.truncated, true);
    for (const sql of ["DELETE FROM di.customer WHERE false", "SELECT 1; COMMIT; SELECT 2", "SELECT 1) AS escape; COMMIT; SELECT 2 --", "WITH changed AS (DELETE FROM di.customer WHERE false RETURNING *) SELECT * FROM changed", "SELECT nextval('di.viewer_nonexistent_sequence')"]) {
      await assert.rejects(viewerQuery(pool, sql));
    }
    assert.equal((await viewerQuery(pool, "SELECT current_setting('transaction_read_only') AS value")).rows[0].value, "on");
  } finally { await pool.end(); }
});
