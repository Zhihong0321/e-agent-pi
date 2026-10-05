import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDomain } from 'tldts';
import { renderSignalReportHtml } from './report-html.mjs';

export const VERSION = 'company-signal-research-v1.0';

export const SignalCategory = z.enum([
  'earnings',
  'contracts_deals',
  'regulatory_legal',
  'management_insider',
  'product_tech',
  'macro_industry',
]);

export const SignalImpact = z.enum([
  'bullish',
  'bearish',
  'neutral',
  'high_volatility',
]);

export const SignalTimeframe = z.enum([
  'immediate',
  'short_term',
  'long_term',
]);

export const SignalSeed = z.object({
  company_uid: z.string().min(2).max(50), // e.g. "AAPL.NASDAQ", "1155.BURSA"
  ticker: z.string().min(1).max(20),
  exchange: z.string().min(1).max(20),
  name: z.string().min(2).max(200),
  sector: z.string().max(100).optional(),
  lookback_days: z.number().int().min(1).max(365).optional().default(30),
});

export const SignalItem = z.object({
  category: SignalCategory,
  impact: SignalImpact,
  timeframe: SignalTimeframe.optional().default('short_term'),
  headline: z.string().min(5).max(250),
  summary: z.string().min(10).max(600),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  evidence_id: z.string(),
  quote: z.string().min(8).max(300),
  price_move_percent: z.number().optional(),
});

export const SignalSubmissions = z.object({
  signals: z.array(SignalItem).default([]),
  thesis: z.object({
    bias: SignalImpact,
    conviction: z.number().min(0).max(1), // 0 to 1
    primary_catalysts: z.array(z.string()).default([]),
    key_risks: z.array(z.string()).default([]),
    summary: z.string().min(10).max(1000),
  }),
  trend_observation: z.object({
    trajectory: z.enum(['accelerating', 'stable', 'deteriorating', 'inflection_point', 'first_report']),
    synthesis: z.string().min(10).max(1000),
    materialized_catalysts: z.array(z.string()).default([]),
    unresolved_risks: z.array(z.string()).default([]),
  }).optional(),
  unknowns: z.array(z.string()).default([]),
});

export const CompanyProfile = z.object({
  core_business: z.string(),
  revenue_segments: z.array(z.string()),
  unit_economics_kpis: z.array(z.string()),
  primary_battlegrounds: z.array(z.string()),
  custom_research_questions: z.array(z.string()),
  targeted_search_terms: z.array(z.string()),
});

export function deriveCompanyProfile(seed) {
  const norm = `${seed.ticker} ${seed.name} ${seed.sector || ''}`.toLowerCase();

  // 1. Utilities / Tenaga Nasional Berhad
  if (/tnb|tenaga|5347|utility|utilities|power grid/i.test(norm)) {
    return {
      core_business: 'Peninsular Malaysia monopoly transmission & distribution (T&D) network operator and integrated electricity generation utility.',
      revenue_segments: [
        'Regulated Transmission & Distribution (T&D under IBR framework)',
        'Thermal & Renewable Power Generation (Coal, Natural Gas, Hydro, Large Scale Solar)',
        'Customer Electricity Retailing & Green Tariffs',
      ],
      unit_economics_kpis: [
        'Regulated Asset Base (RAB) allowable return (WACC)',
        'Imbalance Cost Pass-Through (ICPT) fuel under/over recovery balance',
        'Electricity sales volume growth (% YoY) and Peak demand (MW)',
        'Capital expenditure (Capex) on grid modernization and energy transition',
      ],
      primary_battlegrounds: [
        'Regulatory Period 4 (RP4, 2025–2027) parameter finalization and allowable WACC return',
        'Surging electricity baseload demand from Johor and Cyberjaya AI Data Center clusters (GW pipeline)',
        'Fuel cost stabilization (moderating coal and gas prices) reducing working capital pressure',
        'National Energy Transition Roadmap (NETR) grid reinforcement capital commitments',
      ],
      custom_research_questions: [
        'What are the expected allowable return (WACC) and capex ceiling parameters under Regulatory Period 4 (RP4)?',
        'How much incremental electricity demand (MW/GW) has TNB secured through Electricity Supply Agreements (ESA) with data center operators?',
        'How has the moderation in global coal and gas costs impacted TNB’s net ICPT receivables and cash flow position?',
        'What is TNB’s planned grid capital expenditure allocation to support regional renewable energy integration and interconnectors?',
      ],
      targeted_search_terms: [
        'RP4', 'Regulatory Period 4', 'IBR', 'ICPT', 'tariff', 'data center', 'electricity demand', 'NETR', 'grid capex', 'coal cost',
      ],
    };
  }

  // 2. Semiconductor / AI Hardware (Nvidia, TSMC, etc.)
  if (/semiconductor|chip|hardware|nvda|nvidia|tsmc|gpu|processor/i.test(norm)) {
    return {
      core_business: 'Accelerated computing and semiconductor architecture designing GPUs, interconnects, and AI software stacks.',
      revenue_segments: [
        'Compute & Data Center (AI model training and inference accelerators)',
        'High-speed Networking (InfiniBand & Spectrum-X Ethernet switches)',
        'Workstation & Gaming Visual Computing',
      ],
      unit_economics_kpis: [
        'Data Center revenue growth (% YoY & QoQ)',
        'Gross profit margin (% after advanced packaging and wafer costs)',
        'Hyperscaler capital expenditure trajectory (Microsoft, Meta, Google, Amazon)',
        'Advanced packaging capacity availability (TSMC CoWoS allocation)',
      ],
      primary_battlegrounds: [
        'Next-generation chip architecture production ramp and rack deployment timelines',
        'Hyperscaler multi-year AI capital spending durability and return on investment (ROI)',
        'US export control regulations compliance and international market traction',
        'Ethernet AI networking adoption competing with legacy InfiniBand solutions',
      ],
      custom_research_questions: [
        'Are next-generation GPU server rack shipments on schedule without packaging or cooling bottlenecks?',
        'What are Tier-1 cloud service providers guiding for forward AI infrastructure capital expenditures?',
        'How are gross margins trending under higher advanced memory (HBM) and packaging bill-of-materials?',
        'What is the revenue contribution from geopolitical export-compliant product variants?',
      ],
      targeted_search_terms: [
        'data center revenue', 'hyperscaler capex', 'Blackwell', 'CoWoS', 'gross margin', 'networking', 'export controls', 'HBM',
      ],
    };
  }

  // 3. Banking & Financial Institutions
  if (/bank|banking|financial|maybank|cimb|public bank|jpmorgan/i.test(norm)) {
    return {
      core_business: 'Commercial banking, corporate lending, retail wealth management, and treasury operations.',
      revenue_segments: [
        'Net Interest Income (Interest earned on loans minus cost of customer deposits)',
        'Non-Interest Income (Fee-based wealth management, investment banking, forex, treasury)',
        'Islamic Banking and Shariah-compliant financing assets',
      ],
      unit_economics_kpis: [
        'Net Interest Margin (NIM) compression/expansion',
        'Gross Impaired Loan (GIL) ratio and loan loss coverage',
        'Loan growth rate (% YoY across retail mortgages, auto, SME, and corporate)',
        'Cost-to-Income Ratio (CIR) and Return on Equity (ROE)',
      ],
      primary_battlegrounds: [
        'Central bank interest rate (OPR) trajectory and deposit pricing competition',
        'Credit asset quality and commercial real estate / SME default risk',
        'Fee income diversification through wealth management and digital banking',
      ],
      custom_research_questions: [
        'What is the quarterly Net Interest Margin (NIM) trajectory amidst deposit competition?',
        'How are gross impaired loan ratios and credit loss provisions trending across retail and corporate portfolios?',
        'What is the annualized loan growth rate compared to industry benchmarks?',
        'What are the capital adequacy ratio and dividend payout commitments for the current fiscal year?',
      ],
      targeted_search_terms: [
        'Net Interest Margin', 'NIM', 'impaired loans', 'credit cost', 'OPR', 'loan growth', 'wealth management', 'ROE',
      ],
    };
  }

  // 4. Default / General Listed Company Fallback
  return {
    core_business: `Public listed enterprise operating primarily within the ${seed.sector || 'commercial'} sector.`,
    revenue_segments: [
      'Core Operational Product/Service Sales',
      'Value-added Services & Recurring Contracts',
      'Regional & Export Markets',
    ],
    unit_economics_kpis: [
      'Operating Revenue and Net Profit Margins',
      'EBITDA growth and Free Cash Flow generation',
      'Capital expenditure (Capex) and Debt-to-Equity leverage',
    ],
    primary_battlegrounds: [
      'Topline revenue expansion vs. inflationary operating costs',
      'Management forward revenue/earnings guidance and market share defense',
      'Strategic capital allocation, dividends, and merger & acquisition activity',
    ],
    custom_research_questions: [
      'What are the primary revenue and margin drivers reported in the latest quarterly filing?',
      'Has management revised forward guidance or announced major contract milestones?',
      'Are there material legal, regulatory, or competitive headwinds impacting operations?',
      'How is free cash flow trending to support ongoing capital expenditure and shareholder returns?',
    ],
    targeted_search_terms: [
      'quarterly results', 'revenue guidance', 'operating margin', 'order book', 'capex', 'dividend', 'contract win',
    ],
  };
}

export function normalizeQuote(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function quotePresent(quote, text) {
  if (typeof quote !== 'string' || typeof text !== 'string') return false;
  const q = normalizeQuote(quote).toLowerCase();
  const t = normalizeQuote(text).toLowerCase();
  if (q.length < 8) return false;
  return t.includes(q);
}

export function validDate(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(String(value)) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function dateInQuote(date, quote) {
  if (!validDate(date) || typeof quote !== 'string') return false;
  const q = normalizeQuote(quote).toLowerCase();
  if (q.includes(date)) return true;
  const [year, month, day] = date.split('-').map(Number);
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const m = months[month - 1];
  const re = new RegExp(`\\b${day}\\s+${m}[a-z]*\\s+${year}\\b|\\b${m}[a-z]*\\s+${day}(?:st|nd|rd|th)?,?\\s+${year}\\b`, 'i');
  return re.test(q);
}

export function domain(url) {
  try {
    return getDomain(new URL(url).hostname, { allowPrivateDomains: true });
  } catch {
    return null;
  }
}

export function sourceTier(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const tier1 = [
      'sec.gov', 'bursamalaysia.com', 'londonstockexchange.com', 'hkex.com.hk',
      'sgx.com', 'nasdaq.com', 'nyse.com', 'investor.', 'ir.'
    ];
    if (tier1.some(d => host.includes(d))) return 1;
    const tier2 = [
      'reuters.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'cnbc.com',
      'theedgemalaysia.com', 'theedgemarkets.com', 'marketwatch.com',
      'seekingalpha.com', 'finance.yahoo.com', 'investing.com'
    ];
    if (tier2.some(d => host.includes(d))) return 2;
    return 3;
  } catch {
    return 3;
  }
}

export function evidenceRecord({ id, url, text, tier = 2, lane, mode = 'snippet' }) {
  const stored = String(text || '').slice(0, 120000);
  return {
    id,
    url,
    text: stored,
    tier: tier || sourceTier(url),
    lane,
    mode,
    retrievedAt: new Date().toISOString(),
    hash: createHash('sha256').update(stored).digest('hex'),
  };
}

export function validateSignalFindings(input, evidence) {
  const parsed = SignalSubmissions.safeParse(input);
  if (!parsed.success) {
    return {
      accepted: false,
      errors: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
    };
  }

  const errors = [];
  const findings = parsed.data;

  findings.signals.forEach((sig, i) => {
    const ev = evidence.find(e => e.id === sig.evidence_id);
    if (!ev) {
      errors.push(`signals.${i}: cited evidence ${sig.evidence_id} not found`);
      return;
    }
    if (!quotePresent(sig.quote, ev.text)) {
      errors.push(`signals.${i}: quote is absent from evidence ${sig.evidence_id}`);
    }
    if (!validDate(sig.event_date)) {
      errors.push(`signals.${i}: invalid event_date '${sig.event_date}' (must be YYYY-MM-DD)`);
    } else if (!dateInQuote(sig.event_date, sig.quote)) {
      errors.push(`signals.${i}: date '${sig.event_date}' is not supported by its quote`);
    }
  });

  return errors.length
    ? { accepted: false, errors }
    : { accepted: true, findings };
}

export function checkedSignalFindings(input, evidence) {
  const parsed = SignalSubmissions.safeParse(input);
  if (!parsed.success) return null;
  const findings = { ...parsed.data };
  let discarded = 0;

  findings.signals = findings.signals.filter(sig => {
    const ev = evidence.find(e => e.id === sig.evidence_id);
    if (!ev || !quotePresent(sig.quote, ev.text)) {
      discarded++;
      return false;
    }
    if (!validDate(sig.event_date) || !dateInQuote(sig.event_date, sig.quote)) {
      discarded++;
      return false;
    }
    return true;
  });

  if (discarded > 0) {
    findings.unknowns = [
      ...new Set([
        ...findings.unknowns,
        `${discarded} submitted signals failed evidence quote/date verification and were excluded.`,
      ]),
    ];
  }

  return { findings, discarded };
}

/**
 * Reconciles the new signals and layers them over historical reports.
 */
export function reconcileSignalDossier({
  seed,
  profile,
  previousReports = [],
  evidence = [],
  runs = [],
  startedAt,
}, now = new Date()) {
  const companyProfile = profile || deriveCompanyProfile(seed);
  const verifiedRuns = runs.map(r => {
    const checked = checkedSignalFindings(r.findings || {}, evidence);
    return checked ? checked.findings : null;
  }).filter(Boolean);

  const allSignals = verifiedRuns.flatMap(f => f.signals);
  // Deduplicate signals by date + headline similarity
  const uniqueSignals = [];
  const seenKeys = new Set();
  for (const s of allSignals) {
    const key = `${s.event_date}:${normalizeQuote(s.headline).toLowerCase().slice(0, 40)}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      const ev = evidence.find(e => e.id === s.evidence_id);
      uniqueSignals.push({
        ...s,
        source: ev ? { id: ev.id, url: ev.url, tier: ev.tier } : null,
      });
    }
  }

  // Sort signals chronologically
  uniqueSignals.sort((a, b) => b.event_date.localeCompare(a.event_date));

  const bullishCount = uniqueSignals.filter(s => s.impact === 'bullish').length;
  const bearishCount = uniqueSignals.filter(s => s.impact === 'bearish').length;
  const volatileCount = uniqueSignals.filter(s => s.impact === 'high_volatility').length;

  const latestSynthesis = verifiedRuns.map(r => r.thesis).find(Boolean) || {
    bias: bullishCount > bearishCount ? 'bullish' : bearishCount > bullishCount ? 'bearish' : 'neutral',
    conviction: Math.min(1, Math.round(((uniqueSignals.length * 0.15) + (Math.abs(bullishCount - bearishCount) * 0.1)) * 100) / 100),
    primary_catalysts: uniqueSignals.filter(s => s.impact === 'bullish').map(s => s.headline).slice(0, 4),
    key_risks: uniqueSignals.filter(s => s.impact === 'bearish').map(s => s.headline).slice(0, 4),
    summary: `${seed.name} (${seed.company_uid}): ${uniqueSignals.length} market-moving signals identified (${bullishCount} bullish, ${bearishCount} bearish).`,
  };

  const trendObservation = verifiedRuns.map(r => r.trend_observation).find(Boolean) || {
    trajectory: previousReports.length === 0 ? 'first_report' : 'stable',
    synthesis: previousReports.length === 0
      ? `Initial baseline signal report established for ${seed.name}.`
      : `Stacked report on top of ${previousReports.length} prior historical checkpoint(s).`,
    materialized_catalysts: [],
    unresolved_risks: [],
  };

  // Compile historical progression timeline
  const sequence = previousReports.length + 1;
  const historyTimeline = [
    ...previousReports.map(p => ({
      sequence: p.sequence,
      report_id: p.id,
      date: p.created_at || p.period_end,
      bias: p.result?.thesis?.bias || 'neutral',
      conviction: p.result?.thesis?.conviction || 0,
      summary: p.result?.delta_summary || p.result?.thesis?.summary || '',
      signals_count: p.result?.signals?.length || 0,
    })),
    {
      sequence,
      date: startedAt || now.toISOString(),
      bias: latestSynthesis.bias,
      conviction: latestSynthesis.conviction,
      summary: latestSynthesis.summary,
      signals_count: uniqueSignals.length,
      current: true,
    },
  ];

  const unknowns = [
    ...new Set(verifiedRuns.flatMap(f => f.unknowns || [])),
  ];

  const citedIds = new Set(uniqueSignals.map(s => s.evidence_id));
  const citedSources = evidence
    .filter(e => citedIds.has(e.id))
    .map(e => ({ id: e.id, url: e.url, tier: e.tier, mode: e.mode }));

  return {
    version: VERSION,
    company_uid: seed.company_uid,
    ticker: seed.ticker,
    exchange: seed.exchange,
    name: seed.name,
    sector: seed.sector || null,
    sequence,
    previous_report_id: previousReports[0]?.id || null,
    stack_height: sequence,
    signals: uniqueSignals,
    counts: {
      total: uniqueSignals.length,
      bullish: bullishCount,
      bearish: bearishCount,
      volatile: volatileCount,
    },
    thesis: latestSynthesis,
    delta_summary: latestSynthesis.summary,
    profile: companyProfile,
    trend: {
      ...trendObservation,
      history_timeline: historyTimeline,
      previous_reports_count: previousReports.length,
    },
    unknowns,
    sources: citedSources,
    meta: {
      startedAt,
      completedAt: now.toISOString(),
      durationMs: Math.max(0, now.getTime() - new Date(startedAt).getTime()),
    },
  };
}

export function renderSignalReport(d, format = 'json') {
  if (format === 'json') return JSON.stringify(d, null, 2);
  if (format === 'html') return renderSignalReportHtml(d);

  const lines = [
    `# Market Signal Dossier: ${d.name} (${d.company_uid})`,
    '',
    `**Stack Report #${d.sequence}** | **Overall Bias:** ${d.thesis.bias.toUpperCase()} | **Conviction:** ${Math.round(d.thesis.conviction * 100)}%`,
    '',
    `> **Executive Thesis:** ${d.thesis.summary}`,
    '',
  ];

  if (d.profile) {
    lines.push(
      `## 0. Company Business Model & Strategic Battlegrounds`,
      `- **Core Business:** ${d.profile.core_business}`,
      `- **Key Revenue Segments:** ${d.profile.revenue_segments.join('; ')}`,
      `- **Critical Valuation & Unit Economic KPIs:** ${d.profile.unit_economics_kpis.join('; ')}`,
      `- **Primary Stock Battlegrounds:** ${d.profile.primary_battlegrounds.join('; ')}`,
      '',
      `### Tailored Research Questions:`,
      ...d.profile.custom_research_questions.map((q, idx) => `${idx + 1}. ${q}`),
      ''
    );
  }

  lines.push(
    `## 1. Multi-Report Trend Evolution`,
    `- **Trajectory:** ${d.trend.trajectory.toUpperCase()}`,
    `- **Trend Synthesis:** ${d.trend.synthesis}`,
    '',
    `### Historical Trend Line (${d.trend.history_timeline.length} checkpoints):`
  );

  for (const h of d.trend.history_timeline) {
    lines.push(`- **Report #${h.sequence}** (${String(h.date).slice(0, 10)}): Bias \`${h.bias}\` (${Math.round((h.conviction || 0) * 100)}% conv) — ${h.summary.slice(0, 120)}`);
  }

  lines.push('', '## 2. Market-Moving Catalysts & Signals', '');
  if (!d.signals.length) {
    lines.push('_No confirmed market-moving signals found in this window._');
  } else {
    for (const s of d.signals) {
      lines.push(`### [${s.impact.toUpperCase()}] ${s.headline} (${s.event_date})`);
      lines.push(`- **Category:** \`${s.category}\` | **Timeframe:** \`${s.timeframe}\``);
      lines.push(`- **Summary:** ${s.summary}`);
      lines.push(`- **Quote:** "${s.quote}"`);
      if (s.source) lines.push(`- **Source:** [${s.source.id}](${s.source.url}) (Tier ${s.source.tier})`);
      lines.push('');
    }
  }

  lines.push('## 3. Primary Catalysts & Risks', '');
  lines.push('### Bullish Catalysts:');
  if (d.thesis.primary_catalysts.length) {
    for (const c of d.thesis.primary_catalysts) lines.push(`- ${c}`);
  } else {
    lines.push('- None identified.');
  }

  lines.push('', '### Key Risks & Headwinds:');
  if (d.thesis.key_risks.length) {
    for (const r of d.thesis.key_risks) lines.push(`- ${r}`);
  } else {
    lines.push('- None identified.');
  }

  if (d.unknowns.length) {
    lines.push('', '## 4. Unknowns & Information Gaps:');
    for (const u of d.unknowns) lines.push(`- ${u}`);
  }

  return lines.join('\n');
}
