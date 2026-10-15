// Builds report.md from evidence/<run-id>/results.json (one run) or a k/n table over several runs.
// Usage: node tests/question-menu/v2/report.mjs <run-id> [<run-id> ...]
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { here } from './lib.mjs';
import { SKIPS } from './cases.mjs';

const runs = process.argv.slice(2);
if (!runs.length) throw new Error('give one or more run ids');
const load = (id) => JSON.parse(readFileSync(path.join(here, 'evidence', id, 'results.json'), 'utf8'));
const all = runs.map((id) => ({ id, rows: load(id) }));
const order = ['FAIL', 'INVALID', 'GAP', 'PASS'];
const ids = [...new Set(all.flatMap((r) => r.rows.map((x) => x.id)))];
const byRun = (rid, id) => all.find((r) => r.id === rid).rows.find((x) => x.id === id);

const lines = [];
const counts = (rows) => { const c = {}; for (const r of rows) c[r.verdict] = (c[r.verdict] || 0) + 1; return c; };
lines.push(`# Question-menu baseline (${runs.join(', ')})`, '');
for (const r of all) lines.push(`- ${r.id}: ${r.rows.length} cases ${JSON.stringify(counts(r.rows))}`);
lines.push('', `Skipped (publish outside the test company or change platform-wide state): ${SKIPS.map((s) => s.id).join(', ')}`, '');
lines.push('PASS = expected effect proven by a database row or tool record. GAP = the menu names an agent a company cannot have (platform agent or missing), and the orchestrator held back. FAIL = wrong effect, forbidden effect, or no effect from an installed agent. INVALID = not observable; never a pass.', '');

if (runs.length === 1) {
  const rows = all[0].rows;
  for (const v of order) {
    const set = rows.filter((x) => x.verdict === v);
    if (!set.length) continue;
    lines.push(`## ${v} (${set.length})`, '', '| ID | Role | Code | Reason | Writes | Note |', '|---|---|---|---|---|---|');
    for (const x of set) lines.push(`| ${x.id} | ${x.role || ''} | ${x.code || ''} | ${String(x.reason || '').replace(/\|/g, '/').slice(0, 220)} | ${[...new Set(x.writes || [])].join(', ') || '-'} | ${String(x.note || '').replace(/\|/g, '/')}${x.upstream?.length ? ' upstream: ' + x.upstream.join(' ') : ''} |`);
    lines.push('');
  }
} else {
  lines.push('## Per case across runs', '', `| ID | ${runs.join(' | ')} | Stable? |`, `|---|${runs.map(() => '---|').join('')}---|`);
  for (const id of ids) {
    const cells = runs.map((r) => byRun(r, id)?.verdict || '-');
    const stable = new Set(cells.filter((c) => c !== '-')).size === 1 ? 'yes' : 'FLAKY';
    lines.push(`| ${id} | ${cells.join(' | ')} | ${stable} |`);
  }
}
// ---- Routing: the orchestrator's one decision (route.decided events). See AI-Orchestration-and-agent-design.md Appendix A.
const COMPANY = (a) => a.startsWith('di-') || ['scheduler', 'company-deep-research', 'ads-research', 'media-ai'].includes(a);
const tracesOf = (id) => {
  const dir = path.join(here, 'evidence', id);
  try { return readdirSync(dir).filter((f) => f.startsWith('trace-')).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'))); } catch { return []; }
};
const routeOf = (t) => {
  const e = (t.events || []).find((x) => x.kind === 'route.decided');
  return e ? `${e.outcome || '?'}${e.owner ? ':' + e.owner : ''}` : 'no-route';
};
const routes = new Map(); // case id -> [route per run]
lines.push('', '## Routing (the orchestrator picks one key; code does the rest)', '');
for (const r of all) {
  const tr = tracesOf(r.id);
  const tally = {};
  let owned = 0, right = 0;
  for (const t of tr) {
    const route = routeOf(t);
    const kind = route.split(':')[0];
    tally[kind] = (tally[kind] || 0) + 1;
    (routes.get(t.case.id) || routes.set(t.case.id, []).get(t.case.id)).push(route);
    const need = t.case.needs || [];
    if (need.length === 1 && COMPANY(need[0])) { owned += 1; if (route === `routed:${need[0]}`) right += 1; }
  }
  lines.push(`- ${r.id}: ${JSON.stringify(tally)}; routed to the expected owner ${right} of ${owned}${owned ? ` (${Math.round((100 * right) / owned)}%)` : ''}`);
}
if (runs.length > 1) {
  const seen = [...routes].filter(([, list]) => list.length === runs.length);
  const varied = seen.filter(([, list]) => new Set(list).size > 1);
  lines.push('', `Same route in every run: ${seen.length - varied.length} of ${seen.length} cases.`);
  for (const [id, list] of varied) lines.push(`- ${id}: ${list.join(' | ')}`);
}
const out = path.join(here, 'evidence', runs.length === 1 ? runs[0] : 'compare-' + runs.join('+'), 'report.md');
try { writeFileSync(out, lines.join('\n')); } catch { /* compare dir may not exist */ }
console.log(lines.join('\n'));
