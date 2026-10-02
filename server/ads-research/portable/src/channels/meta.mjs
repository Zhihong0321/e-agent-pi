// Meta Ad Library channel. Public, no login required.
// Ads are keyed by their "Library ID", which is stable across runs — that is
// what makes incremental collection possible.
import fs from 'node:fs';
import path from 'node:path';
import { launch, isBlocked } from './browser.mjs';

export const CHANNEL = 'meta';

const url = (region, q) =>
  `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${region}` +
  `&q=${encodeURIComponent(q)}&search_type=keyword_unordered&media_type=all`;

// Runs inside the page. Finds each ad card by walking up from its Library ID
// label until the parent holds several sibling cards.
const EXTRACT = () => {
  const labels = [...document.querySelectorAll('span,div')].filter(
    e => e.children.length === 0 && /^Library ID:/.test(e.textContent.trim())
  );
  const out = [];
  const seen = new Set();
  for (const s of labels) {
    let n = s;
    for (let i = 0; i < 12 && n.parentElement; i++) {
      const p = n.parentElement;
      const sibs = [...p.children].filter(c => /Library ID:/.test(c.textContent)).length;
      if (sibs >= 3 && n.innerText.length > 200) break;
      n = p;
    }
    if (seen.has(n)) continue;
    seen.add(n);
    const t = n.innerText || '';
    const id = (t.match(/Library ID:\s*(\d+)/) || [])[1];
    if (!id) continue;
    n.setAttribute('data-scrape-id', id);
    const lines = t.replace(/\r/g, '').split('\n').map(x => x.trim());
    const si = lines.findIndex(l => l === 'Sponsored');
    out.push({
      native_id: id,
      advertiser: si > 0 ? lines[si - 1] : null,
      started: (t.match(/Started running on ([^\n]+)/) || [])[1] || null,
      copy: si >= 0 ? lines.slice(si + 1).filter(Boolean).join('\n') : t,
      links: [...n.querySelectorAll('a')].map(a => a.href)
        .filter(h => h && !h.includes('facebook.com/ads/library')).slice(0, 6),
    });
  }
  return out;
};

async function scrapeQuery(browser, ctx, q, { cfg, shotsDir, onAd, log }, retryCount = 0) {
  const c = cfg.meta;
  const page = await ctx.newPage();
  const result = { queries: 0, seen: 0, blocked: false };

  try {
    log(`  [meta] "${q}"`);
    await page.goto(url(cfg.region, q), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(c.settleMs ?? 6000);

    if (await isBlocked(page)) {
      log(`  ! [meta] bot wall on "${q}" — skipping, not bypassing`);
      result.blocked = true;
      return result;
    }

    for (let i = 0; i < (c.scrolls ?? 4); i++) {
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(c.scrollWaitMs ?? 2500);
    }

    const cards = await page.evaluate(EXTRACT);
    log(`    ${cards.length} cards`);
    result.queries++;

    for (const card of cards) {
      result.seen++;
      const rel = `shots/meta-${card.native_id}.png`;
      const abs = path.join(shotsDir, `meta-${card.native_id}.png`);
      // Screenshot only if we do not already have one — saves time on re-runs.
      if (!fs.existsSync(abs)) {
        const el = await page.$(`[data-scrape-id="${card.native_id}"]`);
        if (el) {
          try {
            await el.scrollIntoViewIfNeeded();
            await page.waitForTimeout(350);
            await el.screenshot({ path: abs });
          } catch { /* card scrolled out of view; copy is still captured */ }
        }
      }
      await onAd({ ...card, queries: [q], shot: fs.existsSync(abs) ? rel : null });
    }
  } catch (e) {
    // Detect rate limiting and retry with exponential backoff
    if ((e.message.includes('429') || e.message.includes('rate limit')) && retryCount < 3) {
      const backoffMs = Math.pow(2, retryCount) * 2000; // 2s, 4s, 8s
      log(`  ! [meta] rate limit on "${q}" — backing off ${backoffMs}ms (retry ${retryCount + 1}/3)`);
      await page.close();
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      return scrapeQuery(browser, ctx, q, { cfg, shotsDir, onAd, log }, retryCount + 1);
    }
    log(`  ! [meta] "${q}": ${e.message}`);
  } finally {
    await page.close();
  }

  return result;
}

export async function collect(cfg, { shotsDir, log = console.error, onAd }) {
  const c = cfg.meta;
  const concurrency = cfg.performance?.metaConcurrency ?? 3;
  const maxMemoryMB = cfg.performance?.maxMemoryMB ?? 1024;
  fs.mkdirSync(shotsDir, { recursive: true });

  const { browser, ctx } = await launch();
  const stats = { queries: 0, seen: 0, blocked: false };
  let consecutiveFailures = 0;

  // Memory check helper
  const checkMemory = () => {
    const usage = process.memoryUsage();
    const heapMB = Math.round(usage.heapUsed / 1024 / 1024);
    if (heapMB > maxMemoryMB) {
      log(`  ! [meta] memory usage ${heapMB}MB exceeds limit ${maxMemoryMB}MB — consider reducing metaConcurrency`);
    }
    return heapMB;
  };

  // Process queries in parallel batches
  const queries = c.queries || [];
  for (let i = 0; i < queries.length; i += concurrency) {
    const batch = queries.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(q => scrapeQuery(browser, ctx, q, { cfg, shotsDir, onAd, log }))
    );

    // Merge stats and detect rate limiting pattern
    let batchBlocked = 0;
    for (const r of results) {
      stats.queries += r.queries;
      stats.seen += r.seen;
      stats.blocked = stats.blocked || r.blocked;
      if (r.blocked) batchBlocked++;
    }

    // Check memory after each batch
    checkMemory();

    // If entire batch was blocked, fall back to sequential mode
    if (batchBlocked === batch.length) {
      consecutiveFailures++;
      if (consecutiveFailures >= 2) {
        log(`  ! [meta] rate limiting detected (${consecutiveFailures} batches blocked) — falling back to sequential mode`);
        // Process remaining queries one at a time with longer delays
        for (let j = i + concurrency; j < queries.length; j++) {
          const r = await scrapeQuery(browser, ctx, queries[j], { cfg, shotsDir, onAd, log });
          stats.queries += r.queries;
          stats.seen += r.seen;
          stats.blocked = stats.blocked || r.blocked;
          if (j < queries.length - 1) await new Promise(resolve => setTimeout(resolve, 5000));
        }
        break;
      }
    } else {
      consecutiveFailures = 0;
    }
  }

  await browser.close();
  const finalMem = checkMemory();
  log(`  [meta] memory: ${finalMem}MB heap used`);
  return stats;
}
