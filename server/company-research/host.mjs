import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPool, getSetting } from '../db.mjs';
import { secret, TAVILY_KEY_NAMES } from '../secrets.mjs';
import { getAgent, getMcpServer, listMcpServers, createMcpServer, updateMcpServer, seedSystemAgent, updateAgent } from '../catalog.mjs';
import { BUNDLED_MODELS, ROOT, agentWorkspace } from '../paths.mjs';
import { resolveModelCredentials } from '../models.mjs';
import { RESEARCH_AGENT_ID, researchAuthorized } from './auth.mjs';
import { Seed, reconcile, renderDossier } from './core.mjs';
import { ResearchStore } from './store.mjs';
import { connectScrapling } from './adapters.mjs';
import { PiResearchRunner, researchModelRuntime } from './runner.mjs';
import { researchCompany } from './pipeline.mjs';
import { createMetadataLanes } from './metadata.mjs';

let store, workerTimer, busy = false, stopped = false, tavilyMcpKey = '';
export function tavilyKeyFromMcp(server) {
  const env = server.env || {};
  const direct = env.TAVILY_API_KEY || env.tavily_api_key;
  if (direct) return String(direct).trim();
  try {
    const u = new URL(server.url);
    for (const name of ['tavilyApiKey', 'tavily_api_key', 'apiKey', 'TAVILY_API_KEY']) {
      const key = u.searchParams.get(name); if (key?.startsWith('tvly-')) return key;
    }
  } catch { /* stdio registration */ }
  const header = server.config?.headers?.Authorization || server.config?.headers?.authorization || '';
  const bearer = String(header).replace(/^Bearer\s+/i, '');
  return bearer.startsWith('tvly-') ? bearer : '';
}
export function savedTavilyKeys(get = secret, env = process.env) {
  const slots = TAVILY_KEY_NAMES.map(get);
  const legacy = slots[0] ? '' : get('tavily_api_key');
  return [...new Set([...slots, legacy, env.TAVILY_API_KEY].map(key => String(key || '').trim()).filter(Boolean))];
}
async function resolveTavilyKeys() {
  const direct = savedTavilyKeys();
  if (direct.length) return direct;
  const servers = await listMcpServers();
  tavilyMcpKey = servers.filter(s => /tavily/i.test(`${s.slug} ${s.name}`)).map(tavilyKeyFromMcp).find(Boolean) || '';
  return tavilyMcpKey ? [tavilyMcpKey] : [];
}
export function researchConfiguration() {
  const keyCount = savedTavilyKeys().length || (tavilyMcpKey ? 1 : 0);
  return { tavily: keyCount > 0, tavilyKeyCount: keyCount, model: process.env.COMPANY_RESEARCH_MODEL || null, persistence: Boolean(store), workerBusy: busy };
}
async function configuredRunner(modelId) {
  const resolved = await resolveModelCredentials();
  const chosen = modelId || process.env.COMPANY_RESEARCH_MODEL || await getSetting('active_model_id') || resolved.defaultModelId;
  const selected = resolved.models.find(m => m.id === chosen && m.available);
  if (!selected) throw new Error('No research model with a saved API key is available in the existing model catalog');
  const prefix = selected.envPrefix.toLowerCase();
  const { runtime, model } = await researchModelRuntime({ modelsPath: BUNDLED_MODELS, provider: selected.provider, model: selected.model, apiKey: secret(`${prefix}_api_key`), baseUrl: resolved.env[`${selected.envPrefix}_BASE_URL`] });
  return new PiResearchRunner({ modelRuntime: runtime, model });
}
export async function ensureCompanyResearch({ log = () => {} } = {}) {
  store = new ResearchStore(getPool()); await store.migrate();
  await resolveTavilyKeys();
  const rolePrompt = await readFile(path.join(ROOT, 'agent', 'roles', 'company-deep-research.md'), 'utf8');
  await seedSystemAgent({ id: RESEARCH_AGENT_ID, slug: RESEARCH_AGENT_ID, name: 'Company Deep Research', short: 'CDR', headline: 'Evidence-backed company dossiers', description: 'Researches Malaysian companies with Tavily search, Scrapling page evidence, four restricted Pi sessions, quote validation and reproducible scores.', color: 'cyan', rolePrompt, toolProfile: 'assistant', thinkingLevel: 'low' });
  await mkdir(agentWorkspace({ id: RESEARCH_AGENT_ID, slug: RESEARCH_AGENT_ID }), { recursive: true });
  const payload = { name: 'Company Deep Research', slug: 'company-research', command: process.execPath, args: [path.join(ROOT, 'server', 'company-research', 'mcp-server.mjs')], description: 'Starts private company research jobs, retrieves dossiers and replays synthesis from saved evidence.', config: { directTools: true, lifecycle: 'eager' } };
  const old = await getMcpServer(payload.slug);
  const mcp = old ? await updateMcpServer(old.id, payload) : await createMcpServer(payload);
  const agent = await getAgent(RESEARCH_AGENT_ID);
  await updateAgent(agent.id, { skillIds: [], mcpIds: [mcp.id] });
  stopped = false;
  clearInterval(workerTimer);
  workerTimer = setInterval(() => { void tick(log); }, 2000); workerTimer.unref?.();
  log('info', 'company research agent, private dossier storage and durable queue ready');
  return researchConfiguration();
}
async function tick(log) {
  if (busy || stopped || !store) return;
  busy = true;
  let job, scrapling, heartbeat;
  try {
    job = await store.claim(); if (!job) return;
    heartbeat = setInterval(() => { void store.heartbeat(job.id).catch(() => {}); }, 45000); heartbeat.unref?.();
    const tavilyKeys = await resolveTavilyKeys();
    if (!tavilyKeys.length) throw new Error('Add a Tavily API key in Settings → Keys');
    const runner = await configuredRunner(job.options?.modelId);
    const server = await getMcpServer('scrapling');
    if (server) { try { scrapling = await connectScrapling(server); } catch { await store.event(job.id, { type: 'warning', message: 'Scrapling unavailable; page-fetch lanes will return partial results' }); } }
    const metadataLanes = createMetadataLanes({ seed: job.seed, psiKey: process.env.PSI_API_KEY, pitchSignals: job.options?.pitchSignals, directory: seed => store.directoryCandidates(seed) });
    const outcome = await researchCompany({ seed: job.seed, tavilyKeys, scrapling, runner, metadataLanes, emit: event => store.event(job.id, event), saveEvidence: e => store.evidence(job.id, e), saveRun: r => store.run(job.id, r) });
    await store.finish(job.id, outcome);
  } catch (error) {
    // Provider errors may include request diagnostics. Persist a bounded safe
    // message; never serialize headers or credential-bearing client objects.
    const message = String(error.message || 'Research failed').replace(/(?:sk-|tvly-)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
    if (job) await store.fail(job.id, message).catch(() => {});
    log('warn', `company research job ${job?.id || 'queue'} failed: ${message}`);
  } finally { clearInterval(heartbeat); await scrapling?.close().catch(() => {}); busy = false; }
}
export function stopCompanyResearch() { stopped = true; clearInterval(workerTimer); }
function reportUrl(pathname) {
  const base = process.env.COMPANY_RESEARCH_PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  return base ? new URL(pathname, base).href : pathname;
}
export async function researchAction({ action, seed, id, force, pitchSignals = false, modelId, format = 'json' }, repository = store) {
  if (!repository) throw new Error('Company research is not initialized');
  if (action === 'start') {
    if (!(await resolveTavilyKeys()).length) throw new Error('Add a Tavily API key in Settings → Keys');
    if (modelId !== undefined && (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 200)) throw new Error('Valid research model id required');
    return repository.enqueue(Seed.parse(seed), Boolean(force), { pitchSignals: Boolean(pitchSignals), ...(modelId ? { modelId } : {}) });
  }
  if (action === 'status') return researchConfiguration();
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('Valid dossier id required');
  if (action === 'get') {
    const row = await repository.get(id); if (!row) throw new Error('Dossier not found');
    return row;
  }
  if (action === 'replay') {
    const input = await repository.replayInput(id);
    // Replay uses the original time to reproduce ages, recency and scores.
    const old = await repository.get(id);
    const clock = new Date(new Date(input.startedAt).getTime() + (old.result?.meta?.durationMs || 0));
    const result = reconcile(input, clock);
    result.meta.credits = old.result?.meta?.credits || {};
    result.meta.budgets = old.result?.meta?.budgets || {};
    return { id, replayed: true, result, creditsSpent: 0 };
  }
  if (action === 'artifact') {
    if (!['json', 'md', 'html'].includes(format)) throw new Error('format must be json, md or html');
    const row = await repository.get(id); if (!row?.result) throw new Error('Dossier is not ready');
    return { format, url: reportUrl(`/api/company-research/dossiers/${id}/artifact?format=${format}`), content: renderDossier(row.result, format) };
  }
  if (action === 'publish') {
    const row = await repository.get(id);
    if (!row?.result || !['complete', 'partial'].includes(row.status)) throw new Error('Only a completed or partial dossier with a resolved identity can be published');
    if (row.result.identity.match.status !== 'locked') throw new Error('Resolve company identity before publication');
    const published = await repository.publish(id, renderDossier(row.result, 'html'), row.result.seed.name);
    await repository.event(id, { type: 'published' });
    return { id, published: true, url: reportUrl(`/reports/company/${published.token}`), publishedAt: published.published_at };
  }
  if (action === 'unpublish') {
    await repository.unpublish(id);
    return { id, published: false };
  }
  throw new Error('Unknown research action');
}
export async function handleCompanyResearch(req, res, url, { authorized, readBody, repository = store }) {
  if (url.pathname.startsWith('/reports/company/')) {
    const token = url.pathname.slice('/reports/company/'.length);
    let publication;
    if (token === 'preview') {
      const preview = reconcile({ seed: { name: 'Your company, in focus.' }, identity: { status: 'needs_review' }, evidence: [], runs: [], startedAt: '2026-10-02T00:00:00Z' }, new Date('2026-10-02T00:00:00Z'));
      preview.summary = 'Design preview — no company has been researched. Completed reports show company facts, evidence coverage, published contacts and linked sources in this layout.';
      publication = { html: renderDossier(preview, 'html') };
    } else if (/^[0-9a-f-]{36}$/i.test(token) && repository) publication = await repository.publication(token);
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true; }
    if (!publication) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Report not found'); return true; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox allow-popups allow-popups-to-escape-sandbox" });
    res.end(req.method === 'HEAD' ? undefined : publication.html); return true;
  }
  const internal = url.pathname === '/api/internal/company-research';
  const prefix = '/api/company-research/dossiers';
  const configuration = url.pathname === '/api/company-research/status';
  if (!internal && !configuration && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) return false;
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(body)); };
  if (!(internal ? researchAuthorized(req) : authorized(req))) { json(401, { error: 'Unauthorized' }); return true; }
  if (!repository) { json(503, { error: 'Research database is not ready' }); return true; }
  if (configuration) { json(req.method === 'GET' ? 200 : 405, req.method === 'GET' ? researchConfiguration() : { error: 'GET required' }); return true; }
  const action = input => researchAction(input, repository);
  try {
    if (internal) {
      if (req.method !== 'POST') { json(405, { error: 'POST required' }); return true; }
      const input = JSON.parse(await readBody(req) || '{}');
      json(200, { ok: true, result: await action(input) }); return true;
    }
    if (req.method === 'POST' && url.pathname === prefix) {
      const body = JSON.parse(await readBody(req) || '{}');
      json(202, await action({ action: 'start', seed: body.seed, force: body.options?.force, pitchSignals: body.options?.pitchSignals, modelId: body.options?.modelId })); return true;
    }
    const match = url.pathname.slice(prefix.length).match(/^\/([0-9a-f-]{36})(?:\/(artifact|events|replay|publish))?$/i);
    if (!match) { json(404, { error: 'Unknown research route' }); return true; }
    const [, id, sub] = match;
    if (sub === 'events' && req.method === 'GET') {
      if (!await repository.get(id)) { json(404, { error: 'Dossier not found' }); return true; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      let after = Number(req.headers['last-event-id'] || 0), polling = false;
      if (!Number.isSafeInteger(after) || after < 0) after = 0;
      const poll = async () => {
        if (polling || res.destroyed || res.writableEnded) return; polling = true;
        try {
          const events = await repository.events(id, after);
          for (const e of events) { res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e.data)}\n\n`); after = Number(e.seq); }
          if (!events.length) res.write(': keepalive\n\n');
          const row = await repository.get(id);
          if (!['queued', 'running'].includes(row?.status) && events.length < 100) { clearInterval(timer); res.end(); }
        } catch { clearInterval(timer); res.end(); } finally { polling = false; }
      };
      const timer = setInterval(() => { void poll(); }, 2000);
      res.on('close', () => clearInterval(timer)); await poll(); return true;
    }
    if (sub === 'replay' && req.method === 'POST') { json(200, await action({ action: 'replay', id })); return true; }
    if (sub === 'publish' && req.method === 'POST') { json(200, await action({ action: 'publish', id })); return true; }
    if (sub === 'publish' && req.method === 'DELETE') { json(200, await action({ action: 'unpublish', id })); return true; }
    if (req.method !== 'GET') { json(405, { error: 'Method not allowed' }); return true; }
    if (sub === 'artifact') {
      const format = url.searchParams.get('format') || 'json';
      const out = await action({ action: 'artifact', id, format });
      res.writeHead(200, { 'Content-Type': { json: 'application/json', md: 'text/markdown; charset=utf-8', html: 'text/html; charset=utf-8' }[format], 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }); res.end(out.content); return true;
    }
    json(200, await action({ action: 'get', id }));
  } catch (error) { json(400, { error: error.message }); }
  return true;
}
