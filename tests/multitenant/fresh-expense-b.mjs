import { loadFixtures, makeClient, probe } from './client.mjs';
const f = loadFixtures();
const sql = (q, p = []) => probe('sql', { q, p });
const b = makeClient('mt-b-user1'); b.setCookie(f.cookies['mt-b-user1']);
const stamp = Date.now().toString().slice(-6);
const marker = `MT1009-B-T5-5G-${stamp}`;
const r = await b.post('/api/chat', { message: `${marker} File an expense claim: RM14.20 taxi fare, category Transport, date 2026-10-09, paid by cash, merchant ${marker}. I have no receipt: the driver did not issue one. Use exactly that as the no-receipt reason and file it now.` });
console.log('chat', r.status);
const B = f.companies.B.tenantId, A = f.companies.A.tenantId;
for (let i = 0; i < 8; i++) {
  const rows = sql("SELECT tenant_id, number, merchant, claimant_user_id FROM di.expense_claim WHERE merchant LIKE $1", ['%' + marker + '%']);
  if (rows.length) { console.log(JSON.stringify(rows)); console.log(rows.every((x) => x.tenant_id === B && x.claimant_user_id === f.userIds['mt-b-user1']) ? 'PASS T5.5-B claim in B for mt-b-user1' : 'FAIL T5.5-B'); process.exit(0); }
  await new Promise((res) => setTimeout(res, 15000));
}
const t = sql("SELECT p.company_id, t.status, left(coalesce(t.result,''),500) res FROM orchestrator_plans p JOIN orchestrator_tasks t ON t.plan_id=p.id WHERE p.created_at > now() - interval '10 minutes' ORDER BY p.created_at DESC LIMIT 2");
console.log('no claim yet; recent tasks', JSON.stringify(t), 'A id', A);
