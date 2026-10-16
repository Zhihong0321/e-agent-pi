import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { PI_CLI_PATH, ROOT } from './paths.mjs';

test('real Pi RPC preserves host tools, conversation files, resume and cancellation', { timeout: 45_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-compat-'));
  const requests = [];
  const bridgeCalls = [];
  const errors = [];
  let responseId = 0;
  let legacy = false;
  let held;
  const holding = new Promise(resolve => { held = resolve; });
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/api/internal/execution/tool') {
      bridgeCalls.push({ body, authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, value: 'host-result-41' }));
      return;
    }
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const delta = (value, finishReason = null) => res.write(`data: ${JSON.stringify({
      id: `fixture-${++responseId}`, object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta: value, finish_reason: finishReason }],
    })}\n\n`);
    if (JSON.stringify(body.messages.at(-1)).includes('hold-this-request')) {
      delta({ role: 'assistant', content: '' });
      held();
      return;
    }
    if (requests.length === 1 || (legacy && body.messages.at(-1).role !== 'tool')) {
      const toolName = legacy ? body.tools.find(tool => tool.function.name.endsWith('echo'))?.function.name : 'lookup';
      delta({ role: 'assistant', tool_calls: [{ index: 0, id: `lookup-${responseId}`, type: 'function',
        function: { name: toolName, arguments: JSON.stringify(legacy ? { message: 'legacy-41' } : { key: 'orange-41' }) } }] });
      delta({}, 'tool_calls');
    } else {
      delta({ role: 'assistant', content: 'Remembered orange-41.' });
      delta({}, 'stop');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let client;
  t.after(async () => {
    await client?.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const workspace = path.join(dir, 'workspace');
  await mkdir(workspace);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await writeFile(path.join(dir, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', apiKey: 'test-only', baseUrl: `${baseUrl}/v1`,
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
      contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ packages: [], cacheWarming: 'off' }));
  const manifestFile = path.join(dir, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify({ revision: 'fixture-revision', tools: [{
    id: 'lookup', description: 'Read the fixture key.', kind: 'read',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  }] }));
  const options = {
    cliPath: PI_CLI_PATH, cwd: workspace, provider: 'fixture', model: 'fixture',
    env: { PI_CODING_AGENT_DIR: dir, EXECUTION_WORKER_URL: baseUrl,
      EXECUTION_WORKER_TOKEN: 'fixture-token', EXECUTION_MANIFEST_FILE: manifestFile },
    args: ['--session-dir', path.join(dir, 'sessions'), '--no-extensions', '--no-skills',
      '--no-prompt-templates', '--no-context-files', '--no-builtin-tools',
      ...['host-tools.ts', 'share-file.ts', 'subagents.ts'].flatMap(name => ['--extension', path.join(ROOT, 'agent/extensions', name)])],
  };
  const start = async sessionFile => {
    client = new RpcClient({ ...options, args: [...options.args, ...(sessionFile ? ['--session', sessionFile] : [])] });
    client.onEvent(event => { if (event.type === 'extension_error') errors.push(event.error); });
    await client.start();
    return client.getState();
  };
  const state = await start();
  const firstSettled = client.waitForIdle(20_000);
  assert.equal(await client.prompt('Remember orange-41 and use lookup.'), 'started');
  await firstSettled;
  assert.deepEqual(errors, []);
  assert.equal(bridgeCalls.length, 1);
  assert.equal(bridgeCalls[0].authorization, 'Bearer fixture-token');
  assert.equal(bridgeCalls[0].body.manifestRevision, 'fixture-revision');
  assert.equal(bridgeCalls[0].body.toolId, 'lookup');
  assert.deepEqual(bridgeCalls[0].body.args, { key: 'orange-41' });
  assert.ok(requests[1].messages.some(message => message.role === 'tool' && message.content.includes('host-result-41')));
  const names = requests[0].tools.map(tool => tool.function.name);
  for (const name of ['lookup', 'share_file', 'spawn_subagent', 'subagent_status', 'stop_subagent']) assert.ok(names.includes(name), name);
  for (const name of ['write', 'bash', 'codemode', 'tool_search']) assert.equal(names.includes(name), false, name);
  const saved = await readFile(state.sessionFile, 'utf8');
  assert.ok(saved.includes('orange-41'));
  await client.stop();
  await start(state.sessionFile);
  const resumedSettled = client.waitForIdle(20_000);
  await client.prompt('What did I ask you to remember?');
  await resumedSettled;
  assert.ok(requests[2].messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Remember orange-41')));
  assert.ok(requests[2].messages.some(message => message.role === 'tool' && message.content.includes('host-result-41')));
  const abortedSettled = client.waitForIdle(10_000);
  await client.prompt('hold-this-request');
  await holding;
  await client.abort();
  await abortedSettled;
  assert.equal((await client.getState()).isStreaming, false);
  await client.stop();

  // The older pooled agents still use the adapter, independently of V2's bridge.
  legacy = true;
  const config = path.join(dir, 'mcp-adapter.json');
  await writeFile(config, JSON.stringify({ mcpServers: { fixture: {
    command: process.execPath, args: [path.join(ROOT, 'server/execution/test-mcp-server.mjs')], directTools: true,
  } } }));
  options.env.PI_MCP_CONFIG_MODE = 'exclusive';
  options.args = ['--session-dir', path.join(dir, 'sessions'), '--no-extensions', '--no-skills',
    '--no-prompt-templates', '--no-context-files', '--no-builtin-tools',
    '--extension', path.join(ROOT, 'node_modules/pi-mcp-adapter'), '--mcp-config', config];
  await start();
  const legacySettled = client.waitForIdle(20_000);
  await client.prompt('Use the fixture echo tool.');
  await legacySettled;
  assert.deepEqual(errors, []);
  assert.ok(requests.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('legacy-41')));
});
