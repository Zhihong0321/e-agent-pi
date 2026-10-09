// Multi-tenant isolation test runner. Usage: node tests/multitenant/run.mjs <phase>
//   setup  sign in every fixture login (cookies cached in .fixtures.local.json) and fill company profiles
//   http   T1, T2, T3, T4, T6 (HTTP plus DB records, no LLM)
// Output: PASS/FAIL per case. Evidence: tests/multitenant/evidence/<run>.jsonl
import { randomUUID } from 'node:crypto';
import { loadFixtures, saveFixtures, makeClient, probe, log, evidenceFile } from './client.mjs';

const phase = process.argv[2] || 'http';
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const f = loadFixtures();
const results = [];
const T = { A: () => f.companies.A, B: () => f.companies.B, H: () => f.companies.H };
const uid = (name) => f.userIds[name];

function check(id, desc, ok, detail = '') {
  results.push({ id, desc, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${desc}${detail ? ' :: ' + String(detail).slice(0, 300) : ''}`);
}
function note(id, desc, detail) {
  results.push({ id, desc, ok: null, detail });
  console.log(`NOTE ${id} ${desc} :: ${String(detail).slice(0, 300)}`);
}
function skip(id, desc, why) {
  results.push({ id, desc, ok: null, detail: 'INCONCLUSIVE: ' + why });
  console.log(`INCONCLUSIVE ${id} ${desc} :: ${why}`);
}

// Cookies are cached so the 10-per-15-min login limit is not used up on re-runs.
async function session(username, password) {
  f.cookies ||= {};
  const c = makeClient(username);
  if (f.cookies[username]) { c.setCookie(f.cookies[username]); return c; }
  const r = await c.login(username, password);
  if (r.status !== 200) throw new Error(`login ${username} failed: ${r.status}`);
  f.cookies[username] = c.cookie();
  saveFixtures(f);
  return c;
}
const sql = (q, p = []) => probe('sql', { q, p });
const pw = (u) => f.logins[u];

async function clients() {
  return {
    adminA: await session(T.A().admin, T.A().password),
    user1A: await session('mt-a-user1', pw('mt-a-user1')),
    user2A: await session('mt-a-user2', pw('mt-a-user2')),
    user3A: await session('mt-a-user3', pw('mt-a-user3')),
    adminB: await session(T.B().admin, T.B().password),
    user1B: await session('mt-b-user1', pw('mt-b-user1')),
  };
}

// Every user id and session id that does not belong to company `tenantId`.
async function foreignIds(tenantId) {
  const users = sql('SELECT id FROM users WHERE company_tenant_id IS DISTINCT FROM $1', [tenantId]).map((r) => r.id);
  const sessions = sql('SELECT s.id FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE u.company_tenant_id IS DISTINCT FROM $1 OR s.user_id IS NULL', [tenantId]).map((r) => r.id);
  return [...users, ...sessions, ...Object.values(f.companies).map((c) => c.tenantId).filter((t) => t && t !== tenantId)];
}
const leaked = (text, ids) => ids.filter((id) => id && String(text).includes(id));

// Marker search (D7). Returns the company each hit row belongs to.
function markerCompanies(marker) {
  const r = probe('marker', { m: marker });
  const userCompany = Object.fromEntries(sql('SELECT id, company_tenant_id FROM users').map((u) => [u.id, u.company_tenant_id]));
  const cos = [];
  for (const hit of r.hits) for (const row of hit.scope) {
    const c = row.tenant_id ?? row.company_id ?? row.company_tenant_id ?? userCompany[row.user_id ?? row.owner_user_id] ?? null;
    cos.push({ table: hit.table, company: c });
  }
  return { hits: r.hits, cos };
}
const onlyCompany = (cos, tenantId) => cos.length > 0 && cos.every((x) => x.company === tenantId);

// Fixture data for the HTTP cases: one session per company, owned by a plain user.
function seedSessions() {
  const rows = [
    { key: 'A', owner: uid('mt-a-user1'), agent: 'orchestrator', title: 'MT1009-A-T3-1 session' },
    { key: 'B', owner: uid('mt-b-user1'), agent: 'orchestrator', title: 'MT1009-B-T3-1 session' },
  ];
  f.sessions ||= {};
  for (const r of rows) {
    if (f.sessions[r.key]) continue;
    const id = randomUUID();
    sql("INSERT INTO sessions(id,title,model_id,agent_id,engine,user_id) VALUES ($1,$2,'MiniMax-M3.1-Flash-Preview',$3,'pi',$4)", [id, r.title, r.agent, r.owner]);
    sql('INSERT INTO messages(role,content,model_id,session_id) VALUES ($1,$2,$3,$4)', ['user', `${r.title} message`, 'MiniMax-M3.1-Flash-Preview', id]);
    f.sessions[r.key] = id;
  }
  saveFixtures(f);
}

async function setup() {
  const adminA = await session(T.A().admin, T.A().password);
  const adminB = await session(T.B().admin, T.B().password);
  for (const [client, company, label] of [[adminA, T.A(), 'Alpha'], [adminB, T.B(), 'Beta']]) {
    const rev = (await client.get('/api/demo/state')).data.profile?.revision;
    const profile = {
      name: company.name,
      email: `ops@${label.toLowerCase()}.mt1009.example`,
      country: 'MY',
      phone: `+6035550${label === 'Alpha' ? '01' : '02'}`,
      address: `${label} test block, Kuala Lumpur`,
    };
    for (const [key, value] of Object.entries(profile)) {
      const r = await client.post('/api/demo/action', { action: 'profile', key, value, revision: rev });
      check(`SETUP-${label}-${key}`, `profile ${key} saved for ${label}`, r.status === 200, `status ${r.status}`);
    }
  }
  await clients();
  check('SETUP-logins', 'all six fixture logins signed in', true);
}

async function http() {
  const c = await clients();
  f.runNo = (f.runNo || 0) + 1;
  saveFixtures(f);
  const R = ' r' + f.runNo;
  seedSessions();
  const A = T.A(), B = T.B();
  const foreignForA = await foreignIds(A.tenantId);
  const foreignForB = await foreignIds(B.tenantId);

  // T1 Identity and sign-in
  for (const [who, client, company, user] of [
    ['mt-a-admin', c.adminA, A, A.admin], ['mt-a-user1', c.user1A, A, 'mt-a-user1'],
    ['mt-a-user2', c.user2A, A, 'mt-a-user2'], ['mt-b-admin', c.adminB, B, B.admin], ['mt-b-user1', c.user1B, B, 'mt-b-user1'],
  ]) {
    const me = (await client.get('/api/demo/me')).data.user;
    check(`T1.1-${who}`, `/api/demo/me returns company ${company.name}`, me?.company_tenant_id === company.tenantId && me?.username === user, JSON.stringify(me?.company_tenant_id));
  }
  const spoof = await c.adminA.get('/api/demo/me', { headers: { 'x-user-id': B.adminId, 'x-company-tenant-id': B.tenantId, 'x-username': B.admin } });
  check('T1.2', 'A cookie with forged identity headers still resolves to A', spoof.data.user?.id === A.adminId, spoof.data.user?.id);
  const u3 = uid('mt-a-user3');
  probe('set-active', { userId: u3, active: false });
  const off = await c.user3A.get('/api/demo/state');
  probe('set-active', { userId: u3, active: true });
  check('T1.3', 'deactivated login gets 401 on /api/demo/state', off.status === 401, `status ${off.status}`);
  const anon = await makeClient('anon').get('/api/agents');
  check('T4.10', 'GET /api/agents with no cookie or token is 401', anon.status === 401, `status ${anon.status}`);

  // T2 Business data in /demo panels
  {
    const before = (await c.adminB.get('/api/demo/state')).data.profile;
    const rev = (await c.adminA.get('/api/demo/state')).data.profile?.revision;
    const r = await c.adminA.post('/api/demo/action', { action: 'profile', key: 'legal_name', value: 'MT1009-A-T2-1 Legal Name Sdn Bhd', revision: rev });
    const bAfter = (await c.adminB.get('/api/demo/state')).data.profile?.company;
    check('T2.1a', 'A changes its legal name', r.status === 200, r.status);
    check('T2.1b', "B's profile unchanged by A's edit", bAfter?.name === B.name && bAfter?.legal_name !== 'MT1009-A-T2-1 Legal Name Sdn Bhd', JSON.stringify(bAfter?.legal_name));
    const m = markerCompanies('MT1009-A-T2-1');
    check('T2.1c', 'marker MT1009-A-T2-1 lands only in A', onlyCompany(m.cos, A.tenantId), JSON.stringify(m.cos.slice(0, 5)));
    void before;
  }
  {
    const r = await c.adminA.post('/api/demo/action', { action: 'person', person: { name: 'MT1009-A-T2-2 Person' + R, email: `mt1009-a-t2-2${R.trim()}@example.test`, position: 'Tester' } });
    check('T2.2a', 'A creates person MT1009-A-T2-2', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    const bPeople = JSON.stringify((await c.adminB.get('/api/demo/state')).data.people || []);
    check('T2.2b', "B's people list excludes A's person", !bPeople.includes('MT1009-A-T2-2'));
    const personId = sql("SELECT id FROM di.company_member WHERE tenant_id=$1 AND name=$2 AND deleted_at IS NULL", [A.tenantId, 'MT1009-A-T2-2 Person' + R])[0]?.id;
    const hijack = await c.adminB.post('/api/demo/action', { action: 'person', person_id: personId, person: { name: 'MT1009-B-T2-2 hijack' } });
    const still = sql("SELECT count(*)::int n FROM di.company_member WHERE tenant_id=$1 AND name=$2", [A.tenantId, 'MT1009-A-T2-2 Person' + R])[0].n;
    check('T2.2c', "B cannot update A's person", hijack.status >= 400 && still >= 1, `status ${hijack.status}, A rows ${still}`);
  }
  let invoiceNumber = '';
  let invoiceId = '';
  {
    const cust = await c.adminA.post('/api/demo/action', { action: 'customer', customer: { name: 'MT1009-A-T2-3 Customer' + R, email: `mt1009-a-t2-3${R.trim()}@example.test`, billing_address: { line1: 'MT1009-A-T2-3 Jalan Test 1', city: 'Kuala Lumpur', postcode: '50000', state: 'Wilayah Persekutuan', country: 'Malaysia' } } });
    check('T2.3a', 'A creates customer MT1009-A-T2-3', cust.status === 200, `${cust.status} ${JSON.stringify(cust.data).slice(0, 200)}`);
    const customerId = cust.data?.result?.customer?.id;
    const description = 'MT1009-A-T2-3 line' + R;
    const inv = await c.adminA.post('/api/demo/action', { action: 'invoice', invoice: { customer: customerId, description, amount: 250, due: '2026-11-30' } });
    check('T2.3b', 'A creates draft invoice MT1009-A-T2-3', inv.status === 200, `${inv.status} ${JSON.stringify(inv.data).slice(0, 200)}`);
    invoiceId = sql("SELECT d.id FROM di.document d JOIN di.document_line l ON l.document_id = d.id WHERE d.tenant_id=$1 AND l.description=$2 AND d.deleted_at IS NULL", [A.tenantId, description])[0]?.id || '';
    if (!invoiceId) throw new Error('invoice for T2.3 was not created; skipping the rest of T2.3');
    const bIssue = await c.adminB.post('/api/demo/action', { action: 'issue', id: invoiceId });
    const status = sql('SELECT status FROM di.document WHERE id=$1', [invoiceId])[0]?.status;
    check('T2.3c', "B cannot issue A's invoice", bIssue.status >= 400 && status === 'draft', `status ${bIssue.status}, doc status ${status}`);
    const aIssue = await c.adminA.post('/api/demo/action', { action: 'issue', id: invoiceId });
    invoiceNumber = sql('SELECT number FROM di.document WHERE id=$1', [invoiceId])[0]?.number || '';
    check('T2.3d', 'A issues its own invoice', aIssue.status === 200, `${aIssue.status} number ${invoiceNumber}`);
    const bState = JSON.stringify((await c.adminB.get('/api/demo/state')).data);
    check('T2.3e', "B's state has neither A's customer nor invoice", !bState.includes('MT1009-A-T2-3') && (!invoiceNumber || !bState.includes(invoiceNumber)));
  }
  {
    const cal = '/api/demo/calendar?from=2026-11-01&to=2026-12-31&timezone=Asia%2FKuala_Lumpur';
    const aCal = JSON.stringify((await c.adminA.get(cal)).data);
    const bCal = JSON.stringify((await c.adminB.get(cal)).data);
    const hit = aCal.includes(invoiceNumber) || aCal.includes('MT1009-A-T2-3');
    check('T2.4', "A's calendar shows the invoice due date and B's does not", hit && !bCal.includes(invoiceNumber || 'MT1009-A-T2-3') && !bCal.includes('MT1009-A-T2-3'), `A has it: ${hit}`);
  }
  {
    const merchant = 'MT1009-A-T2-5 Merchant' + R;
    const claim = { action: 'claim', claim: { expense_date: '2026-10-08', merchant, category: 'Meals', amount: 42.5, description: 'MT1009-A-T2-5 claim', payment_method: 'cash', allow_duplicate: true },
      attachments: [{ name: 'MT1009-A-T2-5-receipt.png', data: TINY_PNG }] };
    const r = await c.user1A.post('/api/demo/expenses', claim);
    check('T2.5a', 'mt-a-user1 files a claim with a receipt', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    const claimId = sql('SELECT id FROM di.expense_claim WHERE tenant_id=$1 AND merchant=$2 ORDER BY created_at DESC LIMIT 1', [A.tenantId, merchant])[0]?.id;
    const receipt = sql('SELECT id, file_path FROM di.expense_receipt WHERE claim_id=$1', [claimId])[0];
    note('T2.5-storage', 'receipt file_path recorded for A', receipt?.file_path || 'none');
    const bList = JSON.stringify((await c.user1B.get('/api/demo/expenses')).data);
    check('T2.5b', "B's expense panel excludes A's claim", !bList.includes('MT1009-A-T2-5'));
    const bClaim = await c.user1B.get('/api/demo/expenses/claim?claim=' + claimId);
    check('T2.5c', "B cannot read A's claim", bClaim.status >= 400 || !JSON.stringify(bClaim.data).includes('MT1009-A-T2-5'), `status ${bClaim.status}`);
    const bReceipt = await c.user1B.get('/api/demo/expenses/receipt?id=' + receipt?.id);
    check('T2.5d', "B cannot download A's receipt", bReceipt.status >= 400, `status ${bReceipt.status}`);
    const bReport = await c.user1B.get('/api/demo/expenses/report', { raw: true });
    note('T2.5e', "B's expense report status (PDF body not inspected)", bReport.status);
    f.fixtures = { ...(f.fixtures || {}), expenseClaimId: claimId };
    saveFixtures(f);
  }
  {
    const notes = 'MT1009-A-T2-6' + R;
    const r = await c.adminA.post('/api/demo/procurement', { action: 'draft', po: { supplier: 'S-0001', lines: [{ description: 'MT1009-A-T2-6 item', quantity: 2, unit_price: 100, tax_rate: 0 }], expected_date: '2026-11-15', notes } });
    check('T2.6a', 'A drafts a PO for MT1009-A-T2-6', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 250)}`);
    const poId = sql('SELECT po.id FROM di.purchase_order po WHERE po.tenant_id=$1 AND po.notes=$2 ORDER BY created_at DESC LIMIT 1', [A.tenantId, notes])[0]?.id;
    const bPanel = JSON.stringify((await c.adminB.get('/api/demo/procurement')).data);
    check('T2.6b', "B's procurement panel excludes A's PO", !bPanel.includes('MT1009-A-T2-6'));
    const bPo = await c.adminB.get('/api/demo/procurement/po?po=' + poId);
    check('T2.6c', "B cannot read A's PO", bPo.status >= 400 || !JSON.stringify(bPo.data).includes('MT1009-A-T2-6'), `status ${bPo.status}`);
    skip('T2.6d', "B cannot read A's supplier document", 'no supplier document was created for A (supplier document intake is not an HTTP action)');
  }
  {
    const beforeCounts = sql('SELECT tenant_id, (SELECT count(*) FROM di.expense_claim e WHERE e.tenant_id = t.tenant_id)::int claims, (SELECT count(*) FROM di.purchase_order p WHERE p.tenant_id = t.tenant_id)::int pos FROM (SELECT DISTINCT tenant_id FROM di.tenant) t');
    const e = await c.adminA.post('/api/demo/expenses', { action: 'seed' });
    const p = await c.adminA.post('/api/demo/procurement', { action: 'seed' });
    const afterCounts = sql('SELECT tenant_id, (SELECT count(*) FROM di.expense_claim e WHERE e.tenant_id = t.tenant_id)::int claims, (SELECT count(*) FROM di.purchase_order p WHERE p.tenant_id = t.tenant_id)::int pos FROM (SELECT DISTINCT tenant_id FROM di.tenant) t');
    const byT = (rows, id) => rows.find((r) => r.tenant_id === id) || { claims: 0, pos: 0 };
    const bChanged = JSON.stringify(byT(beforeCounts, B.tenantId)) !== JSON.stringify(byT(afterCounts, B.tenantId));
    check('T2.7', 'A seed buttons write only into A', e.status === 200 && p.status === 200 && !bChanged, `expenses ${e.status}, procurement ${p.status}, B changed ${bChanged}`);
  }
  skip('T2.8', "H admin sees none of A's or B's records", 'no H admin password or owner token for e-agent in the vault; H rows checked by DB in P3 snapshot');

  // T3 Insights
  {
    const logs = (await c.adminA.get('/api/demo/chat-logs')).data;
    const text = JSON.stringify(logs);
    check('T3.1a', 'chat-logs for A admin lists no B session or user', leaked(text, foreignForA).length === 0, leaked(text, foreignForA).join(',').slice(0, 200));
    const bOpened = await c.adminA.get('/api/demo/chat-logs?sessionId=' + f.sessions.B);
    check('T3.1b', 'A admin opening a B session id gets session null', bOpened.data?.session === null || bOpened.data?.session === undefined, JSON.stringify(bOpened.data).slice(0, 150));
    const usage = JSON.stringify((await c.adminA.get('/api/demo/usage')).data);
    check('T3.2', 'usage for A admin excludes B and H users', leaked(usage, foreignForA).length === 0, leaked(usage, foreignForA).join(',').slice(0, 200));
    const act = JSON.stringify((await c.adminA.get('/api/demo/activity')).data);
    check('T3.3', 'activity for A admin excludes B and H rows', leaked(act, foreignForA).length === 0, leaked(act, foreignForA).join(',').slice(0, 200));
    const dbl = await c.adminA.get('/api/demo/db-log');
    check('T3.4a', 'db-log for A admin excludes foreign rows', leaked(JSON.stringify(dbl.data), foreignForA).length === 0, `status ${dbl.status}`);
    const dbl1 = await c.user1A.get('/api/demo/db-log');
    check('T3.4b', 'db-log for plain user is 403', dbl1.status === 403, `status ${dbl1.status}`);
    const met = await c.adminA.get('/api/demo/metrics');
    const metLeak = leaked(JSON.stringify(met.data), foreignForA);
    if (metLeak.length) check('T3.5', 'metrics for A admin shows no other company', false, `FAIL-S3 host-wide metrics include foreign ids: ${metLeak.length}`);
    else note('T3.5', 'metrics for A admin', `status ${met.status}, no foreign ids in response`);
    const u1Logs = JSON.stringify((await c.user1A.get('/api/demo/chat-logs')).data);
    const u1Others = sql("SELECT id FROM sessions WHERE user_id <> $1 AND user_id IS NOT NULL", [uid('mt-a-user1')]).map((r) => r.id);
    check('T3.6a', 'plain user sees only own sessions in chat-logs', leaked(u1Logs, u1Others).length === 0, leaked(u1Logs, u1Others).join(',').slice(0, 120));
    const u1Usage = JSON.stringify((await c.user1A.get('/api/demo/usage')).data);
    const otherAUsers = [A.adminId, uid('mt-a-user2'), uid('mt-a-user3')];
    check('T3.6b', 'plain user usage excludes other A users', leaked(u1Usage, otherAUsers).length === 0, leaked(u1Usage, otherAUsers).join(',').slice(0, 120));
  }

  // T4 Agent assignment
  {
    const ua = (await c.adminA.get('/api/demo/user-agents')).data;
    const names = (ua.users || []).map((u) => u.username);
    check('T4.1', 'user-agents for A admin lists A logins only', names.length > 0 && names.every((n) => n.startsWith('mt-a-')), names.join(','));
    const bUser = uid('mt-b-user1');
    const before = sql('SELECT count(*)::int n FROM user_agents WHERE user_id=$1', [bUser])[0].n;
    const r = await c.adminA.post('/api/demo/user-agents', { userId: bUser, agentId: 'orchestrator', enabled: false });
    const after = sql('SELECT count(*)::int n FROM user_agents WHERE user_id=$1', [bUser])[0].n;
    check('T4.2', "A admin cannot change B's assignments", r.status === 404 && before === after, `status ${r.status}, rows ${before}->${after}`);
    const r3 = await c.user1A.get('/api/demo/user-agents');
    const r3p = await c.user1A.post('/api/demo/user-agents', { userId: uid('mt-a-user2'), agentId: 'orchestrator', enabled: false });
    check('T4.3', 'plain user gets 403 on user-agents', r3.status === 403 && r3p.status === 403, `${r3.status}/${r3p.status}`);
    // The plan lists di-expenses as already assigned to mt-a-user2, but that login is orchestrator-only.
    // Grant it first so the untick is a real change.
    const u2 = uid('mt-a-user2');
    await c.adminA.post('/api/demo/user-agents', { userId: u2, agentId: 'di-expenses', enabled: true });
    const listed = (await c.user2A.get('/api/agents')).data;
    const hasBefore = JSON.stringify(listed).includes('"di-expenses"');
    await c.adminA.post('/api/demo/user-agents', { userId: u2, agentId: 'di-expenses', enabled: false });
    const after4 = JSON.stringify((await c.user2A.get('/api/agents')).data);
    check('T4.4', 'unticked di-expenses disappears from /api/agents for mt-a-user2', hasBefore && !after4.includes('"di-expenses"'), `listed before ${hasBefore}`);
    const denied = await c.user2A.post('/api/chat', { message: 'MT1009-A-T4-5 expense check', agentId: 'di-expenses' });
    check('T4.5', 'unassigned agent chat create is refused', denied.status === 403, `${denied.status} ${JSON.stringify(denied.data).slice(0, 120)}`);
    const sessionsForU2 = sql('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [u2])[0].n;
    note('T4.5-side-effect', 'sessions created for mt-a-user2 by the refused chat', sessionsForU2);
    // Existing session of a now-unassigned agent
    const sid = randomUUID();
    sql("INSERT INTO sessions(id,title,model_id,agent_id,engine,user_id) VALUES ($1,'MT1009-A-T4-6 session','MiniMax-M3.1-Flash-Preview','di-expenses','pi',$2)", [sid, u2]);
    const posted = await c.user2A.post('/api/chat', { message: 'MT1009-A-T4-6 follow-up', sessionId: sid });
    check('T4.6', 'posting to a session of an unassigned agent is refused', posted.status === 403, `${posted.status}`);
    const leftover = sql('SELECT count(*)::int n FROM messages WHERE session_id=$1', [sid])[0].n;
    check('T4.6b', 'refused follow-up did not append a message', leftover === 0, `messages ${leftover}`);
    skip('T4.7', 'default chat agent allowed with zero assignments', 'needs a real chat turn, run in the LLM phase');
    note('T4.8', 'new logins start with no assignments', 'no HTTP route creates logins; the only creator is scripts/create-test-company.mjs (first admin gets all agents)');
    skip('T4.9', '/demo UI hides unassigned sections', 'needs browser screenshot, not run in this phase');
  }

  // T6 Sessions and messages
  {
    const aIds = sql('SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.company_tenant_id=$1', [A.tenantId]).map((r) => r.id);
    const bList = JSON.stringify((await c.user1B.get('/api/sessions')).data);
    check('T6.1', "B's /api/sessions never shows A's sessions", leaked(bList, aIds).length === 0, `A sessions ${aIds.length}`);
    const bMsg = await c.user1B.get('/api/messages?sessionId=' + f.sessions.A);
    check('T6.2', "B reading A's messages is 404", bMsg.status === 404, `status ${bMsg.status}`);
    const countBefore = sql('SELECT count(*)::int n FROM messages WHERE session_id=$1', [f.sessions.A])[0].n;
    const bPost = await c.user1B.post('/api/chat', { message: 'MT1009-B-T6-3 intrusion', sessionId: f.sessions.A });
    const countAfter = sql('SELECT count(*)::int n FROM messages WHERE session_id=$1', [f.sessions.A])[0].n;
    check('T6.3', "B posting to A's session is 404 with no message appended", bPost.status === 404 && countBefore === countAfter, `status ${bPost.status}, messages ${countBefore}->${countAfter}`);
    const bRename = await c.user1B.patch('/api/sessions/' + f.sessions.A, { title: 'MT1009-B-T6-4 renamed' });
    const bDel = await c.user1B.del('/api/sessions/' + f.sessions.A);
    const title = sql('SELECT title FROM sessions WHERE id=$1', [f.sessions.A])[0]?.title;
    check('T6.4', "B cannot rename or delete A's session", bRename.status >= 400 && bDel.status >= 400 && title === 'MT1009-A-T3-1 session', `rename ${bRename.status}, delete ${bDel.status}, title ${title}`);
  }

  // Foreign-id sweep on the B company as well, for the record
  note('SWEEP-B', 'B admin usage excludes A and H ids', leaked(JSON.stringify((await c.adminB.get('/api/demo/usage')).data), foreignForB).length === 0 ? 'clean' : 'contains foreign ids');
}

// T5 agent runs: real LLM chats in both companies at the same time. Pass/fail comes from DB records.
async function llm() {
  const c = await clients();
  const A = T.A(), B = T.B();
  const runsBy = () => Object.fromEntries(sql('SELECT company_id, count(*)::int n FROM execution_runs GROUP BY 1').map((r) => [r.company_id, r.n]));
  const messagesOwnedBy = (marker, tenantId) => sql(
    'SELECT count(*)::int n FROM messages m JOIN sessions s ON s.id = m.session_id JOIN users u ON u.id = s.user_id WHERE m.content LIKE $1 AND u.company_tenant_id = $2',
    ['%' + marker + '%', tenantId])[0].n;
  const before = runsBy();
  const mA = 'MT1009-A-T5-1', mB = 'MT1009-B-T5-2';
  const [rA, rB] = await Promise.all([
    c.user1A.post('/api/chat', { message: `Add a calendar reminder titled ${mA} for tomorrow at 9am.`, sessionId: f.sessions.A }),
    c.user1B.post('/api/chat', { message: `Add a calendar reminder titled ${mB} for tomorrow at 9am.`, sessionId: f.sessions.B }),
  ]);
  check('T5.1-http', 'A and B chats accepted at the same time', rA.status === 200 && rB.status === 200, `A ${rA.status}, B ${rB.status}`);
  const after = runsBy();
  const delta = (map, co) => (map[co] || 0) - (before[co] || 0);
  const mkA = markerCompanies(mA), mkB = markerCompanies(mB);
  note('T5.1-markers', 'marker locations for A and B', JSON.stringify({ A: mkA.cos, B: mkB.cos }).slice(0, 500));
  const outside = (cos, tenantId) => cos.filter((x) => x.company !== null && x.company !== tenantId);
  check('T5.1', 'A marker lands in A only; A run row has company A', outside(mkA.cos, A.tenantId).length === 0 && messagesOwnedBy(mA, A.tenantId) >= 1 && messagesOwnedBy(mA, B.tenantId) === 0 && delta(after, A.tenantId) >= 1,
    `A runs +${delta(after, A.tenantId)}, B runs +${delta(after, B.tenantId)}, A-owned msgs ${messagesOwnedBy(mA, A.tenantId)}`);
  check('T5.2', 'B marker lands in B only; each company gets its own run row', outside(mkB.cos, B.tenantId).length === 0 && messagesOwnedBy(mB, A.tenantId) === 0 && messagesOwnedBy(mB, B.tenantId) >= 1 && delta(after, B.tenantId) >= 1,
    `B runs +${delta(after, B.tenantId)}, B-owned msgs ${messagesOwnedBy(mB, B.tenantId)}`);
  f.fixtures = { ...(f.fixtures || {}), t5Markers: [mA, mB] };
  saveFixtures(f);
}

// T5.3 roster, T5.4 unassigned delegation, T5.10 run status access. mt-a-user2 has only the orchestrator.
async function llm2() {
  const c = await clients();
  const A = T.A();
  const u2 = uid('mt-a-user2');
  f.sessions ||= {};
  if (!f.sessions.U2) {
    const id = randomUUID();
    sql("INSERT INTO sessions(id,title,model_id,agent_id,engine,user_id) VALUES ($1,'MT1009-A-T5-3 session','MiniMax-M3.1-Flash-Preview','orchestrator','pi',$2)", [id, u2]);
    f.sessions.U2 = id;
    saveFixtures(f);
  }
  const unassigned = sql('SELECT a.id FROM agents a WHERE a.id NOT IN (SELECT agent_id FROM user_agents WHERE user_id = $1)', [u2]).map((r) => r.id);
  const r3 = await c.user2A.post('/api/chat', { message: 'MT1009-A-T5-3 Which specialist agents can you delegate to right now? Name them.', sessionId: f.sessions.U2 });
  check('T5.3-http', 'user2 roster chat accepted', r3.status === 200, `${r3.status}`);
  const events = sql('SELECT kind, data::text d FROM execution_events WHERE session_id = $1 ORDER BY id', [f.sessions.U2]);
  const rosterText = events.filter((e) => /list_specialists/.test(e.d)).map((e) => e.d).join('\n');
  const leakedAgents = unassigned.filter((id) => rosterText.includes(id));
  check('T5.3', "user2's list_specialists result names no unassigned agent", rosterText.length > 0 && leakedAgents.length === 0,
    rosterText.length ? `roster event bytes ${rosterText.length}, unassigned ids in it ${leakedAgents.length}` : 'no list_specialists event recorded');

  const r4 = await c.user2A.post('/api/chat', { message: 'MT1009-A-T5-4 Log a RM12 lunch expense claim for me.', sessionId: f.sessions.U2 });
  const claims = sql("SELECT count(*)::int n FROM di.expense_claim WHERE tenant_id = $1 AND (merchant LIKE '%MT1009-A-T5-4%' OR description LIKE '%MT1009-A-T5-4%')", [A.tenantId])[0].n;
  const childRuns = sql('SELECT count(*)::int n FROM execution_runs WHERE session_id = $1 AND profile_id LIKE $2', [f.sessions.U2, '%expenses%'])[0].n;
  const denied = sql("SELECT count(*)::int n FROM execution_events WHERE session_id = $1 AND data::text ILIKE '%PERMISSION_DENIED%'", [f.sessions.U2])[0].n;
  note('T5.4-detail', 'delegation attempt for unassigned di-expenses', `chat ${r4.status}, claims ${claims}, child runs ${childRuns}, PERMISSION_DENIED events ${denied}`);
  check('T5.4', 'unassigned di-expenses delegation writes no claim and starts no child run', claims === 0 && childRuns === 0, `claims ${claims}, child runs ${childRuns}`);

  const cross = await c.user1B.get('/api/execution/runs?sessionId=' + f.sessions.A);
  check('T5.10', "B's run-status request for A's session is 404", cross.status === 404, `status ${cross.status}`);
}

// T5.5 delegated expense runs write their claims into the caller's company only.
async function llm3() {
  const c = await clients();
  const A = T.A(), B = T.B();
  const mA = 'MT1009-A-T5-5', mB = 'MT1009-B-T5-5';
  const [rA, rB] = await Promise.all([
    c.user1A.post('/api/chat', { message: `${mA} Please file an expense claim for me: RM12.50 lunch, category Meals, dated 2026-10-08, paid by cash.`, sessionId: f.sessions.A }),
    c.user1B.post('/api/chat', { message: `${mB} Please file an expense claim for me: RM12.50 lunch, category Meals, dated 2026-10-08, paid by cash.`, sessionId: f.sessions.B }),
  ]);
  check('T5.5-http', 'A and B expense chats accepted', rA.status === 200 && rB.status === 200, `A ${rA.status}, B ${rB.status}`);
  const claimsFor = (marker) => sql("SELECT tenant_id, count(*)::int n FROM di.expense_claim WHERE (merchant || ' ' || COALESCE(description,'')) LIKE $1 GROUP BY 1", ['%' + marker + '%']);
  const cA = claimsFor(mA), cB = claimsFor(mB);
  const inA = cA.find((r) => r.tenant_id === A.tenantId)?.n || 0;
  const inB = cB.find((r) => r.tenant_id === B.tenantId)?.n || 0;
  const crossA = cA.filter((r) => r.tenant_id !== A.tenantId).reduce((s, r) => s + r.n, 0);
  const crossB = cB.filter((r) => r.tenant_id !== B.tenantId).reduce((s, r) => s + r.n, 0);
  note('T5.5-claims', 'claim rows by marker', JSON.stringify({ mA: cA, mB: cB }));
  check('T5.5', 'A claim lands in A and B claim lands in B; no marker claim in the other company', inA >= 1 && inB >= 1 && crossA === 0 && crossB === 0,
    `A-claims ${inA}, B-claims ${inB}, cross ${crossA}/${crossB}`);
}

// T9-T11, T15: the surface of the platform. No LLM. Anonymous callers, company users on operator
// routes, platform agents, and a refused chat. Run after every deploy of the tenancy build.
async function surface() {
  const c = await clients();
  const anon = makeClient('anon');
  const PLATFORM = ['website', 'ops', 'settings', 'proposal', 'newpages', 'package', 'afa-rate', 'sales', 'google-ads', 'tnb', 'solar-roi', 'om', 'app-helper', 'open-design-helper', 'whatsapp-assistant', 'composio'];
  const denied = (r) => r.status === 401 || r.status === 403;

  // T9 anonymous
  const health = await anon.get('/api/health');
  check('T9.0', 'health stays public', health.status === 200, health.status);
  for (const [method, route, body] of [
    ['get', '/api/sessions'], ['get', '/api/messages?sessionId=' + f.sessions.A], ['get', '/api/files?agent=orchestrator'],
    ['get', '/api/files/raw?agent=orchestrator&path=x'], ['get', '/api/debug'], ['get', '/api/metrics'], ['get', '/api/host'],
    ['get', '/api/git'], ['post', '/api/model', { modelId: 'x' }], ['get', '/api/models'], ['get', '/api/agents'],
    ['get', '/api/skills'], ['get', '/api/mcp'], ['get', '/api/blueprints'], ['get', '/api/demo/me'],
    ['get', '/api/platform/companies'], ['post', '/api/platform/companies', { name: 'x', username: 'x', password: 'xxxxxxxx' }],
    ['get', '/api/execution/runs?sessionId=' + f.sessions.A], ['get', '/api/schedules'], ['get', '/api/media-kit'],
  ]) {
    const r = await (method === 'get' ? anon.get(route) : anon.post(route, body));
    check('T9 ' + method.toUpperCase() + ' ' + route.split('?')[0], 'anonymous is refused', denied(r), r.status);
  }
  const anonFile = await anon.get('/files/' + 'a'.repeat(64) + '/x.txt');
  check('T9 GET /files', 'anonymous cannot read a shared file link', denied(anonFile), anonFile.status);

  // T10 company user on operator routes; a spoofed X-Tenant-Id changes nothing
  for (const [method, route, body] of [
    ['get', '/api/debug'], ['get', '/api/metrics'], ['get', '/api/host'], ['get', '/api/git'], ['get', '/api/skills'],
    ['get', '/api/mcp'], ['get', '/api/blueprints'], ['get', '/api/sops'], ['get', '/api/settings'], ['get', '/api/platform/companies'],
    ['post', '/api/model', { modelId: 'x' }], ['post', '/api/agents', { name: 'x' }],
    ['post', '/api/platform/companies', { name: 'x', username: 'x', password: 'xxxxxxxx' }],
  ]) {
    const r = await (method === 'get' ? c.user1A.get(route) : c.user1A.post(route, body));
    check('T10 ' + method.toUpperCase() + ' ' + route, 'a company user is refused', denied(r), r.status);
  }
  const spoof = await c.user1A.get('/api/sessions', { headers: { 'x-tenant-id': T.B().tenantId } });
  const spoofIds = (spoof.data?.sessions || []).map((x) => x.id);
  check('T10 X-Tenant-Id', 'a user cannot switch company with the operator header', spoof.status === 200 && !spoofIds.includes(f.sessions.B), `status ${spoof.status}, sees B session: ${spoofIds.includes(f.sessions.B)}`);

  // T11 platform agents are not available to company logins
  const list = await c.user1A.get('/api/agents');
  const ids = (list.data?.agents || []).map((x) => x.id);
  check('T11.1', 'a company user is not offered platform agents', list.status === 200 && !ids.some((id) => PLATFORM.includes(id)), ids.filter((id) => PLATFORM.includes(id)).join(','));
  const open = await c.user1A.post('/api/sessions', { agentId: 'website' });
  check('T11.2', 'a company user cannot open a session with a platform agent', open.status === 403, open.status);
  const matrix = await c.adminA.get('/api/demo/user-agents');
  const matrixIds = (matrix.data?.agents || []).map((x) => x.id);
  check('T11.3', 'the assignment matrix lists no platform agent', matrix.status === 200 && !matrixIds.some((id) => PLATFORM.includes(id)), matrixIds.filter((id) => PLATFORM.includes(id)).join(','));
  const grant = await c.adminA.post('/api/demo/user-agents', { userId: uid('mt-a-user1'), agentId: 'website', enabled: true });
  check('T11.4', 'a company admin cannot assign a platform agent', grant.status === 404, grant.status);
  const filesWebsite = await c.user1A.get('/api/files?agent=website');
  check('T11.5', 'a company user cannot browse a platform agent workspace', filesWebsite.status === 403, filesWebsite.status);
  const filesNone = await c.user1A.get('/api/files');
  check('T11.6', 'no agent named means no workspace for a company user', filesNone.status === 403, filesNone.status);
  const filesOwn = await c.user1A.get('/api/files?agent=orchestrator');
  check('T11.7', 'a company user can list their own assigned agent workspace', filesOwn.status === 200, filesOwn.status);

  // T15 a refused chat leaves no session row behind
  const before = sql('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [uid('mt-a-user2')])[0].n;
  const refused = await c.user2A.post('/api/chat', { message: 'MT1009 refused chat', agentId: 'di-expenses' });
  const after = sql('SELECT count(*)::int n FROM sessions WHERE user_id=$1', [uid('mt-a-user2')])[0].n;
  check('T15', 'a chat with an unassigned agent is refused and creates no session', refused.status === 403 && after === before, `status ${refused.status}, sessions ${before} -> ${after}`);

  // T17 research data belongs to one company. Existing dossiers belong to the operator company (H).
  const dossiers = sql('SELECT id, company_id FROM company_research_dossiers ORDER BY created_at LIMIT 3');
  check('T17.0', 'every existing dossier has a company', sql('SELECT count(*)::int n FROM company_research_dossiers WHERE company_id IS NULL')[0].n === 0, JSON.stringify(dossiers.map((d) => d.company_id)));
  for (const [who, client] of [['A', c.user1A], ['B', c.user1B]]) {
    const list = await client.get('/api/company-research/dossiers?status=all&limit=50');
    check('T17.1 ' + who, 'company ' + who + ' lists none of the operator company dossiers', list.status === 200 && list.data?.total === 0, `status ${list.status}, total ${list.data?.total}`);
    for (const d of dossiers.slice(0, 1)) {
      const base = '/api/company-research/dossiers/' + d.id;
      const got = await client.get(base);
      const art = await client.get(base + '/artifact?format=json');
      const ev = await client.get(base + '/events');
      const pub = await client.post(base + '/publish', {});
      const rep = await client.post(base + '/replay', {});
      const un = await client.del(base + '/publish');
      check('T17.2 ' + who, 'company ' + who + ' cannot read, replay, publish or unpublish another company dossier',
        [got, art, pub, rep, un].every((r) => r.status === 400 || r.status === 404) && ev.status === 404,
        `get ${got.status}, artifact ${art.status}, events ${ev.status}, publish ${pub.status}, replay ${rep.status}, unpublish ${un.status}`);
    }
  }
  const adsList = await c.user1A.get('/api/ads-research/jobs/' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12));
  check('T17.3', 'ads research job lookup is company scoped (unknown id is refused, not leaked)', adsList.status === 400 || adsList.status === 404, adsList.status);

  // Cases that need credentials or an LLM turn; listed so they are not forgotten.
  skip('T12 workspace', 'company A and B agent workspaces are separate folders', 'needs a delegated run that writes a file (llm phase) and a container listing');
  skip('T13 SOP', 'a company edit of an SOP does not change another company or the default', 'needs a Superadmin chat with the Forward Deploy Engineer (llm phase)');
  skip('T14 company create', 'operator creates a company with its Superadmin', 'needs the operator credential (not in the vault)');
  skip('T16 form link', 'form link carries the company and does not open under another company id', 'needs a di-forms chat to publish a form (llm phase)');
}

const phases = { setup, http, llm, llm2, llm3, surface };
if (!phases[phase]) { console.error('unknown phase ' + phase); process.exit(2); }
try {
  await phases[phase]();
} catch (error) {
  console.log('ABORTED: ' + String(error.message || error).split('\n')[0].slice(0, 300));
}
const failed = results.filter((r) => r.ok === false);
const passed = results.filter((r) => r.ok === true);
console.log(`\n${passed.length} passed, ${failed.length} failed, ${results.length - passed.length - failed.length} notes/inconclusive. Evidence: ${evidenceFile}`);
log({ who: 'runner', phase, results });
