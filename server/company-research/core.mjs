import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getDomain } from 'tldts';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { renderCompanyReport } from './report-html.mjs';

export const VERSION = 'company-research-v2.1';
export const Seed = z.object({
  name: z.string().trim().min(2).max(200), place_id: z.string().max(200).optional(),
  website: z.string().url().refine(v => /^https?:\/\//i.test(v) && Boolean(domain(v)), 'Website must be an HTTP(S) URL with a registrable domain').optional(), phone: z.string().max(80).optional(),
  related_websites: z.array(z.string().url().refine(v => /^https?:\/\//i.test(v) && Boolean(domain(v)))).max(10).optional(),
  address: z.string().max(500).optional(), postcode: z.string().regex(/^\d{5}$/).optional(),
}).strict();
const citation = { evidence_id: z.string(), quote: z.string().trim().min(8).max(200) };
export const Findings = z.object({
  facts: z.array(z.object({ field: z.enum(['legal_name', 'ssm_no', 'incorporated_on', 'status', 'msic', 'paid_up_capital', 'registered_address', 'sells', 'buyers', 'price_points', 'headcount', 'reach', 'phone', 'email', 'social']), value: z.union([z.string().max(1000), z.number().finite()]), ...citation })).max(60).default([]),
  people: z.array(z.object({ name: z.string(), role: z.string(), contact: z.string().nullable().default(null), ...citation })).max(30).default([]),
  clients: z.array(z.object({ name: z.string(), year: z.number().int().nullable(), delivered: z.string(), ...citation })).max(30).default([]),
  signals: z.array(z.object({ what: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ...citation })).max(30).default([]),
  risks: z.array(z.object({ risk: z.string(), ...citation })).max(30).default([]),
  wrong_entity_warnings: z.array(z.string().max(500)).max(20).default([]),
  unknowns: z.array(z.string().max(500)).max(50).default([]),
}).strict();

// Formatting is ignored, but words, digits, punctuation and case are preserved.
export function normalizeQuote(text) {
  return String(text).normalize('NFKC').replace(/\[([^\]]+)\]\([^\s)]+\)/g, '$1')
    .replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
}
export function quotePresent(quote, text) {
  const q = normalizeQuote(quote);
  return q.length >= 8 && q.length <= 200 && normalizeQuote(text).includes(q);
}
export function dateInQuote(date, quote) {
  if (!validDate(date)) return false;
  if (quote.includes(date)) return true;
  const [year, month, day] = date.split('-').map(Number);
  if (new RegExp(`\\b0?${day}[/.-]0?${month}[/.-]${year}\\b`).test(quote)) return true;
  const months = ['jan(?:uary|uari)?', 'feb(?:ruary|ruari)?', 'mar(?:ch)?', 'apr(?:il)?', '(?:may|mei)', 'jun(?:e)?', 'jul(?:y|ai)?', '(?:aug(?:ust)?|ogos)', 'sep(?:tember)?', '(?:oct(?:ober)?|oktober)', 'nov(?:ember)?', '(?:dec(?:ember)?|disember)'];
  const m = months[month - 1], d = `0?${day}(?:st|nd|rd|th)?`, sep = '[\\s,.-]+';
  return new RegExp(`\\b(?:${d}${sep}${m}${sep}${year}|${m}${sep}${d}${sep}${year})\\b`, 'i').test(quote);
}
export const validSsm = value => /^(?:(?:19|20)\d{10}|\d{5,7}-[A-Z])$/.test(String(value));
export function phone(value) {
  const parsed = parsePhoneNumberFromString(String(value), 'MY');
  return parsed?.isValid() ? parsed.number : null;
}
export function domain(url) {
  try { return getDomain(new URL(url).hostname, { allowPrivateDomains: true }); } catch { return null; }
}
export function sourceTier(url, ownDomain, sources) {
  const host = new URL(url).hostname.toLowerCase();
  if ([ownDomain].flat().includes(domain(url)) || sources.social.some(d => host === d || host.endsWith(`.${d}`))) return 3;
  return sources.tier1.some(d => host === d || host.endsWith(`.${d}`)) ? 1 : 2;
}
export function evidenceRecord({ id, url, text, tier, lane, mode = 'snippet' }) {
  const stored = String(text).slice(0, 100000);
  return { id, url, text: stored, tier, lane, mode, retrievedAt: new Date().toISOString(), hash: createHash('sha256').update(stored).digest('hex') };
}
export function validateFindings(input, evidence) {
  const parsed = Findings.safeParse(input);
  if (!parsed.success) return { accepted: false, errors: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  const errors = [];
  for (const key of ['facts', 'people', 'clients', 'signals', 'risks']) parsed.data[key].forEach((item, i) => {
    const e = evidence.find(e => e.id === item.evidence_id);
    if (!e || !quotePresent(item.quote, e.text)) errors.push(`${key}.${i}: quote is absent from evidence ${item.evidence_id}`);
    if (key === 'facts' && item.field === 'ssm_no' && !validSsm(item.value)) errors.push(`facts.${i}: invalid SSM number`);
    if (key === 'facts' && item.field === 'status' && !['live', 'struck_off', 'winding_up', 'dormant'].includes(item.value)) errors.push(`facts.${i}: invalid registry status`);
    if (key === 'facts' && item.field === 'headcount' && (!Number.isInteger(item.value) || item.value < 1)) errors.push(`facts.${i}: headcount must be a positive integer`);
    if (key === 'facts' && item.field === 'msic' && !/^\d{5}$/.test(String(item.value))) errors.push(`facts.${i}: MSIC must be a literal five-digit classification code`);
    if (key === 'facts' && item.field === 'incorporated_on' && !validDate(item.value)) errors.push(`facts.${i}: invalid incorporation date`);
    if (key === 'signals' && !validDate(item.date)) errors.push(`signals.${i}: invalid signal date`);
    // Quotes alone cannot prove semantic entailment; at least reject unrelated
    // identifiers, contacts and names even when the quote itself is authentic.
    if (key === 'facts') {
      const hay = normalizeQuote(item.quote).toLowerCase();
      const value = normalizeQuote(item.value).toLowerCase();
      let included = hay.includes(value);
      if (item.field === 'phone') included = hay.replace(/\D/g, '').includes(value.replace(/\D/g, ''));
      if (item.field === 'headcount') included = new RegExp(`(?:^|\\D)${item.value}(?:\\D|$)`).test(hay);
      if (item.field === 'incorporated_on') included = dateInQuote(item.value, item.quote);
      if (item.field === 'status') {
        const terms = { live: ['live', 'existing', 'active'], struck_off: ['struck off', 'struck-off', 'struck_off'], winding_up: ['winding up', 'winding-up', 'winding_up'], dormant: ['dormant'] };
        included = (terms[item.value] || []).some(t => new RegExp(`\\b${t}\\b`).test(item.quote.toLowerCase()));
      }
      if (!included) errors.push(`facts.${i}: value is absent from its quote`);
    }
    if (['people', 'clients'].includes(key) && !normalizeQuote(item.quote).toLowerCase().includes(normalizeQuote(item.name).toLowerCase())) errors.push(`${key}.${i}: name is absent from its quote`);
    if (key === 'people' && item.role && !normalizeQuote(item.quote).toLowerCase().includes(normalizeQuote(item.role).toLowerCase())) errors.push(`people.${i}: role is absent from its quote`);
    if (key === 'people' && item.contact && !item.quote.toLowerCase().includes(item.contact.toLowerCase())) errors.push(`people.${i}: contact is absent from its quote; use null`);
    if (key === 'signals' && !dateInQuote(item.date, item.quote)) errors.push(`signals.${i}: quote must include the exact date; do not invent dates or days`);
  });
  return errors.length ? { accepted: false, errors } : { accepted: true, findings: parsed.data };
}
export function checkedFindings(input, evidence) {
  const parsed = Findings.safeParse(input);
  if (!parsed.success) return null;
  const findings = { ...parsed.data };
  let discarded = 0;
  for (const key of ['facts', 'people', 'clients', 'signals', 'risks']) {
    findings[key] = findings[key].filter(item => {
      const valid = validateFindings({ [key]: [item] }, evidence).accepted;
      if (!valid) discarded++;
      return valid;
    });
  }
  if (discarded) findings.unknowns = [...new Set([...findings.unknowns, `${discarded} submitted claims failed evidence validation and were excluded.`])].slice(0, 50);
  return { findings, discarded };
}
export function contactFindings(seed, evidence) {
  const own = [seed.website, ...(seed.related_websites || [])].map(domain).filter(Boolean);
  const facts = [], seen = new Set();
  for (const e of evidence.filter(e => e.mode === 'http' && own.includes(domain(e.url)))) {
    for (const [field, regex] of [
      ['phone', /(?<![\dA-Za-z])(?:\+?60|0)[\d ().-]{7,18}(?![\dA-Za-z-])/g],
      ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
    ]) for (const match of e.text.matchAll(regex)) {
      const value = match[0].trim();
      if (field === 'phone' && !phone(value)) continue;
      if (field === 'phone') {
        const before = e.text.slice(Math.max(0, match.index - 60), match.index);
        const after = e.text.slice(match.index + match[0].length, match.index + match[0].length + 40);
        const labelled = /(?:phone|telefon|telephone|tel|whatsapp|mobile|call|hp|contact(?: us)?)\b[^A-Za-z0-9]{0,12}$/i.test(before);
        const linked = /(?:tel:|wa\.me\/|phone=)$/i.test(before) || /^\]\((?:tel:|https?:\/\/wa\.me\/)/i.test(after);
        if (!labelled && !linked) continue;
      }
      const key = `${e.url}\n${field}\n${field === 'phone' ? phone(value) : value.toLowerCase()}`;
      if (seen.has(key)) continue;
      const start = Math.max(0, match.index - 30);
      const quote = e.text.slice(start, Math.min(e.text.length, match.index + match[0].length + 80)).slice(0, 200);
      const claim = { field, value, evidence_id: e.id, quote };
      if (validateFindings({ facts: [claim] }, evidence).accepted) { facts.push(claim); seen.add(key); }
      if (facts.length === 60) return { facts };
    }
  }
  return { facts };
}
export function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function ageYears(date, now = new Date()) {
  if (!validDate(date)) return null;
  const born = new Date(date);
  let n = now.getUTCFullYear() - born.getUTCFullYear();
  if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) n--;
  return n >= 0 ? n : null;
}
const nameKey = text => normalizeQuote(text).toLowerCase().replace(/\b(sdn|bhd|berhad|sendirian|enterprise|trading)\b/g, '').replace(/[^a-z0-9]/g, '');
export function lockIdentity(seed, evidence) {
  const candidates = evidence.map(e => {
    const text = e.text.toLowerCase();
    const matched = [];
    const name = nameKey(seed.name);
    if (name.length >= 2 && nameKey(text).includes(name)) matched.push('name');
    if (seed.website && domain(seed.website) && domain(e.url) === domain(seed.website)) matched.push('domain');
    if (seed.phone && phone(seed.phone)) {
      const found = [...e.text.matchAll(/(?:\+?60|0)[\d\s().-]{7,18}/g)].some(m => phone(m[0]) === phone(seed.phone));
      if (found) matched.push('phone');
    }
    if (seed.address && normalizeQuote(text).includes(normalizeQuote(seed.address).toLowerCase())) matched.push('address');
    if (seed.postcode && new RegExp(`\\b${seed.postcode}\\b`).test(text)) matched.push('postcode');
    const strong = matched.some(a => ['domain', 'phone', 'address'].includes(a));
    return { evidenceId: e.id, url: e.url, anchorsMatched: matched, confidence: matched.includes('name') && strong ? 0.95 : matched.includes('name') && matched.includes('postcode') ? 0.6 : 0.2 };
  }).sort((a, b) => b.confidence - a.confidence);
  const best = candidates[0] || { confidence: 0, anchorsMatched: [] };
  return { ...best, status: best.confidence >= 0.9 ? 'locked' : 'needs_review', candidates: candidates.slice(0, 5) };
}
export function fact(items, evidence) {
  const verified = items.filter(i => {
    const e = evidence.find(e => e.id === i.evidence_id);
    return e && quotePresent(i.quote, e.text);
  });
  if (!verified.length) return { value: null, status: 'unknown', confidence: 0, evidence: [] };
  const refs = [...new Map(verified.map(i => {
    const e = evidence.find(e => e.id === i.evidence_id);
    return [e.id, { id: e.id, url: e.url, tier: e.tier, mode: e.mode, quote: i.quote, retrievedAt: e.retrievedAt }];
  })).values()];
  const valueKey = i => i.field === 'legal_name' ? nameKey(i.value) : i.field === 'ssm_no' ? String(i.value) : JSON.stringify(i.value);
  const unique = new Set(verified.map(valueKey));
  const domains = new Set(refs.filter(e => e.tier === 2).map(e => domain(e.url)));
  const status = unique.size > 1 ? 'conflicting' : refs.some(e => e.tier === 1 && ['http', 'metadata'].includes(e.mode)) ? 'confirmed' : domains.size >= 2 ? 'corroborated' : refs.every(e => e.tier === 3) ? 'self_reported' : 'unknown';
  const out = { value: status === 'unknown' || status === 'conflicting' ? null : verified[0].value, status, confidence: { confirmed: 0.95, corroborated: 0.8, self_reported: 0.5, conflicting: 0, unknown: 0 }[status], evidence: refs };
  if (status === 'unknown' && unique.size === 1) out.reportedValue = verified[0].value;
  if (unique.size > 1) out.conflicts = verified.map(i => ({ value: i.value, evidenceId: i.evidence_id }));
  return out;
}
const trusted = f => ['confirmed', 'corroborated'].includes(f.status);
export function scoreDossier(d, now = new Date()) {
  const drivers = [];
  const add = (feature, max, evaluated, points, note) => drivers.push({ feature, max, evaluated, points: evaluated ? points : 0, note });
  add('Registry', 30, trusted(d.identity.ssmNo) && trusted(d.identity.status), d.identity.status.value === 'live' ? 30 : 0, 'Verified registration and live status required.');
  const address = trusted(d.identity.registeredAddress);
  const phoneAgreement = d.contacts.phones.some(p => (p.sourceDomains || []).length >= 3);
  add('Entity consistency', 15, trusted(d.identity.legalName) && address && phoneAgreement, 15, 'Name, address and the same phone need source agreement.');
  const knownDomainDate = validDate(d.web.domain.createdOn);
  const oldDomain = knownDomainDate && now - new Date(d.web.domain.createdOn) >= 365 * 86400000;
  const history = d.web.archive.snapshotCount > 1 || d.web.archive.snapshotCountLowerBound > 1;
  add('Live website', 5, d.web.domain.state !== 'unknown', d.web.domain.state === 'active' ? 5 : 0, 'A successfully fetched company website.');
  add('Domain age', 5, knownDomainDate, oldDomain ? 5 : 0, 'An established domain registration date older than one year.');
  add('Archive history', 5, Number.isFinite(d.web.archive.snapshotCount) || Number.isFinite(d.web.archive.snapshotCountLowerBound), history ? 5 : 0, 'More than one successful archived capture.');
  const dated = d.signals.filter(s => s.value && validDate(s.value.date));
  const recent = dated.some(s => { const age = now - new Date(s.value.date); return age >= 0 && age <= 90 * 86400000; });
  add('Operating signals', 15, dated.length > 0, recent ? 15 : 0, 'Dated operating evidence within 90 days.');
  add('Named people', 10, d.people.some(trusted), d.people.some(trusted) ? 10 : 0, 'At least one independently corroborated person.');
  const footprint = [...d.clients, ...d.signals].some(trusted);
  add('Independent footprint', 10, footprint, footprint ? 10 : 0, 'Independent client or operating evidence.');
  const explicitRisk = d.risks.some(trusted);
  add('Clean record', 5, explicitRisk, 0, 'Absence of search results is not evidence of a clean record.');
  let legitimacy = drivers.reduce((n, f) => n + f.points, 0);
  const hardCap = ['winding_up', 'struck_off'].includes(d.identity.status.value) && trusted(d.identity.status);
  if (hardCap) legitimacy = Math.min(legitimacy, 15);
  if (explicitRisk) legitimacy = Math.min(legitimacy, 40);
  const coverage = drivers.reduce((n, f) => n + (f.evaluated ? f.max : 0), 0) / 100;
  const verdict = hardCap || explicitRisk ? 'HIGH_RISK' : coverage < 0.4 ? 'INSUFFICIENT_DATA' : legitimacy >= 70 && coverage >= 0.6 ? 'VERIFIED' : 'QUESTIONABLE';
  return { legitimacy, coverage, verdict, drivers };
}
export function reconcile({ seed, identity, evidence, runs, startedAt, webState = 'unknown', web = {} }, now = new Date()) {
  runs = runs.slice().sort((a, b) => a.lane.localeCompare(b.lane));
  // Re-check every stored claim on replay; one unsupported item must not erase
  // unrelated, valid findings from the same completed section.
  const findings = runs.map(r => {
    const checked = checkedFindings(r.findings || {}, evidence);
    if (!checked) return null;
    const out = checked.findings;
    if (!/^G4(?:-|$)/.test(r.lane)) out.risks = [];
    out.signals = out.signals.filter(item => !/(?:rebate|programme|program).*(?:claim window|deadline|eligible homeowner)/i.test(item.what) || nameKey(item.what).includes(nameKey(seed.name)));
    return out;
  }).filter(Boolean);
  const claims = findings.flatMap(f => f.facts);
  const field = key => {
    const rows = claims.filter(c => c.field === key);
    if (!['sells', 'buyers', 'price_points', 'reach'].includes(key)) return fact(rows, evidence);
    // Different services and operating locations can all be true together.
    const groups = [...new Set(rows.map(c => c.value))].map(value => fact(rows.filter(c => c.value === value), evidence));
    const visible = groups.filter(f => f.value !== null);
    if (!visible.length) return fact(rows, evidence);
    const status = visible.every(trusted) ? (visible.every(f => f.status === 'confirmed') ? 'confirmed' : 'corroborated') : 'self_reported';
    return { value: visible.map(f => f.value).join('; '), status, confidence: Math.min(...visible.map(f => f.confidence)), evidence: [...new Map(groups.flatMap(f => f.evidence).map(e => [e.id, e])).values()], reportedValues: groups.filter(f => f.status === 'unknown' && f.reportedValue !== undefined).map(f => f.reportedValue) };
  };
  const list = (key, keys) => {
    const grouped = new Map();
    for (const row of findings.flatMap(f => f[key])) {
      const value = Object.fromEntries(keys.map(k => [k, row[k]]));
      const personName = key === 'people' ? row.name.replace(/^(?:mr\.?|mrs\.?|ms\.?)\s+/i, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') : null;
      const id = key === 'people' ? JSON.stringify([personName, row.role.toLowerCase(), row.contact?.toLowerCase() || null])
        : key === 'signals' ? JSON.stringify([row.date, normalizeQuote(row.what).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()]) : JSON.stringify(value);
      if (!grouped.has(id)) grouped.set(id, []);
      const rows = grouped.get(id);
      rows.push({ ...row, value: rows[0]?.value || value });
    }
    return [...grouped.values()].map(rows => fact(rows, evidence));
  };
  const d = {
    seed, identity: { legalName: field('legal_name'), ssmNo: field('ssm_no'), incorporatedOn: field('incorporated_on'), status: field('status'), msic: field('msic'), paidUpCapital: field('paid_up_capital'), registeredAddress: field('registered_address'), domain: seed.website ? domain(seed.website) : null, match: identity },
    business: { sells: field('sells'), buyers: field('buyers'), pricePoints: field('price_points') },
    scale: { headcount: field('headcount'), reach: field('reach') },
    people: list('people', ['name', 'role', 'contact']), clients: list('clients', ['name', 'year', 'delivered']),
    signals: list('signals', ['what', 'date']), risks: list('risks', ['risk']), contacts: { phones: [], emails: [], social: {} },
    web: { ...web, domain: { ...web.domain, state: webState }, archive: { ...web.archive } }, unknowns: [], outreachAngles: [],
    meta: { version: VERSION, credits: Object.fromEntries(runs.map(r => [r.lane, r.credits || 0])), tokens: Object.fromEntries(runs.map(r => [r.lane, r.tokens || 0])), lanes: runs.map(({ lane, status, ms, error }) => ({ lane, status, ms, error })), durationMs: Math.max(0, now - new Date(startedAt)) },
  };
  d.identity.ageYears = ageYears(d.identity.incorporatedOn.value, now);
  for (const claim of claims.filter(c => ['phone', 'email', 'social'].includes(c.field))) {
    const f = fact([claim], evidence);
    // Contact extraction may use a single independent directory source as long
    // as its quote checks, even though the fact remains below corroborated.
    if (!f.evidence.length || !quotePresent(claim.quote, evidence.find(e => e.id === claim.evidence_id)?.text)) continue;
    if (claim.field === 'phone' && phone(claim.value)) {
      const e164 = phone(claim.value);
      let p = d.contacts.phones.find(p => p.e164 === e164);
      if (!p) { p = { e164, whatsapp: false, sources: [], sourceDomains: [] }; d.contacts.phones.push(p); }
      if (!p.sources.includes(claim.evidence_id)) p.sources.push(claim.evidence_id);
      const source = evidence.find(e => e.id === claim.evidence_id);
      const agreement = source.tier === 3 ? 'company/self-reported' : domain(source.url);
      if (agreement && !p.sourceDomains.includes(agreement)) p.sourceDomains.push(agreement);
      const links = claim.quote.match(/(?:https?:\/\/)?(?:wa\.me\/|api\.whatsapp\.com\/)[^\s)\]]+/gi) || [];
      p.whatsapp ||= links.some(link => {
        try { const u = new URL(link.startsWith('http') ? link : `https://${link}`); const digits = (u.hostname === 'wa.me' ? u.pathname : u.searchParams.get('phone') || '').replace(/\D/g, ''); return phone(`+${digits}`) === e164; } catch { return false; }
      });
    }
    if (claim.field === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claim.value)) {
      const address = claim.value.toLowerCase();
      let e = d.contacts.emails.find(e => e.address === address);
      if (!e) { e = { address, kind: /^(info|sales|hello|contact|admin|support|enquiry|enquiries)@/.test(address) ? 'generic' : 'personal', mxOk: null, sources: [] }; d.contacts.emails.push(e); }
      if (!e.sources.includes(claim.evidence_id)) e.sources.push(claim.evidence_id);
    }
    if (claim.field === 'social') {
      try { const host = new URL(claim.value).hostname; const key = ['facebook', 'instagram', 'linkedin', 'tiktok'].find(k => host === `${k}.com` || host.endsWith(`.${k}.com`)); if (key && claim.quote.includes(claim.value)) d.contacts.social[key] = claim.value; } catch { /* invalid URL */ }
    }
  }
  d.scores = scoreDossier(d, now);
  d.identity.warnings = [...new Set(findings.flatMap(f => f.wrong_entity_warnings))];
  d.unknowns = [...new Set([...(claims.length ? [] : ['No accepted findings']), ...findings.flatMap(f => f.unknowns), ...['legal_name', 'ssm_no', 'incorporated_on', 'status', 'msic', 'paid_up_capital', 'registered_address', 'sells', 'buyers', 'price_points', 'headcount', 'reach'].filter(k => field(k).value === null), ...(d.people.some(p => p.value) ? [] : ['people'])])];
  d.unknowns = d.unknowns.filter(item => {
    const match = item.match(/^(phone|email)(?:$|\s*:\s*(?:no\b|not\b|none\b))/i);
    return !match || !(match[1].toLowerCase() === 'phone' ? d.contacts.phones.length : d.contacts.emails.length);
  });
  for (const signal of d.signals.filter(s => s.value)) {
    if (/hiring|recruit|new branch|expan/i.test(signal.value.what)) d.outreachAngles.push({ angle: `Ask about operating requirements related to the reported signal: ${signal.value.what}`, basedOn: signal.evidence.map(e => e.id) });
  }
  if (d.web.psi?.performance !== null && d.web.psi?.performance < 60) {
    const basis = evidence.filter(e => e.lane === 'H').map(e => e.id);
    if (basis.length) d.outreachAngles.push({ angle: 'Ask whether improving the measured website performance is a current priority.', basedOn: basis });
  }
  // Compact source index includes contact-only citations without publishing
  // full fetched documents or agent transcripts.
  const cited = findings.flatMap(f => [...f.facts, ...f.people, ...f.clients, ...f.signals, ...f.risks]);
  d.sources = evidence.filter(e => cited.some(c => c.evidence_id === e.id)).map(e => ({ id: e.id, url: e.url, tier: e.tier, mode: e.mode, quotes: [...new Set(cited.filter(c => c.evidence_id === e.id).map(c => c.quote))] }));
  d.summary = `${seed.name}: ${d.scores.verdict}. Legitimacy ${d.scores.legitimacy}/100; evidence coverage ${Math.round(d.scores.coverage * 100)}%. ${d.business.sells.value || 'Business activity is unknown.'}`;
  return d;
}
export function renderDossier(d, format) {
  if (format === 'json') return JSON.stringify(d, null, 2);
  if (format === 'html') return renderCompanyReport(d);
  const lines = [`# ${d.seed.name}`, '', d.summary, '', `Identity: ${d.identity.match.status}`, '', '## Verified findings'];
  const visit = (x, key) => {
    if (!x || typeof x !== 'object') return;
    if (Object.hasOwn(x, 'status') && Array.isArray(x.evidence)) {
      lines.push(`- ${key}: ${x.value === null ? 'UNKNOWN' : typeof x.value === 'object' ? JSON.stringify(x.value) : x.value} (${x.status})`);
      for (const e of x.evidence) lines.push(`  - [${e.id}](${e.url}): ${e.quote}`);
      if (x.conflicts) for (const c of x.conflicts) lines.push(`  - Conflicting value: ${JSON.stringify(c.value)} (${c.evidenceId})`);
    } else for (const [k, v] of Object.entries(x)) visit(v, key ? `${key}.${k}` : k);
  };
  for (const key of ['identity', 'business', 'scale', 'people', 'clients', 'signals', 'risks']) visit(d[key], key);
  lines.push('', '## Contacts', JSON.stringify(d.contacts, null, 2), '', '## Unknowns', ...d.unknowns.map(s => `- ${s}`), '', '## Score drivers', ...d.scores.drivers.map(f => `- ${f.feature}: ${f.points}/${f.max}. ${f.note}`));
  const md = lines.join('\n');
  if (format === 'md') return md;
  throw new Error('format must be json, md or html');
}
