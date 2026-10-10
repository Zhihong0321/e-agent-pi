// Incremental LLM analysis. The only expensive stage, so it runs strictly on
// ads with missing or stale analysis. A weekly re-run analyses a handful of ads
// instead of the whole corpus.
//
// Three constraints learned the hard way:
//   1. Legion reads ONE TASK PER LINE. A prompt containing newlines is silently
//      split into several bogus tasks, so every task here must be single-line.
//      Ad copy therefore goes into a file and the worker is pointed at it.
//   2. The `general` worker type is intercepted by a "SuperPractical scope"
//      preamble and never does the work. `read` is the reliable type.
//   3. ONE AD PER WORKER + strict JSON. Large chunks truncated mid-answer and
//      lost advertisers silently; a JSON contract turns truncation into a
//      detectable parse error that the wrapper retries.
//
// Both stages prefer the named model in `config/llm.local.json` (see llm.mjs) and
// only fall back to the swarm when nothing is configured. The direct path has no
// single-line or file-indirection constraints, so the ad copy is inlined.
import fs from 'node:fs';
import path from 'node:path';
import { swarm } from './legion.mjs';
import { llmConfig, completeMany, complete } from './llm.mjs';
import { promptLangRule, isLang } from './i18n.mjs';
import { assertHostedStage } from './runtime.mjs';

// Kept on a single line on purpose — see constraint 1.
const SCHEMA = `Reply with ONLY a fenced json block and no other prose, using exactly these keys: {"positioning":"one line on who advertises and what they sell","hook":"the strongest line VERBATIM from the ad","offer":"the concrete offer/incentive VERBATIM or null","cta":"what action the ad asks for","funnel":"one of whatsapp|lead_form|messenger|phone|website|shop|none","numbers":["each price, RM figure, percentage or warranty term, verbatim"],"angles":["messaging angles e.g. bill-savings, govt-rebate, urgency, social-proof, free-assessment, warranty, zero-upfront"],"audience":"homeowner|commercial|civil-servant|rural|reseller|other","notable":"one line on what is distinctive about the copywriting, or null"}`;

const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim();

function writeAdFile(dir, ad) {
  const name = `${ad.channel}-${ad.native_id}.txt`;
  fs.writeFileSync(path.join(dir, name),
    `Advertiser: ${ad.advertiser || 'unknown'}\nChannel: ${ad.channel}\n\n${ad.copy || ''}`);
  return name;
}

const buildTask = file =>
  oneLine(`read: ads/${file} — This file contains ONE advertisement (an advertiser line, a channel line, then the ad copy). Analyse it for marketing research. Quote strictly from the copy; never invent text; use null for anything absent. ${SCHEMA}`);

const INSTRUCTION = 'Analyse this ONE advertisement for marketing research. Quote strictly from the copy; never invent text; use null for anything absent.';

const buildPrompt = ad =>
  `${INSTRUCTION} ${SCHEMA}\n\nAdvertiser: ${ad.advertiser || 'unknown'}\nChannel: ${ad.channel}\n\n${ad.copy || ''}`;

/** Direct-model path: one request per ad, run with a concurrency window. */
async function analyzeDirect(store, cfg, pending, { log }) {
  let analysed = 0, failed = 0;
  // 3, not 12: the provider rate-limits well below what raw concurrency allows,
  // and a 429 storm costs far more wall-clock than a smaller window ever saves.
  const concurrency = cfg.performance?.analysisConcurrency ?? 3;
  const results = await completeMany(pending.map(buildPrompt), {
    concurrency,
    maxTokens: 4000,
    onDone: (i, r) => {
      if (r.ok) analysed++; else { failed++; log(`  ! ad ${pending[i].native_id} (${pending[i].advertiser}): ${r.error}`); }
      const done = analysed + failed;
      const pct = Math.round((done / pending.length) * 100);
      if (done % 10 === 0 || done === pending.length) log(`  progress: ${analysed} ok / ${failed} failed of ${pending.length} (${pct}%)`);
    },
  });
  for (let i = 0; i < pending.length; i++) {
    if (results[i].ok) store.saveAnalysis(pending[i].id, cfg.analysisVersion, results[i].provider, results[i].json);
  }
  if (failed) log(`  NOTE: ${failed} ad(s) still unanalysed. Re-run \`analyze\` to retry just those.`);
  return { analysed, failed };
}

export async function analyzeNew(store, cfg, { rawDir, root, log = console.error, limit = 0 } = {}) {
  let pending = store.adsNeedingAnalysis(cfg.topic, cfg.analysisVersion);
  if (limit > 0) pending = pending.slice(0, limit);

  if (!pending.length) {
    log('  nothing to analyse — all relevant ads are current');
    return { analysed: 0, failed: 0 };
  }
  log(`  ${pending.length} ad(s) need analysis (version ${cfg.analysisVersion})`);

  assertHostedStage('analyze');
  const direct = llmConfig();
  if (direct) {
    log(`  model: ${direct.model}`);
    return analyzeDirect(store, cfg, pending, { log });
  }
  log('  no LLM configured — falling back to the legion swarm');

  const adsDir = path.join(root, 'ads');
  fs.mkdirSync(adsDir, { recursive: true });

  const BATCH = 24;
  let analysed = 0, failed = 0;

  for (let b = 0; b < pending.length; b += BATCH) {
    const batch = pending.slice(b, b + BATCH);
    const files = batch.map(ad => writeAdFile(adsDir, ad));
    const results = await swarm(files.map(buildTask), {
      preset: 'recon', root, rawDir, wantJson: true, retries: 1,
      label: `analyze-${Math.floor(b / BATCH) + 1}`, log,
    });

    for (let i = 0; i < batch.length; i++) {
      const r = results[i];
      if (r.ok && r.json) {
        store.saveAnalysis(batch[i].id, cfg.analysisVersion, r.provider, r.json);
        analysed++;
      } else {
        failed++;
        log(`  ! ad ${batch[i].native_id} (${batch[i].advertiser}): ${r.error}`);
      }
    }
    for (const f of files) { try { fs.unlinkSync(path.join(adsDir, f)); } catch { /* ignore */ } }
    const done = analysed + failed;
    const pct = Math.round((done / pending.length) * 100);
    log(`  progress: ${analysed} ok / ${failed} failed of ${pending.length} (${pct}%)`);
  }

  try { fs.rmdirSync(adsDir); } catch { /* not empty; harmless */ }
  if (failed) log(`  NOTE: ${failed} ad(s) still unanalysed. Re-run \`analyze\` to retry just those.`);
  return { analysed, failed };
}

/** One cached narrative pass over the corpus, keyed by a corpus hash. */
export async function synthesize(store, cfg, { rawDir, root, log = console.error, lang = 'en' } = {}) {
  const L = isLang(lang) ? lang : 'en';
  const ads = store.relevantAds(cfg.topic);
  if (!ads.length) return null;
  const hash = `${ads.length}:${cfg.analysisVersion}:${L}:${ads.at(-1)?.native_id ?? ''}`;
  const cached = store.kvGet(`synthesis:${cfg.topic}:${L}`);
  if (cached && cached.hash === hash) { log('  synthesis unchanged — using cache'); return cached.data; }

  // Feed the swarm distilled analyses, never the raw corpus.
  const digest = ads.map(a => {
    let an = {};
    try { an = JSON.parse(a.analysis_json || '{}'); } catch { /* unanalysed */ }
    return `${a.advertiser} | ${oneLine(an.hook)} | ${oneLine(an.offer)} | ${(an.angles || []).join(',')}`;
  }).join('\n').slice(0, 40000);

  const BRIEF = `Each line is "advertiser | hook | offer | angles" for one live ad in this market${cfg.label ? ` (${cfg.label})` : ''}. Write a competitive read for a marketer entering it. Reply with ONLY a fenced json block with exactly these keys: {"summary":"2-3 sentences on the state of this ad market","saturated":["angles so common they no longer differentiate"],"whitespace":["specific under-used angles, each with why it is an opportunity"],"standout_advertisers":["advertiser — one line on what they do better"]}${promptLangRule(L)}`;

  assertHostedStage('analyze');
  const direct = llmConfig();
  let res;
  if (direct) {
    log(`  synthesis model: ${direct.model}`);
    res = await complete(`${BRIEF}\n\n${digest}`, { maxTokens: 8000 });
  } else {
    fs.writeFileSync(path.join(root, 'digest.txt'), digest);
    [res] = await swarm([oneLine(`read: digest.txt — ${BRIEF}`)],
      { preset: 'recon', root, rawDir, wantJson: true, retries: 1, label: 'synthesis', log });
    try { fs.unlinkSync(path.join(root, 'digest.txt')); } catch { /* ignore */ }
  }

  if (!res.ok || !res.json) {
    log(`  ! synthesis failed (${res.error}) — report will render without it`);
    return null;
  }
  store.kvSet(`synthesis:${cfg.topic}:${L}`, { hash, data: res.json });
  return res.json;
}
