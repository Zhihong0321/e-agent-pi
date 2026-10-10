import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, test } from 'node:test';
import {
  callProvider, gatedFetch, isWaitingAtLlmGate, llmStats, providerForUrl, registerProviderBase, resetLlmGatesForTests, retryAfterMs, setLlmLimits,
} from './llm-gate.mjs';
import { disableLlmProxy, enableLlmProxy, gateBaseUrl, gateModelsJson, handleLlmProxy, isLlmProxyPath } from './llm-proxy.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fake provider whose behaviour each test scripts: handler(req, res, n) per request. */
async function fakeUpstream(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() };
      seen.push(entry);
      handler(req, res, seen.length, entry);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** This host, with only the gate route mounted. */
async function fakeHost() {
  const server = createServer((req, res) => {
    if (isLlmProxyPath(new URL(req.url, 'http://x').pathname)) return void handleLlmProxy(req, res);
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

let host;
beforeEach(async () => {
  resetLlmGatesForTests();
  host = await fakeHost();
  enableLlmProxy({ origin: host.origin, secret: 'test-secret' });
});
afterEach(async () => {
  disableLlmProxy();
  await host.close();
});

/** What Pi does: POST to the gated base URL with its own key. */
async function piCall(upstreamUrl, { provider = 'prov', caller = 'run-1', body = '{"messages":[]}', signal } = {}) {
  const base = gateBaseUrl(provider, upstreamUrl, caller);
  return fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer sk-real', 'content-type': 'application/json' }, body, signal });
}

test('a call goes through the proxy to the real provider with Pi\'s own key, and the answer comes back unchanged', async () => {
  const upstream = await fakeUpstream((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'x-from': 'provider' }); res.end('{"id":"ok"}'); });
  try {
    const res = await piCall(upstream.url + '/v1');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-from'), 'provider');
    assert.equal(await res.text(), '{"id":"ok"}');
    assert.equal(upstream.seen[0].url, '/v1/chat/completions');
    assert.equal(upstream.seen[0].headers.authorization, 'Bearer sk-real');
    assert.equal(upstream.seen[0].body, '{"messages":[]}');
  } finally { await upstream.close(); }
});

test('real provider errors pass through untouched: the gate neither invents nor hides them', async () => {
  for (const [status, body] of [[400, '{"error":"bad request"}'], [401, '{"error":"bad key"}'], [500, 'upstream exploded'], [503, '{"error":"down"}']]) {
    const upstream = await fakeUpstream((req, res) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(body); });
    try {
      const res = await piCall(upstream.url);
      assert.equal(res.status, status);
      assert.equal(await res.text(), body);
      assert.equal(upstream.seen.length, 1, 'a real error is not retried by the gate');
    } finally { await upstream.close(); }
  }
});

test('a provider that is truly unreachable is reported as the real failure (502), not hidden', async () => {
  const dead = await fakeUpstream(() => {});
  const url = dead.url;
  await dead.close();
  const res = await piCall(url);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Could not reach the provider/);
  assert.equal(llmStats().prov.active, 0, 'the slot came back');
});

test('upstream 429: the gate waits out Retry-After and sends the same request again; the caller only sees the success', async () => {
  const upstream = await fakeUpstream((req, res, n) => {
    if (n < 3) { res.writeHead(429, { 'retry-after-ms': '60' }); res.end('{"error":"rate limited"}'); return; }
    res.writeHead(200); res.end('{"id":"finally"}');
  });
  try {
    const started = Date.now();
    const res = await piCall(upstream.url);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '{"id":"finally"}');
    assert.equal(upstream.seen.length, 3);
    assert.ok(Date.now() - started >= 110, 'it honoured the two waits');
    assert.deepEqual(new Set(upstream.seen.map((s) => s.body)), new Set(['{"messages":[]}']), 'identical request each time');
  } finally { await upstream.close(); }
});

test('429 with no Retry-After backs off and keeps trying: no retry cap, never surfaced', async () => {
  const sleeps = [];
  let calls = 0;
  const { Readable } = await import('node:stream');
  const fakeSend = async () => {
    calls += 1;
    const incoming = Readable.from(calls < 8 ? [] : [Buffer.from('{"id":"ok"}')]);
    incoming.statusCode = calls < 8 ? 429 : 200;
    incoming.headers = {};
    return incoming;
  };
  const incoming = await callProvider({ provider: 'p', url: 'http://x/y', send: fakeSend, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(incoming.statusCode, 200);
  assert.equal(calls, 8);
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 16000, 30000, 30000], 'delay grows to a ceiling; the number of tries does not');
  incoming.resume();
});

test('retryAfterMs reads seconds, dates and the millisecond header', () => {
  assert.equal(retryAfterMs({ 'retry-after': '2' }), 2000);
  assert.equal(retryAfterMs({ 'retry-after-ms': '250' }), 250);
  assert.equal(retryAfterMs({ 'retry-after': new Date(10_000).toUTCString() }, 4_000), 6000);
  assert.equal(retryAfterMs({}), null);
  assert.equal(retryAfterMs({ 'retry-after': 'soon' }), null);
});

test('concurrency cap: extra calls wait in line, none is rejected, every one finishes', async () => {
  setLlmLimits('prov', { maxConcurrent: 2 });
  let running = 0;
  let peak = 0;
  const upstream = await fakeUpstream((req, res) => {
    running += 1; peak = Math.max(peak, running);
    setTimeout(() => { running -= 1; res.writeHead(200); res.end('ok'); }, 60);
  });
  try {
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => piCall(upstream.url, { caller: `run-${i}` }).then((r) => r.status)));
    assert.deepEqual(results, Array(9).fill(200));
    assert.equal(peak, 2);
    assert.equal(llmStats().prov.active, 0);
  } finally { await upstream.close(); }
});

test('a streamed answer keeps its slot until the stream ends', async () => {
  setLlmLimits('prov', { maxConcurrent: 1 });
  const upstream = await fakeUpstream((req, res, n) => {
    if (n === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => res.write('data: two\n\n'), 150);
      setTimeout(() => res.end('data: [DONE]\n\n'), 300);
    } else { res.writeHead(200); res.end('second'); }
  });
  try {
    const first = await piCall(upstream.url);
    const reader = first.body.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(firstChunk, /data: one/, 'chunks arrive as they are produced, not at the end');
    const secondStarted = Date.now();
    const secondPromise = piCall(upstream.url, { caller: 'run-2' }).then(async (r) => ({ text: await r.text(), at: Date.now() }));
    await sleep(100);
    assert.equal(upstream.seen.length, 1, 'the second call is still waiting for the stream\'s slot');
    assert.equal(isWaitingAtLlmGate('run-2'), true, 'and the adapter can tell run-2 is waiting, not silent');
    let rest = '';
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    assert.match(rest, /\[DONE\]/);
    const second = await secondPromise;
    assert.equal(second.text, 'second');
    assert.ok(second.at - secondStarted >= 150, 'it went only after the stream finished');
    assert.equal(isWaitingAtLlmGate('run-2'), false);
  } finally { await upstream.close(); }
});

test('a caller that gives up releases its slot and leaves the line (the only way out of the wait)', async () => {
  setLlmLimits('prov', { maxConcurrent: 1 });
  let release;
  const upstream = await fakeUpstream((req, res, n) => {
    if (n === 1) { release = () => { res.writeHead(200); res.end('first'); }; return; }
    res.writeHead(200); res.end('third');
  });
  try {
    const first = piCall(upstream.url, { caller: 'run-a' });
    await sleep(50);
    const controller = new AbortController();
    const second = piCall(upstream.url, { caller: 'run-b', signal: controller.signal }).catch((e) => e.name);
    const third = piCall(upstream.url, { caller: 'run-c' }).then((r) => r.text());
    await sleep(50);
    assert.equal(llmStats().prov.queued, 2);
    controller.abort();
    assert.equal(await second, 'AbortError');
    await sleep(50); // the host notices the closed connection
    assert.equal(llmStats().prov.queued, 1);
    release();
    assert.equal(await (await first).text(), 'first');
    assert.equal(await third, 'third');
    assert.equal(upstream.seen.length, 2, 'the cancelled call never reached the provider');
  } finally { await upstream.close(); }
});

test('a waiting call is not a failed call: it is still waiting long after, and runs when its turn comes', async () => {
  setLlmLimits('prov', { maxConcurrent: 1 });
  let release;
  const upstream = await fakeUpstream((req, res, n) => {
    if (n === 1) { release = () => { res.writeHead(200); res.end('a'); }; return; }
    res.writeHead(200); res.end('b');
  });
  try {
    const first = piCall(upstream.url, { caller: 'run-a' });
    await sleep(30);
    const second = piCall(upstream.url, { caller: 'run-b' });
    await sleep(2000);
    assert.equal(upstream.seen.length, 1, 'still waiting after 2 s - there is no timer on the line');
    assert.equal(isWaitingAtLlmGate('run-b'), true);
    release();
    await (await first).text();
    assert.equal(await (await second).text(), 'b');
  } finally { await upstream.close(); }
});

test('a wrong secret or an unknown provider gets nothing: the route is not an open proxy', async () => {
  const upstream = await fakeUpstream((req, res) => { res.writeHead(200); res.end('ok'); });
  try {
    gateBaseUrl('prov', upstream.url, 'run-1');
    assert.equal((await fetch(`${host.origin}/internal/llm/wrong/run-1/prov/x`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${host.origin}/internal/llm/test-secret/run-1/nope/x`, { method: 'POST' })).status, 404);
    assert.equal(upstream.seen.length, 0);
  } finally { await upstream.close(); }
});

test('gateModelsJson points every provider at this host and keeps the key; with the proxy off it changes nothing', () => {
  const text = JSON.stringify({ providers: { a: { baseUrl: 'https://a.example/v1', apiKey: 'ka', api: 'openai-completions' }, b: { baseUrl: 'https://b.example', apiKey: 'kb' } } });
  const gated = JSON.parse(gateModelsJson(text, 'execution\\attempt-9'));
  assert.equal(gated.providers.a.baseUrl, `${host.origin}/internal/llm/test-secret/execution%2Fattempt-9/a`);
  assert.equal(gated.providers.b.baseUrl, `${host.origin}/internal/llm/test-secret/execution%2Fattempt-9/b`);
  assert.equal(gated.providers.a.apiKey, 'ka');
  assert.equal(gated.providers.a.api, 'openai-completions');
  assert.equal(gateModelsJson('not json', 'x'), 'not json', 'fail open');
  disableLlmProxy();
  assert.equal(gateModelsJson(text, 'x'), text);
  assert.equal(gateBaseUrl('a', 'https://a.example/v1', 'x'), 'https://a.example/v1');
});

test('server-side callers get a normal Response from gatedFetch, on the same gate', async () => {
  setLlmLimits('prov', { maxConcurrent: 1 });
  const upstream = await fakeUpstream((req, res, n) => {
    if (n === 1) { res.writeHead(429, { 'retry-after-ms': '30' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[]}');
  });
  try {
    const res = await gatedFetch('prov', `${upstream.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"m"}' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { choices: [] });
    assert.equal(upstream.seen.length, 2, 'the 429 was absorbed');
    assert.equal(upstream.seen[1].body, '{"model":"m"}');
    assert.equal(llmStats().prov.active, 0, 'slot released once the body was read');
    const err = await fakeUpstream((req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"nope"}'); });
    try {
      const bad = await gatedFetch('prov', `${err.url}/x`, { method: 'POST', body: '{}' });
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { error: 'nope' });
    } finally { await err.close(); }
  } finally { await upstream.close(); }
});

test('per-minute limit applies per provider and makes calls wait, not fail', async () => {
  setLlmLimits('slow', { perMinute: 1 });
  const upstream = await fakeUpstream((req, res) => { res.writeHead(200); res.end('ok'); });
  try {
    const first = await piCall(upstream.url, { provider: 'slow' });
    await first.text();
    let secondDone = false;
    const leave = new AbortController();
    const second = piCall(upstream.url, { provider: 'slow', caller: 'run-2', signal: leave.signal }).then(async (r) => { await r.text(); secondDone = true; }).catch(() => {});
    const other = await piCall(upstream.url, { provider: 'other' });
    assert.equal(other.status, 200, 'another provider is not held up');
    await other.text();
    await sleep(300);
    assert.equal(secondDone, false, 'the second call to the limited provider is waiting for the minute');
    assert.equal(isWaitingAtLlmGate('run-2'), true);
    assert.equal(llmStats().slow.queued, 1);
    leave.abort();
    await second;
  } finally { await upstream.close(); }
});

test('a run timeout starts when the request is sent: time in the line never counts, a hung provider still ends', async () => {
  setLlmLimits('prov', { maxConcurrent: 1 });
  let release;
  const upstream = await fakeUpstream((req, res, n) => {
    if (n === 1) { release = () => { res.writeHead(200); res.end('first'); }; return; }
    if (n === 2) { res.writeHead(200); res.end('second'); return; }
    /* n === 3 never answers */
  });
  try {
    const first = gatedFetch('prov', `${upstream.url}/a`, { method: 'POST', body: '{}' });
    await sleep(30);
    // Waits ~600 ms in line with a 200 ms run timeout: the wait must not trigger it.
    const second = gatedFetch('prov', `${upstream.url}/b`, { method: 'POST', body: '{}', runTimeoutMs: 200 }).then((r) => r.text());
    await sleep(600);
    release();
    await (await first).text();
    assert.equal(await second, 'second');
    // A request that is sent and then hangs does hit its run timeout.
    const hung = await gatedFetch('prov', `${upstream.url}/c`, { method: 'POST', body: '{}', runTimeoutMs: 150 }).then((r) => r.text()).catch((e) => e.name);
    assert.equal(hung, 'TimeoutError');
    assert.equal(llmStats().prov.active, 0, 'and its slot came back');
  } finally { await upstream.close(); }
});

test('providerForUrl maps a bare URL to the provider whose base it starts with, else its host', () => {
  registerProviderBase('minimax-m-plan', 'https://api.minimax.io/v1/');
  registerProviderBase('cavoti', 'https://cavoti.com/v1');
  assert.equal(providerForUrl('https://api.minimax.io/v1/chat/completions'), 'minimax-m-plan');
  assert.equal(providerForUrl('https://api.minimax.io/v1'), 'minimax-m-plan');
  assert.equal(providerForUrl('https://cavoti.com/v1/chat/completions'), 'cavoti');
  assert.equal(providerForUrl('https://other.example/v1/x'), 'other.example');
});
