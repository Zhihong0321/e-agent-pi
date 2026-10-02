import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbFile, DATA_ROOT, OUT_DIR, ensureDataRoot } from './src/paths.mjs';
import { Store, nowIso } from './src/store.mjs';
import { makeFilter } from './src/filter.mjs';
import { analyzeNew, synthesize } from './src/analyze.mjs';
import { render } from './src/report.mjs';
import { isLang } from './src/i18n.mjs';
import * as meta from './src/channels/meta.mjs';
import * as googleAtc from './src/channels/google-atc.mjs';

const PORTABLE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const CONFIG_ROOT = process.env.ADS_CONFIG_ROOT
  ? path.resolve(process.env.ADS_CONFIG_ROOT)
  : path.join(PORTABLE_ROOT, 'config');

export const topicConfigPath = topic => path.join(CONFIG_ROOT, 'topics', `${topic}.json`);

function configPath(topic) {
  return topicConfigPath(topic);
}

export function loadTopic(topic) {
  const file = configPath(topic);
  if (!fs.existsSync(file)) throw new Error(`topic config not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function topicPaths(topic) {
  return {
    db: dbFile(topic),
    out: path.join(OUT_DIR, topic),
    shots: path.join(OUT_DIR, topic, 'shots'),
    raw: path.join(DATA_ROOT, 'data', 'raw', topic),
    frames: path.join(DATA_ROOT, 'data', 'frames', topic),
  };
}

export function openStore(topic) {
  ensureDataRoot();
  return new Store(dbFile(topic));
}

export function applyFilter(store, cfg) {
  const classify = makeFilter(cfg);
  const pending = store.adsNeedingFilter(cfg.topic, cfg.filterVersion);
  let relevant = 0;
  for (const ad of pending) {
    const result = classify(ad);
    store.setFilter(ad.id, { filterVersion: cfg.filterVersion, ...result });
    if (result.relevant) relevant++;
  }
  return { classified: pending.length, relevant };
}

async function collectChannel(store, cfg, p, mod, enabled, name, options = {}, log = console.error) {
  if (!enabled) return { new: 0, seen: 0 };
  const known = store.knownIds(cfg.topic, mod.CHANNEL);
  const totals = { new: 0, seen: 0 };
  await (mod.capture || mod.collect)(cfg, {
    ...options,
    shotsDir: p.shots,
    framesDir: p.frames,
    log,
    isKnown: id => known.has(String(id)),
    onAd: async ad => {
      const result = store.upsertAd(cfg.topic, mod.CHANNEL, ad);
      totals[result]++;
    },
  });
  return totals;
}

export async function collect(topic, { options = {}, log = console.error } = {}) {
  const cfg = loadTopic(topic);
  const p = topicPaths(topic);
  fs.mkdirSync(p.out, { recursive: true });
  fs.mkdirSync(p.shots, { recursive: true });
  const store = openStore(topic);
  try {
    const sweepStart = nowIso();
    const metaTotals = await collectChannel(store, cfg, p, meta, cfg.meta?.enabled, 'meta', options, log);
    const googleTotals = await collectChannel(store, cfg, p, googleAtc, cfg.googleAtc?.enabled, 'google_atc', options, log);
    if (cfg.meta?.enabled) store.markInactive(cfg.topic, meta.CHANNEL, sweepStart);
    if (cfg.googleAtc?.enabled) store.markInactive(cfg.topic, googleAtc.CHANNEL, sweepStart);
    const filtered = applyFilter(store, cfg);
    return { meta: metaTotals, googleAtc: googleTotals, filtered };
  } finally {
    store.close();
  }
}

export async function analyze(topic, { limit = 0, log = console.error } = {}) {
  const cfg = loadTopic(topic);
  const p = topicPaths(topic);
  const store = openStore(topic);
  try {
    const result = await analyzeNew(store, cfg, { rawDir: p.raw, root: p.out, log, limit });
    const synthesis = await synthesize(store, cfg, { rawDir: p.raw, root: p.out, log });
    return { ...result, synthesis };
  } finally {
    store.close();
  }
}

export async function report(topic, { lang = 'en', archive = true } = {}) {
  const cfg = loadTopic(topic);
  const L = isLang(lang) ? lang : 'en';
  const p = topicPaths(topic);
  fs.mkdirSync(p.out, { recursive: true });
  const store = openStore(topic);
  try {
    const stats = store.stats(topic, cfg.analysisVersion);
    const prevRun = store.lastRunBefore(topic);
    const newSince = store.newSince(topic, prevRun || '1970-01-01');
    const synthesis = store.kvGet(`synthesis:${topic}:${L}`)?.data
      ?? store.kvGet(`synthesis:${topic}`)?.data ?? null;
    const outFile = path.join(p.out, L === 'en' ? 'report.html' : `report.${L}.html`);
    const result = render(store, cfg, { outFile, synthesis, stats, newSince, prevRun, lang: L });
    let archiveFile = null;
    if (archive) {
      const stamp = nowIso().replace(/[:.]/g, '-').replace('Z', '');
      archiveFile = path.join(p.out, L === 'en' ? `report-${stamp}.html` : `report-${stamp}.${L}.html`);
      fs.copyFileSync(outFile, archiveFile);
    }
    return { ...result, outFile, archiveFile };
  } finally {
    store.close();
  }
}

export function status(topic) {
  const cfg = loadTopic(topic);
  const store = openStore(topic);
  try { return store.stats(topic, cfg.analysisVersion); } finally { store.close(); }
}
