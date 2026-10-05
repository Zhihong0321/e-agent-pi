import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { handleCompanySignalResearch, savedTavilyKeys } from './host.mjs';
import { SignalResearchStore } from './store.mjs';
import { SIGNAL_RESEARCH_TOKEN } from './auth.mjs';

test('saved Tavily keys resolve properly for signal research', () => {
  const keys = savedTavilyKeys(() => '', { TAVILY_API_KEY: 'tvly-test' });
  assert.deepEqual(keys, ['tvly-test']);
});

test('SignalResearchStore handles entities, queued dossiers, and stacked reports', async () => {
  const db = new PGlite();
  const store = new SignalResearchStore({
    query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(r => r.at(-1)),
  });
  await store.migrate();

  const seed = {
    company_uid: 'AAPL.NASDAQ',
    ticker: 'AAPL',
    exchange: 'NASDAQ',
    name: 'Apple Inc.',
    sector: 'Technology',
  };

  // 1. Enqueue report 1
  const q1 = await store.enqueue(seed, false);
  assert.equal(q1.status, 'queued');
  assert.equal(q1.sequence, 1);

  // 2. Claim job 1
  const claimed1 = await store.claim();
  assert.equal(claimed1.id, q1.id);
  assert.equal(claimed1.sequence, 1);

  // 3. Finish job 1
  await store.finish(claimed1.id, {
    status: 'complete',
    seed,
    result: {
      sequence: 1,
      thesis: { bias: 'bullish', conviction: 0.8, summary: 'Q3 iPhone revenue grew.' },
      signals: [
        {
          category: 'earnings',
          impact: 'bullish',
          event_date: '2026-08-01',
          headline: 'Q3 iPhone revenue hits record',
          summary: 'iPhone sales beat expectations.',
          quote: 'iPhone revenue reached $39.3 billion',
        },
      ],
    },
  }, claimed1.lease_token);

  const d1 = await store.get(q1.id);
  assert.equal(d1.status, 'complete');
  assert.equal(d1.name, 'Apple Inc.');

  // 4. Enqueue report 2 (should have sequence 2!)
  const q2 = await store.enqueue(seed, true);
  assert.equal(q2.sequence, 2);

  // 5. Check history retrieval
  const history = await store.getHistory('AAPL.NASDAQ');
  assert.equal(history.length, 1);
  assert.equal(history[0].sequence, 1);

  // 6. Check catalysts retrieval
  const catalysts = await store.listCatalysts('AAPL.NASDAQ');
  assert.equal(catalysts.length, 1);
  assert.equal(catalysts[0].headline, 'Q3 iPhone revenue hits record');
});

test('company-signal-research HTTP API and MCP server work end-to-end', async () => {
  const db = new PGlite();
  const repository = new SignalResearchStore({
    query: (sql, params) => params ? db.query(sql, params) : db.exec(sql).then(r => r.at(-1)),
  });
  await repository.migrate();
  const oldKey = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'test-only';

  const readBody = async req => {
    let body = '';
    for await (const chunk of req) body += chunk;
    return body;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const handled = await handleCompanySignalResearch(req, res, url, {
        repository,
        readBody,
        authorized: r => r.headers.authorization === 'Bearer owner-test',
      });
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const client = new Client({ name: 'test-client', version: '1.0' });
  let transport;

  try {
    const listRes = await fetch(`${base}/api/company-signal-research/dossiers`, {
      headers: { Authorization: 'Bearer owner-test' },
    });
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.total, 0);

    // Connect MCP Server
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['server/company-signal-research/mcp-server.mjs'],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        CLOUD_PI_SIGNAL_RESEARCH_URL: base,
        CLOUD_PI_SIGNAL_RESEARCH_TOKEN: SIGNAL_RESEARCH_TOKEN,
      },
      stderr: 'pipe',
    });

    await client.connect(transport);
    const tools = await client.listTools();
    const toolNames = tools.tools.map(t => t.name).sort();
    assert.deepEqual(toolNames, [
      'get_company_signal_dossier',
      'get_company_trend_history',
      'list_company_catalysts',
      'research_company_signals',
    ]);

    // Call research_company_signals tool
    const seed = {
      company_uid: 'TSLA.NASDAQ',
      ticker: 'TSLA',
      exchange: 'NASDAQ',
      name: 'Tesla, Inc.',
      sector: 'Automotive',
    };

    const callResult = await client.callTool({
      name: 'research_company_signals',
      arguments: { seed },
    });
    const parsed = JSON.parse(callResult.content[0].text);
    assert.ok(parsed.id);
    assert.equal(parsed.status, 'queued');
    assert.equal(parsed.sequence, 1);

    // Call get_company_signal_dossier tool
    const getResult = await client.callTool({
      name: 'get_company_signal_dossier',
      arguments: { id: parsed.id, wait_seconds: 0 },
    });
    const dossierData = JSON.parse(getResult.content[0].text);
    assert.equal(dossierData.id, parsed.id);
    assert.equal(dossierData.status, 'queued');

    // Call get_company_trend_history tool
    const historyResult = await client.callTool({
      name: 'get_company_trend_history',
      arguments: { company_uid: 'TSLA.NASDAQ' },
    });
    const historyData = JSON.parse(historyResult.content[0].text);
    assert.deepEqual(historyData, []);

    // Test GET /api/company-signal-research/companies
    const companiesRes = await fetch(`${base}/api/company-signal-research/companies`, {
      headers: { Authorization: 'Bearer owner-test' },
    });
    assert.equal(companiesRes.status, 200);
    const companiesData = await companiesRes.json();
    assert.ok(Array.isArray(companiesData));
    assert.equal(companiesData.length, 1);
    assert.equal(companiesData[0].uid, 'TSLA.NASDAQ');
    assert.equal(companiesData[0].report_count, 1);

    // Test GET /api/company-signal-research/companies/TSLA.NASDAQ
    const companyDetailRes = await fetch(`${base}/api/company-signal-research/companies/TSLA.NASDAQ`, {
      headers: { Authorization: 'Bearer owner-test' },
    });
    assert.equal(companyDetailRes.status, 200);
    const companyDetailData = await companyDetailRes.json();
    assert.equal(companyDetailData.entity.uid, 'TSLA.NASDAQ');
    assert.equal(companyDetailData.reports.length, 1);
    assert.equal(companyDetailData.reports[0].id, parsed.id);

    // Test GET /reports/signal redirects to /signals
    const redirectRes = await fetch(`${base}/reports/signal`, { redirect: 'manual' });
    assert.equal(redirectRes.status, 302);
    assert.equal(redirectRes.headers.get('location'), '/signals');
  } finally {
    process.env.TAVILY_API_KEY = oldKey;
    await client.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
  }
});
