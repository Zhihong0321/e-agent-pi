// The LLM gate: one gate per provider. Every call to a provider's API goes through
// `callProvider`, which waits in that provider's line (max concurrent calls, max
// calls per minute), sends the request, and holds the slot until the response body
// has been fully read - a stream keeps its slot for as long as it streams.
//
// Same contract as gate.mjs: a call waits as long as it takes and is never refused
// or timed out because of load.
//  - Upstream 429 is not an answer: wait out Retry-After (or back off) and send the
//    same request again, keeping the slot. The caller never sees it.
//  - Every other upstream answer, error or not, reaches the caller unchanged. The
//    gate neither invents nor hides errors. A network failure (provider unreachable)
//    is the real error and is thrown as it is.
//  - Only the caller's own AbortSignal ends a wait early.
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { createGate } from './gate.mjs';

const gates = new Map();
const limits = new Map(); // provider -> { maxConcurrent, perMinute }
const bases = new Map(); // provider -> its real base URL (so a bare URL can be matched to its provider's gate)

/** Tell the gate which base URL belongs to which provider. */
export function registerProviderBase(provider, baseUrl) {
  if (provider && baseUrl) bases.set(provider, String(baseUrl).replace(/\/+$/, ''));
}

/** Providers the host knows about (so the admin page can list them before any call has been made). */
export function knownProviders() {
  return [...bases.keys()];
}

/** The gate key for a URL: the provider whose base URL it starts with, else its host. */
export function providerForUrl(url) {
  const text = String(url);
  let best = null;
  for (const [provider, base] of bases) {
    if ((text === base || text.startsWith(base + '/')) && (!best || base.length > best.base.length)) best = { provider, base };
  }
  if (best) return best.provider;
  try { return new URL(text).host; } catch { return text; }
}

/** The gate for a provider, created on first use with whatever limits are set (none = no cap). */
export function llmGate(provider) {
  let gate = gates.get(provider);
  if (!gate) {
    gate = createGate(limits.get(provider) || {});
    gates.set(provider, gate);
  }
  return gate;
}

/** Admin settings: change a provider's limits without a deploy. Running calls are untouched. */
export function setLlmLimits(provider, next = {}) {
  const merged = { ...(limits.get(provider) || {}), ...next };
  limits.set(provider, merged);
  gates.get(provider)?.setLimits(merged);
}

export function llmLimits(provider) {
  return { ...(limits.get(provider) || {}) };
}

/** Queue length, running calls and wait time per provider, for the status snapshot. */
export function llmStats() {
  const out = {};
  for (const [provider, gate] of gates) out[provider] = gate.stats();
  return out;
}

export function resetLlmGatesForTests() {
  gates.clear();
  limits.clear();
  bases.clear();
  waiting.clear();
}

// ---------------------------------------------------------------- who is waiting

const waiting = new Map(); // callerKey -> calls currently waiting at a gate

function markWaiting(callerKey, delta) {
  if (!callerKey) return;
  const next = (waiting.get(callerKey) || 0) + delta;
  if (next > 0) waiting.set(callerKey, next);
  else waiting.delete(callerKey);
}

/**
 * True while a call made by `callerKey` is waiting in a provider's line (or waiting out a
 * 429). A Pi in that state emits no events, so its silence timer must not count that time.
 */
export function isWaitingAtLlmGate(callerKey) {
  return waiting.has(callerKey);
}

// ---------------------------------------------------------------- sending

function abortError(signal) {
  return signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

/** Sleep that only a cancel can cut short. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Retry-After as a delay: seconds, a date, or the non-standard millisecond header. null when absent. */
export function retryAfterMs(headers, now = Date.now()) {
  const ms = Number(headers['retry-after-ms']);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const raw = headers['retry-after'];
  if (raw == null || raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** One raw HTTP request. No timeout of any kind: a slow provider is still working. */
function sendRaw(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'http:' ? http : https;
    const sent = { ...headers };
    delete sent['content-length'];
    if (body != null && body.length) sent['content-length'] = String(Buffer.byteLength(body));
    const request = lib.request(target, { method, headers: sent }, resolve);
    request.on('error', reject);
    const onAbort = () => request.destroy(abortError(signal));
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      request.on('close', () => signal.removeEventListener('abort', onAbort));
    }
    request.end(body != null && body.length ? body : undefined);
  });
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Send one request to a provider through its gate.
 * Resolves with the provider's answer as a Node IncomingMessage (`statusCode`, `headers`, readable
 * body). The slot is held until that body ends, errors or is destroyed.
 *
 * @param {object} req
 * @param {string} req.provider gate key (the provider id in models.json)
 * @param {string} req.url full upstream URL
 * @param {string} [req.method]
 * @param {Record<string, string>} [req.headers] lower-case names
 * @param {Buffer | string | null} [req.body]
 * @param {AbortSignal} [req.signal] the caller cancelling is the only way out of the wait
 * @param {string} [req.callerKey] who is waiting (see isWaitingAtLlmGate)
 * @param {number} [req.runTimeoutMs] gives up on a request that has been *sent* this long without finishing; time in the line, and time spent waiting out a 429, never counts
 * @param {typeof sendRaw} [req.send] transport, replaceable in tests
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [req.sleep]
 */
export async function callProvider({ provider, url, method = 'POST', headers = {}, body = null, signal, callerKey, runTimeoutMs, send = sendRaw, sleep = pause }) {
  const gate = llmGate(provider);
  markWaiting(callerKey, 1);
  let release;
  try {
    release = await gate.acquire({ signal });
  } finally {
    markWaiting(callerKey, -1);
  }
  let backoff = BACKOFF_START_MS;
  for (;;) {
    // The run clock for this request starts now that it is being sent.
    const attempt = new AbortController();
    const onCallerAbort = () => attempt.abort(abortError(signal));
    if (signal) { if (signal.aborted) onCallerAbort(); else signal.addEventListener('abort', onCallerAbort, { once: true }); }
    const clock = runTimeoutMs
      ? setTimeout(() => attempt.abort(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), runTimeoutMs)
      : null;
    const settleAttempt = () => { clearTimeout(clock); signal?.removeEventListener('abort', onCallerAbort); };
    let incoming;
    try {
      incoming = await send(url, { method, headers, body, signal: attempt.signal });
    } catch (error) {
      settleAttempt();
      release();
      throw error; // the real failure, unchanged
    }
    if (incoming.statusCode !== 429) {
      let released = false;
      const give = () => { if (!released) { released = true; settleAttempt(); release(); } };
      incoming.once('close', give);
      return incoming;
    }
    settleAttempt();
    // The provider says slow down. Keep the slot, wait as told, send the same request again.
    const wait = retryAfterMs(incoming.headers) ?? backoff;
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    incoming.destroy();
    markWaiting(callerKey, 1);
    try {
      await sleep(wait, signal);
    } catch (error) {
      release();
      throw error;
    } finally {
      markWaiting(callerKey, -1);
    }
  }
}

/**
 * fetch-shaped wrapper for server-side callers: same gate, a real Response back. The body is
 * requested uncompressed so `.json()` / `.text()` just work.
 * @param {string} provider
 * @param {string} url
 * @param {RequestInit & { callerKey?: string, runTimeoutMs?: number }} [init]
 */
export async function gatedFetch(provider, url, init = {}) {
  const headers = {};
  for (const [name, value] of new Headers(init.headers || {})) headers[name.toLowerCase()] = value;
  if (!headers['accept-encoding']) headers['accept-encoding'] = 'identity';
  const body = init.body == null ? null : (typeof init.body === 'string' || Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body));
  const incoming = await callProvider({
    provider, url, method: init.method || (body ? 'POST' : 'GET'), headers, body, signal: init.signal, callerKey: init.callerKey,
    runTimeoutMs: init.runTimeoutMs,
  });
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value != null) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  const status = incoming.statusCode || 502;
  const empty = status === 204 || status === 205 || status === 304;
  if (empty) incoming.resume();
  return new Response(empty ? null : Readable.toWeb(incoming), { status, statusText: incoming.statusMessage || '', headers: responseHeaders });
}
