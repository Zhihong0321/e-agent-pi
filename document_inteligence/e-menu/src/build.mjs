/* Builds the E Menu pages. Usage: node src/build.mjs [en] [zh]   (default: both)
   Content lives in content.<lang>.mjs; layout in page.css, behaviour in page.js. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc, ph, sprite, ic, copyBtn } from './lib.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(dir, 'page.css'), 'utf8');
const jsTemplate = fs.readFileSync(path.join(dir, 'page.js'), 'utf8');
const safeJson = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const words = (s) => s.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
const chars = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;

async function build(code) {
  const { T, GROUPS, AREAS, STARTERS, LIMITS } = await import(`./content.${code}.mjs`);
  const COPYBTN = copyBtn(T.copyLabel);

  const prompt = (x) =>
    `<div class="pr"><p class="ptxt">${ph(x.t)}</p>${x.n ? `<span class="tag">${esc(x.n)}</span>` : ''}${COPYBTN}</div>`;

  function areaHTML(a) {
    const top = [];
    const rest = [];
    for (const grp of a.groups) {
      const r = [];
      for (const x of grp.p) (x.top ? top : r).push(x);
      if (r.length) rest.push({ l: grp.l, p: r });
    }
    const n = rest.reduce((s, x) => s + x.p.length, 0);
    const note = `<div class="note">${ic('shield')}<p><b>${esc(T.good)}</b>${T.goodSep}${esc(a.note)}</p></div>`;
    const more = n
      ? `<details class="more"><summary><span>${esc(T.more(n))}</span>${ic('chev', 'ic chev')}</summary><div class="inner">${rest
          .map((x) => `<p class="gl">${esc(x.l)}</p>${x.p.map(prompt).join('')}`)
          .join('')}${note}</div></details>`
      : note;
    return `<article class="area" id="${a.id}">
<header class="ah"><span class="ico">${ic(a.ic)}</span><div><h4>${esc(a.title)}</h4><p class="ok${a.okNone ? ' none' : ''}">${a.okNone ? esc(a.ok) : `${esc(T.needsOk)}${esc(a.ok)}`}</p></div></header>
<p class="intro">${esc(a.intro)}</p>
<div class="prs">${top.map(prompt).join('')}</div>
${more}
</article>`;
  }

  const menu = GROUPS.map((gname, gi) => {
    const list = AREAS.filter((a) => a.grp === gi);
    return `<h3 class="gtitle">${esc(gname)}</h3>${list.map(areaHTML).join('')}`;
  }).join('\n');

  const power = GROUPS.map((gname, gi) => {
    const list = AREAS.filter((a) => a.grp === gi);
    return `<p class="gt">${esc(gname)}</p><div class="rows">${list
      .map(
        (a) =>
          `<a class="row" href="#${a.id}"><span class="ico">${ic(a.ic)}</span><span class="rt"><b>${esc(a.title)}</b><span>${esc(a.lead)}</span></span>${ic('chev', 'ic chev')}</a>`
      )
      .join('')}</div>`;
  }).join('\n');

  const starters = STARTERS.map(
    (s) => `<article class="sc"><h3>${esc(s.t)}</h3>${prompt({ t: s.p, n: s.n })}</article>`
  ).join('\n');
  const limits = LIMITS.map(([h, t]) => `<div class="lim"><h3>${esc(h)}</h3><p>${esc(t)}</p></div>`).join('\n');
  const habits = T.habits.map(([h, t]) => `<article class="hb"><h3>${esc(h)}</h3><p>${esc(t)}</p></article>`).join('\n    ');

  const IDX = AREAS.flatMap((a) =>
    a.groups.flatMap((grp) => grp.p.map((x) => ({ a: a.title, id: a.id, t: x.t, n: x.n || '' })))
  );
  const js = jsTemplate
    .replace('__IDX__', safeJson(IDX))
    .replace('__COPY__', safeJson(COPYBTN))
    .replace('__T__', safeJson(T.js));

  const html = `<!doctype html>
<html lang="${T.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<title>${esc(T.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${T.fontHref}" rel="stylesheet">
<style>
${css}
${T.extraCss}
</style>
</head>
<body>
${sprite}

<header class="hero"><div class="wrap">
  <div class="top">
    <div class="brand"><span class="badge" aria-hidden="true">e</span><span>${esc(T.brand)}</span></div>
    <a class="lang" href="${T.otherHref}" hreflang="${T.otherLang}" lang="${T.otherLang}">${esc(T.otherLabel)}</a>
  </div>
  <h1>${esc(T.h1a)} <em>${esc(T.h1b)}</em></h1>
  <p class="sub">${esc(T.sub)}</p>
  <div class="panel" aria-label="${esc(T.panelLabel)}">
    <div class="chat">
      <div class="b you">${esc(T.chat.you1)}</div>
      <div class="b e">${esc(T.chat.e1a)}<div class="draft"><span>${esc(T.chat.item)}</span><b>${esc(T.chat.price)}</b></div>${esc(T.chat.e1b)}</div>
      <div class="b you">${esc(T.chat.you2)}</div>
    </div>
  </div>
  <ul class="chips">
    <li>${ic('chat')}${esc(T.chips[0])}</li>
    <li>${ic('shield')}${esc(T.chips[1])}</li>
    <li>${ic('hand')}${esc(T.chips[2])}</li>
  </ul>
  <div class="cta">
    <a class="btn" href="#start">${esc(T.ctaPrimary)} ${ic('down')}</a>
    <a class="link2" href="#power">${esc(T.ctaSecondary)}</a>
  </div>
</div></header>

<main>
<section class="sec" id="start"><div class="wrap">
  <p class="eyebrow">${esc(T.startEyebrow)}</p>
  <h2>${esc(T.startH2)}</h2>
  <p class="lede">${T.startLede}</p>
  <div class="start">
${starters}
  </div>
</div></section>

<section class="sec" id="power"><div class="wrap">
  <p class="eyebrow">${esc(T.powerEyebrow)}</p>
  <h2>${esc(T.powerH2)}</h2>
  <p class="lede">${esc(T.powerLede(AREAS.length))}</p>
  <div class="search">${ic('search')}<input id="q" type="search" placeholder="${esc(T.searchPlaceholder)}" aria-label="${esc(T.searchLabel)}" autocomplete="off"></div>
  <div id="res" hidden aria-live="polite"></div>
${power}
</div></section>

<section class="sec" id="habits"><div class="wrap">
  <p class="eyebrow">${esc(T.habitsEyebrow)}</p>
  <h2>${esc(T.habitsH2)}</h2>
  <div class="habits">
    ${habits}
  </div>
</div></section>

<section class="sec" id="menu"><div class="wrap">
  <p class="eyebrow">${esc(T.menuEyebrow)}</p>
  <h2>${esc(T.menuH2)}</h2>
${menu}
</div></section>

<section class="sec" id="limits"><div class="wrap">
  <p class="eyebrow">${esc(T.limitsEyebrow)}</p>
  <h2>${esc(T.limitsH2)}</h2>
  <p class="lede">${esc(T.limitsLede)}</p>
  <div class="lims">
${limits}
  </div>
</div></section>
</main>

<footer class="end"><div class="wrap">
  <h2>${esc(T.endH2)}</h2>
  <div class="stack">
    ${T.endPrompts.map((t) => prompt({ t })).join('\n    ')}
  </div>
  <p class="foot">${esc(T.foot)}</p>
</div></footer>

<a class="fab" id="fab" href="#power">${ic('list')}${esc(T.fab)}</a>
<div class="toast" id="toast" role="status" aria-live="polite" hidden></div>

<script>
${js}
</script>
</body>
</html>
`;

  const out = path.join(dir, '..', T.out);
  fs.writeFileSync(out, html, 'utf8');
  const visible = html.replace(/<script>[\s\S]*<\/script>/, '').replace(/<style>[\s\S]*?<\/style>/, '');
  console.log(
    `${code}: wrote ${out} (${(html.length / 1024).toFixed(1)} KB, ${AREAS.length} areas, ${IDX.length} menu prompts, ${STARTERS.length} starters, ~${code === 'zh' ? chars(visible) + ' characters' : words(visible) + ' words'})`
  );
}

const langs = process.argv.slice(2).length ? process.argv.slice(2) : ['en', 'zh'];
for (const l of langs) await build(l);
