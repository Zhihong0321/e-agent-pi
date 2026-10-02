// HTML renderer — editorial layout ported from the hand-built teardown deck:
// Instrument Serif display type on a warm paper ground, rule-separated numbered
// sections, no card shadows. Everything below is driven by the live corpus; the
// only hand-written prose is the section standfirsts.
import fs from 'node:fs';
import path from 'node:path';
import { TIER_LABEL } from './filter.mjs';
import { C, MONO, esc, kicker, STAT_ATTR, siteBar } from './theme.mjs';
import { strings, fonts, term, isLang } from './i18n.mjs';

const pj = s => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

// A report is also publishable as a standalone static site (see publish.mjs),
// where the app's own routes do not exist. Set PUBLIC_BASE_URL and the site bar
// points back at the hosted app instead of at the static bundle's own root.
const SITE_BASE = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

const CHANNEL_LABEL = { meta: 'Meta', google_atc: 'Google', google_serp: 'Google Search' };

// Tier chips keep their own hue so the eye can sort the gallery without reading.
const TIER_HUE = {
  installer: '#2E7D54', hardware: '#8A6A24', brand: '#1F6FEB', adjacent: '#8A8272',
};
const tierChip = (t, L = 'en') => {
  const hue = TIER_HUE[t] || C.faint;
  const label = term(L, 'tiers', t || 'unclassified') || TIER_LABEL[t] || t;
  return `<span style="display:inline-block;padding:3px 10px;font-size:11px;font-family:${MONO};letter-spacing:.04em;color:${hue};border:1px solid ${hue}66;background:${hue}0f;white-space:nowrap">${esc(label)}</span>`;
};

/** Numbered section header: hairline rule, mono index, serif title, standfirst. */
const sectionHead = (n, title, sub, SERIF) => `
  <div style="border-top:1px solid ${C.ink};padding-top:18px;display:grid;grid-template-columns:120px 1fr;gap:24px;align-items:start">
    <div style="font-family:${MONO};font-size:13px;color:${C.acc};letter-spacing:.1em">${n}</div>
    <div>
      <h2 style="font-family:${SERIF};font-weight:400;font-size:clamp(30px,4vw,44px);line-height:1.05;margin:0;letter-spacing:-.01em">${title}</h2>
      ${sub ? `<p style="color:${C.dim};font-size:16px;margin:12px 0 0;max-width:64ch">${esc(sub)}</p>` : ''}
    </div>
  </div>`;

const SECTION = `max-width:1140px;margin:0 auto;padding:96px 28px 0`;
const TH = `text-align:left;padding:12px 16px;font-family:${MONO};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${C.dim};border-bottom:1px solid ${C.ink};font-weight:400`;
const TD = `padding:13px 16px;border-bottom:1px solid ${C.hair};vertical-align:top`;

/** A note/aside block — used for method, readings, and coverage warnings. */
const aside = (label, body, accent = C.acc) => `
  <div style="background:${C.card};border:1px solid ${C.rule};padding:24px 28px;margin-top:40px;max-width:900px">
    ${kicker(label, accent)}
    <p style="margin:10px 0 0;font-size:15px;line-height:1.7;color:${C.dim};text-wrap:pretty">${body}</p>
  </div>`;

export function render(store, cfg, { outFile, synthesis, stats, newSince, prevRun, lang = 'en' }) {
  const L = isLang(lang) ? lang : 'en';
  const t = strings(L);
  const F = fonts(L);
  const SERIF = F.serif;
  const ads = store.relevantAds(cfg.topic).map(a => ({ ...a, an: pj(a.analysis_json), angles: pj(a.angles) }));
  const byAdv = {};
  for (const a of ads) (byAdv[a.advertiser || 'unknown'] ||= []).push(a);
  const advList = Object.entries(byAdv).sort((x, y) => y[1].length - x[1].length);

  // Angle ranking is advertiser-level so one prolific advertiser can't skew it.
  const angleAdv = {};
  for (const a of ads) for (const g of (Array.isArray(a.angles) ? a.angles : [])) (angleAdv[g] ||= new Set()).add(a.advertiser);
  const angleRank = Object.entries(angleAdv).map(([n, s]) => [n, s.size]).sort((x, y) => y[1] - x[1]);
  const maxAngle = angleRank[0]?.[1] || 1;

  const longest = store.longRunning(cfg.topic, 12).filter(r => r.days_tracked > 0);
  const funnels = {};
  for (const a of ads) if (a.an.funnel) funnels[a.an.funnel] = (funnels[a.an.funnel] || 0) + 1;

  const coverage = stats.relevant ? Math.round(stats.analysed / stats.relevant * 100) : 100;
  const langs = {};
  for (const a of ads) if (a.lang) langs[a.lang] = (langs[a.lang] || 0) + 1;

  const tierCounts = {};
  for (const a of ads) tierCounts[a.tier || 'unclassified'] = (tierCounts[a.tier || 'unclassified'] || 0) + 1;

  // ---- 02 swipe file: strongest verbatim hooks ------------------------------
  // Longest hooks carry the most mechanic to learn from; one per advertiser so
  // a single prolific advertiser can't fill the whole wall.
  const seenAdv = new Set();
  const swipe = ads
    .filter(a => a.an.hook && String(a.an.hook).trim().length > 12)
    .sort((x, y) => String(y.an.hook).length - String(x.an.hook).length)
    .filter(a => { if (seenAdv.has(a.advertiser)) return false; seenAdv.add(a.advertiser); return true; })
    .slice(0, 12);

  // ---- 03 offer mechanics --------------------------------------------------
  const offers = ads.filter(a => a.an.offer && String(a.an.offer).trim()).slice(0, 24);

  // `key` is the machine-readable name trend.mjs and the homepage read back.
  const stat = (n, label, key) => `
    <div style="padding:26px 22px;border-right:1px solid ${C.rule}">
      <div ${STAT_ATTR}="${key}" style="font-family:${SERIF};font-size:56px;line-height:1">${n}</div>
      <div style="font-family:${MONO};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${C.dim};margin-top:10px">${esc(label)}</div>
    </div>`;

  const gallery = ads.map(a => `
        <figure class="ad-card" data-tier="${esc(a.tier || 'unclassified')}" data-adv="${esc((a.advertiser || '').toLowerCase())}" style="margin:0;background:${C.card};border:1px solid ${C.rule};display:flex;flex-direction:column">
          ${a.shot
      ? `<a href="${esc(a.shot)}" target="_blank" style="display:block"><img loading="lazy" src="${esc(a.shot)}" alt="Ad by ${esc(a.advertiser)}" style="display:block;width:100%;height:auto;background:#fff"></a>`
      : `<div style="padding:54px 0;text-align:center;font-family:${MONO};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${C.faint};background:${C.hair}">${esc(t.noShot)}</div>`}
          <figcaption style="padding:16px 18px;display:flex;flex-direction:column;gap:8px;flex:1">
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start"><strong style="font-size:14.5px;line-height:1.3">${esc(a.advertiser)}</strong>${tierChip(a.tier, L)}</div>
            <div style="font-family:${MONO};font-size:11px;color:${C.faint}">${esc(a.started || a.first_seen.slice(0, 10))} &middot; ${esc(CHANNEL_LABEL[a.channel] || a.channel)} &middot; ID ${esc(a.native_id)}${a.lang ? ` &middot; ${esc(a.lang)}` : ''}${a.active ? '' : ` &middot; ${esc(t.stopped)}`}</div>
            ${a.an.hook ? `<div style="font-family:${SERIF};font-style:italic;font-size:17px;line-height:1.35;color:${C.ink};text-wrap:pretty">&ldquo;${esc(a.an.hook)}&rdquo;</div>` : ''}
            ${a.an.offer ? `<div style="font-size:12.5px;color:${C.acc};line-height:1.5">${esc(a.an.offer)}</div>` : ''}
            ${(Array.isArray(a.angles) && a.angles.length) ? `<div style="font-size:12px;color:${C.dim};line-height:1.55">${a.angles.map(x => esc(term(L, 'angles', x))).join(' &middot; ')}</div>` : ''}
            <details style="margin-top:auto">
              <summary style="cursor:pointer;font-family:${MONO};font-size:11.5px;letter-spacing:.06em;color:${C.acc};list-style:none">&#9656; ${esc(t.adCopy)}</summary>
              <pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.6;color:${C.dim};background:${C.paper};border:1px solid ${C.hair};padding:12px;margin:10px 0 0;max-height:320px;overflow:auto;font-family:${MONO}">${esc(a.copy)}</pre>
            </details>
          </figcaption>
        </figure>`).join('\n');

  const tierButtons = ['all', ...Object.keys(tierCounts).filter(x => x !== 'unclassified')]
    .map((key, i) => {
      const on = i === 0;
      const label = key === 'all' ? `${t.all} (${ads.length})` : `${term(L, 'tiers', key)} (${tierCounts[key]})`;
      return `<button type="button" data-f="${esc(key)}" style="background:${on ? C.ink : C.card};color:${on ? C.paper : C.ink};border:1px solid ${on ? C.ink : C.rule};padding:8px 16px;font-size:13px;font-family:${F.sans};cursor:pointer;border-radius:0">${esc(label)}</button>`;
    }).join('\n      ');

  const channelSummary = stats.byChannel.map(c => `${c.c} on ${CHANNEL_LABEL[c.channel] || c.channel}`).join(' and ');

  const html = `<!doctype html>
<html lang="${t.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(cfg.label)} — ${esc(t.titleSuffix)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${F.link}
<style>
html,body{margin:0;padding:0;background:${C.paper}}
body{font-family:${F.sans};color:${C.ink};-webkit-font-smoothing:antialiased}
a{color:${C.acc};text-decoration:none}
a:hover{color:#8A5008;text-decoration:underline}
::selection{background:#F0DDBE}
summary::-webkit-details-marker{display:none}
@media (max-width:720px){
  header,section[id^="s"]{padding-left:16px !important;padding-right:16px !important}
  nav>div{padding:12px 16px !important;gap:8px !important}
  nav>div>div:first-child{font-size:10px !important}
  nav>div>div:last-child{gap:10px !important;font-size:10px !important;width:100%;overflow-x:auto;flex-wrap:nowrap !important}
  h1{font-size:36px !important}
  header>p{font-size:16px !important}
  .idx-scroll{overflow-x:auto}
  .idx-row{min-width:640px}
  .angle-row{grid-template-columns:120px 1fr 40px !important;gap:10px !important}
  .stat-grid>div{border-right:0 !important}
  footer{padding-left:16px !important;padding-right:16px !important;flex-direction:column !important}
}
@media (max-width:420px){ h1{font-size:30px !important} }
</style>
</head>
<body>
<div style="min-height:100vh;background:${C.paper}">
${siteBar({ topic: cfg.topic, labels: t.site, sticky: false, base: SITE_BASE })}

<nav style="position:sticky;top:0;z-index:20;background:rgba(250,249,246,.92);backdrop-filter:blur(8px);border-bottom:1px solid ${C.rule}">
  <div style="max-width:1140px;margin:0 auto;padding:14px 28px;display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap">
    <div style="font-family:${MONO};font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${C.ink}"><span style="color:${C.acc}">●</span>&nbsp; ${esc(cfg.label)} / ${esc(cfg.region)} &nbsp;<span style="color:${C.faint}">${esc(t.brandSuffix)}</span></div>
    <div style="display:flex;gap:18px;font-family:${MONO};font-size:11px;letter-spacing:.06em;flex-wrap:wrap">
      <a href="${SITE_BASE}/" style="color:${C.acc}">&larr; ${esc(t.site.reports)}</a>
      <a href="#s1" style="color:${C.dim}">${esc(t.nav[0])}</a>
      <a href="#s2" style="color:${C.dim}">${esc(t.nav[1])}</a>
      <a href="#s3" style="color:${C.dim}">${esc(t.nav[2])}</a>
      <a href="#s4" style="color:${C.dim}">${esc(t.nav[3])}</a>
      <a href="#s5" style="color:${C.dim}">${esc(t.nav[4])}</a>
      <a href="#s6" style="color:${C.dim}">${esc(t.nav[5])}</a>
      <a href="#s7" style="color:${C.dim}">${esc(t.nav[6])}</a>
    </div>
  </div>
</nav>

<header style="max-width:1140px;margin:0 auto;padding:88px 28px 0">
  ${kicker(`${t.kickerResearch} · ${stats.byChannel.map(c => CHANNEL_LABEL[c.channel] || c.channel).join(' · ')} · ${t.regenerated} ${new Date().toISOString().slice(0, 10)}`)}
  <h1 style="font-family:${SERIF};font-weight:400;font-size:clamp(52px,7.5vw,96px);line-height:.98;letter-spacing:-.015em;margin:22px 0 0">${esc(cfg.label)}<br><em style="color:${C.acc}">${esc(t.headline)}</em></h1>
  <p style="font-size:19px;line-height:1.6;color:${C.dim};max-width:62ch;margin:28px 0 0;text-wrap:pretty">${t.lede(stats.relevant, stats.advertisers)}</p>

  <div class="stat-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));border-top:1px solid ${C.ink};border-bottom:1px solid ${C.rule};margin-top:56px">
    ${stat(stats.relevant, t.stats.ads, 'ads')}
    ${stat(stats.advertisers, t.stats.advertisers, 'advertisers')}
    ${stat(stats.active, t.stats.active, 'active')}
    ${stat(newSince.length, t.stats.fresh, 'fresh')}
    ${stat(stats.total, t.stats.raw, 'raw')}
  </div>

  <div style="background:${C.card};border:1px solid ${C.rule};padding:24px 28px;margin-top:28px">
    ${kicker(t.method)}
    <p style="margin:10px 0 0;font-size:14.5px;line-height:1.7;color:${C.dim};text-wrap:pretty">${t.methodBody({ channels: esc(channelSummary), region: esc(cfg.region), raw: stats.total, relevant: stats.relevant, filterVersion: cfg.filterVersion, analysisVersion: cfg.analysisVersion, coverage })}</p>
  </div>

  ${coverage < 100 ? `
  <div style="background:${C.card};border:1px solid ${C.rule};border-left:3px solid ${C.accBright};padding:20px 24px;margin-top:20px">
    ${kicker(t.partial, C.accBright)}
    <p style="margin:10px 0 0;font-size:14.5px;line-height:1.7;color:${C.dim}">${t.partialBody(stats.analysed, stats.relevant, coverage)}</p>
  </div>` : ''}
</header>

<section id="s1" style="${SECTION}">
  ${sectionHead('01', t.s1, t.s1sub, SERIF)}
  <div style="margin-top:44px;display:flex;flex-direction:column;gap:14px;max-width:860px">
${angleRank.map(([n, c], i) => {
    const pct = Math.round(c / maxAngle * 100);
    const fill = i < 3 ? C.accBright : i < 6 ? C.accMid : C.accPale;
    return `    <div class="angle-row" style="display:grid;grid-template-columns:minmax(160px,240px) 1fr 52px;gap:16px;align-items:center"><div style="font-size:15px">${esc(term(L, 'angles', n))}</div><div style="background:${C.hair};height:26px"><div style="height:100%;width:${pct}%;background:${fill}"></div></div><div style="font-family:${MONO};font-size:14px;text-align:right;color:${C.ink}">${c}</div></div>`;
  }).join('\n')}
  </div>
  ${angleRank.length ? aside(t.s1note, t.s1noteBody(angleRank.slice(-3).map(([n]) => esc(term(L, 'angles', n))).join(', '))) : ''}
</section>

<section id="s2" style="${SECTION}">
  ${sectionHead('02', t.s2, t.s2sub, SERIF)}
  ${swipe.length ? `<div style="margin-top:44px;display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:1px;background:${C.rule};border:1px solid ${C.rule}">
${swipe.map(a => `    <div style="background:${C.card};padding:28px;display:flex;flex-direction:column;gap:14px">
      <div style="font-family:${SERIF};font-style:italic;font-size:23px;line-height:1.3;text-wrap:pretty">&ldquo;${esc(a.an.hook)}&rdquo;</div>
      <div style="margin-top:auto">
        <div style="font-family:${MONO};font-size:12px;color:${C.acc}">${esc(a.advertiser)}${(Array.isArray(a.angles) && a.angles[0]) ? ` · ${esc(term(L, 'angles', a.angles[0]))}` : ''}</div>
        ${a.an.notable ? `<div style="font-size:14px;line-height:1.6;color:${C.dim};margin-top:6px">${esc(a.an.notable)}</div>` : ''}
      </div>
    </div>`).join('\n')}
  </div>` : `<div style="margin-top:44px;color:${C.dim};font-size:15px">${t.s2empty}</div>`}
</section>

<section id="s3" style="${SECTION}">
  ${sectionHead('03', t.s3, t.s3sub, SERIF)}
  ${offers.length ? `<div style="overflow-x:auto;margin-top:40px">
    <table style="width:100%;border-collapse:collapse;font-size:14.5px;background:${C.card};border:1px solid ${C.rule}">
      <thead><tr>
        ${t.s3cols.map(c => `<th style="${TH}">${esc(c)}</th>`).join('')}
      </tr></thead>
      <tbody>
${offers.map(a => `        <tr><td style="${TD};font-weight:600;white-space:nowrap">${esc(a.advertiser)}</td><td style="${TD};color:${C.body}">${esc(a.an.offer)}</td><td style="${TD};font-family:${MONO};font-size:12.5px;color:${C.acc}">${esc((a.an.numbers || []).slice(0, 4).join('  ·  '))}</td><td style="${TD};color:${C.dim}">${esc(a.an.funnel ? term(L, 'funnels', a.an.funnel) : (a.an.cta || ''))}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </div>` : `<div style="margin-top:40px;color:${C.dim};font-size:15px">${esc(t.s3empty)}</div>`}
</section>

<section id="s4" style="${SECTION}">
  ${sectionHead('04', t.s4, t.s4sub, SERIF)}
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1px;background:${C.rule};border:1px solid ${C.rule};margin-top:44px">
    <div style="background:${C.card};padding:30px">
      ${kicker(t.s4a)}
      <div style="display:flex;flex-direction:column;gap:12px;margin-top:18px">
${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, n]) => `        <div style="display:grid;grid-template-columns:70px 1fr 44px;gap:12px;align-items:center;font-size:14px"><div style="font-family:${MONO};font-size:12px;color:${C.dim}">${esc(l)}</div><div style="background:${C.hair};height:20px"><div style="height:100%;width:${Math.round(n / ads.length * 100)}%;background:${C.accMid}"></div></div><div style="font-family:${MONO};font-size:13px;text-align:right">${n}</div></div>`).join('\n')}
      </div>
    </div>
    <div style="background:${C.card};padding:30px">
      ${kicker(t.s4b)}
      <div style="display:flex;flex-direction:column;gap:12px;margin-top:18px">
${Object.entries(funnels).sort((a, b) => b[1] - a[1]).map(([k, v]) => `        <div style="display:grid;grid-template-columns:110px 1fr 44px;gap:12px;align-items:center;font-size:14px"><div style="font-family:${MONO};font-size:12px;color:${C.dim}">${esc(term(L, 'funnels', k))}</div><div style="background:${C.hair};height:20px"><div style="height:100%;width:${Math.round(v / ads.length * 100)}%;background:${C.accBright}"></div></div><div style="font-family:${MONO};font-size:13px;text-align:right">${v}</div></div>`).join('\n') || `        <div style="color:${C.dim};font-size:14px">${esc(t.s4empty)}</div>`}
      </div>
    </div>
    <div style="background:${C.card};padding:30px">
      ${kicker(t.s4c)}
      <div style="display:flex;flex-direction:column;gap:12px;margin-top:18px">
${Object.entries(tierCounts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `        <div style="display:grid;grid-template-columns:1fr 44px;gap:12px;align-items:center;font-size:14px"><div>${tierChip(t)}</div><div style="font-family:${MONO};font-size:13px;text-align:right">${n}</div></div>`).join('\n')}
      </div>
    </div>
  </div>
</section>

<section id="s5" style="${SECTION}">
  ${sectionHead('05', t.s5, t.s5sub, SERIF)}
  ${synthesis ? `
  ${synthesis.summary ? `<p style="margin:36px 0 0;font-family:${SERIF};font-size:24px;line-height:1.45;max-width:70ch;text-wrap:pretty">${esc(synthesis.summary)}</p>` : ''}
  ${synthesis.whitespace?.length ? `
  <div style="margin-top:44px;display:flex;flex-direction:column;max-width:900px">
${synthesis.whitespace.map((x, i) => `    <div style="display:grid;grid-template-columns:88px 1fr;gap:24px;padding:26px 0;border-bottom:1px solid ${C.rule}"><div style="font-family:${SERIF};font-size:40px;line-height:1;color:${C.ghost}">${i + 1}</div><div style="font-size:16px;line-height:1.65;color:${C.dim};text-wrap:pretty">${esc(x)}</div></div>`).join('\n')}
  </div>` : ''}
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1px;background:${C.rule};border:1px solid ${C.rule};margin-top:44px">
    ${synthesis.saturated?.length ? `<div style="background:${C.card};padding:30px">
      ${kicker(t.saturated)}
      <ul style="margin:18px 0 0;padding-left:20px;font-size:14.5px;line-height:1.7;color:${C.dim}">${synthesis.saturated.map(x => `<li style="margin-bottom:8px">${esc(x)}</li>`).join('')}</ul>
    </div>` : ''}
    ${synthesis.standout_advertisers?.length ? `<div style="background:${C.card};padding:30px">
      ${kicker(t.standouts)}
      <ul style="margin:18px 0 0;padding-left:20px;font-size:14.5px;line-height:1.7;color:${C.dim}">${synthesis.standout_advertisers.map(x => `<li style="margin-bottom:8px">${esc(x)}</li>`).join('')}</ul>
    </div>` : ''}
  </div>` : `<div style="margin-top:40px;color:${C.dim};font-size:15px">${esc(t.noSynthesis)}</div>`}

  ${longest.length ? `
  <h3 style="font-family:${SERIF};font-weight:400;font-size:28px;margin:64px 0 0">${esc(t.longest)}</h3>
  <p style="color:${C.dim};font-size:15px;margin:10px 0 0;max-width:64ch">${esc(t.longestSub)}</p>
  <div style="overflow-x:auto;margin-top:28px">
    <table style="width:100%;border-collapse:collapse;font-size:14.5px;background:${C.card};border:1px solid ${C.rule}">
      <thead><tr>${t.longestCols.map(c => `<th style="${TH}">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>
${longest.map(r => `        <tr><td style="${TD};font-weight:600;white-space:nowrap">${esc(r.advertiser)}</td><td style="${TD};font-family:${MONO};color:${C.acc}">${Math.round(r.days_tracked)}</td><td style="${TD};color:${C.dim}">${esc((r.copy || '').split('\n')[0].slice(0, 110))}</td></tr>`).join('\n')}
      </tbody>
    </table>
  </div>` : `
  <div style="background:${C.card};border:1px solid ${C.rule};border-left:3px solid ${C.acc};padding:22px 26px;margin-top:48px;max-width:900px">
    ${kicker(t.longevityTitle)}
    <p style="margin:10px 0 0;font-size:15px;line-height:1.7;color:${C.dim}">${esc(t.longevityBody)}</p>
  </div>`}
</section>

<section id="s6" style="${SECTION}">
  ${sectionHead('06', t.s6, t.s6sub(advList.length), SERIF)}
  <div class="idx-scroll" style="margin-top:40px;background:${C.card};border:1px solid ${C.rule}">
    <div class="idx-row" style="display:grid;grid-template-columns:52px minmax(200px,1.4fr) 120px 170px 2fr;gap:14px;padding:12px 20px;border-bottom:1px solid ${C.ink};font-family:${MONO};font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:${C.dim}">
      ${t.s6cols.map(c => `<div>${esc(c)}</div>`).join('')}
    </div>
${advList.map(([name, list], i) => {
    const top = advList[0][1].length || 1;
    const tiers = [...new Set(list.map(x => x.tier).filter(Boolean))];
    const angs = [...new Set(list.flatMap(x => Array.isArray(x.angles) ? x.angles : []))];
    return `    <div class="idx-row" style="display:grid;grid-template-columns:52px minmax(200px,1.4fr) 120px 170px 2fr;gap:14px;padding:14px 20px;border-bottom:1px solid ${C.hair};align-items:center">
      <div style="font-family:${MONO};font-size:12px;color:${C.faint}">${String(i + 1).padStart(2, '0')}</div>
      <div><div style="font-weight:600;font-size:14.5px">${esc(name)}</div><div style="font-family:${MONO};font-size:11px;color:${C.faint};margin-top:2px">${esc([...new Set(list.map(x => x.lang).filter(Boolean))].join(', '))}</div></div>
      <div style="display:flex;align-items:center;gap:10px"><div style="font-family:${MONO};font-size:13px;min-width:20px">${list.length}</div><div style="flex:1;height:6px;background:${C.hair}"><div style="height:100%;width:${Math.round(list.length / top * 100)}%;background:${C.accBright}"></div></div></div>
      <div>${tiers.map(x => tierChip(x, L)).join(' ')}</div>
      <div style="font-size:12.5px;color:${C.dim};line-height:1.5">${angs.map(x => esc(term(L, 'angles', x))).join('  &middot;  ')}</div>
    </div>`;
  }).join('\n')}
  </div>
</section>

<section id="s7" style="${SECTION}">
  ${sectionHead('07', t.s7, t.s7sub, SERIF)}
  <div style="position:sticky;top:49px;z-index:10;background:rgba(250,249,246,.94);backdrop-filter:blur(8px);border-bottom:1px solid ${C.rule};display:flex;gap:10px;flex-wrap:wrap;align-items:center;padding:16px 0;margin-top:36px">
      ${tierButtons}
    <input id="q" placeholder="${esc(t.filterPlaceholder)}" style="flex:1;min-width:200px;background:${C.card};border:1px solid ${C.rule};padding:9px 16px;font-size:13px;font-family:'Instrument Sans',Helvetica,sans-serif;color:${C.ink};border-radius:0;outline:none">
    <div id="shownCount" style="font-family:${MONO};font-size:12px;color:${C.faint};white-space:nowrap">${ads.length} / ${ads.length} ${esc(t.shown)}</div>
  </div>
  <div id="grid" style="display:grid;gap:20px;margin-top:24px;grid-template-columns:repeat(auto-fill,minmax(310px,1fr))">
${gallery}
  </div>
</section>

<footer style="max-width:1140px;margin:96px auto 0;padding:28px;border-top:1px solid ${C.rule};display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;font-family:${MONO};font-size:11px;letter-spacing:.06em;color:${C.faint}">
  <div>solar-ads-engine &middot; topic ${esc(cfg.topic)} &middot; region ${esc(cfg.region)} &middot; filter v${cfg.filterVersion} &middot; analysis v${cfg.analysisVersion}</div>
  <div>${esc(t.footerSources(stats.byChannel.map(c => CHANNEL_LABEL[c.channel] || c.channel).join(', ')))}</div>
</footer>

</div>
<script>
(function () {
  var grid = document.getElementById('grid');
  var q = document.getElementById('q');
  var shownCount = document.getElementById('shownCount');
  var buttons = document.querySelectorAll('button[data-f]');
  var tier = 'all';
  var ON = { bg: '${C.ink}', fg: '${C.paper}', bd: '${C.ink}' };
  var OFF = { bg: '${C.card}', fg: '${C.ink}', bd: '${C.rule}' };
  function apply() {
    var term = q.value.trim().toLowerCase();
    var shown = 0, total = 0;
    grid.querySelectorAll('.ad-card').forEach(function (card) {
      total++;
      var okT = tier === 'all' || card.dataset.tier === tier;
      var okQ = !term || card.dataset.adv.indexOf(term) !== -1;
      var show = okT && okQ;
      card.style.display = show ? '' : 'none';
      if (show) shown++;
    });
    shownCount.textContent = shown + ' / ' + total + ' ${t.shown}';
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      buttons.forEach(function (x) {
        x.style.background = OFF.bg; x.style.color = OFF.fg; x.style.border = '1px solid ' + OFF.bd;
      });
      b.style.background = ON.bg; b.style.color = ON.fg; b.style.border = '1px solid ' + ON.bd;
      tier = b.dataset.f;
      apply();
    });
  });
  q.addEventListener('input', apply);
})();
</script>
</body>
</html>`;

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html);
  return { bytes: html.length, ads: ads.length };
}
