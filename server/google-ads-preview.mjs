// Renders a responsive search ad the way Google Search shows it.
//
// There is no official preview API for RSAs — generateShareablePreviews covers
// Performance Max asset groups only — so this reproduces the search result
// layout from the ad's own fields. It is a faithful mockup, not a screenshot
// from Google, and the tool output says so.
//
// The important thing it communicates: an RSA is not one ad. Google assembles
// headlines and descriptions per auction, so the preview shows several of the
// combinations a searcher could actually see.

import { escapeHtml } from "./report-html.mjs";

/** Google shows up to three headlines, joined by a vertical bar. */
const HEADLINES_SHOWN = 3;
const DESCRIPTIONS_SHOWN = 2;

/**
 * Distinct headline groupings, walked in a stride so later assets appear too
 * rather than always previewing the first three.
 */
export function headlineCombinations(headlines, count = 4) {
  const list = headlines.filter(Boolean);
  if (list.length <= HEADLINES_SHOWN) return [list];

  const out = [];
  for (let start = 0; out.length < count && start < list.length; start += 1) {
    const combo = [];
    for (let step = 0; step < HEADLINES_SHOWN; step += 1) {
      combo.push(list[(start + step * Math.max(1, Math.floor(list.length / HEADLINES_SHOWN))) % list.length]);
    }
    // Skip a grouping that repeats an asset — it would misrepresent the ad.
    if (new Set(combo).size === HEADLINES_SHOWN && !out.some((c) => c.join("|") === combo.join("|"))) {
      out.push(combo);
    }
  }
  return out.length ? out : [list.slice(0, HEADLINES_SHOWN)];
}

export function displayUrl(finalUrl, path1, path2) {
  let host = "example.com";
  try {
    host = new URL(finalUrl).hostname.replace(/^www\./, "");
  } catch {
    /* fall through to the placeholder */
  }
  return [host, path1, path2].filter(Boolean).join("/");
}

function adCard({ headlines, descriptions, url, brand, mobile }) {
  const width = mobile ? "360px" : "600px";
  return `
<div style="max-width:${width};font-family:arial,sans-serif;background:#fff;border:1px solid #dadce0;border-radius:8px;padding:14px 16px;margin:0 0 12px 0">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
    <div style="width:26px;height:26px;border-radius:50%;background:#e8eaed;display:flex;align-items:center;justify-content:center;font-size:12px;color:#5f6368;font-weight:700">${escapeHtml(brand.slice(0, 1).toUpperCase())}</div>
    <div style="line-height:1.2">
      <div style="font-size:14px;color:#202124">${escapeHtml(brand)}</div>
      <div style="font-size:12px;color:#4d5156">${escapeHtml(url)}</div>
    </div>
  </div>
  <div style="font-size:12px;font-weight:700;color:#202124;margin:6px 0 2px 0">Sponsored</div>
  <div style="font-size:${mobile ? "18px" : "20px"};line-height:1.3;color:#1a0dab;margin-bottom:3px">${headlines.map(escapeHtml).join(" <span style=\"color:#5f6368\">|</span> ")}</div>
  <div style="font-size:14px;line-height:1.58;color:#4d5156">${descriptions.map(escapeHtml).join(" ")}</div>
</div>`;
}

/**
 * @param {{headlines: string[], descriptions: string[], finalUrl: string, path1?: string, path2?: string, brand?: string, combinations?: number}} ad
 */
export function renderSearchAdPreview(ad) {
  const headlines = (ad.headlines || []).map((h) => (typeof h === "string" ? h : h?.text)).filter(Boolean);
  const descriptions = (ad.descriptions || []).map((d) => (typeof d === "string" ? d : d?.text)).filter(Boolean);
  const url = displayUrl(ad.finalUrl, ad.path1, ad.path2);
  const brand = ad.brand || url.split("/")[0];

  const combos = headlineCombinations(headlines, ad.combinations || 4);
  const desktop = combos
    .map((combo, index) =>
      adCard({
        headlines: combo,
        descriptions: descriptions.slice(index % Math.max(1, descriptions.length - 1), (index % Math.max(1, descriptions.length - 1)) + DESCRIPTIONS_SHOWN),
        url,
        brand,
        mobile: false,
      }),
    )
    .join("");

  const mobile = adCard({
    headlines: combos[0],
    descriptions: descriptions.slice(0, DESCRIPTIONS_SHOWN),
    url,
    brand,
    mobile: true,
  });

  return { desktop, mobile, combinations: combos.length, headlines, descriptions, url };
}
