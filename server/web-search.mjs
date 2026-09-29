import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { apiToken } from "./auth.mjs";
import { JINA_KEY_NAMES, secret } from "./secrets.mjs";

/**
 * Keyword web search for agents, backed by Jina's s.jina.ai. Up to five Jina
 * tokens (Settings -> Keys) are used round-robin, so a free plan's rate limit
 * and token allowance are spread across them. Agents never see the tokens:
 * they call /api/internal/web-search with SEARCH_TOKEN via $CLOUD_PI_SEARCH.
 */

/** Bearer token agents present to /api/internal/web-search. Fresh per boot, never persisted. */
export const SEARCH_TOKEN = randomBytes(32).toString("hex");

const ENDPOINT = "https://s.jina.ai/";
const TIMEOUT_MS = 25000;
const MAX_QUERY_CHARS = 400;
const MAX_CONTENT_CHARS = 4000;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;

/** Statuses where another token might succeed: auth, quota, rate limit. Network errors (0) and 5xx also move on. */
const NEXT_TOKEN = new Set([0, 401, 402, 403, 429]);
/** How long a token that just failed is skipped, so one dead token does not slow every search. */
const COOLDOWN_MS = { 401: 600000, 402: 600000, 403: 600000, 429: 30000 };

/** @type {Map<number, number>} slot -> epoch ms until which it is skipped */
const cooling = new Map();
let cursor = 0;

/** Test hook: forget rotation position and cooldowns. */
export function resetSearchState() {
  cooling.clear();
  cursor = 0;
}

/** Saved tokens in slot order, duplicates dropped so one token pasted twice is not used twice as often. */
export function jinaKeys() {
  const seen = new Set();
  /** @type {{ slot: number; key: string }[]} */
  const keys = [];
  JINA_KEY_NAMES.forEach((name, index) => {
    const key = secret(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push({ slot: index + 1, key });
  });
  return keys;
}

/**
 * Order to try tokens for one search: start at the next token in the ring and
 * wrap, so consecutive searches spread evenly and a failure falls through to
 * the neighbours. Cooling tokens are skipped unless every token is cooling.
 * @param {{ slot: number; key: string }[]} keys
 * @param {number} now
 */
function rotation(keys, now) {
  if (!keys.length) return [];
  const start = cursor % keys.length;
  cursor = (start + 1) % keys.length;
  const ring = [...keys.slice(start), ...keys.slice(0, start)];
  const ready = ring.filter((entry) => (cooling.get(entry.slot) ?? 0) <= now);
  return ready.length ? ready : ring;
}

/**
 * @param {{ key: string }} entry
 * @param {string} query
 * @param {boolean} full
 * @param {typeof fetch} fetchImpl
 */
async function requestOnce(entry, query, full, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    /** @type {Record<string, string>} */
    const headers = { Authorization: `Bearer ${entry.key}`, Accept: "application/json" };
    // Titles, URLs and snippets only: full page text per result is what drains a free token plan.
    if (!full) headers["X-Respond-With"] = "no-content";
    const res = await fetchImpl(`${ENDPOINT}?q=${encodeURIComponent(query)}`, { headers, signal: controller.signal });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    const message = error instanceof Error ? (error.name === "AbortError" ? "timed out" : error.message) : String(error);
    return { status: 0, text: "", error: message };
  } finally {
    clearTimeout(timer);
  }
}

const str = (value) => (typeof value === "string" ? value : "");
const clip = (value, max) => (value.length > max ? `${value.slice(0, max)}…` : value);

/**
 * @param {string} text
 * @param {boolean} full
 * @returns {{ results: { title: string; url: string; snippet: string; content?: string }[]; tokens: number } | null}
 */
function parseResults(text, full) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null;
  if (!rows) return null;
  let tokens = 0;
  const results = [];
  for (const row of rows) {
    tokens += Number(row?.usage?.tokens) || 0;
    const url = str(row?.url);
    if (!url) continue;
    const item = { title: str(row.title), url, snippet: clip(str(row.description), 600) };
    if (full && str(row.content)) item.content = clip(str(row.content), MAX_CONTENT_CHARS);
    results.push(item);
  }
  return { results, tokens };
}

/**
 * Search the web with the next Jina token in the ring.
 * @param {{ query?: unknown; num?: unknown; full?: unknown }} input
 * @param {{ fetch?: typeof fetch; now?: () => number; keys?: { slot: number; key: string }[] }} [deps]
 */
export async function searchWeb(input, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const query = String(input?.query ?? "").trim().slice(0, MAX_QUERY_CHARS);
  if (!query) return { ok: false, status: 400, error: "query is required" };
  const keys = deps.keys ?? jinaKeys();
  if (!keys.length) {
    return { ok: false, status: 503, error: "No Jina tokens configured. Add them in Settings -> Keys." };
  }
  const limit = Math.min(Math.max(Math.trunc(Number(input?.num)) || DEFAULT_RESULTS, 1), MAX_RESULTS);
  const full = input?.full === true || input?.full === "true";

  /** @type {{ slot: number; status: number }[]} */
  const attempts = [];
  for (const entry of rotation(keys, now())) {
    const res = await requestOnce(entry, query, full, fetchImpl);
    attempts.push({ slot: entry.slot, status: res.status });
    if (res.status === 200) {
      const parsed = parseResults(res.text, full);
      if (!parsed) return { ok: false, status: 502, error: "Jina returned an unreadable response", attempts };
      return {
        ok: true,
        status: 200,
        query,
        results: parsed.results.slice(0, limit),
        tokens: parsed.tokens,
        slot: entry.slot,
        attempts,
      };
    }
    const cooldown = COOLDOWN_MS[res.status];
    if (cooldown) cooling.set(entry.slot, now() + cooldown);
    if (!NEXT_TOKEN.has(res.status) && res.status < 500) {
      // A malformed query fails on every token, so do not burn through the ring.
      return { ok: false, status: 502, error: `Jina rejected the search (HTTP ${res.status}): ${clip(res.text, 200)}`, attempts };
    }
  }
  const summary = attempts.map((a) => `#${a.slot}: ${a.status || "network error"}`).join(", ");
  return { ok: false, status: 502, error: `All Jina tokens failed (${summary})`, attempts };
}

/**
 * One tiny search per saved token, so Settings can show which tokens work.
 * Bypasses rotation and cooldowns on purpose: it tests each token itself.
 * @param {{ fetch?: typeof fetch; now?: () => number; keys?: { slot: number; key: string }[] }} [deps]
 */
export async function testJinaKeys(deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const keys = deps.keys ?? jinaKeys();
  return Promise.all(
    keys.map(async (entry) => {
      const started = now();
      const res = await requestOnce(entry, "jina ai", false, fetchImpl);
      const latencyMs = now() - started;
      if (res.status === 200 && parseResults(res.text, false)) return { slot: entry.slot, ok: true, latencyMs };
      const error = res.error || `HTTP ${res.status}${res.text ? `: ${clip(res.text, 160)}` : ""}`;
      return { slot: entry.slot, ok: false, latencyMs, error };
    }),
  );
}

const sha = (value) => createHash("sha256").update(String(value ?? "")).digest();

/** Does this request carry the per-boot search token? */
export function searchAuthorized(req) {
  const token = apiToken(req);
  return Boolean(token) && timingSafeEqual(sha(token), sha(SEARCH_TOKEN));
}
