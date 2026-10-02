import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceTools, ResearchBudget } from './adapters.mjs';
import { savedSearchKeys } from './host.mjs';
import { BRAVE_KEY_NAMES, EXA_KEY_NAMES, rememberSecret, publicSettings, secret } from '../secrets.mjs';

const seed = { name: 'Acme Solar', website: 'https://acme.example' };
const sources = { tier1: [], tier2: [], blocked: [] };
const reply = (data, status = 200) => ({ ok: status === 200, status, json: async () => data, body: { cancel: async () => {} } });
const braveResult = { web: { results: [{ url: seed.website, title: seed.name, description: 'Solar energy', extra_snippets: ['Call +601121000099'] }] } };
const exaResult = { results: [{ url: seed.website, title: seed.name, highlights: ['Founder Example Person'], summary: 'DO NOT USE GENERATED SUMMARY' }], costDollars: { total: 0.006 } };
const setup = extra => {
  const evidence = [], budget = new ResearchBudget();
  return { evidence, budget, tools: createEvidenceTools({ seed, evidence, sources, budget, ...extra }) };
};

test('three-slot pools expose only flags and deduplicate saved keys', async () => {
  assert.equal(BRAVE_KEY_NAMES.length, 3); assert.equal(EXA_KEY_NAMES.length, 3);
  assert.deepEqual(savedSearchKeys(BRAVE_KEY_NAMES, 'BRAVE_API_KEY', () => ' same ', { BRAVE_API_KEY: 'same' }), ['same']);
  const old = secret('exa_api_key_3');
  try {
    await rememberSecret('exa_api_key_3', 'private-test-key');
    const settings = publicSettings();
    assert.equal(settings.braveKeysSet.length, 3); assert.equal(settings.exaKeysSet[2], true);
    assert.equal(JSON.stringify(settings).includes('private-test-key'), false);
  } finally { await rememberSecret('exa_api_key_3', old); }
});

test('Brave discovery rotates keys, preserves extra snippets and caches duplicate requests', async () => {
  const calls = [];
  const { tools, evidence, budget } = setup({ braveKeys: ['first', 'second'], fetchImpl: async (url, options) => {
    calls.push({ url: String(url), key: options.headers['X-Subscription-Token'] });
    return calls.length === 1 ? reply({}, 429) : reply(braveResult);
  } });
  const [a, b] = await Promise.all([tools.search({ query: seed.name, time_range: 'month', include_domains: ['acme.example'] }), tools.search({ query: seed.name, time_range: 'month', include_domains: ['acme.example'] })]);
  assert.deepEqual(calls.map(c => c.key), ['first', 'second']);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('country'), 'MY'); assert.equal(url.searchParams.get('freshness'), 'pm');
  assert.match(url.searchParams.get('q'), /site:acme.example/);
  assert.equal(a.provider, 'brave'); assert.equal(b.cached, true);
  assert.match(evidence[0].text, /Call/); assert.equal(evidence[0].provider, 'brave'); assert.equal(evidence[0].mode, 'snippet');
  assert.equal(budget.used.searches, 2); assert.equal(budget.used.credits, 0); assert.equal(budget.providers.brave.failures, 1);
});

test('Exa targeted search requests highlights only and counts dollars separately from Tavily credits', async () => {
  let body;
  const { tools, evidence, budget } = setup({ braveKeys: ['brave'], exaKeys: ['exa'], fetchImpl: async (url, options) => {
    assert.equal(String(url), 'https://api.exa.ai/search'); assert.equal(options.headers['x-api-key'], 'exa');
    body = JSON.parse(options.body); return reply(exaResult);
  } });
  const out = await tools.search({ query: 'Acme Solar leadership', include_domains: ['acme.example'], time_range: 'year' }, 'G2');
  assert.equal(out.provider, 'exa'); assert.equal(body.type, 'fast'); assert.deepEqual(body.contents, { highlights: true });
  assert.deepEqual(body.includeDomains, ['acme.example']); assert.ok(body.startPublishedDate); assert.equal(body.category, undefined);
  assert.equal(evidence[0].text.includes('GENERATED SUMMARY'), false); assert.equal(budget.providers.exa.estimatedUsd, 0.006);
  assert.equal(budget.used.credits, 0);
});

test('provider outage and empty searches fall back; provider keys never appear in returned errors', async () => {
  const calls = [];
  const { tools } = setup({ braveKeys: ['private-brave'], exaKeys: ['private-exa'], tavilyKey: 'private-tavily', fetchImpl: async (url) => {
    calls.push(String(url));
    if (String(url).includes('exa.ai')) throw new Error('private-exa');
    if (String(url).includes('brave.com')) return reply({ web: { results: [] } });
    return reply({ results: [{ url: seed.website, title: seed.name, content: 'Solar' }] });
  } });
  const out = await tools.search({ query: 'Acme founders' }, 'G2');
  assert.equal(out.provider, 'tavily'); assert.equal(calls.length, 3); assert.equal(JSON.stringify(out).includes('private-'), false);
});

test('provider fallback respects the shared attempt limit', async () => {
  const budget = new ResearchBudget({ searches: 1 }); let calls = 0;
  const tools = createEvidenceTools({ seed, evidence: [], sources, budget, braveKeys: ['one', 'two'], tavilyKey: 'tavily', fetchImpl: async () => { calls++; return reply({}, 401); } });
  await assert.rejects(tools.search({ query: seed.name }), /budget exhausted/); assert.equal(calls, 1);
});

test('unsafe source URLs and invalid domain filters are rejected', async () => {
  const { tools, evidence } = setup({ exaKeys: ['exa'], fetchImpl: async () => reply({ results: [{ url: 'javascript:alert(1)', title: 'x' }, { url: 'https://key:secret@acme.example', title: 'x' }] }) });
  assert.equal((await tools.search({ query: seed.name })).results.length, 0); assert.equal(evidence.length, 0);
  await assert.rejects(tools.search({ query: seed.name, include_domains: ['acme.example OR anything'] }), /hostnames/);
});
