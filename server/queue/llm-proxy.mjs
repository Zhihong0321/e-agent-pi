// The only way to queue calls that Pi child processes make to a provider: they run
// with the provider's real API key from models.json, so the server cannot throttle them
// directly. `gateModelsJson` points each provider's baseUrl at a local path of this
// server; `handleLlmProxy` forwards the call to the real provider through that
// provider's gate (llm-gate.mjs) and pipes the answer back, streams included.
//
// The key stays in models.json and Pi's Authorization header is forwarded untouched.
// The path carries a per-process secret so nothing outside this host can use the route.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { callProvider } from './llm-gate.mjs';

const PREFIX = '/internal/llm/';
let proxy = null; // { origin, secret } once enabled
const realBases = new Map(); // provider id -> the provider's real base URL

export function enableLlmProxy({ origin, secret = randomBytes(18).toString('hex') }) {
  proxy = { origin: String(origin).replace(/\/+$/, ''), secret };
  return proxy;
}

export function disableLlmProxy() {
  proxy = null;
  realBases.clear();
}

export const LLM_PROXY_PREFIX = PREFIX;

function callerOf(key) {
  return String(key || 'unknown').replaceAll('\\', '/');
}

/** A provider base URL that sends the call through this host's gate. Unchanged while the proxy is off. */
export function gateBaseUrl(provider, realBase, callerKey) {
  if (!proxy || !realBase) return realBase;
  const base = String(realBase).replace(/\/+$/, '');
  if (base.startsWith(proxy.origin + PREFIX)) return realBase; // already gated
  realBases.set(provider, base);
  return `${proxy.origin}${PREFIX}${proxy.secret}/${encodeURIComponent(callerOf(callerKey))}/${encodeURIComponent(provider)}`;
}

/** models.json text with every provider's baseUrl gated. If anything is off it returns the text as it was (fail open). */
export function gateModelsJson(text, callerKey) {
  if (!proxy) return text;
  try {
    const data = JSON.parse(text);
    for (const [id, provider] of Object.entries(data.providers || {})) {
      if (provider?.baseUrl) provider.baseUrl = gateBaseUrl(id, provider.baseUrl, callerKey);
    }
    return JSON.stringify(data, null, 2);
  } catch {
    return text;
  }
}

function secretMatches(given) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(proxy.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const DROP_REQUEST = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'expect']);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function fail(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

/** True if the request was for the gate route (and has been answered). */
export function isLlmProxyPath(pathname) {
  return pathname.startsWith(PREFIX);
}

/** Express-free handler: /internal/llm/<secret>/<callerKey>/<provider>/<path the provider expects> */
export async function handleLlmProxy(req, res) {
  const rawUrl = req.url || '/';
  const queryAt = rawUrl.indexOf('?');
  const rawPath = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const query = queryAt === -1 ? '' : rawUrl.slice(queryAt);
  const [secret, callerKey, provider, ...rest] = rawPath.slice(PREFIX.length).split('/');
  if (!proxy || !secret || !secretMatches(secret)) { fail(res, 404, 'Not found'); return; }
  const base = realBases.get(decodeURIComponent(provider || ''));
  if (!base) { fail(res, 404, 'Unknown provider'); return; }
  const providerId = decodeURIComponent(provider);

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return;
  }
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!DROP_REQUEST.has(name) && value != null) headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  let upstream;
  try {
    upstream = await callProvider({
      provider: providerId,
      url: `${base}/${rest.join('/')}${query}`,
      method: req.method,
      headers,
      body: body.length ? body : null,
      signal: controller.signal,
      callerKey: decodeURIComponent(callerKey || ''),
    });
  } catch (error) {
    if (controller.signal.aborted) return; // the caller went away
    fail(res, 502, `Could not reach the provider: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const out = {};
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (!DROP_RESPONSE.has(name) && value != null) out[name] = value;
  }
  res.writeHead(upstream.statusCode || 502, out);
  res.flushHeaders?.();
  res.socket?.setNoDelay?.(true);
  res.on('close', () => upstream.destroy());
  upstream.on('error', () => res.destroy());
  upstream.pipe(res);
}
