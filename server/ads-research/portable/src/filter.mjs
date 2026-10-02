// Deterministic classification — Tier 0. No LLM, so it is free, instant and
// reproducible. Bump `filterVersion` in the topic config to re-run it over the
// whole corpus without re-scraping anything.

const rx = (s, f = 'i') => new RegExp(s, f);

export function makeFilter(cfg) {
  const f = cfg.filter;
  const must = rx(f.mustMatch);
  const region = rx(f.regionMatch);
  const core = rx(f.coreMatch);
  const off = rx(f.offTopic);
  const tierRx = Object.entries(f.tiers).map(([k, v]) => [k, rx(v)]);
  const angles = cfg.angles.map(([name, re]) => [name, rx(re)]);

  // Ads from a channel driven by a curated advertiser seed list are relevant by
  // provenance — we already know the advertiser sells solar. Their video/image
  // creatives often carry no extractable text and would fail a keyword test.
  const trusted = new Set(f.trustSeedChannels ?? []);

  return function classify(ad) {
    const text = `${ad.advertiser ?? ''}\n${ad.copy ?? ''}`;
    const adv = ad.advertiser ?? '';

    if (trusted.has(ad.channel)) {
      return {
        relevant: true,
        tier: 'installer',
        lang: detectLang(ad.copy ?? ''),
        angles: angles.filter(([, re]) => re.test(text)).map(([n]) => n),
      };
    }

    let relevant = true;
    if (!must.test(text)) relevant = false;
    else if (!region.test(text)) relevant = false;
    else if (!core.test(text)) relevant = false;
    // an advertiser whose NAME is off-topic (tint shop, property agent) is out
    // unless the copy is unmistakably about solar PV
    else if (off.test(adv) && !core.test(ad.copy ?? '')) relevant = false;

    let tier = 'installer';
    for (const [k, re] of tierRx) if (re.test(adv)) { tier = k; break; }

    const lang = detectLang(ad.copy ?? '');
    const found = angles.filter(([, re]) => re.test(text)).map(([n]) => n);

    return { relevant, tier, lang, angles: found };
  };
}

export function detectLang(t) {
  const tags = [];
  if (/\b(anda|kami|dengan|untuk|sekarang|jimat|bil elektrik|rumah|pasang|percuma|sahaja|boleh|yang|dapat)\b/i.test(t)) tags.push('BM');
  if (/\b(the|your|and|with|for|now|free|save|our)\b/i.test(t)) tags.push('EN');
  if (/[一-鿿]/.test(t)) tags.push('中文');
  return tags.length ? tags.join(' + ') : 'EN';
}

export const TIER_LABEL = {
  installer: 'Solar installer / EPC',
  hardware: 'Hardware & e-commerce',
  brand: 'Brand / OEM',
  adjacent: 'Property & adjacent',
};
