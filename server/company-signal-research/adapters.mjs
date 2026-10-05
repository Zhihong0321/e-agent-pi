import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { evidenceRecord, sourceTier, domain } from './core.mjs';
import { robotsAllowed, SIGNAL_RESEARCH_USER_AGENT } from './robots.mjs';
import { createLimiter } from './concurrency.mjs';
import { createSignalSearchRouter } from './search-providers.mjs';
import { recordApiUsage } from '../usage.mjs';

const denied = new BlockList();
for (const [ip, n] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4]
]) denied.addSubnet(ip, n, 'ipv4');

const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new BlockList(); denied6.addSubnet('2001::', 23, 'ipv6'); denied6.addSubnet('2002::', 16, 'ipv6'); denied6.addSubnet('2001:db8::', 32, 'ipv6');

export function publicIp(ip) {
  return isIP(ip) === 4
    ? !denied.check(ip, 'ipv4')
    : isIP(ip) === 6 && global6.check(ip, 'ipv6') && !denied6.check(ip, 'ipv6');
}

export async function safeUrl(input, { blocked = [], resolve = lookup } = {}) {
  if (String(input).length > 2048) throw new Error('URL exceeds 2048 characters');
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (!isIP(host)) url.hostname = host;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) {
    throw new Error('URL scheme, credentials or port is blocked');
  }
  if (host === 'localhost' || (!host.includes('.') && !isIP(host)) || /\.(localhost|local|internal|lan|railway\.internal)\.?$/.test(host)) {
    throw new Error('Internal host is blocked');
  }
  if (blocked.some(d => host === d || host.endsWith(`.${d}`))) throw new Error('Domain is blocked from direct fetch');
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
  if (!addresses.length || addresses.some(a => !publicIp(a.address))) throw new Error('Private or reserved IP is blocked');
  url.hash = '';
  return url.href;
}

export class SignalBudget {
  constructor({ searches = 30, fetches = 30, credits = 40 } = {}) {
    this.limits = { searches, fetches, credits };
    this.used = { searches: 0, fetches: 0, credits: 0 };
    this.lanes = {};
  }
  take(kind, cost = 1, lane = 'unknown') {
    if (this.used[kind] + 1 > this.limits[kind] || (kind === 'searches' && this.used.credits + cost > this.limits.credits)) {
      throw new Error(`Signal research ${kind} budget exhausted`);
    }
    this.used[kind]++;
    if (kind === 'searches') this.used.credits += cost;
    this.lanes[lane] ||= { searches: 0, fetches: 0, credits: 0 };
    this.lanes[lane][kind]++;
    if (kind === 'searches') this.lanes[lane].credits += cost;
  }
}

export function parseScrapling(result) {
  if (result.isError) throw new Error('Scrapling returned a fetch error');
  let body = result.structuredContent;
  if (!body) {
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
    try { body = JSON.parse(text); } catch { throw new Error('Scrapling response is not structured page data'); }
  }
  if (!Number.isInteger(body.status) || !Array.isArray(body.content) || typeof body.url !== 'string') {
    throw new Error('Unsupported Scrapling response shape');
  }
  return { url: body.url, status: body.status, text: body.content.join('\n') };
}

export async function connectScrapling(server) {
  const client = new Client({ name: 'company-signal-research', version: '1.0.0' });
  const transport = server.url
    ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.config?.headers || {} } })
    : new StdioClientTransport({ command: server.command, args: server.args || [], env: { PATH: process.env.PATH || '', ...server.env }, stderr: 'pipe' });
  try {
    await client.connect(transport, { timeout: 30000 });
    const tools = await client.listTools();
    const tool = ['get', 'make_request'].map(name => tools.tools.find(t => t.name === name)).find(Boolean);
    if (!tool) throw new Error('Scrapling fetch tool not found');
    return {
      async get(url, extraction = 'markdown') {
        const result = await client.callTool({
          name: tool.name,
          arguments: {
            url,
            ...(tool.name === 'make_request' ? { method: 'GET' } : {}),
            extraction_type: extraction,
            main_content_only: false,
            follow_redirects: false,
            retries: 0,
            timeout: 25,
            headers: { 'User-Agent': SIGNAL_RESEARCH_USER_AGENT }
          }
        }, undefined, { timeout: 35000 });
        return parseScrapling(result);
      },
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export function createSignalEvidenceTools({
  seed,
  evidence,
  budget,
  tavilyKey,
  tavilyKeys = [],
  braveKeys = [],
  exaKeys = [],
  scrapling,
  persist = async () => {},
  fetchImpl = fetch,
  resolve = lookup,
}) {
  const keys = [...new Set([...tavilyKeys, tavilyKey].map(k => String(k || '').trim()).filter(Boolean))];
  let keyCursor = 0;
  const allowed = new Set(evidence.map(e => e.url));
  const robotCache = new Map();
  const searchCache = new Map(), pageCache = new Map(), evidenceCache = new Map();
  const searchLimit = createLimiter(3), fetchLimit = createLimiter(3);
  let nextId = evidence.length + 1;

  const add = async (url, text, lane, mode, provenance = {}) => {
    const e = evidenceRecord({ id: `S${nextId++}`, url, text, lane, mode, tier: sourceTier(url) });
    Object.assign(e, provenance);
    const key = `${e.url}\n${e.mode}\n${e.hash}`;
    if (evidenceCache.has(key)) return evidenceCache.get(key);
    const saved = (async () => {
      await persist(e);
      evidence.push(e);
      allowed.add(e.url);
      return e;
    })();
    evidenceCache.set(key, saved);
    try { return await saved; } catch (err) { evidenceCache.delete(key); throw err; }
  };

  const tools = {
    async search({ query, include_domains, depth = 'basic', topic = 'news', time_range = 'month' }, lane = 'A') {
      if (!keys.length) throw new Error('Tavily key unavailable in Settings → Keys');
      if (typeof query !== 'string' || !query.trim() || query.length > 400) {
        throw new Error('Search query must be 1–400 characters');
      }
      const cost = depth === 'advanced' ? 2 : 1;
      budget.take('searches', cost, lane);
      budget.providers ||= {};
      budget.providers.tavily ||= { requests: 0 };
      budget.providers.tavily.requests++;

      const key = keys[keyCursor++ % keys.length];
      const body = {
        query,
        search_depth: depth,
        topic: topic || 'news',
        max_results: 5,
        include_raw_content: false,
        include_usage: true,
      };
      if (include_domains?.length) body.include_domains = include_domains.slice(0, 10);
      if (time_range) body.time_range = time_range;

      const started = Date.now();
      const response = await fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        void recordApiUsage({ service: 'tavily', provider: 'tavily', operation: 'search', status: 'error', durationMs: Date.now() - started, metadata: { lane, httpStatus: response.status } });
        throw new Error(`Tavily search failed (HTTP ${response.status})`);
      }

      const result = await response.json();
      void recordApiUsage({ service: 'tavily', provider: 'tavily', operation: 'search', status: 'ok', durationMs: Date.now() - started, credits: cost, metadata: { lane } });

      const rows = [];
      for (const item of (result.results || []).slice(0, 5)) {
        try {
          const url = new URL(item.url);
          if (!['http:', 'https:'].includes(url.protocol)) continue;
          url.hash = '';
          const text = `${item.title || ''}\n${item.content || ''}`;
          const e = await add(url.href, text, lane, 'snippet', { publishedAt: item.published_date || null });
          rows.push({ evidence_id: e.id, url: e.url, text: e.text.slice(0, 8000), tier: e.tier });
        } catch { /* malformed url */ }
      }
      return { untrusted_data: true, results: rows, credits: cost };
    },

    async fetch_pages({ urls }, lane = 'F') {
      if (!Array.isArray(urls) || !urls.length || urls.length > 5) throw new Error('Fetch 1–5 URLs at a time');
      const results = await Promise.all(urls.map(async input => {
        let cacheKey;
        try { const u = new URL(input); u.hash = ''; cacheKey = u.href; } catch { cacheKey = String(input); }
        if (pageCache.has(cacheKey)) return { ...await pageCache.get(cacheKey), cached: true };

        const work = (async () => {
          try {
            const url = await safeUrl(input, { resolve });
            if (!scrapling) throw new Error('Scrapling MCP is unavailable on this host');
            const origin = new URL(url).origin;
            if (!robotCache.has(origin)) {
              robotCache.set(origin, (async () => {
                const robotUrl = await safeUrl(`${origin}/robots.txt`, { resolve });
                budget.take('fetches', 0, lane);
                const robots = await fetchLimit(() => scrapling.get(robotUrl, 'text'));
                return robots.status === 200 ? robots.text : '';
              })());
            }
            if (!robotsAllowed(await robotCache.get(origin), url)) throw new Error('robots.txt disallows this page');
            budget.take('fetches', 0, lane);
            const page = await fetchLimit(() => scrapling.get(url));
            if (page.status >= 300 || page.status < 200) throw new Error(`HTTP ${page.status}`);
            const e = await add(url, page.text, lane, 'http');
            return { evidence_id: e.id, url, status: page.status, tier: e.tier, text: e.text.slice(0, 24000) };
          } catch (error) {
            return { url: input, blocked: true, error: error.message };
          }
        })();

        pageCache.set(cacheKey, work);
        return work;
      }));
      return { untrusted_data: true, results };
    },
  };

  const routerSearch = createSignalSearchRouter({
    braveKeys,
    exaKeys,
    tavilyAvailable: keys.length > 0,
    tavilySearch: tools.search,
    budget,
    fetchImpl,
    add,
  });

  tools.search = async (input, lane = 'A') => {
    const key = JSON.stringify({ q: input.query?.trim(), t: input.time_range, d: input.depth });
    if (searchCache.has(key)) return { ...await searchCache.get(key), credits: 0, cached: true };
    const req = searchLimit(() => routerSearch(input, lane));
    searchCache.set(key, req);
    try { return await req; } catch (err) { searchCache.delete(key); throw err; }
  };

  return tools;
}
