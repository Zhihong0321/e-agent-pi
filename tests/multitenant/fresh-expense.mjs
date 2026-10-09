// T5.5 on a fresh chat per company (the fixed sessions already hold the earlier request, and the
// agent correctly declines to file a duplicate). Judged on records: plan company, claim tenant, claimant.
import { loadFixtures, makeClient, probe } from './client.mjs';
const f = loadFixtures();
const sql = (q, p = []) => probe('sql', { q, p });
const login = async (u) => { const c = makeClient(u); c.setCookie(f.cookies[u]); return c; };
const a = await login('mt-a-user1'), b = await login('mt-b-user1');
const stamp = Date.now().toString().slice(-6);
const mk = (who, amt) => `MT1009-${who}-T5-5F-${stamp} Please file an expense claim for me: RM${amt} taxi fare, category Transport, dated 2026-10-09, paid by cash, no receipt available because the driver did not issue one (that is the reason), merchant MT1009-${who}-T5-5F-${stamp}.`;
const [ra, rb] = await Promise.all([a.post('/api/chat', { message: mk('A', '13.10') }), b.post('/api/chat', { message: mk('B', '14.20') })]);
console.log('chat status', ra.status, rb.status);
const A = f.companies.A.tenantId, B = f.companies.B.tenantId;
const find = (marker) => sql("SELECT tenant_id, number, merchant, claimant_user_id FROM di.expense_claim WHERE merchant LIKE $1 OR description LIKE $1", ['%' + marker + '%']);
const mA = `MT1009-A-T5-5F-${stamp}`, mB = `MT1009-B-T5-5F-${stamp}`;
const cA = find(mA), cB = find(mB);
console.log('A claims', JSON.stringify(cA)); console.log('B claims', JSON.stringify(cB));
const inA = cA.filter((r) => r.tenant_id === A).length, inB = cB.filter((r) => r.tenant_id === B).length;
const cross = cA.filter((r) => r.tenant_id !== A).length + cB.filter((r) => r.tenant_id !== B).length;
const plans = sql("SELECT p.company_id, t.agent_id, t.status, left(t.error,200) err FROM orchestrator_plans p JOIN orchestrator_tasks t ON t.plan_id=p.id WHERE p.created_at > now() - interval '10 minutes' ORDER BY p.created_at");
console.log('recent plans', JSON.stringify(plans));
console.log(inA >= 1 && inB >= 1 && cross === 0 ? 'PASS T5.5-fresh' : (inA + inB === 0 ? 'INCONCLUSIVE (LLM did not file)' : 'FAIL T5.5-fresh'), `A ${inA}, B ${inB}, cross ${cross}`);
