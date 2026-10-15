// Container-side helper for the logical-gate harness (run via lib.mjs inContainer, from /app). One "@@JSON" line.
//   {op:"reset", tenantId}      -> empty the company's document gates and remove its di-documents SOP (clean start)
//   {op:"read", tenantId, sid}  -> the session's tasks and final reply, the company's gates and SOP rows
import pg from 'pg';

const req = JSON.parse(Buffer.from(process.argv[2] || 'e30=', 'base64').toString('utf8'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (t, p = []) => (await pool.query(t, p)).rows;
const emit = (v) => console.log('@@JSON' + JSON.stringify(v));
try {
  if (req.op === 'reset') {
    const gates = await q(`UPDATE di.gate SET rules = '[]'::jsonb WHERE tenant_id = $1 AND record_type = 'document' RETURNING id`, [req.tenantId]);
    const sops = await q(`DELETE FROM agent_sops WHERE company_id = $1 AND agent_id = 'di-documents' RETURNING agent_id`, [req.tenantId]);
    emit({ gatesCleared: gates.length, sopsRemoved: sops.length });
  } else if (req.op === 'read') {
    const tasks = await q(`SELECT t.kind, t.agent_id, t.status, left(coalesce(t.result,''), 2000) result, t.result_data->'check' AS check
      FROM orchestrator_tasks t JOIN orchestrator_plans p ON p.id = t.plan_id WHERE p.parent_session_id = $1 ORDER BY p.created_at, t.sort_order`, [req.sid]);
    const reply = (await q(`SELECT content FROM messages WHERE session_id = $1 AND role = 'assistant' ORDER BY id DESC LIMIT 1`, [req.sid]))[0]?.content || '';
    const gate = (await q(`SELECT rules, updated_at FROM di.gate WHERE tenant_id = $1 AND record_type = 'document' AND deleted_at IS NULL`, [req.tenantId]))[0] || null;
    const sops = await q(`SELECT agent_id, content, updated_at FROM agent_sops WHERE company_id = $1`, [req.tenantId]);
    // How hard the job worked: set_gates calls (all attempts of the session), and how often di.gate changed during the job.
    const calls = (await q(`SELECT count(*)::int total, count(*) FILTER (WHERE status = 'ok')::int ok FROM execution_tool_calls
      WHERE operation_id LIKE '%set_gates' AND attempt_id IN (SELECT attempt_id FROM execution_events WHERE session_id = $1 AND attempt_id IS NOT NULL)`, [req.sid]))[0];
    const changes = (await q(`SELECT count(*)::int n FROM di.audit_log WHERE tenant_id = $1 AND entity = 'gate'
      AND at >= (SELECT min(created_at) FROM orchestrator_plans WHERE parent_session_id = $2)
      AND at <= (SELECT max(created_at) FROM execution_events WHERE session_id = $2)`, [req.tenantId, req.sid]))[0].n;
    emit({ tasks, reply: reply.slice(0, 6000), gate, sops, setGatesCalls: calls, gateChanges: changes });
  } else throw new Error('unknown op ' + req.op);
} finally { await pool.end(); }
