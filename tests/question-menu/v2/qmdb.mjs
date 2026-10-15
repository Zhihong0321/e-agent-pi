// Container-side batch for the question-menu instrument. Runs via ssh.sh; prints one "@@JSON" line.
// op "turn": {sessionIds, tenantId, checks[]} -> plan and task status per parent session, plus row counts.
//   a check is {k, t, like[], col?}; every `like` term must match the same row (ILIKE on the whole row text).
//   rows are scoped to the tenant; di.* rows with deleted_at set are not counted.
import pg from 'pg';

const req = JSON.parse(Buffer.from(process.argv[2] || 'e30=', 'base64').toString('utf8'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emit = (v) => console.log('@@JSON' + JSON.stringify(v));
const q = async (t, p = []) => (await pool.query(t, p)).rows;

async function plansOf(sessionIds) {
  if (!sessionIds?.length) return { plans: [], tasks: [] };
  const plans = await q('SELECT id, parent_session_id sid, status, title FROM orchestrator_plans WHERE parent_session_id = ANY($1)', [sessionIds]);
  const tasks = plans.length
    ? await q("SELECT plan_id, agent_id, status, left(coalesce(error,''),300) error FROM orchestrator_tasks WHERE plan_id = ANY($1)", [plans.map((p) => p.id)])
    : [];
  return { plans, tasks };
}

async function checksOf(tenantId, checks = []) {
  const out = {};
  for (const c of checks) {
    const [schema, table] = c.t.includes('.') ? c.t.split('.') : ['public', c.t];
    const cols = (await q('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [schema, table])).map((r) => r.column_name);
    if (!cols.length) { out[c.k] = { error: 'no such table ' + c.t }; continue; }
    const scope = c.col || (cols.includes('tenant_id') ? 'tenant_id' : cols.includes('company_id') ? 'company_id' : 'company_tenant_id');
    const terms = (c.like || []).map((_, i) => ` AND x::text ILIKE $${i + 2}`).join('');
    const live = cols.includes('deleted_at') ? ' AND x.deleted_at IS NULL' : '';
    const rows = await q(`SELECT left(x::text, 240) r FROM "${schema}"."${table}" x WHERE x.${scope}::text = $1${live}${terms} LIMIT 50`,
      [tenantId, ...(c.like || []).map((l) => '%' + l + '%')]);
    out[c.k] = { n: rows.length, sample: rows.slice(0, 2).map((r) => r.r) };
  }
  return out;
}

try {
  if (req.op === 'turn' || req.op === 'checks') {
    emit({ ...(await plansOf(req.sessionIds)), checks: await checksOf(req.tenantId, req.checks) });
  } else throw new Error('unknown op ' + req.op);
} finally { await pool.end(); }
