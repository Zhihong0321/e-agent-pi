// The one judge. Pure function of (case, turn record, roster). It reads RECORDS only, never reply wording.
// Verdicts:
//   PASS     the expected effect is proven by a database row or a tool-call record
//   FAIL     the product did something wrong, or did not do what an installed agent was asked to do
//   GAP      the menu promises an agent that is not on the roster, and the orchestrator handled it safely (no write)
//   INVALID  the instrument could not observe the case (did not settle, no session, transport error). Never counts as a pass.
// A FAIL always carries a reason code so triage can separate product bugs from model variance.

const CONTROL = new Set(['list_specialists', 'submit_plan', 'task_status', 'get_company_setup', 'route_request']);
// Operations that only read, even when the registry records them as committed (known: read tools report effectState committed).
const READ_OP = /(^|__)(fetch|make_request|stealthy_fetch|list|get|find|match|describe|preview|render|replay|status|search|count|form_field_types|prepare|calendar_events|schedule_(list|preview|history|agents)|procurement_overview|fde_describe)/;
const isRead = (op) => CONTROL.has(op) || READ_OP.test(op || '');

export function summarise(events = []) {
  const fin = events.filter((e) => e.kind === 'tool.finished').map((e) => ({ op: e.data?.operation || '', status: e.data?.status, effect: e.data?.effectState, err: e.data?.error }));
  const writes = fin.filter((t) => t.effect === 'committed' && !isRead(t.op)).map((t) => t.op);
  const readsOk = fin.filter((t) => t.status === 'ok' && !CONTROL.has(t.op)).map((t) => t.op);
  const errs = fin.filter((t) => t.status !== 'ok').map((t) => ({ op: t.op, code: t.err?.code, msg: String(t.err?.message || '').slice(0, 160) }));
  const planned = events.some((e) => e.kind === 'plan.submitted');
  const rejected = events.filter((e) => e.kind === 'completion.rejected').length;
  const finished = events.filter((e) => e.kind === 'run.finished');
  const answered = finished.some((e) => String(e.data?.summary || '').trim());
  const controlOk = fin.filter((t) => t.status === 'ok' && CONTROL.has(t.op)).map((t) => t.op);
  return { controlOk, writes, readsOk, errs, planned, rejected, answered, finished: finished.length };
}

function dbOutcome(tc, dbState) {
  const out = []; let ok = true;
  (tc.db || []).forEach((c, i) => {
    const got = dbState?.checks?.['c' + i];
    if (!got || got.error) { out.push(`c${i} ${c.t}: ${got?.error || 'no result'}`); ok = false; return; }
    const min = c.min ?? 0; const max = c.max ?? Infinity;
    const pass = got.n >= min && got.n <= max;
    if (!pass) ok = false;
    out.push(`${c.t}[${(c.like || []).join('&')}] n=${got.n} want ${min}..${max === Infinity ? '*' : max}${pass ? '' : ' MISMATCH'}`);
  });
  return { ok, detail: out };
}

export function judge(tc, res, roster) {
  const s = summarise(res.events);
  const missing = (tc.needs || []).filter((n) => !roster.includes(n));
  const base = { spec: tc.spec, cls: tc.cls, writes: s.writes, readsOk: s.readsOk, errs: s.errs, planned: s.planned, rejected: s.rejected, missing, note: tc.note };
  const out = (verdict, reason, extra = {}) => ({ verdict, reason, ...base, ...extra });

  if (!res.http || (res.http.status !== 200 && !res.events.length)) return out('INVALID', `chat not accepted: http ${res.http?.status} ${res.http?.error || ''}`);
  if (!res.settled) return out('INVALID', `did not settle in ${Math.round(res.waitedMs / 1000)}s`);
  if (!s.finished) return out('INVALID', 'no run.finished event recorded');

  // The menu names an agent that is not installed.
  if (missing.length) {
    if (s.writes.length) return out('FAIL', `improvised: committed ${[...new Set(s.writes)].join(', ')} although ${missing.join(', ')} is not on the roster`, { code: 'improvised-write' });
    return out('GAP', `agent not on roster: ${missing.join(', ')}`);
  }

  const forbidHit = tc.forbid ? s.writes.filter((o) => tc.forbid.test(o)) : [];
  const forbidReadHit = tc.forbidRead ? s.readsOk.filter((o) => tc.forbidRead.test(o)) : [];
  const dbo = tc.db ? dbOutcome(tc, res.dbState) : null;

  if (tc.cls === 'write') {
    if (forbidHit.length) return out('FAIL', `forbidden write ${forbidHit.join(', ')}`, { code: 'forbidden-write' });
    const opHit = tc.ops ? s.writes.filter((o) => tc.ops.test(o)) : s.writes;
    if (dbo) {
      if (dbo.ok) return out('PASS', dbo.detail.join('; '), { db: dbo.detail });
      if (tc.allowNoWrite && !s.writes.length && dbo.ok) return out('PASS', 'no write, rows as expected', { db: dbo.detail });
      const why = !s.writes.length ? (s.planned ? 'plan ran, nothing committed' : 'no plan, nothing committed (asked or declined)') : `wrote ${[...new Set(s.writes)].join(', ')} but rows not as expected`;
      return out('FAIL', `${why}; ${dbo.detail.join('; ')}`, { code: s.writes.length ? 'wrong-effect' : (s.errs.length ? 'tool-error' : 'no-effect'), db: dbo.detail });
    }
    if (opHit.length) return out('PASS', `committed ${[...new Set(opHit)].join(', ')}`);
    if (tc.allowNoWrite && !s.writes.length) return out('PASS', 'no write, acceptable for this case');
    return out('FAIL', s.writes.length ? `wrote ${[...new Set(s.writes)].join(', ')}, expected ${tc.ops}` : (s.planned ? 'plan ran, nothing committed' : 'no plan, nothing committed (asked or declined)'),
      { code: s.writes.length ? 'wrong-effect' : (s.errs.length ? 'tool-error' : 'no-effect') });
  }

  if (tc.cls === 'read') {
    const hit = [...s.readsOk, ...(tc.allowControl ? s.controlOk : [])].filter((o) => tc.ops.test(o));
    if (hit.length && s.writes.length && !tc.allowWrite) return out('FAIL', `question caused a write: ${[...new Set(s.writes)].join(', ')}`, { code: 'question-wrote' });
    if (hit.length) return out('PASS', `read ok: ${[...new Set(hit)].join(', ')}`);
    if (tc.inherits && !s.errs.length && !s.planned) return out('INVALID', 'answered from the conversation, no live lookup to observe');
    return out('FAIL', s.errs.length ? `lookup failed: ${s.errs.map((e) => `${e.op} ${e.code || ''}`).join(', ')}` : (s.planned ? 'plan ran, no matching read' : 'no lookup ran (asked or declined)'),
      { code: s.errs.length ? 'tool-error' : 'no-effect' });
  }

  // refuse: nothing forbidden may happen and the run must have produced an answer
  if (forbidHit.length) return out('FAIL', `forbidden write ${forbidHit.join(', ')}`, { code: 'forbidden-write' });
  if (forbidReadHit.length) return out('FAIL', `forbidden read ${forbidReadHit.join(', ')}`, { code: 'forbidden-read' });
  if (dbo && !dbo.ok) return out('FAIL', dbo.detail.join('; '), { code: 'forbidden-write', db: dbo.detail });
  if (!s.answered) return out('INVALID', 'finished without any answer text');
  return out('PASS', `held back: no forbidden effect${dbo ? '; ' + dbo.detail.join('; ') : ''}`);
}
