import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPool, getSetting } from '../db.mjs';
import { secret, TAVILY_KEY_NAMES, BRAVE_KEY_NAMES, EXA_KEY_NAMES } from '../secrets.mjs';
import { getAgent, getMcpServer, listMcpServers, createMcpServer, updateMcpServer, seedSystemAgent, updateAgent } from '../catalog.mjs';
import { BUNDLED_MODELS, ROOT, agentWorkspace } from '../paths.mjs';
import { resolveModelCredentials } from '../models.mjs';
import { SIGNAL_RESEARCH_AGENT_ID, signalResearchAuthorized } from './auth.mjs';
import { SignalSeed, renderSignalReport } from './core.mjs';
import { SignalResearchStore } from './store.mjs';
import { connectScrapling } from './adapters.mjs';
import { PiSignalResearchRunner, signalModelRuntime } from './runner.mjs';
import { researchCompanySignals } from './pipeline.mjs';

let store, workerTimer, busy = false, stopped = false, tavilyMcpKey = '';
let activeJob, activeRunner, activeHeartbeat;

function savedSearchKeys(names, envName, get = secret, env = process.env) {
  return [...new Set([...names.map(get), env[envName]].map(key => String(key || '').trim()).filter(Boolean))];
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
  tavilyMcpKey = servers.filter(s => /tavily/i.test(`${s.slug} ${s.name}`)).map(s => s.env?.TAVILY_API_KEY || s.env?.tavily_api_key).find(Boolean) || '';
  return tavilyMcpKey ? [tavilyMcpKey] : [];
}

export function signalResearchConfiguration() {
  const keyCount = savedTavilyKeys().length || (tavilyMcpKey ? 1 : 0);
  const braveKeyCount = savedSearchKeys(BRAVE_KEY_NAMES, 'BRAVE_API_KEY').length;
  const exaKeyCount = savedSearchKeys(EXA_KEY_NAMES, 'EXA_API_KEY').length;
  return {
    brave: braveKeyCount > 0,
    braveKeyCount,
    exa: exaKeyCount > 0,
    exaKeyCount,
    tavily: keyCount > 0,
    tavilyKeyCount: keyCount,
    model: process.env.COMPANY_SIGNAL_RESEARCH_MODEL || null,
    persistence: Boolean(store),
    workerBusy: busy,
  };
}

async function configuredRunner(modelId) {
  const resolved = await resolveModelCredentials();
  const chosen = modelId || process.env.COMPANY_SIGNAL_RESEARCH_MODEL || await getSetting('active_model_id') || resolved.defaultModelId;
  const selected = resolved.models.find(m => m.id === chosen && m.available);
  if (!selected) throw new Error('No available research model in catalog');
  const prefix = selected.envPrefix.toLowerCase();
  const { runtime, model } = await signalModelRuntime({
    modelsPath: BUNDLED_MODELS,
    provider: selected.provider,
    model: selected.model,
    apiKey: secret(`${prefix}_api_key`),
    baseUrl: resolved.env[`${selected.envPrefix}_BASE_URL`],
  });
  return new PiSignalResearchRunner({ modelRuntime: runtime, model });
}

export async function ensureCompanySignalResearch({ log = () => {} } = {}) {
  store = new SignalResearchStore(getPool());
  await store.migrate();
  await resolveTavilyKeys();

  const rolePrompt = await readFile(path.join(ROOT, 'agent', 'roles', 'company-signal-research.md'), 'utf8');
  await seedSystemAgent({
    id: SIGNAL_RESEARCH_AGENT_ID,
    slug: SIGNAL_RESEARCH_AGENT_ID,
    name: 'Company Signal Research',
    short: 'CSR',
    headline: 'Market-moving news and stock price catalysts',
    description: 'Tracks market catalysts, earnings surprises, regulatory actions and long-term narrative trends for listed public companies.',
    color: 'blue',
    rolePrompt,
    toolProfile: 'assistant',
    thinkingLevel: 'low',
  });

  await mkdir(agentWorkspace({ id: SIGNAL_RESEARCH_AGENT_ID, slug: SIGNAL_RESEARCH_AGENT_ID }), { recursive: true });

  const payload = {
    name: 'Company Signal Research',
    slug: 'company-signal-research',
    command: process.execPath,
    args: [path.join(ROOT, 'server', 'company-signal-research', 'mcp-server.mjs')],
    description: 'Researches market-moving news, price catalysts and cumulative trend reports for listed companies.',
    config: { directTools: true, lifecycle: 'eager' },
  };

  const old = await getMcpServer(payload.slug);
  const mcp = old ? await updateMcpServer(old.id, payload) : await createMcpServer(payload);
  const agent = await getAgent(SIGNAL_RESEARCH_AGENT_ID);
  await updateAgent(agent.id, { skillIds: [], mcpIds: [mcp.id] });

  stopped = false;
  clearInterval(workerTimer);
  workerTimer = setInterval(() => { void tick(log); }, 2000);
  workerTimer.unref?.();

  log('info', 'company signal research agent, persistent database and worker queue ready');
  return signalResearchConfiguration();
}

async function tick(log) {
  if (busy || stopped || !store) return;
  busy = true;
  let job, scrapling, heartbeat;
  try {
    job = await store.claim();
    if (!job) return;
    activeJob = job;
    if (stopped) { await store.release(job.id, job.lease_token); return; }

    heartbeat = setInterval(() => { void store.heartbeat(job.id, job.lease_token).catch(() => {}); }, 45000);
    heartbeat.unref?.();
    activeHeartbeat = heartbeat;

    const tavilyKeys = await resolveTavilyKeys();
    const braveKeys = savedSearchKeys(BRAVE_KEY_NAMES, 'BRAVE_API_KEY');
    const exaKeys = savedSearchKeys(EXA_KEY_NAMES, 'EXA_API_KEY');
    if (!tavilyKeys.length && !braveKeys.length && !exaKeys.length) {
      throw new Error('Add a Brave, Exa or Tavily API key in Settings → Keys');
    }

    const runner = await configuredRunner(job.options?.modelId);
    activeRunner = runner;
    if (stopped) return;

    const server = await getMcpServer('scrapling');
    if (server) {
      try { scrapling = await connectScrapling(server); }
      catch { await store.event(job.id, { type: 'warning', message: 'Scrapling unavailable; falling back to search snippets' }, job.lease_token); }
    }

    // Retrieve historical reports for this company UID to layer over!
    const previousReports = await store.getHistory(job.company_uid, 5);

    const outcome = await researchCompanySignals({
      seed: job.seed,
      previousReports,
      tavilyKeys,
      braveKeys,
      exaKeys,
      scrapling,
      runner,
      emit: event => store.event(job.id, event, job.lease_token),
      saveEvidence: e => store.evidence(job.id, e, job.lease_token),
      saveRun: r => store.run(job.id, r, job.lease_token),
    });

    await store.finish(job.id, outcome, job.lease_token);
  } catch (error) {
    const message = String(error.message || 'Signal research failed').replace(/(?:sk-|tvly-)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 500);
    if (job) await store.fail(job.id, message, job.lease_token).catch(() => {});
    log('warn', `company signal research job ${job?.id || 'queue'} failed: ${message}`);
  } finally {
    clearInterval(heartbeat);
    activeJob = activeRunner = activeHeartbeat = undefined;
    await scrapling?.close().catch(() => {});
    busy = false;
  }
}

export async function stopCompanySignalResearch() {
  stopped = true;
  clearInterval(workerTimer);
  clearInterval(activeHeartbeat);
  if (activeJob) await store.release(activeJob.id, activeJob.lease_token).catch(() => {});
  await activeRunner?.abort().catch(() => {});
}

export async function signalResearchAction({ action, seed, id, company_uid, force, modelId, format = 'json', limit = 20, offset = 0, query = '', status = 'all' }, repository = store) {
  if (!repository) throw new Error('Signal research database is not initialized');

  if (action === 'start') {
    if (!seed) throw new Error('Seed is required for start action');
    if (!(await resolveTavilyKeys()).length && !savedSearchKeys(BRAVE_KEY_NAMES, 'BRAVE_API_KEY').length && !savedSearchKeys(EXA_KEY_NAMES, 'EXA_API_KEY').length) {
      throw new Error('Add a Brave, Exa or Tavily API key in Settings → Keys');
    }
    return repository.enqueue(SignalSeed.parse(seed), Boolean(force), { ...(modelId ? { modelId } : {}) });
  }

  if (action === 'status') return signalResearchConfiguration();

  if (action === 'history') {
    if (!company_uid) throw new Error('company_uid required');
    return repository.getHistory(company_uid, 10);
  }

  if (action === 'catalysts') {
    if (!company_uid) throw new Error('company_uid required');
    return repository.listCatalysts(company_uid, { limit: 50 });
  }

  if (action === 'companies') {
    return repository.listCompanies({ query, limit, offset });
  }

  if (action === 'company_reports') {
    if (!company_uid) throw new Error('company_uid required');
    return repository.getCompanyWithReports(company_uid);
  }

  if (action === 'list') {
    return repository.list({ query, status, limit, offset });
  }

  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error('Valid dossier id required');

  if (action === 'get') {
    const row = await repository.get(id);
    if (!row) throw new Error('Dossier not found');
    return row;
  }

  if (action === 'artifact') {
    const row = await repository.get(id);
    if (!row?.result) throw new Error('Dossier is not complete');
    return {
      format,
      content: renderSignalReport(row.result, format),
    };
  }

  throw new Error(`Unknown signal research action: ${action}`);
}

export async function handleCompanySignalResearch(req, res, url, { authorized, readBody, repository = store }) {
  if (url.pathname === '/reports/signal' || url.pathname === '/reports/signal/') {
    res.writeHead(302, { Location: '/signals' });
    res.end();
    return true;
  }

  if (url.pathname.startsWith('/reports/signal/')) {
    const id = url.pathname.slice('/reports/signal/'.length);
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Report not found');
      return true;
    }
    const row = await repository.get(id);
    if (!row?.result) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Report not ready or not found');
      return true;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(renderSignalReport(row.result, 'html'));
    return true;
  }

  const internal = url.pathname === '/api/internal/company-signal-research';
  const prefix = '/api/company-signal-research/dossiers';
  const statusRoute = url.pathname === '/api/company-signal-research/status';
  const historyMatch = url.pathname.match(/^\/api\/company-signal-research\/history\/([^/]+)$/);
  const catalystsMatch = url.pathname.match(/^\/api\/company-signal-research\/catalysts\/([^/]+)$/);
  const companiesRoute = url.pathname === '/api/company-signal-research/companies';
  const companyReportsMatch = url.pathname.match(/^\/api\/company-signal-research\/companies\/([^/]+)$/);

  if (!internal && !statusRoute && !historyMatch && !catalystsMatch && !companiesRoute && !companyReportsMatch && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    return false;
  }

  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' });
    res.end(JSON.stringify(body));
  };

  if (!(internal ? signalResearchAuthorized(req) : authorized(req))) {
    json(401, { error: 'Unauthorized' });
    return true;
  }

  if (!repository) {
    json(503, { error: 'Signal research database is not ready' });
    return true;
  }

  if (statusRoute) {
    json(req.method === 'GET' ? 200 : 405, req.method === 'GET' ? signalResearchConfiguration() : { error: 'GET required' });
    return true;
  }

  if (historyMatch) {
    if (req.method !== 'GET') { json(405, { error: 'GET required' }); return true; }
    try {
      json(200, await repository.getHistory(decodeURIComponent(historyMatch[1]), 10));
    } catch (e) { json(400, { error: e.message }); }
    return true;
  }

  if (catalystsMatch) {
    if (req.method !== 'GET') { json(405, { error: 'GET required' }); return true; }
    try {
      json(200, await repository.listCatalysts(decodeURIComponent(catalystsMatch[1]), { limit: 50 }));
    } catch (e) { json(400, { error: e.message }); }
    return true;
  }

  if (companiesRoute) {
    if (req.method !== 'GET') { json(405, { error: 'GET required' }); return true; }
    try {
      json(200, await repository.listCompanies({
        query: url.searchParams.get('q') || '',
        limit: Number(url.searchParams.get('limit') || 50),
        offset: Number(url.searchParams.get('offset') || 0),
      }));
    } catch (e) { json(400, { error: e.message }); }
    return true;
  }

  if (companyReportsMatch) {
    if (req.method !== 'GET') { json(405, { error: 'GET required' }); return true; }
    try {
      const data = await repository.getCompanyWithReports(decodeURIComponent(companyReportsMatch[1]));
      if (!data) { json(404, { error: 'Company not found' }); return true; }
      json(200, data);
    } catch (e) { json(400, { error: e.message }); }
    return true;
  }

  const action = input => signalResearchAction(input, repository);

  try {
    if (req.method === 'GET' && url.pathname === prefix) {
      json(200, await repository.list({
        query: url.searchParams.get('q') || '',
        status: url.searchParams.get('status') || 'all',
        limit: Number(url.searchParams.get('limit') || 20),
        offset: Number(url.searchParams.get('offset') || 0),
      }));
      return true;
    }

    if (internal) {
      if (req.method !== 'POST') { json(405, { error: 'POST required' }); return true; }
      const input = JSON.parse(await readBody(req) || '{}');
      json(200, { ok: true, result: await action(input) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === prefix) {
      const body = JSON.parse(await readBody(req) || '{}');
      json(202, await action({ action: 'start', seed: body.seed, force: body.options?.force, modelId: body.options?.modelId }));
      return true;
    }

    const match = url.pathname.slice(prefix.length).match(/^\/([0-9a-f-]{36})(?:\/(artifact|events))?$/i);
    if (!match) { json(404, { error: 'Unknown signal research route' }); return true; }
    const [, id, sub] = match;

    if (sub === 'events' && req.method === 'GET') {
      if (!await repository.get(id)) { json(404, { error: 'Dossier not found' }); return true; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'private, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let after = Number(req.headers['last-event-id'] || 0), polling = false;
      const poll = async () => {
        if (polling || res.destroyed || res.writableEnded) return;
        polling = true;
        try {
          const events = await repository.events(id, after);
          for (const e of events) {
            res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e.data)}\n\n`);
            after = Number(e.seq);
          }
          if (!events.length) res.write(': keepalive\n\n');
          const row = await repository.get(id);
          if (!['queued', 'running'].includes(row?.status) && events.length < 100) {
            clearInterval(timer);
            res.end();
          }
        } catch {
          clearInterval(timer);
          res.end();
        } finally {
          polling = false;
        }
      };
      const timer = setInterval(() => { void poll(); }, 2000);
      res.on('close', () => clearInterval(timer));
      await poll();
      return true;
    }

    if (sub === 'artifact' && req.method === 'GET') {
      const format = url.searchParams.get('format') || 'json';
      const out = await action({ action: 'artifact', id, format });
      res.writeHead(200, {
        'Content-Type': format === 'html' ? 'text/html; charset=utf-8' : format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json',
        'Cache-Control': 'private, no-store',
      });
      res.end(out.content);
      return true;
    }

    if (req.method === 'GET') {
      json(200, await action({ action: 'get', id }));
      return true;
    }

    json(405, { error: 'Method not allowed' });
  } catch (error) {
    json(400, { error: error.message });
  }
  return true;
}
