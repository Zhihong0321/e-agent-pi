// Runs the question-menu cases against prod on a company that preflight.mjs has already proven.
// Usage: node tests/question-menu/v2/run.mjs --rep 1 [--only SCRIPT,SCRIPT] [--concurrency 4]
// Every turn is settled (all runs and plans terminal) BEFORE it is judged, and judged only from records:
// tool-call events, run/plan/task status, and database rows. Reply wording is never read.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeClient, makeLogger, qmdb, loadFixtures, runDir, sleep, here } from './lib.mjs';
import { SCRIPTS as ALL_SCRIPTS, SKIPS, GOLDEN, REGRESSION } from './cases.mjs';
import { judge } from './judge.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const rep = Number(arg('rep', 1));
const setName = arg('set');
const wanted = setName === 'golden' ? GOLDEN : setName === 'regression' ? REGRESSION : null;
// --set keeps only the turns in the set; seed scripts a turn needs are listed in its script's `after` and are kept whole.
const SCRIPTS = !wanted ? ALL_SCRIPTS : (() => {
  const keep = new Set(); const need = (id) => { if (keep.has(id)) return; keep.add(id); (ALL_SCRIPTS.find((s) => s.id === id)?.after || []).forEach(need); };
  ALL_SCRIPTS.filter((s) => s.turns.some((t) => wanted.has(t.id))).forEach((s) => need(s.id));
  return ALL_SCRIPTS.filter((s) => keep.has(s.id)).map((s) => (s.turns.some((t) => wanted.has(t.id)) ? { ...s, turns: s.chain ? s.turns : s.turns.filter((t) => wanted.has(t.id)) } : { ...s, seed: true }));
})();
const only = arg('only') ? new Set(arg('only').split(',')) : null;
const CONC = Number(arg('concurrency', 4));
const runId = arg('run-id', `B0-r${rep}-${Date.now()}`);
const dir = runDir(runId);
const log = makeLogger(runId);
const f = loadFixtures(rep);
if (!f.tenantId || !f.cookies) throw new Error('run preflight.mjs first');

const TERMINAL = new Set(['done', 'failed', 'blocked', 'cancelled', 'completed', 'error', 'rejected', 'skipped']);
const RUN_ACTIVE = new Set(['queued', 'running']);
const clients = {};
for (const role of ['admin', 'head', 'user']) {
  const c = makeClient(f.users[role], log);
  const res = await c.login(f.users[role], f.logins[role]);
  if (res.status !== 200) throw new Error(`login ${role} failed ${res.status}`);
  clients[role] = c;
}
const imageB64 = (name) => readFileSync(path.join(here, 'fixtures', name)).toString('base64');

async function fetchEvents(client, sid, afterId) {
  const events = []; let runs = []; let after = afterId;
  for (let page = 0; page < 40; page++) {
    const r = await client.get(`/api/execution/runs?sessionId=${sid}&after=${after}`);
    if (r.status !== 200) return { error: `status ${r.status}`, events, runs };
    if (page === 0) runs = r.data.runs || [];
    const ev = r.data.events || [];
    events.push(...ev);
    if (ev.length < 100) break;
    after = Number(ev[ev.length - 1].id);
  }
  return { events, runs };
}

async function sendChat(client, sid, tc) {
  const body = { message: typeof tc.msg === 'function' ? tc.msg(f) : tc.msg, sessionId: sid, agentId: 'orchestrator' };
  if (tc.att) body.attachments = [{ name: tc.att, mime: 'image/png', data: imageB64(tc.att) }];
  try {
    const res = await client.post('/api/chat', body, { text: true });
    const lines = String(res.data).split('\n').filter((l) => l.startsWith('data:'));
    const parsed = lines.map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
    const err = parsed.find((e) => e.type === 'error');
    return { status: res.status, error: err ? String(err.error || err.message || 'stream error').slice(0, 300) : null,
      reply: parsed.filter((e) => e.type === 'text').map((e) => e.delta || e.text || '').join('').slice(0, 1500) };
  } catch (e) {
    return { status: 0, error: 'transport: ' + String(e.message || e).slice(0, 200), reply: '' };
  }
}

// Wait until the turn is over: no active run, no new event for 25 s, and every plan and task terminal in the database.
async function settle(client, sid, baseId, startedAt, maxWaitMs, tc) {
  const t0 = Date.now(); let last = { events: [], runs: [] }; let dbState = null;
  while (Date.now() - t0 < maxWaitMs) {
    last = await fetchEvents(client, sid, baseId);
    const refs = new Set(last.events.map((e) => e.runRef).filter(Boolean));
    const runs = (last.runs || []).filter((u) => refs.has(u.id));
    const active = runs.some((u) => RUN_ACTIVE.has(u.status));
    const lastEv = last.events.length ? new Date(last.events[last.events.length - 1].createdAt).getTime() : t0;
    const quiet = Date.now() - lastEv >= 25000;
    const planned = last.events.some((e) => e.kind === 'plan.submitted');
    const started = last.events.length > 0;
    if (started && !active && quiet) {
      const checks = (tc.db || []).map((c, i) => ({ k: 'c' + i, t: c.t, like: c.like, col: c.col }));
      dbState = qmdb({ op: 'turn', sessionIds: [sid], tenantId: f.tenantId, checks });
      const open = dbState.plans.some((p) => !TERMINAL.has(p.status)) || dbState.tasks.some((t) => !TERMINAL.has(t.status));
      if (!open && (!planned || dbState.plans.length)) return { settled: true, waitedMs: Date.now() - t0, ...last, dbState };
    }
    await sleep(6000);
  }
  return { settled: false, waitedMs: Date.now() - t0, ...last, dbState };
}

const results = [];
const upstreamBad = new Map();

async function runScript(script) {
  const role = script.turns[0].role;
  const client = clients[role];
  const newSession = async () => { const s = await client.post('/api/sessions', { agentId: 'orchestrator' }); return s.data?.session?.id || s.data?.id; };
  let sid = script.chain ? await newSession() : null;
  for (const tc of script.turns) {
    // A question must hit live data, so every turn gets its own session unless the script is a chain that needs a referent.
    if (!script.chain) sid = await newSession();
    const t0 = Date.now();
    const base = !sid ? { events: [] } : await fetchEvents(client, sid, 0);
    const baseId = base.events.length ? Number(base.events[base.events.length - 1].id) : 0;
    const startedAt = new Date(Date.now() - 1000);
    let res;
    if (!sid) res = { http: { status: 0, error: 'no session created', reply: '' }, settled: false, events: [], runs: [] };
    else {
      const http = await sendChat(clients[tc.role], sid, tc);
      const st = await settle(clients[tc.role], sid, baseId, startedAt, (script.maxWaitMin || 20) * 60000, tc);
      res = { http, ...st };
    }
    const verdict = judge(tc, res, f.roster[tc.role] || []);
    const upstream = (script.after || []).filter((a) => upstreamBad.has(a)).map((a) => `${a}:${upstreamBad.get(a).join('+')}`);
    const row = { id: tc.id, script: script.id, seed: script.seed && !(wanted && wanted.has(tc.id)) ? true : undefined, role: tc.role, sid, ms: Date.now() - t0, upstream, ...verdict };
    results.push(row);
    writeFileSync(path.join(dir, `trace-${tc.id}.json`), JSON.stringify({ case: { id: tc.id, msg: typeof tc.msg === 'function' ? tc.msg(f) : tc.msg, cls: tc.cls, needs: tc.needs, ops: String(tc.ops || ''), forbid: String(tc.forbid || ''), db: tc.db },
      http: res.http, settled: res.settled, waitedMs: res.waitedMs, runs: res.runs, events: slim(res.events), dbState: res.dbState, verdict }, null, 1));
    console.log(`${row.id.padEnd(8)} ${row.verdict.padEnd(8)} ${String(Math.round(row.ms / 1000)).padStart(4)}s  ${row.reason || ''}`);
    writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 1));
  }
  const bad = results.filter((r) => r.script === script.id && !['PASS', 'GAP'].includes(r.verdict)).map((r) => r.id);
  if (bad.length) upstreamBad.set(script.id, bad);
}

function slim(events = []) {
  return events.map((e) => ({ id: e.id, kind: e.kind, at: e.createdAt, op: e.data?.operation, status: e.data?.status, effect: e.data?.effectState,
    error: e.data?.error ? { code: e.data.error.code, msg: String(e.data.error.message || '').slice(0, 240) } : undefined,
    summary: e.kind === 'run.finished' ? String(e.data?.summary || '').slice(0, 600) : undefined, reason: e.data?.reason,
    ...(e.kind === 'route.decided' ? { intent: e.data?.intent, owner: e.data?.owner, outcome: e.data?.outcome } : {}) }));
}

// Scheduler: honour `after` and `group`, never exceed the concurrency.
const pending = SCRIPTS.filter((s) => !only || only.has(s.id));
const finished = new Set(); const running = new Set(); const busyGroups = new Set();
const known = new Set(SCRIPTS.map((s) => s.id));
await new Promise((resolve, reject) => {
  const tick = () => {
    if (!pending.length && !running.size) return resolve();
    for (let i = 0; i < pending.length && running.size < CONC; i++) {
      const s = pending[i];
      const ready = (s.after || []).every((a) => finished.has(a) || !known.has(a) || (only && !only.has(a)));
      if (!ready || (s.group && busyGroups.has(s.group))) continue;
      pending.splice(i--, 1); running.add(s.id); if (s.group) busyGroups.add(s.group);
      runScript(s).catch((e) => { console.log(`SCRIPT ${s.id} CRASHED ${e.message}`); results.push({ id: s.id, script: s.id, verdict: 'INVALID', reason: 'harness crash: ' + e.message }); })
        .finally(() => { running.delete(s.id); finished.add(s.id); if (s.group) busyGroups.delete(s.group); tick(); });
    }
    if (!running.size && pending.length) reject(new Error('no runnable script left: ' + pending.map((p) => p.id).join(',')));
  };
  tick();
});
writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 1));
writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ runId, rep, tenantId: f.tenantId, company: f.company, skipped: SKIPS, roster: f.roster, finishedAt: new Date().toISOString() }, null, 1));
const counts = {}; for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
console.log('DONE', runId, JSON.stringify(counts));
