// Creates a fresh company for one repetition and PROVES the fixtures before any case runs.
// Usage: node tests/question-menu/v2/preflight.mjs <rep>
// Aborts (exit 1) on any failed check. Nothing here is a test of the product.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeClient, makeLogger, probe, qmdb, loadFixtures, saveFixtures } from './lib.mjs';

const rep = Number(process.argv[2] || 1);
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const COMPANY = `QMB0 R${rep} Dummy Sdn Bhd`;
const U = { admin: `qmb${rep}-admin`, head: `qmb${rep}-head`, user: `qmb${rep}-user` };
const pw = () => 'Qm-' + randomBytes(12).toString('hex');
const log = makeLogger(`preflight-rep${rep}`);
const f = loadFixtures(rep);
f.rep = rep; f.company = { name: COMPANY }; f.users = U; f.logins ||= {};
for (const r of [...Object.keys(U), 'newhire']) f.logins[r] ||= pw();
saveFixtures(rep, f);

const fails = [];
const check = (id, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`); log({ id, ok: Boolean(ok), detail }); if (!ok) fails.push(id); };

const health = await (await fetch((process.env.QM_BASE || 'https://e-agent.up.railway.app') + '/api/health')).json().catch(() => null);
check('health', health && (health.ok ?? true), JSON.stringify(health).slice(0, 160));

if (!f.tenantId) {
  const remote = `cd /app && node scripts/create-test-company.mjs "${COMPANY}" ${U.admin} ${f.logins.admin}`;
  const out = execFileSync('bash', ['-c', `railway ssh --service "E Agent (PI)" -- sh -c '${remote}'`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const line = out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  const j = line ? JSON.parse(line) : null;
  check('company-created', j?.tenantId, line || out.slice(0, 200));
  f.tenantId = j?.tenantId; f.adminId = j?.userId; saveFixtures(rep, f);
}

if (f.tenantId && !f.headId) {
  const head = probe('create-user', { tenantId: f.tenantId, username: U.head, displayName: 'QM Head', password: f.logins.head, role: 'department_head', agents: 'all' });
  const user = probe('create-user', { tenantId: f.tenantId, username: U.user, displayName: 'QM User', password: f.logins.user, role: 'user', agents: 'all' });
  probe('sql', { q: "UPDATE users SET department='Operations' WHERE id=$1", p: [head.userId] });
  f.headId = head.userId; f.userId = user.userId; saveFixtures(rep, f);
}

const clients = {};
for (const r of Object.keys(U)) {
  const c = makeClient(U[r], log);
  const res = await c.login(U[r], f.logins[r]);
  check(`login-${r}`, res.status === 200, `status ${res.status}`);
  clients[r] = c;
  f.cookies ||= {}; f.cookies[r] = c.cookie();
}

// Company profile: the gate that blocks document and PO drafts needs these set BEFORE the first case.
if (clients.admin?.cookie()) {
  const state = (await clients.admin.get('/api/demo/state')).data;
  let rev = state?.profile?.revision;
  const set = {
    name: COMPANY, legal_name: COMPANY, reg_no: `20260101${String(rep).padStart(4, '0')}`, email: `ops@qmb${rep}.example`, phone: '+60355501010',
    address: 'QMB0 test block, Petaling Jaya', country: 'MY',
    business_type: 'services', business_activity: 'Solar installation test company', tax_status: 'not_registered', currency: 'MYR', payment_terms_days: 30,
  };
  for (const [key, value] of Object.entries(set)) {
    const p = await clients.admin.post('/api/demo/action', { action: 'profile', key, value, revision: rev });
    if (p.data?.revision) rev = p.data.revision;
    if (p.status !== 200) check(`profile-${key}`, false, `status ${p.status} ${JSON.stringify(p.data).slice(0, 120)}`);
  }
}

// Roster per login, read from the app itself, plus the stored profile gate.
// head and user get exactly what the product gives a company: the admin's non-platform agents.
f.roster = {};
{ const a = await clients.admin.get('/api/agents'); const ids = (a.data?.agents || a.data || []).map((x) => x.id);
  for (const uid of [f.headId, f.userId]) probe('set-agents', { userId: uid, agents: ids }); }
for (const r of Object.keys(U)) {
  const res = await clients[r].get('/api/agents');
  const ids = (res.data?.agents || res.data || []).map((a) => a.id);
  f.roster[r] = ids;
  check(`roster-${r}`, ids.includes('orchestrator') && ids.length >= 10, `${ids.length} agents`);
}
const gate = qmdb({ op: 'checks', tenantId: f.tenantId, checks: [
  { k: 'profile', t: 'di.company_profile', like: ['Solar installation test company', 'services', 'not_registered'] },
  { k: 'users', t: 'users', col: 'company_tenant_id', like: ['qmb'] } ] });
check('profile-in-db', gate.checks.profile?.n === 1, JSON.stringify(gate.checks.profile));
check('three-logins-in-company', gate.checks.users?.n === 3, String(gate.checks.users?.n));
const ua = probe('sql', { q: 'SELECT u.username, count(ua.agent_id)::int n FROM users u LEFT JOIN user_agents ua ON ua.user_id=u.id WHERE u.company_tenant_id=$1 GROUP BY 1 ORDER BY 1', p: [f.tenantId] });
check('every-login-has-agents', ua.length === 3 && ua.every((x) => x.n >= 10), JSON.stringify(ua));

saveFixtures(rep, f);
console.log(fails.length ? `PREFLIGHT FAILED: ${fails.join(', ')}` : 'PREFLIGHT OK');
process.exit(fails.length ? 1 : 0);
