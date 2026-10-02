// Report language packs.
//
// What gets translated and what must not:
//   translated — page chrome, section titles, standfirsts, table headers, and
//                the LLM narrative (regenerated in the target language)
//   NOT        — ad hooks, offers and copy. Those are verbatim evidence quoted
//                from live ads; translating them would falsify the research.
//                Many are already Chinese or Malay in the original.
//
// Enum values (funnel, audience, tier) and angle names come from the analysis
// and the topic config in English, so they get display maps rather than being
// regenerated.

export const LANGS = ['en', 'zh'];
export const isLang = l => LANGS.includes(l);

// Latin-first stacks that fall through to a CJK face for Chinese glyphs, so a
// mixed line (RM3,000 · 太阳能) keeps one visual voice.
export const FONTS = {
  en: {
    serif: "'Instrument Serif',Georgia,serif",
    sans: "'Instrument Sans',Helvetica,Arial,sans-serif",
    link: `<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:ital,wght@0,400..700;1,400&display=swap" rel="stylesheet">`,
  },
  zh: {
    serif: "'Instrument Serif','Noto Serif SC',Georgia,serif",
    sans: "'Instrument Sans','Noto Sans SC',Helvetica,Arial,sans-serif",
    link: `<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:ital,wght@0,400..700;1,400&family=Noto+Serif+SC:wght@400;600&family=Noto+Sans+SC:wght@400;500;700&display=swap" rel="stylesheet">`,
  },
};

const EN = {
  htmlLang: 'en',
  titleSuffix: 'Advertising Teardown',
  brandSuffix: '— Ad Library Teardown',
  nav: ['01 Angles', '02 Swipe file', '03 Offers', '04 Language', '05 Gaps', '06 Index', '07 Gallery'],
  // Site-wide bar — same three destinations on every page of the web app.
  site: { reports: 'Reports', changed: 'What changed', admin: 'Admin', brand: 'Ads Research' },

  kickerResearch: 'Ad Content Research',
  regenerated: 'Regenerated',
  headline: 'Advertising Teardown',
  lede: (ads, advs) => `A structured read of <strong>${ads} live ads</strong> from <strong>${advs} advertisers</strong> — what they say, what they offer, and where the messaging gaps are.`,

  stats: {
    ads: 'Relevant ads tracked', advertisers: 'Distinct advertisers',
    active: 'Still running', fresh: 'New since last run', raw: 'Raw ads before filtering',
  },

  method: 'Method',
  methodBody: (o) => `Collected from ${o.channels}, region <code>${o.region}</code>, active ads only. ${o.raw} raw ad records were captured with full copy and per-ad creative, then filtered to ${o.relevant} genuinely relevant ads by deterministic rules (filter v${o.filterVersion}). Every hook and offer quoted below is verbatim from the live ad, extracted by per-ad LLM analysis (v${o.analysisVersion}); ${o.coverage}% of relevant ads carry a current analysis. Ads are keyed by their platform ad ID, so figures accumulate across runs rather than resetting.`,

  partial: 'Partial analysis',
  partialBody: (a, r, c) => `${a} of ${r} ads carry a current analysis (${c}%). Ads without one still appear in the gallery with their raw copy, but contribute no hook, offer or angle to the sections above. Re-run <code>analyze</code> to fill the gaps.`,

  s1: 'The messaging angles that dominate',
  s1sub: 'Ranked by how many distinct advertisers deploy each angle. Most ads stack three or four at once.',
  s1note: 'Read this way',
  s1noteBody: tail => `The top angles are effectively table stakes — run by the most advertisers, so none of them differentiate. The competitive daylight sits further down the list, in <strong>${tail}</strong>.`,

  s2: 'Swipe file — the hooks worth stealing',
  s2sub: 'Verbatim opening lines, one per advertiser, longest-form first.',
  s2empty: 'No analysed hooks yet — run <code>analyze</code>.',

  s3: 'Offer mechanics side-by-side',
  s3sub: 'What advertisers actually put on the table, and how they structure the ask.',
  s3cols: ['Advertiser', 'Headline offer', 'Numbers on the table', 'Conversion path'],
  s3empty: 'No concrete offers extracted yet.',

  s4: 'Language &amp; funnel',
  s4sub: 'How the copy is written, and what it asks the reader to do.',
  s4a: 'Language split', s4b: 'Conversion paths', s4c: 'Market mix',
  s4empty: 'No funnel data yet.',

  s5: 'Gaps &amp; opportunities',
  s5sub: 'Where the market is crowded, and what almost nobody is doing.',
  saturated: 'Saturated — no longer differentiating',
  standouts: 'Standouts',
  noSynthesis: 'Synthesis not available for this run.',
  longest: 'Longest-running ads',
  longestSub: 'An ad that keeps running is an ad that keeps paying. The closest free proxy for what actually converts — and it sharpens with every run.',
  longestCols: ['Advertiser', 'Days tracked', 'Opening line'],
  longevityTitle: 'Longevity needs a second run',
  longevityBody: 'Ad longevity is measured between runs, so this table fills in once the pipeline has executed at least twice. It becomes the most valuable section in the report over time.',

  s6: 'Advertiser index',
  s6sub: n => `All ${n} advertisers, ranked by number of live ads captured.`,
  s6cols: ['#', 'Advertiser', 'Live ads', 'Category', 'Angles used'],

  s7: 'Ad screenshot gallery',
  s7sub: 'Every captured ad with its creative and full copy. Filter by category or advertiser name.',
  all: 'All', shown: 'shown', filterPlaceholder: 'Filter by advertiser name…',
  adCopy: 'AD COPY', noShot: 'No screenshot', stopped: 'stopped',

  footerSources: ch => `Sources: ${ch} — both public. Copy quoted verbatim for research; it remains the property of the respective advertisers.`,

  tiers: {
    installer: 'Solar installer / EPC', hardware: 'Hardware & e-commerce',
    brand: 'Brand / OEM', adjacent: 'Property & adjacent', unclassified: 'Unclassified',
  },
  funnels: {
    whatsapp: 'WhatsApp', lead_form: 'Lead form', messenger: 'Messenger',
    phone: 'Phone', website: 'Website', shop: 'Shop', none: 'None',
  },
  angles: {},
};

const ZH = {
  htmlLang: 'zh-Hans',
  titleSuffix: '广告拆解报告',
  brandSuffix: '— 广告库拆解',
  nav: ['01 诉求角度', '02 文案金句', '03 优惠机制', '04 语言与转化', '05 空白机会', '06 广告主索引', '07 广告图库'],
  site: { reports: '全部报告', changed: '变化趋势', admin: '管理台', brand: '广告研究' },

  kickerResearch: '广告内容研究',
  regenerated: '生成于',
  headline: '广告拆解报告',
  lede: (ads, advs) => `系统梳理 <strong>${ads} 则在投广告</strong>、<strong>${advs} 家广告主</strong>——他们在说什么、给什么优惠，以及市场上还有哪些没人讲的空白。`,

  stats: {
    ads: '相关广告数', advertisers: '广告主数量',
    active: '仍在投放', fresh: '本次新增', raw: '过滤前原始广告',
  },

  method: '研究方法',
  methodBody: (o) => `数据来源：${o.channels}，地区 <code>${o.region}</code>，仅统计在投广告。共抓取 ${o.raw} 条原始广告记录（含完整文案与创意素材），再依据确定性规则筛选出 ${o.relevant} 则真正相关的广告（过滤规则 v${o.filterVersion}）。下文引用的每一句文案与优惠均为广告原文，由逐条 LLM 分析提取（v${o.analysisVersion}）；其中 ${o.coverage}% 的相关广告已完成最新分析。广告以平台广告 ID 为唯一键，因此数据会跨批次累积，而非每次归零。`,

  partial: '分析未完成',
  partialBody: (a, r, c) => `${r} 则广告中有 ${a} 则已完成最新分析（${c}%）。未分析的广告仍会出现在图库中并保留原始文案，但不会计入上方各章节的金句、优惠与角度统计。重新执行 <code>analyze</code> 即可补齐。`,

  s1: '最主流的诉求角度',
  s1sub: '按「使用该角度的广告主数量」排序。多数广告会同时叠加三到四种角度。',
  s1note: '该怎么读这张图',
  s1noteBody: tail => `排在最前面的角度基本已是入场门槛——几乎人人都在用，因此谁也无法靠它建立差异。真正的竞争空档在列表下方，也就是 <strong>${tail}</strong>。`,

  s2: '文案金句——值得借鉴的开场白',
  s2sub: '广告原文开场白，每家广告主取一条，按篇幅由长到短排列。',
  s2empty: '尚无已分析的文案金句——请先执行 <code>analyze</code>。',

  s3: '优惠机制横向对比',
  s3sub: '广告主实际给出的条件，以及他们如何设计这个「钩子」。',
  s3cols: ['广告主', '主打优惠', '关键数字', '转化路径'],
  s3empty: '尚未提取到明确的优惠信息。',

  s4: '语言与转化路径',
  s4sub: '文案怎么写，以及它要求读者做什么。',
  s4a: '语言分布', s4b: '转化路径', s4c: '市场构成',
  s4empty: '尚无转化路径数据。',

  s5: '空白与机会',
  s5sub: '哪些地方已经挤满了人，哪些几乎还没人做。',
  saturated: '已饱和——不再具备差异化',
  standouts: '表现突出的广告主',
  noSynthesis: '本次未生成综合分析。',
  longest: '投放时间最长的广告',
  longestSub: '一则能持续投放的广告，通常意味着它还在赚钱。这是最接近「什么真正带来转化」的免费信号，且随着追踪批次增加会越来越准。',
  longestCols: ['广告主', '追踪天数', '开场白'],
  longevityTitle: '需要第二次运行才能统计',
  longevityBody: '广告投放时长是跨批次比对得出的，因此本表需要至少运行两次后才会有内容。随着时间推移，它会成为整份报告中最有价值的部分。',

  s6: '广告主索引',
  s6sub: n => `全部 ${n} 家广告主，按在投广告数量排序。`,
  s6cols: ['#', '广告主', '在投广告', '类别', '使用的角度'],

  s7: '广告截图总览',
  s7sub: '全部已抓取广告的创意与完整文案。可按类别或广告主名称筛选。',
  all: '全部', shown: '显示中', filterPlaceholder: '输入广告主名称筛选…',
  adCopy: '广告文案', noShot: '无截图', stopped: '已停投',

  footerSources: ch => `数据来源：${ch}——均为公开数据。文案按原文引用仅供研究使用，版权归各广告主所有。`,

  tiers: {
    installer: '太阳能安装商 / EPC', hardware: '硬件与电商',
    brand: '品牌 / 原厂', adjacent: '房产及周边', unclassified: '未分类',
  },
  funnels: {
    whatsapp: 'WhatsApp', lead_form: '表单留资', messenger: 'Messenger',
    phone: '电话', website: '官网', shop: '商城', none: '无',
  },
  // Keyed on the English angle names in the topic config.
  angles: {
    'Bill-shock savings': '电费省钱诉求',
    'Govt rebate (SuRIA/ATAP)': '政府补贴（SuRIA/ATAP）',
    'Urgency / quota scarcity': '紧迫感 / 名额稀缺',
    'Zero-upfront / instalment': '零首付 / 分期',
    'Free assessment lead-magnet': '免费评估引流',
    'Social proof / testimonial': '客户见证 / 口碑',
    'Warranty / trust stack': '质保 / 信任背书',
    'Segment targeting': '细分人群定向',
  },
};

const PACKS = { en: EN, zh: ZH };

export const strings = lang => PACKS[lang] || EN;
export const fonts = lang => FONTS[lang] || FONTS.en;

/** Display name for an angle / tier / funnel, falling back to the raw value. */
export const term = (lang, kind, value) => {
  if (!value) return value;
  const t = strings(lang)[kind]?.[value];
  return t || value;
};

/** Appended to LLM prompts so generated prose matches the report language. */
export const promptLangRule = lang => lang === 'zh'
  ? ' Write every value in Simplified Chinese, EXCEPT any text quoted verbatim from an ad, which must stay exactly as it appears in the original language.'
  : '';
