// Direct OpenAI-compatible client for the judgement-heavy stages.
//
// The legion swarm is a good fit for grunt work, but per-ad analysis and the
// market synthesis are the two places where model quality shows up in the
// report, so they get a single named model over a plain HTTP call instead of a
// rotating worker fleet. Fewer moving parts, no `<think>` leakage, no
// one-task-per-line constraint, and a provider string we can actually trust in
// the `analysis.provider` column.
//
// Credentials never live in the repo: `config/llm.local.json` is gitignored,
// env vars override it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractJson } from './legion.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let cached;

/** Resolved model config, or null when nothing is configured (caller falls back to the swarm). */
export function llmConfig() {
  if (cached !== undefined) return cached;
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'llm.local.json'), 'utf8'));
  } catch { /* no local config — env only */ }

  const baseUrl = process.env.ADS_LLM_BASE_URL || file.baseUrl;
  const model = process.env.ADS_LLM_MODEL || file.model;
  const apiKey = process.env.ADS_LLM_KEY || file.apiKey;

  cached = baseUrl && model && apiKey
    ? { baseUrl: baseUrl.replace(/\/+$/, ''), model, apiKey, providerHost: process.env.ADS_LLM_PROVIDER_HOST || '' }
    : null;
  return cached;
}

/** `provider` string stored alongside an analysis row. */
export const providerTag = cfg => `${cfg.providerHost || new URL(cfg.baseUrl).host}::${cfg.model}`;

// In hosted runs `baseUrl` points at the host's LLM gate (server/queue/llm-proxy.mjs): calls wait in the
// provider's line there, upstream 429s are waited out and re-sent there, and real provider errors arrive
// here unchanged. So this client has no rate-limit loop and no per-call timer of its own: a timer started
// here would also count the time the call spends waiting in line.
async function once(cfg, prompt, maxTokens) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      ...(cfg.model === 'MiniMax-M3.1-Flash-Preview'
        ? { max_completion_tokens: Math.max(maxTokens, 8192), reasoning_effort: 'low' }
        : { max_tokens: maxTokens }),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const choice = body.choices?.[0];
  const text = choice?.message?.content ?? '';
  // A truncated answer is a parse error waiting to happen — surface it as a failure
  // so the retry below gets a shot rather than storing half an object.
  if (choice?.finish_reason === 'length') throw new Error('truncated (finish_reason=length)');
  if (!text.trim()) throw new Error('empty completion');
  return { text, usage: body.usage ?? null };
}

/**
 * One prompt -> parsed JSON. Retries on transport errors and unparseable answers.
 * Never throws; failures come back as `{ ok: false, error }`.
 */
export async function complete(prompt, { maxTokens = 4000, retries = 2, wantJson = true } = {}) {
  const cfg = llmConfig();
  if (!cfg) return { ok: false, error: 'no LLM configured' };

  let lastErr = 'unknown';
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { text, usage } = await once(cfg, prompt, maxTokens);
      if (!wantJson) return { ok: true, text, usage, provider: providerTag(cfg) };
      const json = extractJson(text);
      if (json) return { ok: true, json, text, usage, provider: providerTag(cfg) };
      lastErr = 'no parseable JSON in answer';
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { ok: false, error: lastErr, provider: providerTag(cfg) };
}

/** Run prompts with a fixed concurrency window, preserving input order. */
export async function completeMany(prompts, { concurrency = 6, onDone, ...opts } = {}) {
  const results = new Array(prompts.length);
  let next = 0;
  const worker = async () => {
    while (next < prompts.length) {
      const i = next++;
      results[i] = await complete(prompts[i], opts);
      onDone?.(i, results[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, prompts.length) }, worker));
  return results;
}
