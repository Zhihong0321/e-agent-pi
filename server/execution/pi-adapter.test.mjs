import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'pi-adapter-test-'));
let batches = [];
let aborts = 0;
let piSessionFile = path.join(root, 'new-session.jsonl');
mock.module('@earendil-works/pi-coding-agent', { namedExports: { RpcClient: class {
  async start() {}
  onEvent(fn) { this.listener = fn; return () => { this.listener = null; }; }
  async prompt() { for (const event of batches.shift()) this.listener(event); }
  async getState() { return { sessionId: 'pi-session', sessionFile: piSessionFile }; }
  async abort() { aborts += 1; }
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

const textDelta = delta => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });

test('a chat turn returns the answer Pi wrote and is never aborted', async () => {
  aborts = 0;
  batches = [[{ type: 'agent_start' }, textDelta('Done, '), textDelta('the login is enabled.'), assistant(), settled]];
  const worker = piWorkerFactory({ profile: { id: 'test' }, manifest: { manifest: {} }, attemptId: 'chat-answer', runKind: 'chat' });
  await worker.start();
  const answer = await worker.prompt('enable it');
  assert.equal(answer.text, 'Done, the login is enabled.');
  assert.equal(aborts, 0);
  await worker.dispose();
});

test('a task, like a chat turn, ends with the answer Pi wrote: no completion call, nothing aborts it', async () => {
  aborts = 0;
  batches = [[{ type: 'agent_start' }, textDelta('Saved the address.'), assistant(), settled]];
  const worker = piWorkerFactory({ profile: { id: 'test' }, manifest: { manifest: {} }, attemptId: 'task-answer', runKind: 'task' });
  await worker.start();
  const answer = await worker.prompt('go');
  assert.equal(answer.text, 'Saved the address.');
  assert.equal(aborts, 0);
  await worker.dispose();
});

test('a chat session reference comes from Pi and exists only once its file is written', async () => {
  piSessionFile = path.join(root, 'written-later.jsonl');
  const worker = piWorkerFactory({ profile: { id: 'test' }, manifest: { manifest: {} }, attemptId: 'chat-ref', runKind: 'chat' });
  await worker.start();
  assert.equal(worker.sessionRef(), null, 'nothing to resume before Pi writes the file');
  await writeFile(piSessionFile, '{}\n');
  assert.deepEqual(worker.sessionRef(), { sessionId: 'pi-session', sessionFile: piSessionFile });
  await worker.dispose();
});

test('a saved conversation whose file is missing is reported, not replaced by a blank one', async () => {
  const worker = piWorkerFactory({
    profile: { id: 'test' }, manifest: { manifest: {} }, attemptId: 'chat-missing', runKind: 'chat',
    sessionFile: path.join(root, 'gone.jsonl'),
  });
  await assert.rejects(worker.start(), error => error.execCode === 'SESSION_UNAVAILABLE' && /cannot be resumed/.test(error.message));
});
