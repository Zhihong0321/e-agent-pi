// Scheduler persistence layer: schedules, actions, occurrences, authorizations.
// Supports both pg.Pool and PGlite adapters.

import { randomUUID } from "node:crypto";
import { getPool } from "../db.mjs";

let poolOverride = null;

export function setSchedulerPool(pool) {
  poolOverride = pool;
}

function db() {
  return poolOverride || getPool();
}

let schemaReady = null;

export async function ensureSchedulerSchema(targetDb = null) {
  const runner = targetDb || db();
  if (!runner) return;
  if (!targetDb && schemaReady) return schemaReady;

  const init = async () => {
    const execute = runner.exec ? (sql) => runner.exec(sql) : (sql) => runner.query(sql);
    await execute(`
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        preset TEXT NOT NULL DEFAULT 'note',
        visibility TEXT NOT NULL DEFAULT 'company',
        timezone TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
        timing_rule JSONB NOT NULL DEFAULT '{}'::jsonb,
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        next_due_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'active',
        revision INT NOT NULL DEFAULT 1,
        source_session_id TEXT,
        source_record_link JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS schedules_company_id_idx ON schedules (company_id);
      CREATE INDEX IF NOT EXISTS schedules_status_idx ON schedules (status);
      CREATE INDEX IF NOT EXISTS schedules_next_due_at_idx ON schedules (next_due_at);

      CREATE TABLE IF NOT EXISTS schedule_actions (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL DEFAULT 'note',
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS schedule_actions_schedule_id_idx ON schedule_actions (schedule_id);

      CREATE TABLE IF NOT EXISTS schedule_occurrences (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        action_id TEXT REFERENCES schedule_actions(id) ON DELETE CASCADE,
        nominal_due_at TIMESTAMPTZ NOT NULL,
        revision INT NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'scheduled',
        execution_ref TEXT,
        delivery_receipt JSONB,
        error TEXT,
        attempts INT NOT NULL DEFAULT 0,
        claimed_at TIMESTAMPTZ,
        dispatched_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT schedule_occurrences_unique_run UNIQUE (schedule_id, nominal_due_at)
      );
      CREATE INDEX IF NOT EXISTS schedule_occurrences_due_status_idx ON schedule_occurrences (status, nominal_due_at);

      CREATE TABLE IF NOT EXISTS schedule_authorizations (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL REFERENCES schedule_actions(id) ON DELETE CASCADE,
        revision INT NOT NULL,
        authorized_by_user_id TEXT NOT NULL,
        authorized_scope JSONB NOT NULL DEFAULT '{}'::jsonb,
        authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS session_id TEXT;
      ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS result TEXT;
      ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;
      ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS snapshot JSONB;

      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'di_app') THEN
          GRANT SELECT ON schedules, schedule_actions, schedule_occurrences TO di_app;
        END IF;
      END $$;
    `);
  };

  if (targetDb) {
    return init();
  }
  schemaReady = init().catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

export function resetSchedulerSchemaForTests() {
  schemaReady = null;
  poolOverride = null;
}

export async function insertSchedule(runner, row) {
  const r = runner || db();
  const id = row.id || `sch_${randomUUID()}`;
  const result = await r.query(
    `INSERT INTO schedules (
      id, company_id, owner_user_id, title, note, preset, visibility,
      timezone, timing_rule, start_time, end_time, next_due_at,
      status, revision, source_session_id, source_record_link, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12,
      $13, $14, $15, $16, NOW(), NOW()
    ) RETURNING *`,
    [
      id,
      row.company_id,
      row.owner_user_id,
      row.title,
      row.note || "",
      row.preset || "note",
      row.visibility || "company",
      row.timezone || "Asia/Kuala_Lumpur",
      JSON.stringify(row.timing_rule || {}),
      row.start_time || null,
      row.end_time || null,
      row.next_due_at || null,
      row.status || "active",
      row.revision || 1,
      row.source_session_id || null,
      row.source_record_link ? JSON.stringify(row.source_record_link) : null,
    ],
  );
  return result.rows[0];
}

export async function insertScheduleAction(runner, row) {
  const r = runner || db();
  const id = row.id || `act_${randomUUID()}`;
  const result = await r.query(
    `INSERT INTO schedule_actions (
      id, schedule_id, action_type, config, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, NOW(), NOW()
    ) RETURNING *`,
    [id, row.schedule_id, row.action_type || "note", JSON.stringify(row.config || {})],
  );
  return result.rows[0];
}

export async function insertScheduleOccurrence(runner, row) {
  const r = runner || db();
  const id = row.id || `occ_${randomUUID()}`;
  const result = await r.query(
    `INSERT INTO schedule_occurrences (
      id, schedule_id, action_id, nominal_due_at, revision,
      status, execution_ref, delivery_receipt, error, attempts, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10, NOW(), NOW()
    )
    ON CONFLICT (schedule_id, nominal_due_at) DO UPDATE
      SET revision = EXCLUDED.revision,
          updated_at = NOW()
    RETURNING *`,
    [
      id,
      row.schedule_id,
      row.action_id || null,
      row.nominal_due_at,
      row.revision || 1,
      row.status || "scheduled",
      row.execution_ref || null,
      row.delivery_receipt ? JSON.stringify(row.delivery_receipt) : null,
      row.error || null,
      row.attempts || 0,
    ],
  );
  return result.rows[0];
}

export async function getScheduleById(runner, id) {
  const r = runner || db();
  const result = await r.query(`SELECT * FROM schedules WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return result.rows[0] || null;
}

export async function listSchedules(runner, { companyId, userId, isAdmin = false, from, to, status, preset, limit = 50 }) {
  const r = runner || db();
  const conditions = ["deleted_at IS NULL", "company_id = $1"];
  const params = [companyId];

  // Visibility check: private items are visible only to the owner (or company admin)
  if (!isAdmin && userId) {
    params.push(userId);
    conditions.push(`(visibility = 'company' OR owner_user_id = $${params.length})`);
  } else if (!isAdmin && !userId) {
    conditions.push(`visibility = 'company'`);
  }

  if (status && status !== "all") {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  if (preset && preset !== "all") {
    params.push(preset);
    conditions.push(`preset = $${params.length}`);
  }

  if (from) {
    params.push(from);
    conditions.push(`(timing_rule->>'date' >= $${params.length} OR start_time >= $${params.length}::date OR next_due_at >= $${params.length}::date)`);
  }

  if (to) {
    params.push(to);
    conditions.push(`(timing_rule->>'date' <= $${params.length} OR start_time <= ($${params.length}::date + interval '1 day') OR next_due_at <= ($${params.length}::date + interval '1 day'))`);
  }

  params.push(limit);
  const sql = `
    SELECT schedules.*,
      (SELECT jsonb_build_object('id', a.id, 'action_type', a.action_type, 'config', a.config)
       FROM schedule_actions a WHERE a.schedule_id=schedules.id ORDER BY a.created_at LIMIT 1) AS action,
      (SELECT jsonb_build_object('status', o.status, 'due_at', o.nominal_due_at, 'error', o.error, 'result', o.result)
       FROM schedule_occurrences o WHERE o.schedule_id=schedules.id AND o.status <> 'scheduled'
       ORDER BY o.nominal_due_at DESC LIMIT 1) AS last_run
    FROM schedules
    WHERE ${conditions.join(" AND ")}
    ORDER BY COALESCE(next_due_at, start_time, (timing_rule->>'date')::timestamptz, created_at) ASC
    LIMIT $${params.length}
  `;

  const result = await r.query(sql, params);
  return result.rows;
}

export async function updateSchedule(runner, { id, expectedRevision, updates }) {
  const r = runner || db();
  const existing = await getScheduleById(r, id);
  if (!existing) {
    throw Object.assign(new Error(`Schedule not found: ${id}`), { code: "NOT_FOUND" });
  }

  if (expectedRevision !== undefined && expectedRevision !== null && existing.revision !== expectedRevision) {
    throw Object.assign(
      new Error(`Revision conflict: current revision is ${existing.revision}, expected ${expectedRevision}`),
      { code: "CONFLICT", currentRevision: existing.revision, expectedRevision },
    );
  }

  const fields = [];
  const params = [id, existing.revision];
  let pIdx = 3;

  if (updates.title !== undefined) {
    fields.push(`title = $${pIdx++}`);
    params.push(updates.title);
  }
  if (updates.note !== undefined) {
    fields.push(`note = $${pIdx++}`);
    params.push(updates.note);
  }
  if (updates.visibility !== undefined) {
    fields.push(`visibility = $${pIdx++}`);
    params.push(updates.visibility);
  }
  if (updates.timezone !== undefined) {
    fields.push(`timezone = $${pIdx++}`);
    params.push(updates.timezone);
  }
  if (updates.timing_rule !== undefined) {
    fields.push(`timing_rule = $${pIdx++}`);
    params.push(JSON.stringify(updates.timing_rule));
  }
  if (updates.start_time !== undefined) {
    fields.push(`start_time = $${pIdx++}`);
    params.push(updates.start_time);
  }
  if (updates.end_time !== undefined) {
    fields.push(`end_time = $${pIdx++}`);
    params.push(updates.end_time);
  }
  if (updates.next_due_at !== undefined) {
    fields.push(`next_due_at = $${pIdx++}`);
    params.push(updates.next_due_at);
  }
  if (updates.status !== undefined) {
    fields.push(`status = $${pIdx++}`);
    params.push(updates.status);
  }

  fields.push(`revision = revision + 1`);
  fields.push(`updated_at = NOW()`);

  const sql = `
    UPDATE schedules
    SET ${fields.join(", ")}
    WHERE id = $1 AND revision = $2 AND deleted_at IS NULL
    RETURNING *
  `;

  const result = await r.query(sql, params);
  if (!result.rows[0]) {
    throw Object.assign(
      new Error(`Concurrent update detected on schedule ${id}`),
      { code: "CONFLICT" },
    );
  }
  return result.rows[0];
}

// Supplied runners are existing transactions, as used by native host tools.
export async function scheduleTransaction(runner, work) {
  if (runner) return work(runner);
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function softDeleteSchedule(runner, id, expectedRevision = null) {
  const r = runner || db();
  const existing = await getScheduleById(r, id);
  if (!existing) return null;

  if (expectedRevision !== null && expectedRevision !== undefined && existing.revision !== expectedRevision) {
    throw Object.assign(
      new Error(`Revision conflict: current revision is ${existing.revision}, expected ${expectedRevision}`),
      { code: "CONFLICT", currentRevision: existing.revision },
    );
  }

  const result = await r.query(
    `UPDATE schedules
     SET deleted_at = NOW(), status = 'cancelled', revision = revision + 1, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [id],
  );
  return result.rows[0] || null;
}

export async function listScheduleOccurrences(runner, scheduleId, limit = 20) {
  const r = runner || db();
  const result = await r.query(
    `SELECT * FROM schedule_occurrences
     WHERE schedule_id = $1
     ORDER BY nominal_due_at DESC
     LIMIT $2`,
    [scheduleId, limit],
  );
  return result.rows;
}
