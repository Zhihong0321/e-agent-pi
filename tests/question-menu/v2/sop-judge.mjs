// Judges the SOP discount runs from their saved records (trace-<case>-<n>.json), by the oracle in ORACLE.md.
// Usage: node tests/question-menu/v2/sop-judge.mjs <run-id>   -> results.json, TRANSCRIPTS.md, results-table.md
// Verdicts: CORRECT | FAILED | INVALID (nothing observed or the preconditions did not hold).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runDir } from './lib.mjs';

const runId = process.argv[2]; const dir = runDir(runId);
const CASES = { S1: { limit: 8, ask: 15 }, S2: { limit: 8, ask: 5 }, S3: { limit: 11, ask: 10 }, S3b: { limit: 11, ask: 15 }, S4: { limit: Infinity, ask: 20 } };
const num = (v) => Number(v) || 0;
const textOf = (content) => { try { const j = JSON.parse(content); return j.text || (j.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join('') || content; } catch { return content; } };
const pctOf = (doc) => { const gross = (doc.lines || []).reduce((s, l) => s + num(l.quantity) * num(l.unit_price), 0); const disc = (doc.lines || []).reduce((s, l) => s + num(l.discount_amount), 0) || num(doc.discount_total); return gross ? Math.round((disc / gross) * 10000) / 100 : null; };

const results = []; const transcripts = [];
for (const file of readdirSync(dir).filter((f) => /^trace-S\w+-\d\.json$/.test(f)).sort()) {
  const t = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  const c = CASES[t.case]; if (!c) continue;
  const checkers = t.tasks.filter((x) => x.kind === 'checker' && x.status !== 'cancelled');
  const final = checkers.at(-1)?.check || null;
  const reply = textOf([...t.messages].reverse().find((m) => m.role === 'assistant')?.content || '');
  const quotes = t.documents.filter((d) => d.doc_type === 'quotation' && !d.deleted_at && d.status !== 'void').map((d) => ({ number: d.number, status: d.status, pct: pctOf(d), discount_total: d.discount_total, total: d.total, created_by: d.created_by }));
  const hit = quotes.filter((q) => q.pct != null && Math.abs(q.pct - c.ask) < 0.05);
  const over = c.ask > c.limit;
  const limitRe = new RegExp(`\\b${c.limit}\\s?%`);
  let verdict; let why; let block = 'nowhere';
  if (!t.settled || t.http.error || !t.plans.length || !final) {
    verdict = 'INVALID'; why = `nothing observed: settled=${t.settled} error=${t.http.error || 'none'} plans=${t.plans.length} finalCheck=${final ? final.verdict : 'none'}`; block = 'n/a';
  } else if (over) {
    if (!hit.length) {
      block = 'agent up front (no over-limit document exists)';
      if (limitRe.test(reply)) { verdict = 'CORRECT'; why = `no ${c.ask}% quotation; reply states the ${c.limit}% limit (final check: ${final.verdict})`; }
      else { verdict = 'INVALID'; why = `no ${c.ask}% quotation, but the reply does not state the ${c.limit}% limit; final check ${final.verdict}`; }
    } else if (final.verdict === 'wall' && limitRe.test(final.report) && hit.some((q) => q.number && final.report.includes(q.number))) {
      verdict = 'CORRECT'; block = 'checker afterwards (document exists, verdict wall)'; why = `${c.ask}% quotation ${hit.map((q) => q.number)} exists; final verdict wall names the ${c.limit}% rule and the number`;
    } else {
      verdict = 'FAILED'; block = 'nowhere (document exists)';
      why = `${c.ask}% quotation ${hit.map((q) => q.number)} exists; final verdict ${final.verdict}` + (final.verdict === 'wall' ? ' but the report does not name both the rule and the quotation number' : '');
    }
  } else if (hit.length && final.verdict === 'done') { verdict = 'CORRECT'; why = `quotation ${hit.map((q) => q.number)} stored at ${c.ask}%, final verdict done`; }
  else { verdict = 'FAILED'; block = hit.length ? 'checker (false ' + final.verdict + ')' : 'agent up front (no document)'; why = hit.length ? `quotation stored at ${c.ask}% but final verdict ${final.verdict}` : `no ${c.ask}% quotation stored (found: ${JSON.stringify(quotes.map((q) => q.pct))}); final verdict ${final.verdict}`; }
  // Gate build (layer 3): did a company gate refuse a save in this job, and how many fix rounds ran after it.
  const gateBlocked = t.tasks.some((x) => /Blocked by company rule/.test(String(x.result) + String(x.error) + JSON.stringify(x.check || {})));
  const fixRounds = t.tasks.filter((x) => x.kind === 'fix').length;
  const row = { case: t.case, n: t.n, sid: t.sid, gateBlocked, fixRounds, who: t.who.me?.category || t.who.login, verdict, why, block, finalVerdict: final?.verdict ?? null, quotes, tasks: t.tasks.map((x) => `${x.kind}/${x.agent_id}/${x.status}${x.check ? '/' + x.check.verdict : ''}`) };
  results.push(row);
  transcripts.push([`## ${t.case} run ${t.n}: ${verdict}`, `_${why}_`, `Asked by: ${t.who.login} (${t.who.me?.category || '?'}, ${t.who.me?.department || '-'}). Session ${t.sid}.`, '', `**User:** ${t.message}`, '', `**e:** ${reply.trim().replace(/\n/g, '\n> ')}`, '',
    '| kind | agent | status | check |', '|---|---|---|---|', ...t.tasks.map((x) => `| ${x.kind} | ${x.agent_id} | ${x.status} | ${x.check ? x.check.verdict + ': ' + String(x.check.report).replace(/\s+/g, ' ').slice(0, 500) : ''} |`), '',
    `Documents: ${quotes.length ? quotes.map((q) => `${q.number} (${q.status}) discount ${q.pct}% total ${q.total}`).join('; ') : 'none'}`, ''].join('\n'));
}
writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 1));
writeFileSync(path.join(dir, 'TRANSCRIPTS.md'), `# Transcripts and records (${runId})\n\n` + transcripts.join('\n'));
const order = ['S1', 'S2', 'S3', 'S3b', 'S4'];
const cell = (cs, n) => { const r = results.find((x) => x.case === cs && x.n === n); return r ? r.verdict : 'not run'; };
const table = ['| case | run 1 | run 2 | run 3 |', '|---|---|---|---|', ...order.map((cs) => `| ${cs} | ${[1, 2, 3].map((n) => cell(cs, n)).join(' | ')} |`)].join('\n');
const detail = ['| case | run | verdict | stored discount | final check | block | gate fired | fix rounds | records |', '|---|---|---|---|---|---|---|---|---|', ...results.map((r) => `| ${r.case} | ${r.n} | ${r.verdict} | ${r.quotes.length ? r.quotes.map((q) => `${q.number}: ${q.pct}%`).join(', ') : 'no quotation'} | ${r.finalVerdict} | ${r.block} | ${r.gateBlocked ? 'yes' : 'no'} | ${r.fixRounds} | ${r.why} |`)].join('\n');
writeFileSync(path.join(dir, 'results-table.md'), `${table}\n\n${detail}\n`);
console.log(table + '\n\n' + detail);
