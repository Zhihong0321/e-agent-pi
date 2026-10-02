import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEvidenceTools, ResearchBudget } from './adapters.mjs';
import { createLimiter, settleBatch } from './concurrency.mjs';
import { evidenceRecord, fact, lockIdentity, reconcile } from './core.mjs';
import { PiResearchRunner, RESEARCH_TOOLS, researchContext } from './runner.mjs';
import { researchCompany } from './pipeline.mjs';

const sources = JSON.parse(await readFile(new URL('./sources.json', import.meta.url)));
const seed = { name: 'Acme Solar Sdn Bhd', website: 'https://acme.example/' };
const resolve = async () => [{ address: '1.1.1.1' }];
const ev = (id, url, text, tier = 2, mode = 'snippet') => evidenceRecord({ id, url, text, tier, mode, lane: 'test' });
const pause = () => new Promise(r => setTimeout(r, 10));

test('limiter caps concurrent work and releases capacity after errors', async () => {
  const limit = createLimiter(3);
  let active = 0, peak = 0, completed = 0;
  const out = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => limit(async () => {
    peak = Math.max(peak, ++active);
    try { await pause(); if (i === 4) throw Error('fixture failure'); completed++; }
    finally { active--; }
  })));
  assert.equal(peak, 3); assert.equal(active, 0); assert.equal(completed, 11);
  assert.equal(out.filter(r => r.status === 'rejected').length, 1);
});

test('batch waits for siblings before reporting a failure', async () => {
  let settled = false;
  await assert.rejects(settleBatch([Promise.reject(Error('fixture failure')), pause().then(() => { settled = true; })]));
  assert.equal(settled, true);
});

test('duplicate simultaneous searches reuse request, credits and persisted evidence', async () => {
  const evidence = [], budget = new ResearchBudget();
  let calls = 0, saved = 0;
  const tools = createEvidenceTools({ seed, evidence, sources, budget, tavilyKey: 'test-only', persist: async () => { saved++; }, fetchImpl: async () => {
    calls++; await pause();
    return { ok: true, status: 200, json: async () => ({ results: [{ url: seed.website, title: seed.name, content: 'Solar installation' }] }) };
  } });
  const [a, b] = await Promise.all([tools.search({ query: 'Acme Solar' }), tools.search({ query: 'Acme Solar' }, 'G2')]);
  assert.equal(calls, 1); assert.equal(saved, 1); assert.equal(evidence.length, 1);
  assert.equal(b.cached, true); assert.equal(b.credits, 0); assert.equal(a.results[0].evidence_id, b.results[0].evidence_id);
  await tools.search({ query: 'Acme Solar services' });
  assert.equal(calls, 2); assert.equal(evidence.length, 1); assert.equal(budget.used.credits, 2);
});

test('search network failures retry within the counted attempt budget', async () => {
  let calls = 0;
  const budget = new ResearchBudget({ searches: 2, credits: 2 });
  const tools = createEvidenceTools({ seed, evidence: [], sources, budget, tavilyKeys: ['one', 'two'], fetchImpl: async () => {
    if (++calls === 1) throw Error('socket failed');
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  } });
  assert.equal((await tools.search({ query: 'Acme' })).credits, 2);
  assert.equal(calls, 2); assert.equal(budget.used.searches, 2);
});

test('page requests overlap, deduplicate, and share one robots fetch per origin', async () => {
  let active = 0, peak = 0;
  const calls = [], evidence = [], budget = new ResearchBudget();
  const tools = createEvidenceTools({ seed, evidence, sources, budget, resolve, scrapling: { get: async url => {
    calls.push(url); peak = Math.max(peak, ++active); await pause(); active--;
    return { url, status: 200, text: url.endsWith('robots.txt') ? 'User-agent: *\nAllow: /' : seed.name + ' solar installations.' };
  } } });
  const urls = ['a', 'b', 'c', 'd'].map(p => seed.website + p);
  const [a, b] = await Promise.all([tools.fetch_pages({ urls: [...urls, urls[0]] }), tools.fetch_pages({ urls: [urls[0]] }, 'G2')]);
  assert.equal(a.results.every(r => !!r.evidence_id), true);
  assert.equal(b.results[0].evidence_id, a.results[0].evidence_id);
  assert.equal(calls.length, 5); assert.equal(evidence.length, 4); assert.equal(peak, 3);
  assert.equal(budget.used.fetches, 5);
});

test('authority snippets are qualified observations; original authority documents confirm', () => {
  const e = ev('E1', 'https://ssm.com.my/acme', 'Acme registration 202301029164 status live', 1);
  const claim = { field: 'ssm_no', value: '202301029164', evidence_id: 'E1', quote: e.text };
  assert.equal(fact([claim], [e]).status, 'unknown');
  assert.equal(fact([claim], [e]).reportedValue, claim.value);
  assert.equal(fact([claim], [{ ...e, mode: 'http' }]).status, 'confirmed');
  assert.equal(lockIdentity({ name: 'Sdn Bhd', website: seed.website }, [ev('E2', seed.website, 'Other entity')]).status, 'needs_review');
});

test('coverage does not treat missing metadata or unverified people as evaluated', () => {
  const input = { seed, identity: { status: 'locked' }, evidence: [], runs: [], startedAt: '2026-10-02' };
  const d = reconcile({ ...input, webState: 'active' }, new Date('2026-10-02'));
  assert.equal(d.scores.coverage, 0.05); assert.equal(d.scores.legitimacy, 5);
  const person = ev('P', 'https://directory.example/', 'Jane Tan is the Technical Officer');
  const out = reconcile({ ...input, evidence: [person], runs: [{ lane: 'G2', findings: { people: [{ name: 'Jane Tan', role: 'Technical Officer', contact: null, evidence_id: 'P', quote: person.text }] } }] }, new Date('2026-10-02'));
  assert.equal(out.people.length, 1); assert.equal(out.scores.coverage, 0);
});

test('phone agreement counts domains, with all first-party/social claims as one origin', () => {
  const urls = [seed.website + 'a', seed.website + 'b', 'https://linked.example/profile'];
  const evidence = urls.map((url, i) => ev(`E${i}`, url, 'Contact +601123456789 for Acme Solar', 3));
  const facts = evidence.map(e => ({ field: 'phone', value: '+601123456789', evidence_id: e.id, quote: e.text }));
  const d = reconcile({ seed, identity: { status: 'locked' }, evidence, runs: [{ lane: 'G2', findings: { facts } }], startedAt: '2026-10-02' });
  assert.equal(d.contacts.phones[0].sources.length, 3);
  assert.equal(d.contacts.phones[0].sourceDomains.length, 1);
});

test('focused context preserves a useful middle passage and prefers the original page', () => {
  const text = 'Header. ' + 'x'.repeat(3000) + 'Our director Jane Tan leads solar installation.' + 'y'.repeat(3000) + 'Footer.';
  const data = [ev('S', seed.website, 'Acme Solar truncated snippet'), ev('H', seed.website, text, 3, 'http')];
  const context = researchContext(data, 'G2');
  assert.equal(context[0].id, 'H'); assert.match(context[0].text, /Our director Jane Tan/);
  assert.ok(context[0].text.length <= 1000); assert.equal(context.length, 1);
});

test('a rejected submission salvages supported claims after the repair limit', async () => {
  const e = ev('E1', seed.website, 'Acme Solar supplies solar installation', 3);
  const good = { field: 'sells', value: 'solar installation', evidence_id: e.id, quote: e.text };
  const runner = new PiResearchRunner({ sessionFactory: async options => ({ session: {
    getActiveToolNames: () => RESEARCH_TOOLS, subscribe: () => () => {}, abort: async () => {}, dispose: () => {},
    prompt: async () => { const submit = options.customTools.find(t => t.name === 'submit_findings'); for (let i = 0; i < 3; i++) await submit.execute(String(i), { facts: [good, { ...good, value: 'invented service' }] }); },
  } }) });
  const out = await runner.run({ lane: 'G2', seed, identity: {}, evidence: [e], tools: {} });
  assert.equal(out.status, 'partial'); assert.equal(out.findings.facts.length, 1);
  assert.equal(out.findings.facts[0].value, good.value); assert.match(out.error, /quote_retries/);
});

test('identity searches and page retrieval overlap before the identity decision', async () => {
  let started = 0;
  let release;
  const gate = new Promise(r => { release = r; });
  const work = async () => { if (++started === 3) release(); await gate; };
  const out = await researchCompany({ seed, runner: {}, metadataLanes: {}, toolsFactory: () => ({ search: work, fetch_pages: work }) });
  assert.equal(started, 3); assert.equal(out.status, 'needs_review');
});

test('shutdown cancellation aborts the active research session and disposes it', async () => {
  let promptStarted, rejectPrompt, disposed = false;
  const ready = new Promise(r => { promptStarted = r; });
  const runner = new PiResearchRunner({ sessionFactory: async () => ({ session: {
    getActiveToolNames: () => RESEARCH_TOOLS, subscribe: () => () => {},
    prompt: async () => { promptStarted(); await new Promise((_resolve, reject) => { rejectPrompt = reject; }); },
    abort: async () => { rejectPrompt?.(Error('aborted for shutdown')); }, dispose: () => { disposed = true; },
  } }) });
  const pending = runner.run({ lane: 'G2', seed, identity: {}, evidence: [], tools: {} });
  await ready;
  await runner.abort();
  const result = await pending;
  assert.equal(result.status, 'failed'); assert.match(result.error, /shutdown/);
  assert.equal(disposed, true); assert.equal(runner.sessions.size, 0);
});
