// HARNESS layer 2 (written before the build, see sop-logical-gates-build-plan.md): does the SOP AI turn an
// owner's sentence into the right gates and the right text SOP? Runs on prod, as the company's Superadmin.
// Judged from records only: the stored gate list is run (locally, with the built gates.mjs) on fixed facts;
// the text part is looked for in the di-documents SOP row. Reply wording is recorded, never judged.
// Usage: node tests/question-menu/v2/gates-compile.mjs --rep <fixtures rep> --run-id gates-compile-<date> [--only G1,G4] [--reps 3]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeClient, makeLogger, inContainer, loadFixtures, runDir, here } from './lib.mjs';
import { chatTurn } from './chat-turn.mjs';
import { decide } from '../../../document_inteligence/core/gates.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const rep = Number(arg('rep')); const runId = arg('run-id'); const reps = Number(arg('reps', 3));
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const f = loadFixtures(rep); const dir = runDir(runId); const log = makeLogger(runId);
const records = (payload) => inContainer(path.join(here, 'gates-records.mjs'), payload);

const who = { sales: { access: 'user', category: 'Sales', department: 'Sales' }, head: { access: 'department_head', category: 'Department head', department: 'Sales' },
  owner: { access: 'superadmin', category: 'Superadmin' }, staff: { access: 'user', category: 'Staff' } };
const doc = (o) => ({ doc_type: 'quotation', ...o });
const fact = (requester, document, action = 'save') => ({ action, document: doc(document), requester });

// Each case: the owner's sentence, the decisions its gates must give on fixed facts, and what the text SOP must hold.
// `chain` = runs right after the named case, without a reset (an edit of what that case saved).
const CASES = [
  { id: 'G1', msg: 'From now on, for quotations and invoices: Sales can give at most 8% discount, a department head at most 11%, a Superadmin has no limit.',
    expect: [[fact(who.sales, { discount_pct: 15 }), 'block'], [fact(who.sales, { discount_pct: 5 }), 'allow'], [fact(who.sales, { discount_pct: 8 }), 'allow'],
      [fact(who.head, { discount_pct: 10 }), 'allow'], [fact(who.head, { discount_pct: 15 }), 'block'], [fact(who.owner, { discount_pct: 20 }), 'allow'],
      [fact(who.sales, { doc_type: 'invoice', discount_pct: 15 }), 'block'], [fact(who.sales, { discount_pct: 15 }, 'issue'), 'block']],
    textSop: null },
  { id: 'G5', chain: 'G1', msg: 'Change the discount rule: Sales can now give up to 10%. Everything else stays.',
    expect: [[fact(who.sales, { discount_pct: 9 }), 'allow'], [fact(who.sales, { discount_pct: 11 }), 'block'], [fact(who.head, { discount_pct: 12 }), 'block'],
      [fact(who.owner, { discount_pct: 20 }), 'allow']], textSop: null },
  { id: 'G2', msg: 'From now on: Sales can give at most 8% discount on quotations, and every quotation with a discount must explain the discount to the customer in a short, polite note.',
    expect: [[fact(who.sales, { discount_pct: 15 }), 'block'], [fact(who.sales, { discount_pct: 5 }), 'allow'], [fact(who.owner, { discount_pct: 20 }), 'allow']],
    textSop: /polite|explain/i },
  { id: 'G3', msg: 'From now on, always thank the customer by name in the notes of every quotation.',
    expect: [[fact(who.sales, { discount_pct: 50 }), 'allow']], noGates: true, textSop: /thank/i },
  { id: 'G4', msg: 'From now on, only a Superadmin can issue an invoice above RM 50,000.',
    expect: [[fact(who.sales, { doc_type: 'invoice', total: 60000 }, 'issue'), 'block'], [fact(who.sales, { doc_type: 'invoice', total: 40000 }, 'issue'), 'allow'],
      [fact(who.owner, { doc_type: 'invoice', total: 60000 }, 'issue'), 'allow'], [fact(who.sales, { doc_type: 'invoice', total: 60000 }, 'save'), 'allow'],
      [fact(who.sales, { doc_type: 'quotation', total: 60000 }, 'issue'), 'allow']], textSop: null },
  // No fact exists for a signature: the gate must not be invented. Expected: no gate saved; the reply should say it cannot be enforced yet (recorded only).
  { id: 'G6', msg: 'From now on, no invoice may be issued before the customer has signed the quotation.',
    expect: [], noGates: true, textSop: null, observe: /not enforce|cannot enforce|can't enforce|not supported|no way to check|can't check|cannot check/i },
];

const owner = makeClient(f.users.admin, log);
if ((await owner.login(f.users.admin, f.logins.admin, f.companyCode)).status !== 200) throw new Error('owner login failed');
const textOf = (c) => { try { const j = JSON.parse(c); return j.text || c; } catch { return c; } };

// Effort, from records: set_gates calls (execution_tool_calls), fix rounds (fix tasks), changes to di.gate in the job (di.audit_log).
const effort = (t) => ({ setGatesCalls: t.setGatesCalls?.total ?? 0, setGatesOk: t.setGatesCalls?.ok ?? 0, fixRounds: t.tasks.filter((x) => x.kind === 'fix').length, gateChanges: t.gateChanges ?? 0 });

function judge(c, t) {
  const rules = t.gate?.rules || [];
  const checks = c.expect.map(([facts, want]) => { const got = decide(rules, facts); return { facts, want, got: got.decision, rule: got.rule?.id || null, ok: got.decision === want }; });
  const sop = t.sops.find((s) => s.agent_id === 'di-documents')?.content || '';
  const fails = [];
  if (!t.settled || t.http.error) return { verdict: 'INVALID', why: `settled=${t.settled} error=${t.http.error}`, checks };
  if (!t.tasks.length) return { verdict: 'INVALID', why: 'no job (nothing was routed)', checks };
  for (const x of checks) if (!x.ok) fails.push(`${JSON.stringify(x.facts)} -> ${x.got}, want ${x.want}`);
  if (c.noGates && rules.length) fails.push(`expected no gate, found ${rules.length}`);
  if (c.textSop && !c.textSop.test(sop)) fails.push(`di-documents SOP does not hold ${c.textSop}`);
  if (effort(t).fixRounds > 0) fails.push(`needed fix rounds (${effort(t).fixRounds})`);
  return { verdict: fails.length ? 'FAILED' : 'CORRECT', why: fails.join('; ') || 'all fact checks pass', checks,
    observed: c.observe ? c.observe.test(textOf(t.reply)) : undefined };
}

const results = [];
for (let n = 1; n <= reps; n++) {
  for (const c of CASES) {
    if (only && !only.has(c.id)) continue;
    if (c.chain && only && !only.has(c.chain)) continue;
    if (!c.chain) records({ op: 'reset', tenantId: f.tenantId });
    const turn = await chatTurn(owner, f.tenantId, c.msg);
    const t = { case: c.id, n, msg: c.msg, ...turn, ...records({ op: 'read', tenantId: f.tenantId, sid: turn.sid }) };
    const j = judge(c, t);
    writeFileSync(path.join(dir, `trace-${c.id}-${n}.json`), JSON.stringify({ ...t, judged: j }, null, 1));
    results.push({ case: c.id, n, verdict: j.verdict, why: j.why, ...effort(t), observed: j.observed, gates: (t.gate?.rules || []).map((r) => `${r.id}:${r.then}`),
      tasks: t.tasks.map((x) => `${x.kind}/${x.agent_id}/${x.status}${x.check ? '/' + x.check.verdict : ''}`) });
    const e = effort(t);
    console.log(`${c.id} run ${n}: ${j.verdict}  set_gates calls ${e.setGatesCalls} (ok ${e.setGatesOk}), fix rounds ${e.fixRounds}, di.gate changes ${e.gateChanges}  ${j.why}`);
    writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 1));
  }
}
const ids = [...new Set(results.map((r) => r.case))];
const table = ['| case | ' + Array.from({ length: reps }, (_, i) => `run ${i + 1}`).join(' | ') + ' |', '|---|' + '---|'.repeat(reps),
  ...ids.map((id) => `| ${id} | ${Array.from({ length: reps }, (_, i) => results.find((r) => r.case === id && r.n === i + 1)?.verdict || 'not run').join(' | ')} |`)].join('\n');
writeFileSync(path.join(dir, 'results-table.md'), table + '\n');
console.log(table);
