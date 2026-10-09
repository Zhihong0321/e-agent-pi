// Container-side DB probe for the multi-tenant test. Run via ssh.sh; prints one "@@JSON" line.
// ops: snapshot | marker {m} | sql {q,p} | create-user {tenantId,username,displayName,password,role,agents}
//      | set-agents {userId,agents} | set-active {userId,active}
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from './server/users.mjs';

const req = JSON.parse(Buffer.from(process.argv[2] || 'e30=', 'base64').toString('utf8'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emit = (value) => console.log('@@JSON' + JSON.stringify(value));
const q = async (text, params = []) => (await pool.query(text, params)).rows;
const TENANT_COLS = ['tenant_id', 'company_id', 'company_tenant_id', 'owner_user_id', 'user_id'];

try {
  if (req.op === 'snapshot') {
    emit({
      tenants: await q('SELECT id, name, is_default FROM di.tenant ORDER BY name'),
      users: await q('SELECT id, username, role, active, company_tenant_id FROM users ORDER BY company_tenant_id, username'),
      userAgentsPerUser: await q('SELECT user_id, count(*)::int n FROM user_agents GROUP BY 1'),
      userAgentRows: (await q('SELECT count(*)::int n FROM user_agents'))[0].n,
      sessionsByCompany: await q('SELECT u.company_tenant_id, count(*)::int n FROM sessions s LEFT JOIN users u ON u.id = s.user_id GROUP BY 1'),
      sessionsWithoutOwner: (await q('SELECT count(*)::int n FROM sessions WHERE user_id IS NULL'))[0].n,
      executionRunsByCompany: await q('SELECT company_id, count(*)::int n FROM execution_runs GROUP BY 1'),
      schedulesByCompany: await q('SELECT company_id, count(*)::int n FROM schedules GROUP BY 1'),
      planByCompany: await q('SELECT company_id, count(*)::int n FROM orchestrator_plans GROUP BY 1'),
      diRowsByTenant: await q(`SELECT t.tenant_id, count(*)::int n FROM (
          SELECT tenant_id FROM di.customer UNION ALL SELECT tenant_id FROM di.document UNION ALL
          SELECT tenant_id FROM di.expense_claim UNION ALL SELECT tenant_id FROM di.purchase_order UNION ALL
          SELECT tenant_id FROM di.supplier UNION ALL SELECT tenant_id FROM di.company_member UNION ALL
          SELECT tenant_id FROM di.supplier_document UNION ALL SELECT tenant_id FROM di.expense_receipt) t GROUP BY 1`),
      rls: await q(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'di' AND c.relkind = 'r' AND NOT c.relrowsecurity ORDER BY 1`),
    });
  } else if (req.op === 'marker') {
    const like = '%' + req.m + '%';
    const tables = await q(`SELECT table_schema s, table_name t FROM information_schema.tables
      WHERE table_schema IN ('public','di') AND table_type = 'BASE TABLE' ORDER BY 1, 2`);
    const hits = [];
    for (const { s, t } of tables) {
      const ref = `"${s}"."${t}"`;
      const n = (await q(`SELECT count(*)::int n FROM ${ref} x WHERE x::text LIKE $1`, [like]))[0].n;
      if (!n) continue;
      const rows = await q(`SELECT to_jsonb(x) j FROM ${ref} x WHERE x::text LIKE $1 LIMIT 20`, [like]);
      hits.push({
        table: `${s}.${t}`,
        count: n,
        scope: rows.map((r) => Object.fromEntries(
          Object.entries(r.j).filter(([k]) => ['id', ...TENANT_COLS].includes(k)))),
      });
    }
    emit({ marker: req.m, hits });
  } else if (req.op === 'sql') {
    emit(await q(req.q, req.p || []));
  } else if (req.op === 'create-user') {
    const id = randomUUID();
    await q(
      "INSERT INTO users(id, username, display_name, password_hash, role, company_tenant_id, active) VALUES ($1,$2,$3,$4,$5,$6,true)",
      [id, req.username, req.displayName, hashPassword(req.password), req.role || 'user', req.tenantId],
    );
    if (req.agents === 'all') await q('INSERT INTO user_agents SELECT $1, id FROM agents', [id]);
    emit({ userId: id, username: req.username });
  } else if (req.op === 'set-agents') {
    await q('DELETE FROM user_agents WHERE user_id = $1', [req.userId]);
    if (req.agents === 'all') await q('INSERT INTO user_agents SELECT $1, id FROM agents', [req.userId]);
    else if (req.agents.length) await q('INSERT INTO user_agents SELECT $1, unnest($2::text[])', [req.userId, req.agents]);
    emit({ ok: true });
  } else if (req.op === 'set-active') {
    await q('UPDATE users SET active = $2 WHERE id = $1', [req.userId, req.active]);
    emit({ ok: true });
  } else {
    throw new Error('unknown op ' + req.op);
  }
} finally {
  await pool.end();
}
