import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { domain, evidenceRecord, sourceTier } from './core.mjs';
import { robotsAllowed, RESEARCH_USER_AGENT } from './robots.mjs';

const denied = new BlockList();
for (const [ip, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) denied.addSubnet(ip, n, 'ipv4');
// IPv6 is limited to global unicast; translated/private/reserved ranges fail closed.
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const denied6 = new BlockList(); denied6.addSubnet('2001::', 23, 'ipv6'); denied6.addSubnet('2002::', 16, 'ipv6'); denied6.addSubnet('2001:db8::', 32, 'ipv6');
export function publicIp(ip) {
  return isIP(ip) === 4 ? !denied.check(ip, 'ipv4') : isIP(ip) === 6 && global6.check(ip, 'ipv6') && !denied6.check(ip, 'ipv6');
}
export async function safeUrl(input, { blocked = [], resolve = lookup } = {}) {
  if (String(input).length > 2048) throw new Error('URL exceeds 2048 characters');
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (!isIP(host)) url.hostname = host;
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('URL scheme, credentials or port is blocked');
  if (host === 'localhost' || !host.includes('.') && !isIP(host) || /\.(localhost|local|internal|lan|railway\.internal)\.?$/.test(host)) throw new Error('Internal host is blocked');
  if (blocked.some(d => host === d || host.endsWith(`.${d}`))) throw new Error('Domain is snippets-only');
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
  if (!addresses.length || addresses.some(a => !publicIp(a.address))) throw new Error('Private or reserved IP is blocked');
  url.hash = '';
  return url.href;
}
export class ResearchBudget {
  constructor({ searches = 30, fetches = 40, credits = 40 } = {}) { this.limits = { searches, fetches, credits }; this.used = { searches: 0, fetches: 0, credits: 0 }; this.lanes = {}; }
  take(kind, cost = 1, lane = 'unknown') {
    if (this.used[kind] + 1 > this.limits[kind] || kind === 'searches' && this.used.credits + cost > this.limits.credits) throw new Error(`Dossier ${kind} budget exhausted`);
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
  if (!Number.isInteger(body.status) || !Array.isArray(body.content) || !body.content.every(c => typeof c === 'string') || typeof body.url !== 'string') throw new Error('Unsupported Scrapling response shape');
  return { url: body.url, status: body.status, text: body.content.join('\n') };
}
export function scraplingHttpGet(tools) {
  const tool = ['get', 'make_request'].map(name => tools.find(t => t.name === name)).find(t => t?.inputSchema?.properties?.follow_redirects);
  if (!tool) throw new Error('Scrapling HTTP GET must support follow_redirects=false');
  return tool.name;
}
export async function connectScrapling(server) {
  const client = new Client({ name: 'company-research', version: '2.0.0' });
  const transport = server.url
    ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.config?.headers || {} } })
    : new StdioClientTransport({ command: server.command, args: server.args || [], env: { PATH: process.env.PATH || '', HOME: process.env.HOME || process.env.USERPROFILE || '', ...server.env }, stderr: 'pipe' });
  try {
    await client.connect(transport, { timeout: 30000 });
    const tools = await client.listTools();
    const get = scraplingHttpGet(tools.tools);
    return {
      async get(url, extraction = 'markdown') {
        const result = await client.callTool({ name: get, arguments: { url, ...(get === 'make_request' ? { method: 'GET' } : {}), extraction_type: extraction, main_content_only: false, follow_redirects: false, retries: 0, timeout: 25, headers: { 'User-Agent': RESEARCH_USER_AGENT } } }, undefined, { timeout: 35000 });
        return parseScrapling(result);
      },
      close: () => client.close(),
    };
  } catch (error) { await client.close().catch(() => {}); throw error; }
}
export function createEvidenceTools({ seed, evidence, sources, budget, tavilyKey, tavilyKeys = [], scrapling, persist = async () => {}, fetchImpl = fetch, resolve = lookup }) {
  const keys = [...new Set([...tavilyKeys, tavilyKey].map(key => String(key || '').trim()).filter(Boolean))];
  let keyCursor = 0;
  const ownDomain = seed.website ? domain(seed.website) : null;
  const ownDomains = [ownDomain, ...(seed.related_websites || []).map(domain)].filter(Boolean);
  const allowed = new Set(evidence.map(e => e.url));
  const robotCache = new Map();
  let nextId = evidence.length + 1;
  const add = async (url, text, lane, mode) => {
    const e = evidenceRecord({ id: `E${nextId++}`, url, text, lane, mode, tier: sourceTier(url, ownDomains, sources) });
    await persist(e); evidence.push(e); allowed.add(e.url); return e;
  };
  return {
    record_metadata: (url, text, lane) => add(url, text, lane, 'metadata'),
    async search({ query, include_domains, depth = 'basic', topic = 'general', time_range }, lane = 'A') {
      if (!keys.length) throw new Error('Tavily key is unavailable: add a key in Settings → Keys');
      if (typeof query !== 'string' || !query.trim() || query.length > 400) throw new Error('Search query must be 1–400 characters');
      const cost = depth === 'advanced' ? 2 : 1;
      budget.take('searches', cost, lane);
      let attempts = 1;
      const body = { query, search_depth: depth, topic, max_results: 5, auto_parameters: false, include_answer: false, include_raw_content: false, include_usage: true };
      if (topic === 'general') body.country = 'malaysia';
      if (include_domains?.length) body.include_domains = include_domains.slice(0, 10);
      if (time_range) body.time_range = time_range;
      let response;
      const start = keyCursor++ % keys.length;
      const maxAttempts = keys.length === 1 ? 3 : keys.length;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt) { budget.take('searches', cost, lane); attempts++; } // Failed attempts count conservatively.
        const key = keys[(start + attempt) % keys.length];
        response = await fetchImpl('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
        const keyFailure = [401, 402, 403, 432, 433].includes(response.status);
        if (!keyFailure && response.status !== 429 && response.status < 500 || attempt === maxAttempts - 1 || (keyFailure && keys.length === 1)) break;
        if (keys.length > 1) { await response.body?.cancel(); continue; }
        const retry = response.headers.get('retry-after');
        const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 1000 * (attempt + 1);
        if (delay > 10000) throw new Error('Tavily rate limited; retry this dossier later');
        await response.body?.cancel();
        await new Promise(r => setTimeout(r, Math.max(500, delay || 1000)));
      }
      if (!response.ok) throw new Error(`Tavily search failed (HTTP ${response.status})`);
      const result = await response.json();
      const rows = [];
      for (const item of (result.results || []).slice(0, 5)) {
        try { const url = new URL(item.url); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue; const e = await add(url.href, `${item.title || ''}\n${item.content || ''}`, lane, 'snippet'); rows.push({ evidence_id: e.id, url: e.url, text: e.text.slice(0, 8000), tier: e.tier }); } catch (error) { if (!(error instanceof TypeError)) throw error; }
      }
      return { untrusted_data: true, results: rows, credits: attempts * cost };
    },
    async fetch_pages({ urls }, lane = 'C') {
      if (!Array.isArray(urls) || !urls.length || urls.length > 5) throw new Error('Fetch 1–5 URLs at a time');
      const results = [];
      for (const input of urls) {
        try {
          const url = await safeUrl(input, { blocked: sources.blocked, resolve });
          if (/\.(?:png|jpe?g|gif|webp|svg|ico|mp4|mp3|woff2?|zip|pdf)$/i.test(new URL(url).pathname)) throw new Error('Only text pages are supported by this evidence fetcher');
          if (!allowed.has(url) && !(ownDomain && domain(url) === ownDomain)) throw new Error('URL has no seed/search/link provenance');
          if (!scrapling) throw new Error('Scrapling MCP is unavailable on this host');
          const origin = new URL(url).origin;
          if (!robotCache.has(origin)) robotCache.set(origin, (async () => {
            const robotUrl = await safeUrl(`${origin}/robots.txt`, { blocked: sources.blocked, resolve });
            budget.take('fetches', 0, lane);
            const robots = await scrapling.get(robotUrl, 'text');
            if (robots.url !== robotUrl) throw new Error('robots.txt redirected; fetch policy cannot be established');
            if ([404, 410].includes(robots.status)) return '';
            if (robots.status !== 200) throw new Error('robots.txt policy is unavailable');
            return robots.text;
          })());
          if (!robotsAllowed(await robotCache.get(origin), url)) throw new Error('robots.txt disallows this page');
          budget.take('fetches', 0, lane);
          const page = await scrapling.get(url);
          // No redirects: even an older Scrapling server cannot silently follow
          // a public page to an internal network target or a forbidden social.
          if (page.status >= 300 || page.status < 200) throw new Error(`Page fetch HTTP ${page.status}; redirects are not followed`);
          const finalUrl = await safeUrl(page.url, { blocked: sources.blocked, resolve });
          if (finalUrl !== url) throw new Error('Scrapling followed a redirect despite the fetch policy');
          const e = await add(url, page.text, lane, 'http');
          for (const match of page.text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
            try { const linked = new URL(match[1], url); linked.hash = ''; if (linked.protocol === 'https:' || linked.protocol === 'http:') allowed.add(linked.href); } catch { /* malformed link */ }
          }
          results.push({ evidence_id: e.id, url, status: page.status, tier: e.tier, text: e.text.slice(0, 24000) });
        } catch (error) { results.push({ url: input, blocked: true, error: error.message }); }
      }
      return { untrusted_data: true, results };
    },
  };
}
