// Shows what the user saw: every assistant message in each case's chat session, plus the job's steps.
// Usage: node tests/question-menu/v2/chat-view.mjs <run-id>   (reads evidence/<run-id>/results.json, writes chat-view.json + .md)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { here } from './lib.mjs';

const runId = process.argv[2];
const dir = path.join(here, 'evidence', runId);
const results = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8'));
const sids = results.map((r) => r.sid).filter(Boolean);

const remote = `
const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});
(async()=>{const sids=${JSON.stringify(sids)};
const textOf=(c)=>{try{const t=JSON.parse(c);return (t.blocks||[]).filter((b)=>b.type==='text').map((b)=>b.text).join('')||t.text||c;}catch{return c;}};
const msgs=(await p.query("SELECT session_id, role, content FROM messages WHERE session_id=ANY($1) ORDER BY id",[sids])).rows
  .map((m)=>({session_id:m.session_id,role:m.role,content:String(m.role==='user'?m.content:textOf(m.content)).slice(0,2500)}));
const tasks=(await p.query("SELECT p.parent_session_id sid, t.title, t.kind, t.status, left(coalesce(t.result,''),600) result, t.result_data->'check' AS check, t.error FROM orchestrator_tasks t JOIN orchestrator_plans p ON p.id=t.plan_id WHERE p.parent_session_id=ANY($1) ORDER BY p.created_at, t.sort_order",[sids])).rows;
out({msgs,tasks});process.exit(0)})().catch(e=>{out({error:e.message});process.exit(0)});
function out(o){console.log('@@B64START '+Buffer.from(JSON.stringify(o)).toString('base64')+' @@B64END');}`;
const b64 = Buffer.from(remote).toString('base64');
const out = execFileSync('bash', ['-c', `railway ssh --service "E Agent (PI)" "cd /app && echo ${b64} | base64 -d > /app/zcv.cjs && node /app/zcv.cjs; rm -f /app/zcv.cjs"`],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
// The terminal may wrap long lines: take everything between the markers and drop whitespace.
const b64out = out.slice(out.indexOf('@@B64START') + '@@B64START'.length, out.indexOf('@@B64END')).replace(/\s+/g, '');
const data = JSON.parse(Buffer.from(b64out, 'base64').toString('utf8'));
if (data.error) throw new Error(data.error);

// An assistant message is a serialized turn (JSON with blocks) or plain text (a job report).
const textOf = (content) => {
  try {
    const turn = JSON.parse(content);
    const blocks = turn.blocks || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return text || turn.text || content;
  } catch { return content; }
};
const view = results.map((r) => ({
  id: r.id, verdict: r.verdict, reason: r.reason,
  chat: data.msgs.filter((m) => m.session_id === r.sid).map((m) => ({ role: m.role, text: m.role === 'user' ? m.content : textOf(m.content) })),
  steps: data.tasks.filter((t) => t.sid === r.sid).map(({ sid, ...t }) => t),
}));
writeFileSync(path.join(dir, 'chat-view.json'), JSON.stringify(view, null, 1));
const md = view.map((v) => [`## ${v.id} — ${v.verdict}`, `_${v.reason || ''}_`, '',
  ...v.chat.map((m) => `**${m.role === 'user' ? 'User' : 'e'}:** ${m.text.trim().replace(/\n/g, '\n> ')}\n`),
  '| step | kind | status | check |', '|---|---|---|---|',
  ...v.steps.map((s) => `| ${s.title} | ${s.kind} | ${s.status} | ${s.check ? `${s.check.verdict}: ${s.check.findings}` : ''} |`), ''].join('\n')).join('\n');
writeFileSync(path.join(dir, 'chat-view.md'), `# ${runId}: what the user saw\n\n${md}`);
console.log(`wrote ${path.join(dir, 'chat-view.md')}`);
