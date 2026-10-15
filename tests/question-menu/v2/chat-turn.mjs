// One chat turn against prod, waited until it has settled: no active run, no new event for 25 s,
// and every plan and task terminal in the database. Same rule as sop-run.mjs and run.mjs.
import { qmdb, sleep } from './lib.mjs';

const TERMINAL = new Set(['done', 'failed', 'blocked', 'cancelled', 'completed', 'error', 'rejected', 'skipped']);
const RUN_ACTIVE = new Set(['queued', 'running']);

async function fetchEvents(client, sid) {
  const events = []; let runs = []; let after = 0;
  for (let page = 0; page < 40; page++) {
    const r = await client.get(`/api/execution/runs?sessionId=${sid}&after=${after}`);
    if (r.status !== 200) return { events, runs };
    if (page === 0) runs = r.data.runs || [];
    const ev = r.data.events || []; events.push(...ev);
    if (ev.length < 100) break;
    after = Number(ev[ev.length - 1].id);
  }
  return { events, runs };
}

/** Sends `message` in a fresh orchestrator session and waits. Returns {sid, http, settled, waitedMs}. */
export async function chatTurn(client, tenantId, message, maxWaitMs = 15 * 60000) {
  const s = await client.post('/api/sessions', { agentId: 'orchestrator' });
  const sid = s.data?.session?.id || s.data?.id;
  if (!sid) throw new Error('no session');
  const res = await client.post('/api/chat', { message, sessionId: sid, agentId: 'orchestrator' }, { text: true });
  const parsed = String(res.data).split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } }).filter(Boolean);
  const err = parsed.find((e) => e.type === 'error');
  const http = { status: res.status, error: err ? String(err.error || err.message || 'stream error').slice(0, 300) : null };
  const t0 = Date.now();
  while (Date.now() - t0 < maxWaitMs) {
    const { events, runs } = await fetchEvents(client, sid);
    const refs = new Set(events.map((e) => e.runRef).filter(Boolean));
    const active = runs.filter((u) => refs.has(u.id)).some((u) => RUN_ACTIVE.has(u.status));
    const lastEv = events.length ? new Date(events[events.length - 1].createdAt).getTime() : t0;
    if (events.length && !active && Date.now() - lastEv >= 25000) {
      const db = qmdb({ op: 'turn', sessionIds: [sid], tenantId, checks: [] });
      const open = db.plans.some((p) => !TERMINAL.has(p.status)) || db.tasks.some((t) => !TERMINAL.has(t.status));
      const planned = events.some((e) => e.kind === 'plan.submitted');
      if (!open && (!planned || db.plans.length)) return { sid, http, settled: true, waitedMs: Date.now() - t0 };
    }
    await sleep(6000);
  }
  return { sid, http, settled: false, waitedMs: Date.now() - t0 };
}
