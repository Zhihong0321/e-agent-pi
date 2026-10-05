import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SignalSeed,
  validateSignalFindings,
  checkedSignalFindings,
  reconcileSignalDossier,
  renderSignalReport,
  evidenceRecord,
  quotePresent,
  dateInQuote,
} from './core.mjs';

const seed = {
  company_uid: 'NVDA.NASDAQ',
  ticker: 'NVDA',
  exchange: 'NASDAQ',
  name: 'NVIDIA Corporation',
  sector: 'Semiconductors',
  lookback_days: 30,
};

const ev1 = evidenceRecord({
  id: 'S1',
  url: 'https://reuters.com/technology/nvidia-earnings-2026',
  text: 'NVIDIA Corporation announced Q3 revenue of $35.1 billion on 2026-09-15, up 94% year-over-year. Data center revenue reached $30.8 billion.',
  tier: 2,
  lane: 'test',
});

const ev2 = evidenceRecord({
  id: 'S2',
  url: 'https://sec.gov/edgar/data/nvidia-8k',
  text: 'NVIDIA signed a strategic multi-year cloud infrastructure partnership with major hyperscalers on 2026-09-22.',
  tier: 1,
  lane: 'test',
});

test('SignalSeed parses valid listed company inputs and normalizes fields', () => {
  const parsed = SignalSeed.parse(seed);
  assert.equal(parsed.ticker, 'NVDA');
  assert.equal(parsed.exchange, 'NASDAQ');
  assert.equal(parsed.company_uid, 'NVDA.NASDAQ');
  assert.equal(parsed.lookback_days, 30);
});

test('quotePresent accurately validates literal excerpts while normalizing whitespace', () => {
  assert.equal(quotePresent('announced Q3 revenue of $35.1 billion', ev1.text), true);
  assert.equal(quotePresent('announced\n  Q3 revenue of   $35.1 billion', ev1.text), true);
  assert.equal(quotePresent('announced Q3 revenue of $50 billion', ev1.text), false);
});

test('dateInQuote verifies calendar dates strictly inside quotes', () => {
  assert.equal(dateInQuote('2026-09-15', 'NVIDIA announced results on 2026-09-15.'), true);
  assert.equal(dateInQuote('2026-09-15', 'NVIDIA announced results on 15 September 2026.'), true);
  assert.equal(dateInQuote('2026-09-15', 'NVIDIA announced results in September 2026.'), false);
  assert.equal(dateInQuote('2026-09-15', 'NVIDIA announced results on 15 August 2026.'), false);
});

test('validateSignalFindings rejects ungrounded quotes, wrong dates and accepts valid findings', () => {
  const validSubmission = {
    signals: [
      {
        category: 'earnings',
        impact: 'bullish',
        timeframe: 'immediate',
        headline: 'Q3 revenue hits $35.1B, surging 94% YoY',
        summary: 'Record data center revenue of $30.8 billion propelled total revenue up 94% year-over-year.',
        event_date: '2026-09-15',
        evidence_id: 'S1',
        quote: 'NVIDIA Corporation announced Q3 revenue of $35.1 billion on 2026-09-15',
      },
    ],
    thesis: {
      bias: 'bullish',
      conviction: 0.85,
      primary_catalysts: ['Exceptional Data Center revenue expansion'],
      key_risks: ['Export control uncertainties'],
      summary: 'Strong earnings momentum with accelerating hyper-scaler demand.',
    },
    unknowns: [],
  };

  const ok = validateSignalFindings(validSubmission, [ev1, ev2]);
  assert.equal(ok.accepted, true);

  // Submitting fake quote
  const badQuote = {
    ...validSubmission,
    signals: [
      {
        ...validSubmission.signals[0],
        quote: 'NVIDIA will acquire Intel next month for 100 billion',
      },
    ],
  };
  const rejected = validateSignalFindings(badQuote, [ev1, ev2]);
  assert.equal(rejected.accepted, false);
});

test('checkedSignalFindings salvages verified signals and discards invalid ones', () => {
  const mixedSubmission = {
    signals: [
      {
        category: 'earnings',
        impact: 'bullish',
        headline: 'Q3 revenue hits $35.1B',
        summary: 'Revenue grew 94% driven by data center demands.',
        event_date: '2026-09-15',
        evidence_id: 'S1',
        quote: 'NVIDIA Corporation announced Q3 revenue of $35.1 billion on 2026-09-15',
      },
      {
        category: 'contracts_deals',
        impact: 'bearish',
        headline: 'Fabricated cancellation',
        summary: 'All contracts cancelled.',
        event_date: '2026-09-15',
        evidence_id: 'S1',
        quote: 'All contracts cancelled permanently today',
      },
    ],
    thesis: {
      bias: 'bullish',
      conviction: 0.7,
      primary_catalysts: ['Earnings'],
      key_risks: [],
      summary: 'Mixed test.',
    },
    unknowns: [],
  };

  const checked = checkedSignalFindings(mixedSubmission, [ev1]);
  assert.equal(checked.findings.signals.length, 1);
  assert.equal(checked.discarded, 1);
  assert.equal(checked.findings.unknowns.length, 1);
});

test('reconcileSignalDossier stacks new reports on top of historical reports to demonstrate trend evolution', () => {
  // First baseline report
  const initialRun = {
    lane: 'S1',
    status: 'ok',
    findings: {
      signals: [
        {
          category: 'earnings',
          impact: 'bullish',
          timeframe: 'immediate',
          headline: 'Q3 revenue hits $35.1B, surging 94% YoY',
          summary: 'Record data center revenue of $30.8 billion.',
          event_date: '2026-09-15',
          evidence_id: 'S1',
          quote: 'NVIDIA Corporation announced Q3 revenue of $35.1 billion on 2026-09-15',
        },
      ],
      thesis: {
        bias: 'bullish',
        conviction: 0.8,
        primary_catalysts: ['Data center demand'],
        key_risks: ['High valuation'],
        summary: 'Initial baseline report: strong data center growth.',
      },
      trend_observation: {
        trajectory: 'first_report',
        synthesis: 'Initial baseline tracking checkpoint established.',
        materialized_catalysts: [],
        unresolved_risks: [],
      },
      unknowns: [],
    },
  };

  const report1 = reconcileSignalDossier({
    seed,
    previousReports: [],
    evidence: [ev1],
    runs: [initialRun],
    startedAt: '2026-09-16T00:00:00Z',
  }, new Date('2026-09-16T00:00:00Z'));

  assert.equal(report1.sequence, 1);
  assert.equal(report1.stack_height, 1);
  assert.equal(report1.thesis.bias, 'bullish');
  assert.equal(report1.trend.trajectory, 'first_report');

  // Now simulate second report layered on top of report1!
  const report1HistoricalMock = {
    id: 'report-1-uuid',
    sequence: 1,
    created_at: '2026-09-16T00:00:00Z',
    result: report1,
  };

  const secondRun = {
    lane: 'S2',
    status: 'ok',
    findings: {
      signals: [
        {
          category: 'contracts_deals',
          impact: 'bullish',
          timeframe: 'long_term',
          headline: 'Strategic multi-year cloud partnership signed',
          summary: 'Multi-year infrastructure agreements with hyperscalers solidified.',
          event_date: '2026-09-22',
          evidence_id: 'S2',
          quote: 'NVIDIA signed a strategic multi-year cloud infrastructure partnership with major hyperscalers on 2026-09-22',
        },
      ],
      thesis: {
        bias: 'bullish',
        conviction: 0.9,
        primary_catalysts: ['Hyperscaler cloud partnership', 'Q3 earnings beat'],
        key_risks: ['Export controls'],
        summary: 'Commercial partnership reinforces previously reported earnings beat.',
      },
      trend_observation: {
        trajectory: 'accelerating',
        synthesis: 'Thesis is accelerating: commercial deals confirm strong demand identified in Report #1.',
        materialized_catalysts: ['Data center demand'],
        unresolved_risks: [],
      },
      unknowns: [],
    },
  };

  const report2 = reconcileSignalDossier({
    seed,
    previousReports: [report1HistoricalMock],
    evidence: [ev1, ev2],
    runs: [secondRun],
    startedAt: '2026-09-23T00:00:00Z',
  }, new Date('2026-09-23T00:00:00Z'));

  assert.equal(report2.sequence, 2);
  assert.equal(report2.stack_height, 2);
  assert.equal(report2.previous_report_id, 'report-1-uuid');
  assert.equal(report2.trend.trajectory, 'accelerating');
  assert.equal(report2.trend.history_timeline.length, 2);
  assert.equal(report2.trend.history_timeline[0].sequence, 1);
  assert.equal(report2.trend.history_timeline[1].sequence, 2);
  assert.equal(report2.trend.history_timeline[1].current, true);

  const md = renderSignalReport(report2, 'md');
  assert.match(md, /Stack Report #2/);
  assert.match(md, /ACCELERATING/);
  assert.match(md, /Report #1/);
});

test('market-data resolves global stock symbols and renders 7-day SVG price chart', async () => {
  const { resolveStockSymbol, renderPriceChartHtml, fetchStockPriceData } = await import('./market-data.mjs');

  assert.equal(resolveStockSymbol({ ticker: '5347', exchange: 'BURSA' }), '5347.KL');
  assert.equal(resolveStockSymbol({ ticker: 'TNB', exchange: 'BURSA' }), '5347.KL');
  assert.equal(resolveStockSymbol({ ticker: '700', exchange: 'HKEX' }), '0700.HK');
  assert.equal(resolveStockSymbol({ ticker: 'D05', exchange: 'SGX' }), 'D05.SI');
  assert.equal(resolveStockSymbol({ ticker: 'AAPL', exchange: 'NASDAQ' }), 'AAPL');

  // Test HTML rendering with mock data
  const mockMarketData = {
    symbol: '5347.KL',
    currency: 'MYR',
    exchangeName: 'KLS',
    currentPrice: 13.00,
    sevenDayChange: -0.14,
    sevenDayChangePercent: -1.07,
    sevenDayHigh: 13.28,
    sevenDayLow: 12.72,
    regularMarketVolume: 2291400,
    totalVolume: 50400000,
    tradingViewSymbol: 'MYX:TENAGA',
    points: [
      { date: '2026-09-25', open: 13.10, high: 13.28, low: 13.10, close: 13.14, volume: 5767700, changePercent: 0 },
      { date: '2026-09-28', open: 13.16, high: 13.24, low: 13.10, close: 13.16, volume: 5724300, changePercent: 0.15 },
      { date: '2026-09-29', open: 12.94, high: 13.00, low: 12.72, close: 12.72, volume: 10054700, changePercent: -3.34 },
      { date: '2026-09-30', open: 12.80, high: 13.12, low: 12.76, close: 12.96, volume: 10433500, changePercent: 1.89 },
      { date: '2026-10-01', open: 12.96, high: 13.04, low: 12.86, close: 12.90, volume: 8385400, changePercent: -0.46 },
      { date: '2026-10-02', open: 13.00, high: 13.12, low: 12.86, close: 12.96, volume: 7744200, changePercent: 0.47 },
      { date: '2026-10-05', open: 12.96, high: 13.04, low: 12.96, close: 13.00, volume: 2291400, changePercent: 0.31 },
    ],
  };

  const html = renderPriceChartHtml(mockMarketData, { ticker: '5347', exchange: 'BURSA' });
  assert.match(html, /5347\.KL/);
  assert.match(html, /13\.00/);
  assert.match(html, /pill-down/);
  assert.match(html, /price-svg-chart/);
  assert.match(html, /TradingView/);

  // Test fallback for null data
  const emptyHtml = renderPriceChartHtml(null, { ticker: 'TEST', exchange: 'UNKNOWN' });
  assert.match(emptyHtml, /empty-chart/);
});

