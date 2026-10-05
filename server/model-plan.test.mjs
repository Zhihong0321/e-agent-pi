import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { PGlite } from "@electric-sql/pglite";

let apiKey = "test-key";
mock.module("./secrets.mjs", { namedExports: { secret: () => apiKey } });
mock.module("./db.mjs", { namedExports: { dbReady: () => false, getPool: () => null } });
const { migrateMiniMaxPlan, MINIMAX_MODEL_ID } = await import("./model-plan.mjs");

test("migration moves all Pi selections once and preserves history and other engines", async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);
    CREATE TABLE agents (id text PRIMARY KEY, engine text, model_id text);
    CREATE TABLE sessions (id text PRIMARY KEY, engine text, model_id text, title text);
    CREATE TABLE messages (content text, model_id text);
    INSERT INTO settings VALUES ('active_model_id','old'),('pi_last_slot','old');
    INSERT INTO agents VALUES ('worker','pi','old'),('default','pi',NULL),('other','agy','gemini');
    INSERT INTO sessions VALUES ('chat','pi','old','Keep my title'),('other','agy','gemini','AGY');
    INSERT INTO messages VALUES ('Keep my message','old');
  `);
  let releases = 0;
  const client = {
    query: async (sql, args) => {
      // Embedded Postgres has one connection; advisory locking is supplied by production PG.
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      const result = await db.query(sql, args);
      return { ...result, rowCount: result.affectedRows };
    },
    release: () => { releases++; },
  };
  const pool = { connect: async () => client };
  try {
    const result = await migrateMiniMaxPlan(pool);
    assert.equal(result.modelId, MINIMAX_MODEL_ID);
    assert.equal(result.agents, 2);
    assert.equal(result.sessions, 1);
    assert.deepEqual((await db.query("SELECT * FROM messages")).rows, [{ content: "Keep my message", model_id: "old" }]);
    assert.equal((await db.query("SELECT title FROM sessions WHERE id='chat'")).rows[0].title, "Keep my title");
    assert.equal((await db.query("SELECT model_id FROM agents WHERE id='other'")).rows[0].model_id, "gemini");
    assert.equal((await db.query("SELECT value FROM settings WHERE key='active_model_id'")).rows[0].value, MINIMAX_MODEL_ID);
    assert.equal((await db.query("SELECT * FROM settings WHERE key='pi_last_slot'")).rows.length, 0);
    await db.query("UPDATE agents SET model_id='later-choice' WHERE id='worker'");
    assert.deepEqual(await migrateMiniMaxPlan(pool), { skipped: true });
    assert.equal((await db.query("SELECT model_id FROM agents WHERE id='worker'")).rows[0].model_id, "later-choice");
    assert.equal(releases, 2);
    apiKey = "";
    assert.deepEqual(await migrateMiniMaxPlan(pool), { skipped: true });
    assert.equal(releases, 2);
  } finally {
    apiKey = "test-key";
    await db.close();
  }
});
