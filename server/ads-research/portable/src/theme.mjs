// Shared design tokens. The report renderer and the web app both import these
// so a palette change lands in one place instead of two.

/** paper / ink / accent — the ground the whole deck is built on */
export const C = {
  paper: '#FAF9F6', card: '#FFFFFF', ink: '#1C1A16', body: '#3D392F',
  dim: '#6F6857', faint: '#9C947F', rule: '#E7E2D6', hair: '#F1EDE2',
  acc: '#B26A10', accBright: '#D98A24', accMid: '#E4B36C', accPale: '#EDD0A4', ghost: '#D9CFB8',
  ok: '#2E7D54', bad: '#A33A2A',
};

export const MONO = 'ui-monospace,Menlo,Consolas,monospace';
export const SERIF = "'Instrument Serif',Georgia,serif";
export const SANS = "'Instrument Sans',Helvetica,Arial,sans-serif";

export const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Instrument+Sans:ital,wght@0,400..700;1,400&display=swap" rel="stylesheet">`;

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const kicker = (text, color = C.acc) =>
  `<div style="font-family:${MONO};font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${color}">${esc(text)}</div>`;

/** Marks the big-number cells in a report's stat grid so they can be read back
 *  out later. Parsing rendered HTML by shape is brittle — this is the contract
 *  between the renderer and every consumer of an archived report. */
export const STAT_ATTR = 'data-stat';

/** Headline figures from a rendered report. Accepts the whole file or a head
 *  slice; matches the explicit data-stat markers, falling back to the visual
 *  shape for reports rendered before those markers existed. */
export function parseStats(html) {
  const out = {};
  for (const m of html.matchAll(/data-stat="([^"]+)"[^>]*>(\d+)</g)) {
    out[m[1]] = Number(m[2]);
  }
  if (Object.keys(out).length) return out;

  // Reports rendered before data-stat existed. Two earlier shapes:
  //   editorial: <div …font-size:56px…>N</div><div …>Label</div>
  //   original:  <div class="stat"><b>N</b><span>Label</span></div>
  const KEY = {
    'relevant ads tracked': 'ads', 'distinct advertisers': 'advertisers',
    'still running': 'active', 'new since last run': 'fresh',
    'raw ads before filtering': 'raw', 'advertisers': 'advertisers',
    'analysis coverage': null,
  };
  const take = (num, label) => {
    const key = KEY[label.trim().toLowerCase()];
    if (key && out[key] === undefined) out[key] = Number(num);
  };
  for (const m of html.matchAll(/font-size:56px;line-height:1">(\d+)<\/div>\s*<div[^>]*>([^<]+)</g)) take(m[1], m[2]);
  for (const m of html.matchAll(/<b>(\d+)<\/b><span>([^<]+)<\/span>/g)) take(m[1], m[2]);
  return out;
}

// ---- site-wide navigation ---------------------------------------------------
// Every page the server hands out — homepage, trend, admin and every archived
// report — carries the same bar. Reports are static files that were rendered at
// different times, so the server injects this into any that predate it; the
// marker attribute is how it tells the two apart.

/** Present on any document that already carries the site bar. */
export const SITE_NAV_ATTR = 'data-sitenav';

const SITE_LABELS = { reports: 'Reports', changed: 'What changed', admin: 'Admin', brand: 'Ads Research' };

/**
 * The site-wide bar. `active` is the current path so the matching link lights
 * up; `topic` adds that topic's trend link; `sticky` is for pages with no nav
 * of their own (a report has its own sticky nav and would collide).
 */
export function siteBar({ active = null, topic = null, labels = {}, sticky = true, base = '' } = {}) {
  const L = { ...SITE_LABELS, ...labels };
  const b = base.replace(/\/+$/, '');
  const links = [[`${b}/`, L.reports], ...(topic ? [[`${b}/trend/${topic}`, L.changed]] : []), [`${b}/admin`, L.admin]]
    .map(([href, label]) => {
      const on = active === href;
      return `<a href="${href}" style="color:${on ? C.accMid : '#B7B0A0'};text-decoration:none;border-bottom:1px solid ${on ? C.accMid : 'transparent'};padding-bottom:2px">${esc(label)}</a>`;
    }).join('\n      ');

  return `<nav ${SITE_NAV_ATTR}="1" style="${sticky ? 'position:sticky;top:0;z-index:40;' : ''}background:${C.ink};color:${C.paper}">
  <div style="max-width:1140px;margin:0 auto;padding:9px 28px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;font-family:${MONO};font-size:11px;letter-spacing:.1em;text-transform:uppercase">
    <a href="${b}/" style="color:${C.paper};text-decoration:none"><span style="color:${C.accBright}">●</span>&nbsp; ${esc(L.brand)}</a>
    <div style="display:flex;gap:20px;align-items:center">
      ${links}
    </div>
  </div>
</nav>`;
}

/** Base page chrome shared by every non-report page. */
export const BASE_CSS = `
html,body{margin:0;padding:0;background:${C.paper}}
body{font-family:${SANS};color:${C.ink};-webkit-font-smoothing:antialiased}
a{color:${C.acc};text-decoration:none}
a:hover{color:#8A5008;text-decoration:underline}
::selection{background:#F0DDBE}
button{font-family:${SANS};border-radius:0;cursor:pointer}
@media (max-width:720px){
  header,main,nav>div,footer{padding-left:16px !important;padding-right:16px !important}
  h1{font-size:38px !important}
}`;
