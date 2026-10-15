// SOP discount test driver. Usage:
//   node tests/question-menu/v2/sop-run.mjs --rep 15 --run-id sop-discount-2026-10-15 --case SOP|S1|S2|S3|S3b|S4 --n 1
// Sends the case message in a fresh session as the right login, waits until the turn has settled (no active run,
// no new event for 25 s, every plan/task terminal in the DB), then writes trace-<case>-<n>.json with the RECORDS:
// the chat messages, every orchestrator_tasks row of the job, the documents + lines created in the window.
// No marker is put in any message. The verdict is judged afterwards by sop-judge.mjs from these records.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeClient, makeLogger, probe, qmdb, inContainer, loadFixtures, runDir, sleep, here } from './lib.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const rep = Number(arg('rep', 15)); const runId = arg('run-id'); const caseId = arg('case'); const n = arg('n', '1');
const f = loadFixtures(rep); const dir = runDir(runId); const log = makeLogger(runId);

const SOP_MESSAGE = 'From now on, for quotations and invoices: Sales can give at most 8% discount, a department head at most 11%, a Superadmin has no limit.';
const quote = (pct) => `Please make a quotation for Bintang Hijau Sdn Bhd: 1 x Solar Panel Set 5kW (SKU SOLAR-5KW), and give them ${pct}% discount.`;
const CASES = {
  SOP: { role: 'admin', msg: SOP_MESSAGE },
  S1: { role: 'user', msg: quote(15) }, S2: { role: 'user', msg: quote(5) },
  S3: { role: 'head', msg: quote(10) }, S3b: { role: 'head', msg: quote(15) },
  S4: { role: 'admin', msg: quote(20) },
  // Seed for the repro of S3 run 3: a 20% quotation that is ISSUED, so the next run's reset leaves a voided one behind.
  S4i: { role: 'admin', msg: quote(20) + ' Valid for 30 days. Issue it now.' },
};
const tc = CASES[caseId]; if (!tc) throw new Error('unknown case ' + caseId);
const TERMINAL = new Set(['done', 'failed', 'blocked', 'cancelled', 'completed', 'error', 'rejected', 'skipped']);
const RUN_ACTIVE = new Set(['queued', 'running']);

const client = makeClient(f.users[tc.role], log);
const lg = await client.login(f.users[tc.role], f.logins[tc.role], f.companyCode);
if (lg.status !== 200) throw new Error(`login ${tc.role} failed ${lg.status}`);
const me = (await client.get('/api/demo/me')).data?.user;

async function fetchEvents(sid, afterId) {
  const events = []; let runs = []; let after = afterId;
  for (let page = 0; page < 40; page++) {
    const r = await client.get(`/api/execution/runs?sessionId=${sid}&after=${after}`);
    if (r.status !== 200) return { error: `status ${r.status}`, events, runs };
    if (page === 0) runs = r.data.runs || [];
    const ev = r.data.events || []; events.push(...ev);
    if (ev.length < 100) break;
    after = Number(ev[ev.length - 1].id);
  }
  return { events, runs };
}
async function settle(sid, maxWaitMs) {
  const t0 = Date.now(); let last = { events: [], runs: [] };
  while (Date.now() - t0 < maxWaitMs) {
    last = await fetchEvents(sid, 0);
    const refs = new Set(last.events.map((e) => e.runRef).filter(Boolean));
    const runs = (last.runs || []).filter((u) => refs.has(u.id));
    const active = runs.some((u) => RUN_ACTIVE.has(u.status));
    const lastEv = last.events.length ? new Date(last.events[last.events.length - 1].createdAt).getTime() : t0;
    const quiet = Date.now() - lastEv >= 25000;
    const planned = last.events.some((e) => e.kind === 'plan.submitted');
    if (last.events.length && !active && quiet) {
      const dbState = qmdb({ op: 'turn', sessionIds: [sid], tenantId: f.tenantId, checks: [] });
      const open = dbState.plans.some((p) => !TERMINAL.has(p.status)) || dbState.tasks.some((t) => !TERMINAL.has(t.status));
      if (!open && (!planned || dbState.plans.length)) return { settled: true, waitedMs: Date.now() - t0, ...last };
    }
    await sleep(6000);
  }
  return { settled: false, waitedMs: Date.now() - t0, ...last };
}

// --sid/--since re-collect the records of a turn that already ran (the driver died after sending, before reading).
const again = arg('sid');
const s = again ? null : await client.post('/api/sessions', { agentId: 'orchestrator' });
const sid = again || s.data?.session?.id || s.data?.id;
if (!sid) throw new Error('no session');
// Each run starts from the same state: no live quotation or invoice for the company (an agent will edit an
// earlier run's draft instead of making a new one, which also hides the run's document from a created_at window).
const cleared = again ? [] : [
  ...probe('sql', { q: "UPDATE di.document SET deleted_at = now(), deleted_by = 'sop-test-reset' WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'draft' RETURNING id, doc_type, number", p: [f.tenantId] }),
  ...probe('sql', { q: "UPDATE di.document SET status = 'void', voided_at = now(), void_reason = 'sop-test-reset' WHERE tenant_id = $1 AND deleted_at IS NULL AND status NOT IN ('draft', 'void') RETURNING id, doc_type, number", p: [f.tenantId] }),
];
const startedAt = arg('since') || probe('sql', { q: 'SELECT now() t' })[0].t;   // DB clock: documents are windowed on it
const res = again ? { status: 0, data: '' } : await client.post('/api/chat', { message: tc.msg, sessionId: sid, agentId: 'orchestrator' }, { text: true });
const parsed = String(res.data).split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
const err = parsed.find((e) => e.type === 'error');
const http = { status: res.status, error: err ? String(err.error || err.message || 'stream error').slice(0, 300) : null,
  reply: parsed.filter((e) => e.type === 'text').map((e) => e.delta || e.text || '').join('').slice(0, 3000) };
const st = await settle(sid, 15 * 60000);

// Records, read from the DB in the container (sop-records.mjs).
const records = inContainer(path.join(here, 'sop-records.mjs'), { sid, tenantId: f.tenantId, since: startedAt });

const trace = { case: caseId, n: Number(n), who: { login: f.users[tc.role], me }, message: tc.msg, sid, startedAt, clearedBefore: cleared.length, http, settled: st.settled, waitedMs: st.waitedMs, ...records };
writeFileSync(path.join(dir, `trace-${caseId}-${n}.json`), JSON.stringify(trace, null, 1));
const checkers = trace.tasks.filter((t) => t.kind === 'checker');
console.log(JSON.stringify({ case: caseId, n, sid, settled: st.settled, waitedMs: st.waitedMs, http: { status: http.status, error: http.error }, plans: trace.plans.length,
  tasks: trace.tasks.map((t) => `${t.kind}/${t.agent_id}/${t.status}${t.check ? '/' + t.check.verdict : ''}`),
  docs: trace.documents.map((d) => `${d.doc_type} ${d.number} disc=${d.discount_total} total=${d.total}`), lastCheck: checkers.at(-1)?.check || null, sop: trace.sop.map((x) => x.agent_id) }, null, 1));
