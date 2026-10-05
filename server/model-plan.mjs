import { dbReady, getPool } from "./db.mjs";
import { secret } from "./secrets.mjs";

export const MINIMAX_MODEL_ID = "MiniMax-M3.1-Flash-Preview";
const MIGRATION_KEY = "minimax_m_plan_migrated";

/** Move existing model selections once, after credentials and catalog schema are ready. */
export async function migrateMiniMaxPlan(pool = dbReady() ? getPool() : null) {
  if (!pool || !secret("minimax_api_key")) return { skipped: true };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [MIGRATION_KEY]);
    const existing = await client.query("SELECT value FROM settings WHERE key=$1", [MIGRATION_KEY]);
    if (existing.rows[0]?.value === MINIMAX_MODEL_ID) {
      await client.query("COMMIT");
      return { skipped: true };
    }
    const agents = await client.query(
      "UPDATE agents SET model_id=$1 WHERE COALESCE(engine, 'pi')='pi' AND model_id IS DISTINCT FROM $1", [MINIMAX_MODEL_ID],
    );
    const sessions = await client.query(
      "UPDATE sessions SET model_id=$1 WHERE COALESCE(engine, 'pi')='pi' AND model_id IS DISTINCT FROM $1", [MINIMAX_MODEL_ID],
    );
    await client.query(
      "INSERT INTO settings(key,value) VALUES ('active_model_id',$1),($2,$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
      [MINIMAX_MODEL_ID, MIGRATION_KEY],
    );
    // Prewarming must use the migrated selections rather than a cached legacy model.
    await client.query("DELETE FROM settings WHERE key='pi_last_slot'");
    await client.query("COMMIT");
    return { modelId: MINIMAX_MODEL_ID, agents: agents.rowCount, sessions: sessions.rowCount };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
