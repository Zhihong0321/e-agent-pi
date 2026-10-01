// Manual behavioral test: real Pi + MCP adapter + roles, isolated dispatch host/DI database.
// The website worker uses a real HTTP fetch; timeout mode simulates a stalled worker.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { migrate, pgliteAdapter } from '../document_inteligence/core/db.mjs';
import { seedTenant, ensureDefaultTenant } from '../document_inteligence/core/seed.mjs';
import { runTool } from '../document_inteligence/core/actions.mjs';
import { capabilityCard, specialistPrompt } from '../server/orchestrator.mjs';
import { NON_CODING_SYSTEM_PROMPT } from '../server/agent-profiles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PGlite } = createRequire(path.join(root, 'document_inteligence/package.json'))('@electric-sql/pglite');
const output = await mkdtemp(path.join(tmpdir(), 'logo-prompt-eval-'));
const vault = JSON.parse(await readFile('D:/Tools/my-vault/vault.json', 'utf8'));
const credential = vault.credentials.find(c => c.name === 'OPENCODE_GO_TOKEN_PLAN');
if (!credential?.secret) throw new Error('Same-model evaluation credential unavailable');
const model = 'deepseek-v4.1-flash';
const provider = JSON.parse(await readFile(path.join(root, '.pi/agent/models.json'), 'utf8')).providers['opencode-go'];
const prompt = 'https://ee-pr.up.railway.app/  ( record the link to eternalgy logo, pick 1, and store its url )';
const report = { model, prompt, setup: 'Real Pi/MCP/Onboarding; isolated dispatch host; HTTP website worker', cases: [] };
let current;
let port;
const children = new Set();

async function runPi(agent, message, label) {
  const dir = path.join(output, label, agent);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'models.json'), JSON.stringify({ providers: { 'opencode-go': provider } }));
  await writeFile(path.join(dir, 'auth.json'), '{}');
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ packages: [] }));
  const server = agent === 'orchestrator' ? 'orchestrator-dispatch' : 'document-intelligence';
  const entry = agent === 'orchestrator' ? 'server/orchestrator-mcp-server.mjs' : 'document_inteligence/mcp-server.mjs';
  await writeFile(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { [server]: {
    command: process.execPath, args: [path.join(root, entry)], lifecycle: 'lazy',
  } } }));
  const args = [path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    '--system-prompt', NON_CODING_SYSTEM_PROMPT, '--append-system-prompt', path.join(root, `agent/roles/${agent}.md`),
    '--provider', 'opencode-go', '--model', model, '--thinking', agent === 'orchestrator' ? 'medium' : 'low',
    '--no-builtin-tools', '--no-skills', '--no-extensions', '--no-prompt-templates', '--no-context-files',
    '--extension', path.join(root, 'node_modules/pi-mcp-adapter'), '--session', path.join(dir, 'session.jsonl'),
    '--approve', '--mode', 'json', '--print', message];
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: output, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, OPENCODE_GO_API_KEY: credential.secret, PI_CODING_AGENT_DIR: dir,
      ORCHESTRATOR_DISPATCH_URL: `http://127.0.0.1:${port}`, ORCHESTRATOR_DISPATCH_TOKEN: 'eval',
      DI_AGENT: agent, DI_TOKEN: 'eval', DI_URL: `http://127.0.0.1:${port}`,
    } });
    children.add(child);
    let stdout = '', stderr = '', pending = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 180000);
    child.stdout.on('data', c => {
      stdout += c; pending += c;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) try {
        const e = JSON.parse(line);
        if (e.type === 'tool_execution_start') console.log(`${label} ${agent}: ${e.toolName}`);
      } catch {}
    });
    child.stderr.on('data', c => { stderr += c; });
    child.on('close', async code => {
      clearTimeout(timer); children.delete(child);
      await writeFile(path.join(dir, 'events.jsonl'), stdout);
      let reply = '';
      for (const line of stdout.split('\n')) try {
        const e = JSON.parse(line);
        if (e.type === 'message_end' && e.message?.role === 'assistant') {
          const text = e.message.content?.filter(p => p.type === 'text').map(p => p.text).join('') || '';
          if (text.trim()) reply = text;
        }
      } catch {}
      resolve({ agent, code, timedOut, elapsedMs: Date.now() - started, reply, stderr: stderr.slice(-1500) });
    });
  });
}

const host = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    let raw = ''; for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    current.calls.push({ at: Date.now(), ...body });
    console.log(`${current.mode} HOST: ${body.action || body.tool}`);
    if (current.calls.length > 25) throw new Error('Evaluation tool budget exceeded');
    let result;
    if (req.url === '/api/internal/di') result = await runTool(current.di, body);
    else if (body.action === 'list_specialists') result = { specialists: current.roster, company_setup: { minimum_ready: true, revision: 1, company_name: 'Eternalgy Sdn Bhd' } };
    else if (body.action === 'get_company_setup') {
      const s = await runTool(current.di, { agent: 'di-onboarding', tool: 'get_onboarding_status', args: {} });
      result = { minimum_ready: true, revision: s.company.revision, company_name: s.company.name };
    } else if (body.action === 'create_plan') {
      if (current.plan) throw new Error('Duplicate plan');
      current.plan = { id: 'test-plan', tasks: body.tasks.map((t, i) => ({ ...t, id: t.id || `t${i+1}`, status: 'pending' })) };
      result = current.plan;
    } else if (body.action === 'task_status') result = current.plan;
    else if (body.action === 'dispatch_task') {
      const task = current.plan.tasks.find(t => t.id === body.taskId);
      if (!task || task.status !== 'pending') throw new Error('Unknown or already dispatched task');
      if ((task.dependsOn || []).some(id => current.plan.tasks.find(t => t.id === id)?.status !== 'done')) throw new Error('Dependency unfinished');
      task.status = 'running';
      if (task.agent === 'web-scraper') {
        if (current.mode === 'timeout') throw new Error('Request timed out');
        const page = 'https://ee-pr.up.railway.app/';
        const response = await fetch(page, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`Website HTTP ${response.status}`);
        const html = await response.text();
        const image = html.match(/<img[^>]+src=["']([^"']+)["'][^>]+alt=["'][^"']*Eternalgy[^"']*["']/i);
        if (!image) throw new Error('No observed logo');
        const url = new URL(image[1], page).href;
        const logo = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!logo.ok || !logo.headers.get('content-type')?.startsWith('image/')) throw new Error('Logo unavailable');
        task.result = `Verified logo URL: ${url}\nSource page: ${page}\nHTTP ${logo.status}; ${logo.headers.get('content-type')}`;
      } else if (task.agent === 'di-onboarding') {
        const run = await runPi('di-onboarding', specialistPrompt(task, current.plan.tasks), current.mode);
        current.runs.push(run); if (run.timedOut || run.code) throw new Error('Onboarding evaluation failed');
        task.result = run.reply;
      } else throw new Error(`Unknown specialist ${task.agent}`);
      task.status = 'done'; result = { ok: true, status: 'done', task };
    } else throw new Error(`Unsupported action ${body.action}`);
    res.end(JSON.stringify({ ok: true, result: req.url === '/api/internal/di' ? result : JSON.stringify(result) }));
  } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: error.message })); }
});
await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
port = host.address().port;
console.log(`OUTPUT ${output}`);
try {
  for (const mode of (process.argv.includes('--success-only') ? ['success'] : ['success', 'timeout'])) {
    const engine = new PGlite(); const db = pgliteAdapter(engine);
    try {
      await migrate(db); const tenantId = await ensureDefaultTenant(db); await seedTenant(db, tenantId);
      const di = { db, tenantId: () => tenantId, actor: 'prompt-eval' };
      await runTool(di, { agent: 'di-onboarding', tool: 'update_company_profile', args: {
        name: 'Eternalgy Sdn Bhd', country: 'MY', business_type: 'services', business_activity: 'Solar installation', currency: 'MYR', email: 'test@example.com',
      } });
      current = { mode, calls: [], runs: [], di, roster: [
        capabilityCard({ id: 'web-scraper', slug: 'web-scraper', name: 'Web Scraper', headline: 'Browse websites and find images', description: 'Inspect public sites for logos and company facts', mcp: [{ name: 'Scrapling' }] }),
        capabilityCard({ id: 'di-onboarding', slug: 'di-onboarding', name: 'Company Onboarding', headline: 'Save company profile including logo_url', mcp: [{ name: 'Document Intelligence' }] }),
        ...Array.from({ length: 20 }, (_, i) => capabilityCard({ id: `other-${i}`, slug: `other-${i}`, name: `Other ${i}`, headline: 'Unrelated invoice or sales tasks', skills: [{ name: 'reporting', description: 'x'.repeat(5000) }] })),
      ] };
      current.runs.push(await runPi('orchestrator', prompt, mode));
      const profile = (await runTool(di, { agent: 'di-onboarding', tool: 'get_onboarding_status', args: {} })).company;
      const statuses = current.calls.filter(c => c.action === 'task_status').length;
      const rootRun = current.runs.find(r => r.agent === 'orchestrator');
      const passed = !rootRun.timedOut && rootRun.code === 0 && current.calls.length <= 15 &&
        (mode === 'success' ? !!profile.logo_url && profile.evidence.logo_url.source === 'website' : statuses <= 1 && !profile.logo_url);
      const item = { mode, passed, calls: current.calls, runs: current.runs, logo: profile.logo_url, evidence: profile.evidence.logo_url, statusChecks: statuses };
      report.cases.push(item); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ mode, passed, elapsedMs: rootRun.elapsedMs, calls: current.calls.length, statusChecks: statuses, logo: profile.logo_url, reply: rootRun.reply }));
    } finally { await engine.close(); }
  }
} finally {
  for (const child of children) child.kill();
  host.closeAllConnections(); await new Promise(resolve => host.close(resolve));
}
if (report.cases.some(c => !c.passed)) process.exitCode = 1;
