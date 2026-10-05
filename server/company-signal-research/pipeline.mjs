import { SignalSeed, reconcileSignalDossier, deriveCompanyProfile } from './core.mjs';
import { SignalBudget, createSignalEvidenceTools } from './adapters.mjs';
import { settleBatch } from './concurrency.mjs';
import { fetchStockPriceData } from './market-data.mjs';

export async function researchCompanySignals({
  seed: input,
  previousReports = [],
  tavilyKey,
  tavilyKeys,
  braveKeys,
  exaKeys,
  scrapling,
  runner,
  emit = async () => {},
  saveEvidence = async () => {},
  saveRun = async () => {},
  budget = new SignalBudget(),
  toolsFactory = createSignalEvidenceTools,
  now = () => new Date(),
}) {
  const seed = SignalSeed.parse(input);
  const startedAt = now().toISOString();
  const evidence = [];
  const runs = [];

  const tools = toolsFactory({
    seed,
    evidence,
    budget,
    tavilyKey,
    tavilyKeys,
    braveKeys,
    exaKeys,
    scrapling,
    persist: saveEvidence,
  });

  const lane = async (id, work) => {
    const start = Date.now();
    await emit({ type: 'lane', lane: id, status: 'running' });
    let row;
    try {
      const result = await work();
      row = {
        lane: id,
        status: 'ok',
        ms: Date.now() - start,
        credits: budget.lanes[id]?.credits || 0,
        result,
      };
    } catch (err) {
      row = {
        lane: id,
        status: 'failed',
        ms: Date.now() - start,
        credits: budget.lanes[id]?.credits || 0,
        error: err.message,
      };
    }
    runs.push(row);
    await saveRun(row);
    await emit({ type: 'lane', lane: id, status: row.status });
    return row;
  };

  const profile = deriveCompanyProfile(seed);
  await emit({ type: 'wave', wave: 0, status: 'profiling', sequence: previousReports.length + 1, profile });

  // Lookback time range: if previous report exists within last 7 days, use 'week', else 'month'
  const timeRange = seed.lookback_days <= 7 ? 'week' : seed.lookback_days <= 31 ? 'month' : 'year';

  let marketData = null;

  // 1. Parallel targeted search discovery for market-moving signals & 7-day stock price action
  await Promise.allSettled([
    lane('discovery_market_data', async () => {
      marketData = await fetchStockPriceData(seed);
      return marketData;
    }),
    lane('discovery_financials', async () => {
      const q = `"${seed.name}" OR "${seed.ticker}" (earnings OR revenue OR profit OR guidance OR quarterly results)`;
      return tools.search({ query: q, time_range: timeRange, topic: 'news' }, 'discovery_financials');
    }),
    lane('discovery_commercial', async () => {
      const q = `"${seed.name}" OR "${seed.ticker}" (contract OR deal OR acquisition OR partnership OR customer order)`;
      return tools.search({ query: q, time_range: timeRange, topic: 'news' }, 'discovery_commercial');
    }),
    lane('discovery_governance', async () => {
      const q = `"${seed.name}" OR "${seed.ticker}" (investigation OR lawsuit OR penalty OR regulatory OR CEO OR insider)`;
      return tools.search({ query: q, time_range: timeRange, topic: 'news' }, 'discovery_governance');
    }),
    lane('discovery_sentiment', async () => {
      const q = `"${seed.name}" OR "${seed.ticker}" (analyst rating OR target price OR upgrade OR downgrade OR shares surge OR shares drop)`;
      return tools.search({ query: q, time_range: timeRange, topic: 'news' }, 'discovery_sentiment');
    }),
    lane('discovery_strategic_battlegrounds', async () => {
      const terms = profile.targeted_search_terms.slice(0, 6).map(t => `"${t}"`).join(' OR ');
      const q = `"${seed.name}" OR "${seed.ticker}" (${terms})`;
      return tools.search({ query: q, time_range: timeRange, topic: 'news' }, 'discovery_strategic_battlegrounds');
    }),
  ]);

  // 2. Fetch full text of top Tier 1 / Tier 2 sources if Scrapling is available
  if (scrapling) {
    await lane('deep_fetch', async () => {
      const seenDomains = new Set();
      const topUrls = evidence
        .filter(e => e.mode === 'snippet' && e.tier <= 2)
        .filter(e => {
          try {
            const h = new URL(e.url).hostname;
            if (seenDomains.has(h)) return false;
            seenDomains.add(h);
            return true;
          } catch {
            return false;
          }
        })
        .slice(0, 4)
        .map(e => e.url);

      if (!topUrls.length) return { skipped: 'No high-tier news URLs to fetch' };
      return tools.fetch_pages({ urls: topUrls }, 'deep_fetch');
    });
  }

  // 3. Dispatch Pi Agent lanes for signal extraction
  await emit({ type: 'wave', wave: 1, status: 'signal_extraction' });

  const runAgent = async (agentLane) => {
    const creditsBefore = budget.lanes[agentLane]?.credits || 0;
    await emit({ type: 'agent', lane: agentLane, status: 'running' });
    let row;
    try {
      row = await runner.run({
        lane: agentLane,
        seed,
        profile,
        previousReports,
        evidence,
        tools,
      });
    } catch (err) {
      row = { lane: agentLane, status: 'failed', error: err.message, findings: null };
    }
    row.credits = (budget.lanes[agentLane]?.credits || 0) - creditsBefore;
    runs.push(row);
    await saveRun(row);
    await emit({ type: 'agent', lane: agentLane, status: row.status });
  };

  // Run the 4 primary signal lanes concurrently
  await settleBatch(['S1', 'S2', 'S3', 'S4'].map(runAgent));

  // 4. Longitudinal Trend Stacking Lane
  // If there are prior reports or if multiple signals exist, run the trend synthesis lane
  await emit({ type: 'wave', wave: 2, status: 'trend_synthesis' });
  await runAgent('ST');

  // 5. Final Reconcile & Stack
  const result = reconcileSignalDossier({
    seed,
    profile,
    marketData,
    previousReports,
    evidence,
    runs,
    startedAt,
  }, now());

  result.meta.credits = { total: budget.used.credits };
  result.meta.searchProviders = budget.providers || {};
  result.meta.budgets = { ...budget.used };

  const status = runs.some(r => ['S1', 'S2', 'S3', 'S4', 'ST'].includes(r.lane)
    && ['ok', 'partial'].includes(r.status) && r.findings) ? 'complete' : 'failed';
  const error = status === 'failed' ? 'No research lane produced accepted findings; inspect lane errors before retrying' : null;
  await emit({
    type: 'wave',
    wave: 3,
    status,
    sequence: result.sequence,
    bias: result.thesis.bias,
    conviction: result.thesis.conviction,
    signalsCount: result.signals.length,
  });

  return {
    status,
    error,
    result,
    seed,
    evidence,
    runs,
    startedAt,
  };
}
