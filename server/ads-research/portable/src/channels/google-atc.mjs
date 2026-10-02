// Google Ads Transparency Centre channel. Public, no login.
//
// The ATC has NO free-text keyword search, so this channel is driven by the
// `googleAtc.domains` seed list rather than by queries. Three levels:
//
//   1. domain page      -> advertiser ids (a domain page only previews 4 ads)
//   2. advertiser page  -> every creative id, via the SearchCreatives RPC the
//                          page itself fires while lazy-loading (intercepted,
//                          not replayed — the browser is already open for #3)
//   3. creative page    -> for image ads the API already gives a CDN url, no
//                          browser needed; for text/html ads the copy lives
//                          inside a nested iframe, so the page is visited and
//                          the winning frame's HTML is dumped to disk
//
// capture() is the only network-touching half. It writes raw frame HTML to
// disk and does a best-effort inline extraction so a plain `collect`/`run`
// stays a complete one-shot. extract() is the offline half: it re-parses
// whatever is already on disk, zero network, zero LLM — re-run it for free
// after fixing a template parser, instead of re-scraping.
import fs from 'node:fs';
import path from 'node:path';
import { launch, isBlocked } from './browser.mjs';

export const CHANNEL = 'google_atc';
const BASE = 'https://adstransparency.google.com';

const domainUrl = (region, d) => `${BASE}/?region=${region}&domain=${encodeURIComponent(d)}`;
const advUrl = (region, ar) => `${BASE}/advertiser/${ar}?region=${region}`;
const creativeUrl = (region, ar, cr) => `${BASE}/advertiser/${ar}/creative/${cr}?region=${region}`;

/** Scroll the advertiser page until the creative count stops growing. Also
 *  what keeps the SearchCreatives RPC firing for every lazy-loaded page. */
async function loadAll(page, maxRounds = 16) {
  let last = -1, stable = 0;
  for (let i = 0; i < maxRounds; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('creative-preview').length);
    if (n === last) { if (++stable >= 3) break; } else stable = 0;
    last = n;
    await page.mouse.wheel(0, 8000);
    await page.waitForTimeout(1600);
  }
  return last;
}

// ---- extraction (pure, offline, no LLM) ------------------------------------
// Applied both at capture time (to score candidate frames) and at extract
// time (to re-parse dumped HTML from disk).

function stripHtml(s) {
  return s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function safeDecode(s) { try { return decodeURIComponent(s || ''); } catch { return s || ''; } }

/** The `mys-content`-family responsive text ad. Fields carry BOTH a
 *  per-render hash class (`ns-xxxxx-e-N` — never select on those) and a
 *  stable semantic marker: a `data-asoch-targets="ad0,titleClk"`-style
 *  attribute (preferred) and a `title`/`url`/`button` class token (fallback). */
function extractGeneric(html) {
  const byTarget = name => {
    const m = html.match(new RegExp(`data-asoch-targets="[^"]*\\b${name}\\b[^"]*"[^>]*>([\\s\\S]*?)</a>`, 'i'));
    return m ? stripHtml(m[1]) : null;
  };
  const byClass = cls => {
    const m = html.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>\\s*<a[^>]*>([\\s\\S]*?)</a>`, 'i'));
    return m ? stripHtml(m[1]) : null;
  };
  const headline = byTarget('titleClk') || byClass('title');
  const displayUrl = byTarget('urlClk') || byClass('url');
  const cta = byTarget('btnClk') || byClass('button');

  // description: the longest adurl= anchor that isn't the title/url/button one
  const bodies = [...html.matchAll(/<a[^>]*\badurl=([^"'&]*)[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ landing: safeDecode(m[1]), text: stripHtml(m[2]) }))
    .filter(x => x.text.length > 15 && x.text !== headline && x.text !== displayUrl && x.text !== cta)
    .sort((a, c) => c.text.length - a.text.length);
  const description = bodies[0]?.text || null;
  const landing = bodies[0]?.landing || null;

  if (!headline && !description && !displayUrl) return null;
  return { template: 'text', headline, description, displayUrl, cta, landing };
}

/** Video ad — the frame's own <title> is just "YouTube", not useful; the
 *  embed src carries the video id, which is the one deterministic fact. */
function extractYouTube(html) {
  const m = html.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{6,})/);
  if (!m) return null;
  return { template: 'video', headline: null, description: null, displayUrl: null, cta: null,
    landing: `https://www.youtube.com/watch?v=${m[1]}` };
}

/** Local Ad Rendering Service — business name in `.o89p9e`, a `.rMoTmb` line
 *  that mixes real data with unfilled template placeholders like
 *  "<Rating (Reviews)> · <Distance> · Petaling Jaya" — only the trailing
 *  non-placeholder segments (e.g. the town) are real. */
function extractLocalAd(html) {
  const nameM = html.match(/class="[^"]*\bo89p9e\b[^"]*"[^>]*>([^<]{2,120})</);
  const locM = html.match(/class="[^"]*\brMoTmb\b[^"]*"[^>]*>([\s\S]{0,300}?)<\/div>/i);
  if (!nameM && !locM) return null;
  const business = nameM ? stripHtml(nameM[1]) : null;
  let location = null;
  if (locM) {
    const parts = stripHtml(locM[1]).split('·').map(s => s.trim()).filter(s => s && !/^<.*>$/.test(s));
    location = parts.join(', ') || null;
  }
  if (!business && !location) return null;
  return { template: 'local', headline: business, description: location, displayUrl: null, cta: null, landing: null };
}

/** Dispatch by structural fingerprint, not by a fragile "which fixture is
 *  this" label. Returns null (never a guess) for a template not yet handled —
 *  e.g. a genuine SafeFrame image banner with no text at all. */
export function fingerprint(html) {
  return extractGeneric(html) || extractYouTube(html) || extractLocalAd(html) || null;
}

/** How many usable fields a candidate frame yields — used at capture time to
 *  pick the real ad frame over a SafeFrame wrapper shell (bug: "any frame >
 *  20KB" was picking the wrapper). Prefers substance over raw byte size. */
function score(html) {
  const r = fingerprint(html);
  if (!r) return 0;
  return ['headline', 'description', 'displayUrl', 'cta'].filter(k => r[k]).length;
}

function copyFrom(r) {
  return r ? [r.headline, r.description, r.displayUrl].filter(Boolean).join('\n') : '';
}

// ---- capture (network) ------------------------------------------------------

export async function capture(cfg, { shotsDir, framesDir, log = console.error, onAd, isKnown = () => false, forceRefetch = () => false }) {
  const c = cfg.googleAtc;
  const cap = c.maxPerAdvertiser ?? 30;
  const maxMemoryMB = cfg.performance?.maxMemoryMB ?? 1024;
  const { browser, ctx } = await launch();
  const page = await ctx.newPage();
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });
  const stats = { domains: 0, advertisers: 0, seen: 0, fetched: 0, skipped: 0, imaged: 0, framed: 0, unresolved: 0, blocked: false };

  // Memory check helper
  const checkMemory = () => {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    if (heapMB > maxMemoryMB) {
      log(`  ! [google] memory usage ${heapMB}MB exceeds limit ${maxMemoryMB}MB — consider reducing googleAtcConcurrency`);
    }
    return heapMB;
  };

  // ---- level 1: domains -> advertiser ids ---------------------------------
  const advertisers = new Map(); // AR id -> seed label

  for (const entry of c.advertiserIds ?? []) {
    const id = typeof entry === 'string' ? entry : entry.id;
    const label = typeof entry === 'string' ? 'pinned' : (entry.label || 'pinned');
    if (id) advertisers.set(id, label);
  }
  if (advertisers.size) log(`  [google] ${advertisers.size} pinned advertiser(s)`);

  for (const domain of c.domains) {
    try {
      await page.goto(domainUrl(cfg.region, domain), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(c.settleMs ?? 6000);
      stats.domains++;
      if (await isBlocked(page)) { log(`  ! [google] bot wall on ${domain} — skipping, not bypassing`); stats.blocked = true; continue; }
      const body = await page.evaluate(() => document.body.innerText || '');
      if (/No ads found/i.test(body)) { log(`  [google] ${domain}: no ads`); continue; }
      const ids = await page.evaluate(() => [...new Set(
        [...document.querySelectorAll('a[href*="/advertiser/"]')]
          .map(a => ((a.getAttribute('href') || '').match(/\/advertiser\/(AR[\w-]+)/) || [])[1])
          .filter(Boolean))]);
      for (const id of ids) if (!advertisers.has(id)) advertisers.set(id, domain);
      log(`  [google] ${domain}: ${ids.length} advertiser account(s)`);
    } catch (e) { log(`  ! [google] ${domain}: ${e.message}`); }
  }

  // ---- level 2: advertiser -> creatives, via SearchCreatives interception --
  for (const [ar, domain] of advertisers) {
    try {
      const rows = new Map(); // CR id -> row
      const onResp = async r => {
        if (!r.url().includes('SearchCreatives')) return;
        try {
          const j = JSON.parse(await r.text());
          for (const row of (j['1'] || [])) {
            const cr = row['2'];
            if (cr) rows.set(cr, row);
          }
        } catch { /* not JSON, or body already consumed by another listener */ }
      };
      page.on('response', onResp);
      await page.goto(advUrl(cfg.region, ar), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(c.settleMs ?? 6000);
      stats.advertisers++;

      const name = await page.evaluate(() => {
        const t = (document.body.innerText || '').split('\n').map(s => s.trim()).filter(Boolean);
        const i = t.indexOf('Ad details') >= 0 ? t.indexOf('Ad details') : t.indexOf('FAQs');
        return i > 1 ? t[i - 1] : null;
      });

      await loadAll(page);
      page.off('response', onResp);
      log(`  [google] ${name || ar} (${domain}): ${rows.size} creative(s)`);

      if (rows.size > cap) {
        log(`    ! capped at ${cap} of ${rows.size} — raise googleAtc.maxPerAdvertiser, or re-run to backfill the rest`);
      }

      // ---- level 3: per creative — image via CDN, text via frame dump ----
      // A --refetch-missing target bypasses the discovery cap entirely: it's
      // an explicitly bounded repair list (store.adsNeedingShot), not
      // open-ended new-creative discovery, so it must not be starved by
      // brand-new creatives crowding the same per-advertiser cap.
      const concurrency = cfg.performance?.googleAtcConcurrency ?? 10;
      const creativeEntries = Array.from(rows.entries());
      let used = 0;

      for (let batch = 0; batch < creativeEntries.length; batch += concurrency) {
        const batchEntries = creativeEntries.slice(batch, batch + concurrency);
        const promises = batchEntries.map(async ([cr, row]) => {
          stats.seen++;
          const mustRefetch = forceRefetch(cr);
          if (!mustRefetch && used >= cap) { stats.skipped++; return null; }

          const advertiserName = row['12'] || name || domain;
          const firstShown = row['6']?.['1'] ?? null;
          const lastShown = row['7']?.['1'] ?? null;
          const format = row['4'] ?? null;
          const imgHtml = row['3']?.['3']?.['2'];
          const previewUrl = row['3']?.['1']?.['4'];
          const imgSrc = imgHtml ? (imgHtml.match(/src\s*=\s*"([^"]+)"/) || [])[1] : null;

          // Incremental: a creative we already have needs no re-fetch, unless
          // the caller explicitly asked to backfill it (--refetch-missing).
          if (!mustRefetch && isKnown(cr)) {
            stats.skipped++;
            await onAd({ native_id: cr, advertiser: advertiserName, queries: [domain], copy: '' });
            return null;
          }
          if (!mustRefetch) used++;

          let shot = null, copy = '';
          const extra = { advertiser_id: ar, source_domain: domain, format, first_shown: firstShown, last_shown: lastShown };

          if (imgSrc) {
            try {
              const res = await fetch(imgSrc);
              if (res.ok) {
                const buf = Buffer.from(await res.arrayBuffer());
                const extM = imgSrc.match(/\.(png|jpe?g|gif|webp)(?:$|\?)/i);
                const ext = extM ? extM[1].toLowerCase() : 'png';
                fs.writeFileSync(path.join(shotsDir, `gatc-${cr}.${ext}`), buf);
                shot = `shots/gatc-${cr}.${ext}`;
                stats.imaged++;
              }
            } catch (e) { log(`    ! image ${cr}: ${e.message.slice(0, 60)}`); }
          }

          if (previewUrl) {
            try {
              await page.goto(creativeUrl(cfg.region, ar, cr), { waitUntil: 'domcontentloaded', timeout: 45000 });
              let best = '', bestScore = -1;
              for (let t = 0; t < 12; t++) {
                await page.waitForTimeout(500);
                for (const fr of page.frames()) {
                  if (fr === page.mainFrame()) continue;
                  try {
                    const html = await fr.content();
                    if (html.length < 2000) continue;
                    const sc = score(html);
                    if (sc > bestScore || (sc === bestScore && html.length > best.length)) { best = html; bestScore = sc; }
                  } catch { /* torn-down or cross-origin frame */ }
                }
                if (bestScore > 0) break;
              }
              if (best) {
                fs.writeFileSync(path.join(framesDir, `${ar}_${cr}.html`), best);
                const r = fingerprint(best);
                if (r) { copy = copyFrom(r); extra.template = r.template; extra.cta = r.cta; if (r.landing) extra.landing = r.landing; }
                else { extra.template = 'unresolved'; stats.unresolved++; }
                stats.framed++;
              }
            } catch (e) { log(`    ! creative ${cr}: ${e.message.slice(0, 60)}`); }
          }

          stats.fetched++;
          return {
            native_id: cr,
            advertiser: advertiserName,
            started: firstShown ? String(firstShown) : null,
            copy,
            links: [creativeUrl(cfg.region, ar, cr), `https://${domain}`],
            queries: [domain],
            extra,
            shot,
          };
        });

        const results = await Promise.allSettled(promises);
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value) {
            await onAd(result.value);
          }
        }

        // Check memory after each batch
        checkMemory();
      }
    } catch (e) { log(`  ! [google] advertiser ${ar}: ${e.message}`); }
  }

  await browser.close();
  const finalMem = checkMemory();
  log(`  [google] ${stats.fetched} fetched (${stats.imaged} images, ${stats.framed} frames, ${stats.unresolved} unresolved), ${stats.skipped} already known`);
  log(`  [google] memory: ${finalMem}MB heap used`);
  return stats;
}

// ---- extract (offline, disk only) -------------------------------------------

/** Re-parse every dumped frame from disk. Zero network, zero LLM — safe to
 *  re-run after fixing a template parser without touching the site again. */
export function extractFrames(framesDir) {
  if (!fs.existsSync(framesDir)) return [];
  const files = fs.readdirSync(framesDir).filter(f => f.endsWith('.html'));
  const out = [];
  for (const f of files) {
    const m = f.match(/^(AR[\w-]+)_(CR[\w-]+)\.html$/);
    if (!m) continue;
    const [, advertiserId, nativeId] = m;
    const html = fs.readFileSync(path.join(framesDir, f), 'utf8');
    const r = fingerprint(html);
    out.push({
      advertiserId,
      nativeId,
      template: r?.template ?? 'unresolved',
      copy: copyFrom(r),
      headline: r?.headline ?? null,
      displayUrl: r?.displayUrl ?? null,
      cta: r?.cta ?? null,
      landing: r?.landing ?? null,
    });
  }
  return out;
}
