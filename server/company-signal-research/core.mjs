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
    bias: SignalImpact.default('neutral'),
    conviction: z.number().min(0).max(1).default(0.5),
    primary_catalysts: z.array(z.string()).default([]),
    key_risks: z.array(z.string()).default([]),
    summary: z.string().default('Signal evaluation completed.'),
  }).default({
    bias: 'neutral',
    conviction: 0.5,
    primary_catalysts: [],
    key_risks: [],
    summary: 'Signal evaluation completed.',
  }),
  trend_observation: z.object({
    trajectory: z.enum(['accelerating', 'stable', 'deteriorating', 'inflection_point', 'first_report']).default('first_report'),
    synthesis: z.string().default('Trend observation completed.'),
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
      core_business: '西马半岛独家垄断输配电网络运营商（IBR激励监管框架下）及综合电力公用事业龙头。',
      revenue_segments: [
        '监管电网输配电业务（IBR框架下的核心准许资产基数回报收入）',
        '传统及可再生能源发电（燃煤、天然气、大型水力及大型太阳能LSS）',
        '终端电力零售、商业售电与绿色关税服务（Green Electricity Tariff）',
      ],
      unit_economics_kpis: [
        '监管资产基数（RAB）准许加权平均资本成本回报率（WACC）',
        '成本转嫁机制（ICPT燃料成本补差 / 月度自动燃料调整AFA）应收账款平衡',
        '全半岛售电量年度同比增速（% YoY）与最高用电负荷峰值（MW/GW）',
        '国家能源转型路线图（NETR）电网强化及跨国区域互联资本开支（Capex）',
      ],
      primary_battlegrounds: [
        '监管周期4（RP4, 2025–2027）最终参数落地与准许WACC回报率锁定',
        '柔佛州与赛城（Cyberjaya）AI超级数据中心算力集群激增的电网接入与负荷交付',
        '全球煤炭与天然气价格回落企稳对运营资金压力的有效释放',
        '可再生能源消纳与东盟区域电网互联带来的额外电网资本开支与资产池扩容',
      ],
      custom_research_questions: [
        '在能源委员会（ST）核定的第四监管期（RP4）中，准许回报率（WACC）与资本开支上限具体为何？',
        'TNB目前与数据中心运营商签署的供电协议（ESA）已锁定多少增量负荷需求（MW/GW）？',
        '全球燃料成本回落如何改善TNB政府电费补贴（ICPT/AFA）应收款项与经营现金流？',
        'TNB为支持高压电网升级与可再生能源并网，未来三年的年度资本开支预算与执行节奏如何？',
      ],
      targeted_search_terms: [
        'RP4', 'Regulatory Period 4', 'IBR', 'ICPT', 'tariff', 'data center', 'electricity demand', 'NETR', 'grid capex', 'coal cost',
      ],
    };
  }

  // 2. Semiconductor / AI Hardware (Nvidia, TSMC, etc.)
  if (/semiconductor|chip|hardware|nvda|nvidia|tsmc|gpu|processor/i.test(norm)) {
    return {
      core_business: '加速计算与半导体架构先锋，研发生产高端GPU加速芯片、高速互联架构及全栈AI系统软件。',
      revenue_segments: [
        '计算与数据中心集群业务（AI超算集群大模型训练与推理加速卡）',
        '高速网络互联产品线（InfiniBand与Spectrum-X以太网交换系统）',
        '专业图形工作站与游戏视觉计算芯片',
      ],
      unit_economics_kpis: [
        '数据中心业务营收同比及环比增速（% YoY & QoQ）',
        '先进封装（CoWoS）及先进制程代工成本后的综合毛利率（Gross Margin %）',
        '超大规模云厂商（Hyperscalers: 微软、Meta、谷歌、亚马逊）资本开支指引趋势',
        '台积电CoWoS先进封装产能与HBM高带宽内存供应链供给充裕度',
      ],
      primary_battlegrounds: [
        '下一代AI芯片架构量产爬坡、液冷机柜系统出货与交付节点',
        '头部云厂商多年度AI基础设施资本投入的持续性与投资回报率（ROI）',
        '出口管制法规合规性与全球定制合规芯片的商业化渗透',
        '以太网AI网络架构与专有InfiniBand生态的市场份额博弈',
      ],
      custom_research_questions: [
        '下一代GPU服务器整机柜出货是否按既定节奏交付，是否存在散热或互联瓶颈？',
        '北美顶级云服务商对未来多季度的AI算力资本开支指引是否出现上修或分化？',
        '在HBM及先进封装成本占比上升背景下，综合毛利率能否维持指引区间？',
        '合规特定市场芯片对总收入的贡献占比与新订单签署节奏如何？',
      ],
      targeted_search_terms: [
        'data center revenue', 'hyperscaler capex', 'Blackwell', 'CoWoS', 'gross margin', 'networking', 'export controls', 'HBM',
      ],
    };
  }

  // 3. Banking & Financial Institutions
  if (/bank|banking|financial|maybank|cimb|public bank|jpmorgan/i.test(norm)) {
    return {
      core_business: '综合商业银行与金融机构，涵盖企业贷款、零售财富管理、投行与资金营运。',
      revenue_segments: [
        '净利息收入（贷款利息收益与存款成本利差）',
        '非利息收入（财富管理手续费、投行业务、外汇与资金营运收益）',
        '伊斯兰银行合规金融资产与融资分部',
      ],
      unit_economics_kpis: [
        '净息差水平（NIM）收窄或扩张幅度',
        '总不良贷款率（GIL Ratio）及拨备覆盖率（Loss Coverage）',
        '按揭、汽车、中小微企业及大企业贷款综合年化增速（% YoY）',
        '成本收入比（CIR）与净资产收益率（ROE）',
      ],
      primary_battlegrounds: [
        '央行基准利率（OPR）周期走势与存款价格竞争压力',
        '信贷资产质量演变与商业地产/中小企业违约风险防范',
        '财富管理及数字化银行对非息手续费收入的拉动多元化',
      ],
      custom_research_questions: [
        '本季度在激烈的存款竞争下，净息差（NIM）表现如何？',
        '零售与对公资产组合的总不良贷款率与信贷拨备成本趋势如何？',
        '年化贷款增速是否符合行业基准？核心资本充足率与股息派发承诺如何？',
      ],
      targeted_search_terms: [
        'Net Interest Margin', 'NIM', 'impaired loans', 'credit cost', 'OPR', 'loan growth', 'wealth management', 'ROE',
      ],
    };
  }

  // 4. Default / General Listed Company Fallback
  return {
    core_business: `主营业务深耕于 ${seed.sector || '商业与工业'} 领域的上市企业。`,
    revenue_segments: [
      '核心主营产品与服务运营销售',
      '高附加值增值服务与长期复购签约',
      '区域市场及海外出口业务',
    ],
    unit_economics_kpis: [
      '主营业务收入增速及净利润率表现',
      'EBITDA增长及自由现金流（FCF）充裕度',
      '年度资本开支（Capex）及资产负债杠杆率',
    ],
    primary_battlegrounds: [
      '营收顶层扩张与通胀营运成本控制之间的平衡',
      '管理层最新季度/年度业绩前瞻指引与市场份额防守',
      '战略资本分配、分红派息政策及战略并购整合',
    ],
    custom_research_questions: [
      '最新财报季中揭示的核心收入与毛利率核心驱动力是什么？',
      '管理层是否对未来业绩指引进行调整，或有重大商业订单签约？',
      '是否存在重大法律诉讼、监管政策合规或激烈行业竞争风险？',
      '自由现金流能否持续支撑当前资本开支与股东分红回报计划？',
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
    summary: `${seed.name} (${seed.company_uid}): 识别出 ${uniqueSignals.length} 项关键市场异动信号（${bullishCount} 项利多，${bearishCount} 项利空，${volatileCount} 项中性/高波动）。`,
  };

  const trendObservation = verifiedRuns.map(r => r.trend_observation).find(Boolean) || {
    trajectory: previousReports.length === 0 ? 'first_report' : 'stable',
    synthesis: previousReports.length === 0
      ? `已建立 ${seed.name} 首期纵向基准研报档案，锁定核心监管指标与追踪锚点。`
      : `本期报告叠加上期历史记录（已累计追踪 ${previousReports.length} 期），持续观测催化剂落地与风险演变。`,
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
