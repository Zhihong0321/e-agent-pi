import { safeUrl } from './adapters.mjs';
import { domain, phone, normalizeQuote } from './core.mjs';

// These are metadata APIs, not page extraction. All website text still comes
// from Scrapling. Provider URLs never come from a research model.
export async function metadataJson(input, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  let url = input;
  for (let redirects = 0; redirects <= 3; redirects++) {
    await safeUrl(url);
    let response;
    try { response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } }); }
    catch { throw new Error('Metadata API request failed or timed out'); }
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location'), url).href; await response.body?.cancel(); continue;
    }
    if (!response.ok) throw new Error(`Metadata API HTTP ${response.status}`);
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 2000000) throw new Error('Metadata response exceeds 2 MB'); chunks.push(Buffer.from(value)); }
    } finally { await reader.cancel().catch(() => {}); }
    return { url, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  }
  throw new Error('Metadata redirect limit exceeded');
}
export function parseRdap(data) {
  const date = data.events?.find(e => e.eventAction === 'registration')?.eventDate;
  const registrant = data.entities?.filter(e => e.roles?.includes('registrant')).flatMap(e => e.vcardArray?.[1] || []).find(row => row[0] === 'fn')?.[3];
  return { ...(date && Number.isFinite(Date.parse(date)) ? { createdOn: new Date(date).toISOString().slice(0, 10) } : {}), ...(typeof registrant === 'string' ? { registrant } : {}) };
}
export function parseArchive(rows) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0]) || !rows[0].includes('timestamp')) throw new Error('Unexpected Wayback CDX response');
  const col = rows[0].indexOf('timestamp');
  const timestamps = rows.slice(1).map(r => r[col]).filter(t => /^\d{14}$/.test(t)).sort();
  if (timestamps.length > 10000) return { snapshotCountLowerBound: 10000, truncated: true };
  const t = timestamps[0];
  return { snapshotCount: timestamps.length, ...(t ? { firstCapture: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` } : {}) };
}
export function parsePsi(data) {
  const lh = data.lighthouseResult;
  if (!lh?.categories) throw new Error('PageSpeed returned no Lighthouse data');
  const category = key => typeof lh.categories[key]?.score === 'number' ? Math.round(lh.categories[key].score * 100) : null;
  const metric = key => typeof lh.audits?.[key]?.numericValue === 'number' ? lh.audits[key].numericValue : null;
  return { performance: category('performance'), seo: category('seo'), accessibility: category('accessibility'), bestPractices: category('best-practices'), lcp: metric('largest-contentful-paint'), cls: metric('cumulative-layout-shift'), tbt: metric('total-blocking-time'), opportunities: Object.values(lh.audits || {}).filter(a => a.details?.type === 'opportunity' && a.score !== null && a.score < 1).map(a => a.title).slice(0, 12) };
}
export function directoryAnchors(seed, row) {
  const anchors = [];
  if (seed.phone && phone(seed.phone) && phone(seed.phone) === phone(row.phone)) anchors.push('phone');
  if (seed.website && row.website && domain(seed.website) === domain(row.website)) anchors.push('domain');
  if (seed.address && row.address && normalizeQuote(seed.address).toLowerCase() === normalizeQuote(row.address).toLowerCase()) anchors.push('address');
  return anchors;
}
export function createMetadataLanes({ seed, psiKey, pitchSignals = false, directory, getJson = metadataJson }) {
  const ownDomain = seed.website ? domain(seed.website) : null;
  return {
    async B() {
      if (!ownDomain) return { skipped: 'No verified website domain supplied' };
      const bootstrap = await getJson('https://data.iana.org/rdap/dns.json');
      const suffix = ownDomain.split('.').at(-1);
      const base = bootstrap.data.services?.find(([tlds]) => tlds.includes(suffix))?.[1]?.find(u => u.startsWith('https://'));
      if (!base) return { skipped: `No IANA HTTPS RDAP service for .${suffix}; WHOIS access has not been authorized` };
      const response = await getJson(`${base.replace(/\/$/, '')}/domain/${encodeURIComponent(ownDomain)}`);
      return { url: response.url, text: JSON.stringify(response.data), web: { domain: parseRdap(response.data) } };
    },
    async D() {
      if (!ownDomain) return { skipped: 'No verified website domain supplied' };
      const url = new URL('https://web.archive.org/cdx/search/cdx');
      for (const [key, value] of Object.entries({ url: `${ownDomain}/`, matchType: 'host', output: 'json', fl: 'timestamp', filter: 'statuscode:200', limit: '10001' })) url.searchParams.set(key, value);
      const response = await getJson(url.href);
      return { url: response.url, text: JSON.stringify(response.data), web: { archive: parseArchive(response.data) } };
    },
    async E() {
      if (!directory) return { skipped: 'Newpages dataset not imported' };
      const candidates = await directory(seed);
      if (!candidates.length) return { skipped: 'Newpages dataset has no matching candidates' };
      const checked = candidates.map(row => ({ ...row, anchors: directoryAnchors(seed, row) }));
      return { directory: checked, evidence: checked.filter(row => row.anchors.length && row.url?.startsWith('https://')).map(row => ({ url: row.url, text: JSON.stringify(row) })) };
    },
    async H() {
      if (!pitchSignals || !psiKey || !seed.website) return { skipped: 'Enable pitchSignals and provide PSI_API_KEY plus a website for PageSpeed' };
      await safeUrl(seed.website);
      const url = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
      url.searchParams.set('url', seed.website); url.searchParams.set('strategy', 'mobile'); url.searchParams.set('key', psiKey);
      for (const c of ['performance', 'seo', 'accessibility', 'best-practices']) url.searchParams.append('category', c);
      const response = await getJson(url.href, { timeoutMs: 60000 });
      // Never put the provider key in an evidence URL, transcript or artifact.
      url.searchParams.delete('key');
      return { url: url.href, text: JSON.stringify(response.data), web: { psi: parsePsi(response.data) } };
    },
  };
}
