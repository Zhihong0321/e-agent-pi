import { readFile } from 'node:fs/promises';
import { Seed, VERSION, lockIdentity, reconcile, domain, contactFindings } from './core.mjs';
import { ResearchBudget, createEvidenceTools } from './adapters.mjs';
import { TASKS } from './runner.mjs';
import { createMetadataLanes } from './metadata.mjs';
import { settleBatch } from './concurrency.mjs';

const SOURCES = JSON.parse(await readFile(new URL('./sources.json', import.meta.url), 'utf8'));
export async function researchCompany({ seed: input, tavilyKey, tavilyKeys, braveKeys, exaKeys, scrapling, runner, emit = async () => {}, saveEvidence = async () => {}, saveRun = async () => {}, budget = new ResearchBudget(), toolsFactory = createEvidenceTools, now = () => new Date(), metadataLanes }) {
  const seed = Seed.parse(input), startedAt = now().toISOString();
  const evidence = [], runs = [];
  const tools = toolsFactory({ seed, evidence, sources: SOURCES, budget, tavilyKey, tavilyKeys, braveKeys, exaKeys, scrapling, persist: saveEvidence });
  const web = { domain: {}, archive: {} };
  const lane = async (id, work) => {
    const start = Date.now(); await emit({ type: 'lane', lane: id, status: 'running' });
    let row;
    try {
      const result = await work();
      const blocked = result?.results?.filter(r => r.blocked).length || 0;
      row = { lane: id, status: result?.skipped ? 'skipped' : blocked ? 'partial' : 'ok', ms: Date.now() - start, credits: budget.lanes[id]?.credits || 0, result,
        ...(result?.skipped ? { error: result.skipped } : blocked ? { error: `${blocked} pages could not be fetched; available evidence retained` } : {}) };
    } catch (error) { row = { lane: id, status: 'failed', ms: Date.now() - start, credits: budget.lanes[id]?.credits || 0, error: error.message }; }
    runs.push(row); await saveRun(row); await emit({ type: 'lane', lane: id, status: row.status }); return row;
  };
  await emit({ type: 'wave', wave: 0, status: 'identity' });
  await lane('identity', async () => {
    const [first, second] = await settleBatch([
      tools.search({ query: `"${seed.name}" ${seed.phone || seed.postcode || seed.address || 'Malaysia'}` }, 'identity'),
      tools.search({ query: `"${seed.name}" ${seed.website ? domain(seed.website) : 'SSM Malaysia contact address'}` }, 'identity'),
      ...(seed.website ? [tools.fetch_pages({ urls: [seed.website] }, 'identity')] : []),
    ]);
    return { first, second };
  });
  const identity = lockIdentity(seed, evidence);
  await emit({ type: 'identity', status: identity.status, confidence: identity.confidence, anchors: identity.anchorsMatched });
  if (identity.status !== 'locked') {
    const result = reconcile({ seed, identity, evidence, runs, startedAt }, now());
    result.unknowns.push('Identity needs review: provide a corroborating website, phone or full address.');
    result.meta.credits = { total: budget.used.credits };
    result.meta.searchProviders = budget.providers || {};
    return { status: 'needs_review', result, seed, identity, evidence, runs, startedAt, webState: 'unknown' };
  }
  await emit({ type: 'wave', wave: 1, status: 'evidence' });
  const optional = metadataLanes || createMetadataLanes({ seed });
  await Promise.allSettled([
    lane('A', async () => {
      await settleBatch(['registration SSM directors', 'services projects clients', 'jobs expansion news'].map(suffix => tools.search({ query: `"${seed.name}" ${suffix} Malaysia` }, 'A')));
    }),
    lane('F', async () => { await settleBatch(['facebook.com', 'linkedin.com'].map(d => tools.search({ query: `"${seed.name}" Malaysia`, include_domains: [d] }, 'F'))); }),
    lane('C', async () => {
      if (!seed.website) throw new Error('No verified company website supplied');
      const home = evidence.find(e => e.mode === 'http' && domain(e.url) === domain(seed.website));
      if (!home) await tools.fetch_pages({ urls: [seed.website] }, 'C');
      const pages = evidence.filter(e => e.mode === 'http' && domain(e.url) === domain(seed.website));
      if (!pages.length) throw new Error('Company homepage could not be fetched');
      const links = new Set();
      for (const e of pages) for (const m of e.text.matchAll(/\[([^\]]*)\]\(([^\s)]+)\)/g)) {
        try { const url = new URL(m[2], e.url); if (domain(url.href) === domain(seed.website) && /contact|about|team|service|project|portfolio/i.test(m[1] + url.pathname)) links.add(url.href); } catch { /* malformed link */ }
      }
      const urls = [...links].filter(url => !pages.some(e => e.url === url)).slice(0, 10);
      const results = [];
      for (let i = 0; i < urls.length; i += 5) results.push(...(await tools.fetch_pages({ urls: urls.slice(i, i + 5) }, 'C')).results);
      return { results };
    }),
    ...Object.entries(optional).map(([id, work]) => lane(id, async () => {
    const out = await work();
    if (out.web?.domain) Object.assign(web.domain, out.web.domain);
    if (out.web?.archive) Object.assign(web.archive, out.web.archive);
    if (out.web?.psi) web.psi = out.web.psi;
    if (out.url && out.text) await tools.record_metadata(out.url, out.text, id);
    for (const item of out.evidence || []) await tools.record_metadata(item.url, item.text, id);
    return out;
    })),
  ]);
  // Fetch a few independent originals rather than asking the model to infer
  // registry, leadership and risk facts from shortened search snippets alone.
  if (scrapling) await lane('I', async () => {
    const seen = new Set();
    const originals = evidence.filter(e => e.mode === 'snippet' && e.tier < 3)
      .sort((a, b) => a.tier - b.tier || Number(/registration|ssm|award|court|director/i.test(b.url + b.text)) - Number(/registration|ssm|award|court|director/i.test(a.url + a.text)))
      .filter(e => { const d = domain(e.url); if (!d || seen.has(d)) return false; seen.add(d); return true; }).slice(0, 3);
    if (!originals.length) return { skipped: 'No independent original pages discovered' };
    const out = await tools.fetch_pages({ urls: originals.map(e => e.url) }, 'I');
    if (out.results.every(r => r.blocked)) throw new Error('Independent originals could not be fetched; snippet evidence retained');
    return out;
  });
  await emit({ type: 'wave', wave: 1, status: 'agents' });
  const runAgent = async (id, gaps = []) => {
    const creditsBefore = budget.lanes[id]?.credits || 0;
    await emit({ type: 'agent', lane: id, status: 'running', gapFill: gaps.length > 0 });
    let row;
    try { row = await runner.run({ lane: id, seed, identity, evidence, tools, gaps }); }
    catch (error) { row = { lane: id, status: 'failed', error: error.message, findings: null }; }
    if (gaps.length) row = { ...row, lane: `${id}-gap` };
    row.credits = (budget.lanes[id]?.credits || 0) - creditsBefore;
    runs.push(row); await saveRun(row); await emit({ type: 'agent', lane: row.lane, status: row.status });
  };
  await Promise.allSettled(Object.keys(TASKS).map(id => runAgent(id)));
  const webState = evidence.some(e => e.mode === 'http' && domain(e.url) === (seed.website ? domain(seed.website) : null) && e.text.length >= 300) ? 'active' : 'unknown';
  let result = reconcile({ seed, identity, evidence, runs, startedAt, webState, web }, now());
  const gaps = [];
  if (!result.identity.ssmNo.value) gaps.push(['G1', 'ssm_no']);
  if (!result.identity.status.value) gaps.push(['G1', 'status']);
  if (!result.people.some(p => p.value)) gaps.push(['G2', 'people']);
  if (!result.scale.headcount.value) gaps.push(['G3', 'headcount']);
  if (gaps.length && budget.used.searches < budget.limits.searches && budget.used.credits < budget.limits.credits) {
    await emit({ type: 'wave', wave: 2, status: 'gap_fill' });
    const sessions = [...new Set(gaps.map(g => g[0]))];
    await Promise.allSettled(sessions.map(id => runAgent(id, gaps.filter(g => g[0] === id).map(g => g[1]))));
    result = reconcile({ seed, identity, evidence, runs, startedAt, webState, web }, now());
  }
  const contacts = { lane: 'contacts', status: 'ok', findings: contactFindings(seed, evidence), ms: 0, credits: 0 };
  runs.push(contacts); await saveRun(contacts);
  result = reconcile({ seed, identity, evidence, runs, startedAt, webState, web }, now());
  result.meta.credits = { total: budget.used.credits };
  result.meta.searchProviders = budget.providers || {};
  result.meta.budgets = { ...budget.used };
  result.meta.version = VERSION;
  const acceptedAgents = runs.filter(r => /^G[1-4]$/.test(r.lane) && r.status === 'ok');
  const status = acceptedAgents.length === 4 && !runs.some(r => ['failed', 'partial'].includes(r.status)) ? 'complete' : 'partial';
  await emit({ type: 'wave', wave: 3, status: 'reconciled', verdict: result.scores.verdict });
  return { status, result, seed, identity, evidence, runs, startedAt, webState, web };
}
