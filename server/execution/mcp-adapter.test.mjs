// External MCP transport acceptance: a real SDK handshake against a local test
// server exercises connection ownership, tool enumeration, isError preservation,
// timeouts, schema freezing and credential isolation.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectBinding, callExternal, connectionStatus, closeAllConnections } from './mcp-adapter.mjs';
import { EE_MAIL_DISPATCH_TOKEN } from '../ee-mail.mjs';

const TEST_SERVER = fileURLToPath(new URL('./test-mcp-server.mjs', import.meta.url));

const GOOD_BINDING = {
  slug: 'test-external',
  revision: 'rev-1',
  command: process.execPath,
  args: [TEST_SERVER],
  env: { TEST_MODE: 'ok', TEST_SECRET: 'credential-value' },
  scope: 'company:1',
  timeoutMs: 10_000,
};

function binding(patch = {}) {
  return { ...GOOD_BINDING, ...patch };
}

test('external MCP: real handshake, frozen tool list and normalized results', { concurrency: false }, async () => {
  const owner = await connectBinding(binding());
  assert.equal(owner.status, 'connected');
  assert.deepEqual(owner.tools.map((t) => t.mcpTool), ['echo', 'fail_tool', 'slow_tool']);
  assert.ok(owner.tools.every((t) => t.name.startsWith('test-external__')), 'exposed names are stable and namespaced');

  const result = await callExternal(binding(), 'echo', { message: 'hello' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { text: 'echo: hello', note: 'structured value' });
  assert.equal(result.effects[0].kind, 'external');

  // Tool-level errors (isError) stay distinct from transport failures.
  const failed = await callExternal(binding(), 'fail_tool', {});
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'EXTERNAL_ERROR');

  // Status distinguishes connected from configured/unavailable.
  const statuses = connectionStatus();
  assert.equal(statuses[0].status, 'connected');
  assert.ok(statuses[0].lastChecked);
  await closeAllConnections();
});

test('external MCP: timeouts become unknown outcomes, not resends', { concurrency: false }, async () => {
  await assert.doesNotReject(() => connectBinding(binding({ slug: 'test-timeout' })));
  const startedAt = performance.now();
  const result = await callExternal(binding({ slug: 'test-timeout', timeoutMs: 300 }), 'slow_tool', {});
  assert.ok(performance.now() - startedAt >= 900, 'the 1000ms minimum timeout must elapse before rejection');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'EXTERNAL_TIMEOUT');
  assert.equal(result.error.effectState, 'unknown');
  await closeAllConnections();
});

test('external MCP: responses inside the configured deadline do not time out immediately', { concurrency: false }, async () => {
  const delayedBinding = binding({ slug: 'test-delayed', timeoutMs: 1500 });
  try {
    await connectBinding(delayedBinding);
    const result = await callExternal(delayedBinding, 'echo', { message: 'delayed response', delayMs: 150 });
    assert.equal(result.ok, true);
    assert.equal(result.data.text, 'echo: delayed response');
  } finally {
    await closeAllConnections();
  }
});

test('external MCP: unavailable server fails explicitly without touching other bindings', { concurrency: false }, async () => {
  await assert.rejects(() => connectBinding(binding({
    slug: 'test-broken',
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    scope: 'company:1',
  })), /unavailable/);
  const goodOwner = await connectBinding(binding());
  assert.equal(goodOwner.status, 'connected', 'a failed optional integration does not disable working operations');
  await closeAllConnections();
});

test('external MCP: credential isolation — the worker never sees binding env', { concurrency: false }, async () => {
  // The binding env is passed only to the MCP server transport inside the host
  // adapter; nothing in the exposed manifest or the call path carries secrets.
  const owner = await connectBinding(binding());
  const manifestJson = JSON.stringify(owner.tools);
  assert.ok(!manifestJson.includes('credential-value'), 'secrets never appear in the tool manifest');
  const call = await callExternal(binding(), 'echo', { message: 'x' });
  assert.ok(!JSON.stringify(call).includes('credential-value'), 'secrets never appear in results');
  await closeAllConnections();
});

test('external MCP: ee-mail helper gets its host callback credentials from the adapter', { concurrency: false }, async () => {
  // The host spawns the ee-mail helper itself, so the adapter (not the Pi process
  // env) must hand it the agent, URL and per-boot bearer. Without them every send
  // fails with "EE_MAIL_TOKEN is missing".
  let seen;
  const host = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen = { auth: req.headers.authorization, body: JSON.parse(raw || '{}') };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { sent: true } }));
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  const previousPort = process.env.PORT;
  process.env.PORT = String(host.address().port);
  const mail = {
    slug: 'ee-mail',
    revision: 'rev-1',
    command: process.execPath,
    args: [fileURLToPath(new URL('../ee-mail-mcp-server.mjs', import.meta.url))],
    env: {},
    scope: 'catalog:orchestrator',
    agentId: 'orchestrator',
    timeoutMs: 10_000,
  };
  try {
    await connectBinding(mail);
    // At call time the registry swaps the scope for company/user; the agent must survive that.
    const result = await callExternal({ ...mail, scope: 'company:1:user:2' }, 'send_email', { to: 'a@example.com', subject: 'Hi', text: 'Hi' });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(seen.auth, `Bearer ${EE_MAIL_DISPATCH_TOKEN}`);
    assert.equal(seen.body.agent, 'orchestrator');
  } finally {
    await closeAllConnections();
    host.close();
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
  }
});
