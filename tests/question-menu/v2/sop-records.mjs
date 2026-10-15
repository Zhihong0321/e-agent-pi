// Container-side record reader for the SOP discount test (run via lib.mjs inContainer, from /app).
// {sid, tenantId, since} -> the session's messages, plans, every orchestrator_tasks row, the documents
// (with lines) created since `since`, and the company's SOP rows. Prints one "@@JSON" line.
import pg from 'pg';

const req = JSON.parse(Buffer.from(process.argv[2] || 'e30=', 'base64').toString('utf8'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (t, p = []) => (await pool.query(t, p)).rows;
try {
  const messages = await q(`SELECT role, left(content, 6000) content FROM messages WHERE session_id = $1 ORDER BY id`, [req.sid]);
  const plans = await q(`SELECT id, status, title, left(manifest->>'request', 600) request FROM orchestrator_plans WHERE parent_session_id = $1 ORDER BY created_at`, [req.sid]);
  const tasks = await q(`SELECT t.id, t.sort_order sort, t.kind, t.agent_id, t.title, t.status, left(coalesce(t.result,''), 3000) result,
      t.result_data->'check' AS check, left(coalesce(t.error,''), 600) error, t.created_at, t.finished_at
    FROM orchestrator_tasks t JOIN orchestrator_plans p ON p.id = t.plan_id WHERE p.parent_session_id = $1 ORDER BY p.created_at, t.sort_order`, [req.sid]);
  const documents = await q(`SELECT d.id, d.doc_type, d.number, d.status, d.subtotal, d.discount_total, d.total, d.created_by, d.created_at, d.deleted_at,
      (SELECT coalesce(json_agg(json_build_object('description', l.description, 'quantity', l.quantity, 'unit_price', l.unit_price,
         'discount_amount', l.discount_amount, 'total', l.total) ORDER BY l.sort), '[]')
       FROM di.document_line l WHERE l.document_id = d.id AND l.deleted_at IS NULL) AS lines
    FROM di.document d WHERE d.tenant_id = $1 AND (d.created_at >= $2::timestamptz - interval '5 seconds' OR d.updated_at >= $2::timestamptz - interval '5 seconds') ORDER BY d.created_at`, [req.tenantId, req.since]);
  const sop = await q(`SELECT agent_id, company_id, content, updated_at FROM agent_sops WHERE company_id = $1`, [req.tenantId]);
  console.log('@@JSON' + JSON.stringify({ messages, plans, tasks, documents, sop }));
} finally { await pool.end(); }
