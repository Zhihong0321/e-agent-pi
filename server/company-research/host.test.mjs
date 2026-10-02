import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { handleCompanyResearch, tavilyKeyFromMcp, savedTavilyKeys } from './host.mjs';
import { ResearchStore } from './store.mjs';
import { RESEARCH_TOKEN } from './auth.mjs';
import { reconcile } from './core.mjs';
import { publicSettings, rememberSecret, secret } from '../secrets.mjs';

test('existing Tavily MCP credentials can be reused without treating proxy tokens as search keys', () => {
  assert.equal(tavilyKeyFromMcp({ env: { TAVILY_API_KEY: 'tvly-test-only' } }), 'tvly-test-only');
  assert.equal(tavilyKeyFromMcp({ url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-test-only' }), 'tvly-test-only');
  assert.equal(tavilyKeyFromMcp({ config: { headers: { Authorization: 'Bearer proxy-token' } } }), '');
});
test('saved Tavily slots are deduplicated and legacy/env keys remain supported', () => {
  const saved = { tavily_api_key_1: 'tvly-one', tavily_api_key_2: 'tvly-two', tavily_api_key: 'tvly-one' };
  assert.deepEqual(savedTavilyKeys(key => saved[key], { TAVILY_API_KEY: 'tvly-two' }), ['tvly-one', 'tvly-two']);
});
test('Tavily settings expose saved-slot flags and never return raw keys', async () => {
  const old = secret('tavily_api_key_5');
  try {
    await rememberSecret('tavily_api_key_5', 'tvly-test-only-private');
    const settings = publicSettings();
    assert.equal(settings.tavilyKeysSet.length, 5);
    assert.equal(settings.tavilyKeysSet[4], true); assert.equal(settings.tavilyApiKeySet, true);
    assert.equal(JSON.stringify(settings).includes('tvly-test-only-private'), false);
  } finally { await rememberSecret('tavily_api_key_5', old); }
});

test('private API, SSE, report publication, replay and chat MCP tools work end to end', async () => {
  const db = new PGlite();
  const repository = new ResearchStore({ query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(r => r.at(-1)) });
  await repository.migrate();
  const oldKey = process.env.TAVILY_API_KEY; process.env.TAVILY_API_KEY = 'test-only';
  const readBody = async req => { let body = ''; for await (const chunk of req) body += chunk; return body; };
  const server = createServer(async (req, res) => {
    try { if (!await handleCompanyResearch(req, res, new URL(req.url, 'http://localhost'), { repository, readBody, authorized: req => req.headers.authorization === 'Bearer owner-test' })) { res.writeHead(404); res.end(); } }
    catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({ name: 'test', version: '1' });
  let transport;
  try {
    const route = '/api/company-research/dossiers';
    const preview = await fetch(`${base}/reports/company/preview`);
    assert.equal(preview.status, 200); assert.match(await preview.text(), /no company has been researched/);
    assert.equal((await fetch(`${base}${route}`, { method: 'POST', body: '{}' })).status, 401);
    assert.equal((await fetch(`${base}/api/internal/company-research`, { method: 'POST', headers: { Authorization: 'Bearer owner-test' }, body: '{}' })).status, 401);
    transport = new StdioClientTransport({ command: process.execPath, args: ['server/company-research/mcp-server.mjs'], cwd: process.cwd(), env: { PATH: process.env.PATH, CLOUD_PI_RESEARCH_URL: base, CLOUD_PI_RESEARCH_TOKEN: RESEARCH_TOKEN }, stderr: 'pipe' });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['get_company_dossier', 'publish_company_report', 'replay_company_dossier', 'research_company', 'unpublish_company_report']);
    const started = await client.callTool({ name: 'research_company', arguments: { seed: { name: 'Acme Solar', website: 'https://example.com/' } } });
    const { id } = JSON.parse(started.content[0].text); assert.ok(id);
    assert.equal((await repository.get(id)).status, 'queued');
    assert.equal((await client.callTool({ name: 'get_company_dossier', arguments: { id, wait_seconds: 0 } })).isError, undefined);
    await repository.claim();
    const input = { seed: { name: 'Acme Solar' }, identity: { status: 'locked' }, evidence: [], runs: [], startedAt: '2026-10-02T00:00:00Z' };
    const result = reconcile(input, new Date('2026-10-02T00:01:00Z'));
    await repository.finish(id, { ...input, status: 'partial', result });
    const authed = { headers: { Authorization: 'Bearer owner-test' } };
    const artifact = await fetch(`${base}${route}/${id}/artifact?format=html`, authed);
    assert.equal(artifact.status, 200); assert.match(artifact.headers.get('cache-control'), /private/); assert.match(artifact.headers.get('content-security-policy'), /sandbox/);
    assert.match(await artifact.text(), /Acme Solar/);
    assert.equal((await fetch(`${base}${route}/${id}/publish`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/reports/company/${id}`)).status, 404);
    const published = await client.callTool({ name: 'publish_company_report', arguments: { id } });
    const publication = JSON.parse(published.content[0].text);
    assert.equal(publication.published, true);
    const publicReport = await fetch(`${base}${publication.url}`);
    assert.equal(publicReport.status, 200); assert.equal(publicReport.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.match(await publicReport.text(), /Company intelligence report/);
    assert.equal((await fetch(`${base}${route}/${id}`)).status, 401);
    const republished = await client.callTool({ name: 'publish_company_report', arguments: { id } });
    assert.equal(JSON.parse(republished.content[0].text).url, publication.url);
    await client.callTool({ name: 'unpublish_company_report', arguments: { id } });
    assert.equal((await fetch(`${base}${publication.url}`)).status, 404);
    await repository.finish(id, { ...input, status: 'needs_review', result });
    assert.equal((await client.callTool({ name: 'publish_company_report', arguments: { id } })).isError, true);
    await repository.finish(id, { ...input, status: 'partial', result });
    const events = await fetch(`${base}${route}/${id}/events`, authed); assert.match(await events.text(), /"status":"partial"/);
    const replay = await client.callTool({ name: 'replay_company_dossier', arguments: { id } });
    const data = JSON.parse(replay.content[0].text); assert.equal(data.creditsSpent, 0); assert.deepEqual(data.result.scores, result.scores);
    const malformed = await fetch(`${base}${route}`, { method: 'POST', headers: authed.headers, body: '{broken' }); assert.equal(malformed.status, 400);
  } finally {
    await client.close().catch(() => {}); await transport?.close().catch(() => {});
    await new Promise(resolve => server.close(resolve)); await db.close();
    if (oldKey === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = oldKey;
  }
});
