import { recordApiUsage } from '../usage.mjs';

const unique = values => [...new Set(values.map(v => String(v || '').trim()).filter(Boolean))];

export function createSignalSearchRouter({ braveKeys = [], exaKeys = [], tavilyAvailable, tavilySearch, budget, fetchImpl, add }) {
  const pools = { brave: unique(braveKeys), exa: unique(exaKeys) };
  const cursors = { brave: 0, exa: 0 };
  budget.providers ||= {};

  const request = async (provider, input, lane) => {
    const keys = pools[provider];
    if (!keys || !keys.length) throw new Error(`${provider} API keys unavailable`);
    const start = cursors[provider]++ % keys.length;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      budget.take('searches', 0, lane);
      const usage = budget.providers[provider] ||= { requests: 0, failures: 0, estimatedUsd: 0 };
      usage.requests++;
      const key = keys[(start + attempt) % keys.length];
      let url, options;
      const days = { day: 1, week: 7, month: 31, year: 366 };

      if (provider === 'brave') {
        url = new URL('https://api.search.brave.com/res/v1/web/search');
        const sites = (input.include_domains || []).slice(0, 10).map(d => `site:${d}`).join(' OR ');
        const q = sites ? `${input.query} (${sites})` : input.query;
        if (q.length > 400) throw new Error('Brave query with domain filters exceeds 400 characters');
        for (const [name, value] of Object.entries({ q, count: '5', extra_snippets: 'true', spellcheck: 'false' })) {
          url.searchParams.set(name, value);
        }
        if (input.country) url.searchParams.set('country', input.country);
        if (input.time_range) url.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[input.time_range]);
        options = { headers: { Accept: 'application/json', 'X-Subscription-Token': key } };
      } else {
        url = 'https://api.exa.ai/search';
        const body = { query: input.query, type: 'fast', numResults: 5, contents: { highlights: true } };
        if (input.include_domains?.length) body.includeDomains = input.include_domains.slice(0, 10);
        if (input.time_range) body.startPublishedDate = new Date(Date.now() - (days[input.time_range] || 31) * 86400000).toISOString();
        options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) };
      }

      const started = Date.now();
      let response, data;
      try {
        response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15000) });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`HTTP ${response.status}`);
        }
        data = await response.json();
      } catch (err) {
        usage.failures++;
        void recordApiUsage({ service: provider, provider, operation: 'signal_search', status: 'error', durationMs: Date.now() - started, metadata: { lane, attempt, httpStatus: response?.status } });
        if (response && ![401, 402, 403, 429].includes(response.status) && response.status < 500) throw new Error(`${provider} search failed (HTTP ${response.status})`);
        if (attempt === keys.length - 1) throw new Error(`${provider} search unavailable after key rotation`);
        continue;
      }

      const cost = provider === 'brave' ? 0.005 : Number(data.costDollars?.total);
      if (Number.isFinite(cost) && cost >= 0) usage.estimatedUsd += cost;
      void recordApiUsage({ service: provider, provider, operation: 'signal_search', status: 'ok', durationMs: Date.now() - started, estimatedCost: Number.isFinite(cost) ? cost : undefined, metadata: { lane, attempt } });

      const items = provider === 'brave' ? data.web?.results : data.results;
      if (!Array.isArray(items)) throw new Error(`${provider} returned unsupported search data`);

      const rows = [];
      for (const item of items.slice(0, 5)) {
        let source;
        try { source = new URL(item.url); } catch { continue; }
        if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) continue;
        source.hash = '';
        const snippets = provider === 'brave' ? [item.description, ...(item.extra_snippets || [])] : item.highlights || [];
        const text = [item.title || '', ...snippets.filter(s => typeof s === 'string')].join('\n').slice(0, 12000);
        if (!text.trim()) continue;
        const e = await add(source.href, text, lane, 'snippet', { provider, publishedAt: item.publishedDate || null });
        rows.push({ evidence_id: e.id, url: e.url, text: e.text.slice(0, 8000), tier: e.tier, provider });
      }
      return { untrusted_data: true, provider, results: rows, credits: 0 };
    }
  };

  return async (input, lane) => {
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 400) {
      throw new Error('Search query must be 1–400 characters');
    }
    // Prioritize news and recent filing discovery
    const order = [...new Set(['brave', 'tavily', 'exa'])].filter(p => p === 'tavily' ? tavilyAvailable : pools[p].length);
    if (!order.length) throw new Error('Add a Brave, Exa or Tavily key in Settings → Keys');

    let lastError, empty;
    for (const provider of order) {
      try {
        const result = provider === 'tavily' ? await tavilySearch(input, lane) : await request(provider, input, lane);
        if (result.results.length) return { ...result, provider };
        empty = result;
      } catch (error) {
        if (/budget exhausted|lease/i.test(error.message)) throw error;
        lastError = error;
      }
    }
    if (empty) return empty;
    throw lastError;
  };
}
