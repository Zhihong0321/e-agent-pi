import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'pi-adapter-test-'));
let batches = [];
mock.module('@earendil-works/pi-coding-agent', { namedExports: { RpcClient: class {
  async start() {}
  onEvent(fn) { this.listener = fn; return () => { this.listener = null; }; }
  async prompt() { for (const event of batches.shift()) this.listener(event); }
  async abort() {}
  async stop() {}
} } });
mock.module('../proc.mjs', { namedExports: { killTree: async () => {}, rpcClientPid: () => null } });
mock.module('../agent-env.mjs', { namedExports: { agentEnv: () => ({}) } });
mock.module('../models.mjs', { namedExports: {
  findModel: () => ({ available: true, provider: 'test', model: 'test' }),
  resolveModelCredentials: async () => ({ models: [] }),
} });
mock.module('../paths.mjs', { namedExports: {
  agentWorkspace: () => root, PI_CLI_PATH: '', PI_PACKAGE_DIR: '', ROOT: root, RUNTIME_DIR: root, STORAGE: root,
} });
mock.module('../runtime.mjs', { namedExports: {
  buildPiArgs: () => [], materializeAgentRuntime: async () => {}, resolveToolProfile: async () => ({ profile: 'assistant' }),
} });
const { piWorkerFactory, setModelsJsonProvider } = await import('./pi-adapter.mjs');
setModelsJsonProvider(() => ({}));
test.after(() => rm(root, { recursive: true, force: true }));
const settled = { type: 'agent_settled' };
const assistant = errorMessage => ({ type: 'message_end', message: { role: 'assistant', content: [], errorMessage } });

test('provider overload survives settlement and unmapped events stay out of SSE', async () => {
  batches = [[{ type: 'agent_start' }, assistant('529: overloaded_error'), settled]];
  const events = [];
  const worker = piWorkerFactory({ profile: { id: 'test' }, manifest: { manifest: {} }, attemptId: 'overload', onEvent: event => events.push(event) });
  await worker.start();
  await assert.rejects(worker.prompt('hi'), /529: overloaded_error/);
  assert.ok(events.every(event => event && typeof event.type === 'string'));
  await worker.dispose();
});

test('a successful SDK retry clears an earlier provider error', async () => {
  batches = [[assistant('529: overloaded_error'), assistant(), settled]];
  const worker = piWorkerFactory({ profile: { id: 'test' }, manifest: { manifest: {} }, attemptId: 'recovered' });
  await worker.start();
  await worker.prompt('hi');
  assert.equal(worker.settledWithoutError(), true);
  await worker.dispose();
});
