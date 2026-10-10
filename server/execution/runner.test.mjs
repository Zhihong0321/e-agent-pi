// Execution contract tests: real dispatcher, registry, store and runner on an
// embedded Postgres; only the model responses are scripted. These prove the
// completion protocol, duplicate suppression, dependency execution,
// cancellation, capacity, restart recovery and shutdown behavior.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { migrate, pgliteAdapter } from '../../document_inteligence/core/db.mjs';
import { createTestCompany } from '../../document_inteligence/test/company-fixture.mjs';

// ---- module seams: embedded Postgres + fake catalog -------------------------
const holder = { pool: null, tenantId: null, pglite: null };
mock.module('../db.mjs', {
  namedExports: {
    getPool: () => {
      if (!holder.pool) throw new Error('Test pool not ready');
      return holder.pool;
    },
    dbReady: () => Boolean(holder.pool),
    createSession: async (input = {}) => {
      const id = input.id || randomUUID();
      await holder.pool.query(`INSERT INTO sessions (id, title, parent_session_id) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
        [id, input.title || 'New chat', input.parentSessionId || null]);
      return { id };
    },
    getSession: async (id) => (await holder.pool.query(`SELECT * FROM sessions WHERE id=$1`, [id])).rows[0] || null,
  },
});
mock.module('../catalog.mjs', {
  namedExports: {
    getAgent: async (ref) => CATALOG[ref] || null,
    listAgents: async () => Object.values(CATALOG),
  },
});
mock.module('../debug.mjs', { namedExports: { logEvent: () => {} } });
mock.module('../../document_inteligence/host.mjs', {
  namedExports: {
    companyOnboardingStatus: async () => ({ minimum_ready: true, revision: 3, company_name: 'Acme' }),
  },
});

const CATALOG = {
  orchestrator: { id: 'orchestrator', slug: 'orchestrator', name: 'Orchestrator', toolProfile: 'assistant', thinkingLevel: 'low', mcp: [], skills: [] },
  worker: { id: 'worker', slug: 'worker', name: 'Worker', toolProfile: 'assistant', thinkingLevel: 'low', mcp: [], skills: [] },
  reviewer: { id: 'reviewer', slug: 'reviewer', name: 'Reviewer', toolProfile: 'assistant', thinkingLevel: 'low', mcp: [], skills: [] },
};

const { ensureUsers } = await import('../users.mjs');
const orchestrator = await import('../orchestrator.mjs');
const store = await import('./store.mjs');
const dispatch = await import('./dispatch.mjs');
const runner = await import('./runner.mjs');
const profiles = await import('./profiles.mjs');
const registry = await import('./registry.mjs');
const { resetPiGateForTests } = await import('../queue/pi-gate.mjs');

// Wire the registry's control operations to the runner (as boot does).
registry.registerControlHandlers({
  submitPlan: (ctx, args) => runner.submitPlanHandler(ctx, args),
  stopTask: (input) => runner.stopTaskHandler(input),
  listSpecialists: async () => ({ specialists: Object.values(CATALOG).filter((a) => a.id !== 'orchestrator') }),
  companySetup: async () => ({ minimum_ready: true, revision: 3, company_name: 'Acme' }),
  taskStatus: (input) => orchestrator.taskStatus(input),
});

// ---- harness ----------------------------------------------------------------

let callSeq = 0;
function fakeWorkerFactory() {
  /** script(promptMessage, opts) -> { toolCalls:[{callId, toolId, args}], finishRun, events, error } */
  let script = () => ({});
  const factory = (opts) => {
    let prompts = 0;
    const promptsSeen = [];
    const worker = {
      promptsSeen: () => promptsSeen,
      async start() {},
      async prompt(message) {
        promptsSeen.push(message);
        const action = await script(message, { ...opts, promptIndex: prompts++ });
        for (const call of action.toolCalls || []) {
          const binding = dispatch.getBindingByToken(opts.token);
          const result = await dispatch.dispatchTool(binding, {
            callId: call.callId || `call-${++callSeq}`,
            toolId: call.toolId,
            manifestRevision: binding.manifestRevision,
            args: call.args ?? {},
          }, runner.dispatchServices());
          if (!result.ok) (factory.dispatchErrors ||= []).push({ toolId: call.toolId, error: result.error });
        }
        if (action.finishRun) {
          const binding = dispatch.getBindingByToken(opts.token);
          const result = await dispatch.dispatchTool(binding, {
            callId: action.finishRunCallId || `finish-${++callSeq}`,
            toolId: 'finish_run',
            manifestRevision: binding.manifestRevision,
            args: action.finishRun,
          }, runner.dispatchServices());
          if (!result.ok) (factory.dispatchErrors ||= []).push({ toolId: 'finish_run', error: result.error });
        }
        if (action.error) throw action.error;
        return { text: action.text ?? '' };
      },
      settledWithoutError: () => true,
      sessionRef: () => factory.sessionRef || null,
      async dispose() {},
    };
    factory.lastWorker = worker;
    return worker;
  };
  factory.setScript = (fn) => { script = fn; };
  return factory;
}

async function makeDb() {
  if (!holder.pglite) {
    holder.pglite = new PGlite();
    let tail = Promise.resolve();
    const acquire = async () => {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      return release;
    };
    const query = async (sql, params) => {
      const result = params?.length ? await holder.pglite.query(sql, params) : (await holder.pglite.exec(sql)).at(-1);
      return { rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
    };
    holder.pool = {
      query: async (sql, params) => { const release = await acquire(); try { return await query(sql, params); } finally { release(); } },
      connect: async () => { const release = await acquire(); return { query, release }; },
    };
  } else {
    // One PGlite per process (its WASM code space is precious); reset state via SQL.
    await holder.pglite.exec(`DROP SCHEMA IF EXISTS di CASCADE;
      DROP TABLE IF EXISTS users, user_sessions, sessions, messages,
        user_agents, execution_runs, execution_tool_calls, execution_events, execution_submissions,
        orchestrator_plans, orchestrator_tasks, orchestrator_attempts CASCADE;`);
  }
  const pool = holder.pool;
  await pool.query(`CREATE TABLE sessions (id text PRIMARY KEY, title text DEFAULT 'New chat', parent_session_id text, updated_at timestamptz DEFAULT NOW())`);
  await pool.query(`CREATE TABLE messages (id serial PRIMARY KEY, session_id text, role text, content text, model_id text)`);
  await pool.query(`INSERT INTO sessions (id) VALUES ('parent-chat')`);
  await ensureUsers(pool);
  // submit_plan only delegates to specialists assigned to the signed-in user.
  await pool.query(`CREATE TABLE user_agents (user_id text, agent_id text, PRIMARY KEY (user_id, agent_id))`);
  await pool.query(`INSERT INTO user_agents VALUES ('u-admin', 'worker'), ('u-admin', 'reviewer')`);
  const db = pgliteAdapter(holder.pglite);
  await migrate(db);
  holder.tenantId = await createTestCompany(db, "Test Co");
  store.resetSchemaMemoForTests();
  orchestrator.resetOrchestratorSchemaMemoForTests();
  await orchestrator.ensureOrchestratorSchema();
  await store.ensureExecutionSchema();
  return pool;
}

const admin = { id: 'u-admin', role: 'admin', active: true, username: 'admin' };

function setupRunner(workerFactory, { maxConcurrent = 4, planBudgetMs, services: serviceOverrides = {} } = {}) {
  runner.initExecution({
    pool: holder.pool,
    maxConcurrent,
    planBudgetMs,
    workerFactory,
    services: {
      logEvent: () => {},
      userLookup: async (id) => (id === 'u-admin' ? admin : null),
      getAgent: async (ref) => CATALOG[ref] || null,
      profileFor: (agent) => profiles.resolveProfileManifest(agent, {}),
      refreshPlanStatus: orchestrator.refreshPlanStatus,
      canDelegate: (profileId) => profileId === 'orchestrator',
      ...serviceOverrides,
    },
  });
}

function orchestratorProfile() {
  return profiles.resolveProfileManifest(CATALOG.orchestrator, { peopleTools: true, controlTools: true });
}


async function settleChat(runId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await store.getChatRun(runId);
    if (run && ['done', 'failed', 'blocked', 'cancelled'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  const run = await store.getChatRun(runId);
  throw new Error(`Chat run ${runId} did not settle: ${JSON.stringify(run?.status)} ${JSON.stringify(run?.error)}`);
}

async function settleTasks(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = await holder.pool.query(`SELECT COUNT(*)::int n FROM orchestrator_tasks WHERE status='running'`);
    if (!running.rows[0].n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Tasks did not settle');
}

async function startChatRun(overrides = {}) {
  const session = { id: overrides.sessionId || 'parent-chat', parentSessionId: null };
  const manifest = overrides.manifest || orchestratorProfile();
  const factory = overrides.factory || fakeWorkerFactory();
  setupRunner(factory, overrides);
  const result = await runner.acceptChatRun({
    session,
    profile: CATALOG.orchestrator,
    user: admin,
    prompt: overrides.prompt || 'Do the thing',
    images: [],
    modelId: 'test-model',
    submissionKey: overrides.submissionKey || `key-${randomUUID()}`,
    manifest,
    chatContext: { companyId: holder.tenantId },
    sessionFile: null,
  });
  return { ...result, factory };
}

/** Runs one specialist task (typed finish_run completion) to its terminal state and returns its row. */
async function runSpecialistTask({ factory, prompt = 'Do the thing' }) {
  setupRunner(factory, { services: { profileFor: (agent) => profiles.resolveProfileManifest(agent, { peopleTools: true }) } });
  await runner.submitPlanHandler(
    { sessionId: 'parent-chat', userId: admin.id, companyId: holder.tenantId, profileId: 'orchestrator', runRef: 'plan-run', requestId: randomUUID() },
    { title: 'Specialist job', tasks: [{ id: 't1', agent: 'worker', prompt }] });
  await runner.tick();
  await settleTasks();
  const row = (await holder.pool.query(`SELECT id, status, result, result_data, error FROM orchestrator_tasks`)).rows[0];
  return { ...row, error: row.error ? JSON.parse(row.error) : null };
}

/** Each test gets a fresh embedded database and clean execution state. */
function withDb(name, fn) {
  test(name, async () => {
    runner.resetForTests();
    dispatch.resetDispatcherForTests();
    await makeDb();
    await fn();
  });
}

// ---------------------------------------------------------------- tests

withDb('vertical slice: chat run calls native tools through the bridge and finalizes with Pi\'s own answer', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript(() => ({
    toolCalls: [{ toolId: 'count_user_accounts', args: {} }, { toolId: 'list_people', args: {} }],
    text: 'Counted the company people',
  }));
  const { run, deduped } = await startChatRun({ factory });
  assert.equal(deduped, false);
  const settled = await settleChat(run.id);
  assert.equal(settled.status, 'done', `run error: ${JSON.stringify(settled.error)}`);
  assert.equal(settled.outcome.summary, 'Counted the company people', 'the run outcome carries the answer Pi wrote');
  assert.equal(factory.lastWorker.promptsSeen().length, 1, 'no completion-only follow-up prompt for chat');

  const calls = await store.listToolCalls(run.id);
  assert.deepEqual(calls.map((c) => c.operationId).sort(), ['count_user_accounts', 'list_people']);
  assert.equal(calls[0].status, 'ok');
  const events = await store.listEvents({ runRef: run.id });
  assert.ok(events.some((e) => e.kind === 'run.queued'));
  assert.ok(events.some((e) => e.kind === 'tool.started'));
  assert.ok(events.some((e) => e.kind === 'run.finished'));
  // Prompt streamed to the worker contains no admin capability: identity is host context.
  assert.ok(!factory.lastWorker.promptsSeen()[0].includes('admin_capability'));
});

withDb('chat run: a Pi error stays a failure and the committed tool effect is kept', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript(() => ({
    toolCalls: [{ toolId: 'create_person', args: { name: 'Persisted' } }],
    error: new Error('529: overloaded_error'),
  }));
  const { run } = await startChatRun({ factory });
  const settled = await settleChat(run.id);
  assert.equal(settled.status, 'failed');
  assert.match(settled.error?.message, /overloaded_error/);
  const calls = await store.listToolCalls(run.id);
  assert.equal(calls.length, 1, 'the committed effect stays inspectable');
  const member = await holder.pool.query(`SELECT name FROM di.company_member`);
  assert.equal(member.rows[0]?.name, 'Persisted', 'the committed write remains');
});

withDb('chat run: Pi\'s session reference is saved before the run settles, and only when it changed', async () => {
  const saved = [];
  const ref = { sessionId: 'pi-session-1', sessionFile: '/data/storage/pi-session-1.jsonl' };
  const factory = fakeWorkerFactory();
  factory.sessionRef = ref;
  factory.setScript(() => ({ text: 'hello' }));
  setupRunner(factory, { services: { saveSessionRef: async (sessionId, value) => { saved.push({ sessionId, value }); } } });
  const first = await runner.acceptChatRun({
    session: { id: 'chat-ref', parentSessionId: null }, profile: CATALOG.orchestrator, user: admin, prompt: 'hi', images: [],
    modelId: 'm', submissionKey: `k-${randomUUID()}`, manifest: orchestratorProfile(), chatContext: { companyId: holder.tenantId }, sessionFile: null,
  });
  await settleChat(first.run.id);
  assert.deepEqual(saved, [{ sessionId: 'chat-ref', value: ref }]);

  // The next turn resumes that file, so there is nothing new to save.
  const second = await runner.acceptChatRun({
    session: { id: 'chat-ref', parentSessionId: null }, profile: CATALOG.orchestrator, user: admin, prompt: 'done?', images: [],
    modelId: 'm', submissionKey: `k-${randomUUID()}`, manifest: orchestratorProfile(), chatContext: { companyId: holder.tenantId },
    sessionFile: ref.sessionFile,
  });
  await settleChat(second.run.id);
  assert.equal(saved.length, 1);
});

withDb('completion protocol: missing completion gets one completion-only continuation with writes disabled', async () => {
  const factory = fakeWorkerFactory();
  let prompts = 0;
  factory.setScript(() => {
    prompts += 1;
    if (prompts === 1) return {}; // ends without finish_run
    return { finishRun: { status: 'done', summary: 'repaired completion' } };
  });
  const task = await runSpecialistTask({ factory });
  assert.equal(task.status, 'done');
  assert.equal(task.result, 'repaired completion');

  // A second attempt at business writes during the continuation is refused.
  await makeDb();
  const factory2 = fakeWorkerFactory();
  factory2.setScript((message, ctx) => {
    if (ctx.promptIndex === 0) return {};
    return {
      toolCalls: [{ toolId: 'create_person', args: { name: 'Sneaky' } }],
      finishRun: { status: 'done', summary: 'trying to write after the fact' },
    };
  });
  const task2 = await runSpecialistTask({ factory: factory2 });
  assert.equal(task2.status, 'done', 'the protocol repair completes; the refused write is not fatal');
  const people = await holder.pool.query(`SELECT COUNT(*)::int n FROM di.company_member`);
  assert.equal(people.rows[0].n, 0, 'no business write after the completion boundary');
});

withDb('completion protocol: no completion after continuation records failed/COMPLETION_MISSING and keeps effects', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript((message, ctx) => {
    if (ctx.promptIndex === 0) {
      return { toolCalls: [{ toolId: 'create_person', args: { name: 'Persisted' } }] };
    }
    return {}; // never completes, even after the repair prompt
  });
  const task = await runSpecialistTask({ factory });
  assert.equal(task.status, 'failed');
  assert.equal(task.error?.code, 'COMPLETION_MISSING');
  const attempt = await holder.pool.query(`SELECT id FROM orchestrator_attempts WHERE task_id=$1`, [task.id]);
  const calls = await store.listToolCalls(attempt.rows[0].id);
  assert.equal(calls.length, 1, 'the committed effect stays inspectable');
  const member = await holder.pool.query(`SELECT name FROM di.company_member`);
  assert.equal(member.rows[0]?.name, 'Persisted', 'the committed write remains');
});

withDb('duplicate suppression: transport replay returns the stored result and never repeats the write', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript(() => ({
    toolCalls: [
      { callId: 'stable-call-1', toolId: 'create_person', args: { name: 'Once Only' } },
      { callId: 'stable-call-1', toolId: 'create_person', args: { name: 'Once Only' } }, // replay after lost response
    ],
    finishRun: { status: 'done', summary: 'created exactly one person', sourceCallIds: ['stable-call-1'] },
  }));
  const { run } = await startChatRun({ factory });
  const settled = await settleChat(run.id);
  assert.equal(settled.status, 'done');
  const members = await holder.pool.query(`SELECT COUNT(*)::int n FROM di.company_member`);
  assert.equal(members.rows[0].n, 1, 'exactly one business effect');

  // Same key, different arguments is a conflict, not a second write.
  const factory2 = fakeWorkerFactory();
  factory2.setScript(() => ({
    toolCalls: [
      { callId: 'dup-key', toolId: 'create_person', args: { name: 'First' } },
      { callId: 'dup-key', toolId: 'create_person', args: { name: 'Second' } },
    ],
    finishRun: { status: 'done', summary: 'unreachable' },
  }));
  const second = await startChatRun({ factory: factory2, sessionId: 'chat-2', submissionKey: `k-${randomUUID()}` });
  await settleChat(second.run.id);
  const names = await holder.pool.query(`SELECT name FROM di.company_member WHERE name='Second'`);
  assert.equal(names.rows.length, 0, 'conflicting duplicate created no second effect');
  const calls2 = await store.listToolCalls(second.run.id);
  assert.equal(calls2.find((c) => c.id === 'dup-key')?.status, 'ok');
});

withDb('known business outputs are derived from persisted tool results, not model claims', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript(() => ({
    toolCalls: [{ callId: 'c1', toolId: 'create_person', args: { name: 'Evidence' } }],
    finishRun: { status: 'done', summary: 'created', sourceCallIds: ['c1'], outputs: { person_id: 'fabricated-id' } },
  }));
  const task = await runSpecialistTask({ factory });
  assert.equal(task.status, 'done');
  assert.match(task.result_data.outputs.person_id, /^[0-9a-f-]{36}$/, 'authoritative person id replaces the model claim');

  // A count claim that contradicts the count result is rejected.
  await makeDb();
  const factory2 = fakeWorkerFactory();
  factory2.setScript(() => ({
    toolCalls: [{ callId: 'c2', toolId: 'count_user_accounts', args: {} }],
    finishRun: { status: 'done', summary: 'lies about the count', sourceCallIds: ['c2'], outputs: { company_people: 99 } },
  }));
  const task2 = await runSpecialistTask({ factory: factory2 });
  assert.equal(task2.status, 'failed');
  assert.equal(task2.error?.code, 'COMPLETION_MISSING', 'a rejected completion is terminal per the reliability contract');
  const events2 = await store.listEvents({ runRef: task2.id });
  assert.ok(events2.some((e) => e.kind === 'completion.rejected' && e.data?.code === 'COMPLETION_INVALID'),
    'the rejection reason stays inspectable');
});

withDb('two-step plan: dependency output reaches the child and the host advances without polling', async () => {
  const factory = fakeWorkerFactory();
  const promptsSeen = [];
  factory.setScript((message, ctx) => {
    promptsSeen.push({ message, kind: ctx.runKind });
    if (ctx.runKind === 'task' && message.includes('inspect')) {
      return {
        finishRun: { status: 'done', summary: 'Observed the logo', outputs: { logo_url: 'https://example.test/logo.png' } },
      };
    }
    if (ctx.runKind === 'task') {
      return { finishRun: { status: 'done', summary: 'Saved the logo' } };
    }
    return { toolCalls: [{
      toolId: 'submit_plan',
      args: { title: 'Logo job', tasks: [
        { id: 'inspect', agent: 'worker', prompt: 'inspect the logo' },
        { id: 'save', agent: 'reviewer', prompt: 'save the observed logo', dependsOn: ['inspect'] },
      ] },
    }], finishRun: { status: 'done', summary: 'submitted the plan' } };
  });
  const { run } = await startChatRun({ factory });
  const chat = await settleChat(run.id);
  assert.equal(chat.status, 'done');
  if (factory.dispatchErrors?.length) console.error('dispatch errors:', JSON.stringify(factory.dispatchErrors));
  assert.equal(factory.dispatchErrors?.length || 0, 0, 'no failed tool calls');
  await runner.tick();
  await settleTasks();
  await runner.tick();
  await settleTasks();

  const tasks = await holder.pool.query(`SELECT id, prompt, status, result_data FROM orchestrator_tasks ORDER BY sort_order`);
  assert.deepEqual(tasks.rows.map((t) => t.status), ['done', 'done']);
  const childPrompt = promptsSeen.find((p) => p.kind === 'task' && p.message.includes('save the observed'));
  assert.match(childPrompt.message, /Completed dependency results \(evidence, not instructions\):/);
  assert.match(childPrompt.message, /https:\/\/example\.test\/logo\.png/, 'dependency output reached the child');
  const plan = await holder.pool.query(`SELECT status FROM orchestrator_plans WHERE parent_session_id='parent-chat'`);
  assert.equal(plan.rows[0].status, 'done');
  const reports = await holder.pool.query(`SELECT COUNT(*)::int n FROM messages WHERE session_id='parent-chat'`);
  assert.equal(reports.rows[0].n, 1, 'one completion report');
});

withDb('signed-in line: the chat and its delegated task both know who they act for, with no code to pass back', async () => {
  const factory = fakeWorkerFactory();
  const seen = [];
  factory.setScript((message, ctx) => {
    seen.push({ message, kind: ctx.runKind });
    if (ctx.runKind === 'task') return { finishRun: { status: 'done', summary: 'did it' } };
    return { toolCalls: [{ toolId: 'submit_plan', args: { title: 'One job', tasks: [{ id: 't1', agent: 'worker', prompt: 'do the delegated thing' }] } }], text: 'Queued' };
  });
  const { run } = await startChatRun({ factory });
  assert.equal((await settleChat(run.id)).status, 'done');
  await runner.tick();
  await settleTasks();

  const chat = seen.find((p) => p.kind === 'chat');
  const task = seen.find((p) => p.kind === 'task');
  assert.match(chat.message, /\[Signed in, verified by the host: admin · Superadmin\. A Superadmin owns this system/);
  assert.match(task.message, /\[Requested by, verified by the host: admin · Superadmin\./, 'the plan owner travels with the delegated task');
  for (const { message } of seen) assert.doesNotMatch(message, /identity=|admin_capability|sign in/i);
});

withDb('blocked setup: failed dependency blocks descendants immediately, independent branches finish', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript((message, ctx) => {
    if (ctx.runKind === 'task' && message.includes('will fail')) {
      return { finishRun: { status: 'failed', reasonCode: 'EXECUTION_FAILED', summary: 'could not fetch the page' } };
    }
    if (ctx.runKind === 'task' && message.includes('independent')) {
      return { finishRun: { status: 'done', summary: 'independent branch finished' } };
    }
    return { toolCalls: [{
      toolId: 'submit_plan',
      args: { title: 'Mixed', tasks: [
        { id: 'a', agent: 'worker', prompt: 'independent work' },
        { id: 'b', agent: 'worker', prompt: 'this will fail' },
        { id: 'c', agent: 'reviewer', prompt: 'depends on b', dependsOn: ['b'] },
      ] },
    }], finishRun: { status: 'done', summary: 'submitted' } };
  });
  const { run } = await startChatRun({ factory });
  await settleChat(run.id);
  await runner.tick();
  await settleTasks();
  await runner.tick();
  await settleTasks();

  const tasks = await holder.pool.query(`SELECT id, status, error FROM orchestrator_tasks ORDER BY sort_order`);
  assert.deepEqual(tasks.rows.map((t) => t.status), ['done', 'failed', 'blocked']);
  const blocked = JSON.parse(tasks.rows[2].error);
  assert.equal(blocked.code, 'DEPENDENCY_BLOCKED');
  assert.equal(blocked.dependencyId.endsWith('-b'), true);
});

withDb('unauthorized calls: fabricated identity and cross-profile tools are refused by the host', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript(() => ({
    toolCalls: [
      { toolId: 'create_person', args: { name: 'Nope', tenant_id: '00000000-0000-0000-0000-000000000009' } },
    ],
    finishRun: { status: 'done', summary: 'should not reach done' },
  }));
  const workerOnly = profiles.resolveProfileManifest(CATALOG.worker, {});
  const { run } = await startChatRun({ factory, manifest: workerOnly, sessionId: 'chat-perm', submissionKey: `k-${randomUUID()}` });
  const settled = await settleChat(run.id);
  assert.equal(settled.status, 'done', 'the completion itself is valid; the refused write is not fatal');
  assert.equal(factory.dispatchErrors?.[0]?.error?.code, 'PERMISSION_DENIED', 'the profile lacking the op is denied by the host');
  const members = await holder.pool.query(`SELECT COUNT(*)::int n FROM di.company_member`);
  assert.equal(members.rows[0].n, 0, 'no write happened');
});

withDb('cancellation race: new calls stop, committed effects remain, late completion cannot overwrite', async () => {
  let resolveTask;
  const gate = new Promise((resolve) => { resolveTask = resolve; });
  const factory = fakeWorkerFactory();
  factory.setScript(async (message, ctx) => {
    if (ctx.runKind === 'task') {
      const writeResult = await dispatch.dispatchTool(dispatch.getBindingByToken(ctx.token), {
        callId: 'write-1', toolId: 'create_person', manifestRevision: dispatch.getBindingByToken(ctx.token).manifestRevision,
        args: { name: 'Committed Before Cancel' },
      }, runner.dispatchServices());
      if (!writeResult.ok) (factory.dispatchErrors ||= []).push({ toolId: 'write-1', error: writeResult.error });
      await gate;
      return { finishRun: { status: 'done', summary: 'late completion' } };
    }
    return { toolCalls: [{
      toolId: 'submit_plan',
      args: { title: 'Cancel job', tasks: [{ id: 't1', agent: 'worker', prompt: 'long work' }] },
    }], finishRun: { status: 'done', summary: 'submitted' } };
  });
  const { run } = await startChatRun({ factory, services: {
    profileFor: (agent) => profiles.resolveProfileManifest(agent, agent.id === 'worker' ? { peopleTools: true } : {}),
  } });
  const chatSettled = await settleChat(run.id);
  assert.equal(chatSettled.status, 'done', JSON.stringify(chatSettled.error));
  assert.equal(factory.dispatchErrors?.length || 0, 0, JSON.stringify(factory.dispatchErrors));
  await runner.tick();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const committed = await holder.pool.query(`SELECT COUNT(*)::int n FROM di.company_member WHERE name='Committed Before Cancel'`);
    if (committed.rows[0].n) break; // the write landed; now cancel and prove it survives
    await new Promise((r) => setTimeout(r, 10));
  }
  const taskId = (await holder.pool.query(`SELECT id FROM orchestrator_tasks WHERE status='running'`)).rows[0].id;
  await runner.cancelRun({ runRef: taskId, runKind: 'task' });
  resolveTask();
  await settleTasks();
  const task = await holder.pool.query(`SELECT status, error FROM orchestrator_tasks WHERE id=$1`, [taskId]);
  assert.equal(task.rows[0].status, 'cancelled', JSON.stringify(task.rows[0]));
  const effect = await holder.pool.query(`SELECT COUNT(*)::int n FROM di.company_member WHERE name='Committed Before Cancel'`);
  assert.equal(effect.rows[0].n, 1, 'committed effects survive cancellation');
});

// ---------------------------------------------------------------- queue: nothing is refused for load

/** The chat's own words: the host appends a signed-in line after them. */
const said = (message) => String(message).split('\n')[0];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/** Submit one chat message without re-initialising the runner (so limits and factory stay as the test set them). */
function submitChat({ sessionId, prompt = 'hi', sessionFile = null, onQueue } = {}) {
  return runner.acceptChatRun({
    session: { id: sessionId, parentSessionId: null }, profile: CATALOG.orchestrator, user: admin, prompt, images: [],
    modelId: 'm', submissionKey: `k-${randomUUID()}`, manifest: orchestratorProfile(), chatContext: { companyId: holder.tenantId },
    sessionFile, onQueue,
  });
}

async function runStatus(runId) {
  return (await store.getChatRun(runId)).status;
}

withDb('queue (kill point 1): with every slot held a chat run waits in line, is never refused, and runs when a slot frees', async () => {
  const factory = fakeWorkerFactory();
  const hold = deferred();
  const started = [];
  factory.setScript(async (message) => {
    started.push(said(message));
    if (said(message) === 'first') await hold.promise;
    return { text: `answer to ${said(message)}` };
  });
  setupRunner(factory, { maxConcurrent: 1 });
  const positions = [];
  const first = await submitChat({ sessionId: 'chat-a', prompt: 'first' });
  const second = await submitChat({ sessionId: 'chat-b', prompt: 'second', onQueue: ({ position }) => positions.push(position) });
  assert.equal(second.deduped, false, 'accepted at once, no CAPACITY_UNAVAILABLE');
  await sleep(2500); // the old admission limit was 20 s; there is no timer on this path any more
  assert.equal(await runStatus(second.run.id), 'queued', 'still waiting, not failed');
  assert.deepEqual(started, ['first'], 'the second run has not started');
  assert.deepEqual(positions, [1], 'the waiting user is told their place in line');
  hold.resolve();
  const settled = await settleChat(second.run.id);
  assert.equal(settled.status, 'done');
  assert.equal(settled.outcome.summary, 'answer to second');
  assert.deepEqual(positions, [1, 0], 'and told when it starts');
  assert.equal((await settleChat(first.run.id)).status, 'done');
});

withDb('queue (kill point 3): a second message in a busy chat waits behind the first instead of being refused', async () => {
  const factory = fakeWorkerFactory();
  const hold = deferred();
  const order = [];
  factory.setScript(async (message) => {
    order.push(`start:${said(message)}`);
    if (said(message) === 'one') await hold.promise;
    order.push(`end:${said(message)}`);
    return { text: said(message) };
  });
  setupRunner(factory, { maxConcurrent: 4 });
  const one = await submitChat({ sessionId: 'same-chat', prompt: 'one' });
  const two = await submitChat({ sessionId: 'same-chat', prompt: 'two' });
  assert.notEqual(one.run.id, two.run.id, 'the second message is its own run, not a CONFLICT');
  await sleep(300);
  assert.deepEqual(order, ['start:one'], 'two waits for one even though slots are free');
  assert.equal(await runStatus(two.run.id), 'queued');
  hold.resolve();
  await settleChat(two.run.id);
  assert.deepEqual(order, ['start:one', 'end:one', 'start:two', 'end:two']);
  assert.equal((await settleChat(one.run.id)).status, 'done');
});

withDb('queue (kill point 3): the queued message resumes the Pi session file the first message left behind', async () => {
  const seen = [];
  const inner = fakeWorkerFactory();
  const wrapped = (opts) => { seen.push(opts.sessionFile); return inner(opts); };
  inner.setScript(async (message) => { if (said(message) === 'one') await sleep(200); return { text: said(message) }; });
  setupRunner(wrapped, { maxConcurrent: 4, services: { sessionFileFor: async () => '/data/latest.jsonl' } });
  await submitChat({ sessionId: 'resume-chat', prompt: 'one' });
  const two = await submitChat({ sessionId: 'resume-chat', prompt: 'two' });
  await settleChat(two.run.id);
  assert.equal(seen.at(-1), '/data/latest.jsonl');
});

withDb('queue (kill point 4): a chat run\'s deadline starts when it starts, not while it waits', async () => {
  const original = profiles.DEFAULT_LIMITS.chat.durationMs;
  profiles.DEFAULT_LIMITS.chat.durationMs = 1500;
  try {
    const factory = fakeWorkerFactory();
    const hold = deferred();
    factory.setScript(async (message) => {
      if (said(message) === 'first') await hold.promise;
      return { text: said(message) };
    });
    setupRunner(factory, { maxConcurrent: 1 });
    await submitChat({ sessionId: 'dl-a', prompt: 'first' });
    const second = await submitChat({ sessionId: 'dl-b', prompt: 'second' });
    await sleep(2500); // longer than the whole run budget
    hold.resolve();
    const settled = await settleChat(second.run.id);
    assert.equal(settled.status, 'done', `waiting must not eat the deadline: ${JSON.stringify(settled.error)}`);
    assert.ok(new Date(settled.deadlineAt).getTime() > Date.now() - 1500, 'the deadline was set when the run started');
  } finally {
    profiles.DEFAULT_LIMITS.chat.durationMs = original;
  }
});

withDb('queue (kill point 4): a plan\'s deadline does not run while its tasks only wait in line', async () => {
  const factory = fakeWorkerFactory();
  const hold = deferred();
  factory.setScript(async (message, ctx) => {
    if (ctx.runKind === 'chat' && said(message) === 'hog') await hold.promise;
    if (ctx.runKind === 'task') return { finishRun: { status: 'done', summary: 'task ran after waiting' } };
    return { text: 'ok' };
  });
  setupRunner(factory, { maxConcurrent: 1, planBudgetMs: 1500, services: { profileFor: (agent) => profiles.resolveProfileManifest(agent, { peopleTools: true }) } });
  await runner.submitPlanHandler(
    { sessionId: 'parent-chat', userId: admin.id, companyId: holder.tenantId, profileId: 'orchestrator', runRef: 'plan-run', requestId: randomUUID() },
    { title: 'Waiting job', tasks: [{ id: 't1', agent: 'worker', prompt: 'work' }] });
  await submitChat({ sessionId: 'hog-chat', prompt: 'hog' }); // holds the only slot
  await sleep(100);
  for (let i = 0; i < 14; i += 1) { await runner.tick(); await sleep(200); } // 2.8 s > the 1.5 s plan budget
  const waiting = await holder.pool.query(`SELECT status, error FROM orchestrator_tasks`);
  assert.equal(waiting.rows[0].status, 'pending', `still waiting, not blocked: ${waiting.rows[0].error}`);
  hold.resolve();
  await sleep(200);
  await runner.tick();
  await settleTasks();
  const done = await holder.pool.query(`SELECT status, result FROM orchestrator_tasks`);
  assert.equal(done.rows[0].status, 'done');
  assert.equal(done.rows[0].result, 'task ran after waiting');
});

withDb('queue: specialist tasks beyond the cap wait in line and all finish, never above the cap', async () => {
  const factory = fakeWorkerFactory();
  let running = 0;
  let peak = 0;
  factory.setScript(async (message, ctx) => {
    if (ctx.runKind !== 'task') return { text: 'ok' };
    running += 1;
    peak = Math.max(peak, running);
    await sleep(150);
    running -= 1;
    return { finishRun: { status: 'done', summary: `done ${message.slice(0, 6)}` } };
  });
  setupRunner(factory, { maxConcurrent: 2, services: { profileFor: (agent) => profiles.resolveProfileManifest(agent, { peopleTools: true }) } });
  const agents = ['worker', 'reviewer'];
  for (let plan = 0; plan < 3; plan += 1) {
    await runner.submitPlanHandler(
      { sessionId: 'parent-chat', userId: admin.id, companyId: holder.tenantId, profileId: 'orchestrator', runRef: `plan-run-${plan}`, requestId: randomUUID() },
      { title: `Job ${plan}`, tasks: agents.map((agent) => ({ id: `t-${agent}`, agent, prompt: `job ${plan} ${agent}` })) });
  }
  const deadline = Date.now() + 20_000;
  for (;;) {
    await runner.tick();
    const left = await holder.pool.query(`SELECT COUNT(*)::int n FROM orchestrator_tasks WHERE status NOT IN ('done')`);
    if (!left.rows[0].n) break;
    assert.ok(Date.now() < deadline, 'all tasks finish');
    await sleep(100);
  }
  assert.ok(peak <= 2, `peak concurrency ${peak} stayed within the cap`);
  assert.equal((await holder.pool.query(`SELECT COUNT(*)::int n FROM orchestrator_tasks WHERE status='done'`)).rows[0].n, 6);
});

withDb('queue: a parent that submits a plan frees its slot, so its children can run with a cap of one', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript((message, ctx) => {
    if (ctx.runKind === 'task') return { finishRun: { status: 'done', summary: 'child done' } };
    return { toolCalls: [{ toolId: 'submit_plan', args: { title: 'One slot', tasks: [{ id: 't1', agent: 'worker', prompt: 'child' }] } }],
      finishRun: { status: 'done', summary: 'submitted' } };
  });
  setupRunner(factory, {
    maxConcurrent: 1,
    services: { profileFor: (agent) => profiles.resolveProfileManifest(agent, agent.id === 'worker' ? { peopleTools: true } : { peopleTools: true, controlTools: true }) },
  });
  const parent = await submitChat({ sessionId: 'parent-chat', prompt: 'delegate' });
  assert.equal((await settleChat(parent.run.id)).status, 'done');
  const deadline = Date.now() + 10_000;
  for (;;) {
    await runner.tick();
    const rows = await holder.pool.query(`SELECT status FROM orchestrator_tasks`);
    if (rows.rows[0]?.status === 'done') break;
    assert.ok(Date.now() < deadline, 'the child got the only slot once the parent ended its turn');
    await sleep(100);
  }
});

withDb('queue: cancelling a run that is still in line removes it; it never starts', async () => {
  const factory = fakeWorkerFactory();
  const hold = deferred();
  const started = [];
  factory.setScript(async (message) => { started.push(said(message)); if (said(message) === 'first') await hold.promise; return { text: said(message) }; });
  setupRunner(factory, { maxConcurrent: 1 });
  await submitChat({ sessionId: 'c-a', prompt: 'first' });
  const second = await submitChat({ sessionId: 'c-b', prompt: 'second' });
  const third = await submitChat({ sessionId: 'c-c', prompt: 'third' });
  await sleep(100);
  assert.equal(await runner.cancelRun({ runRef: second.run.id, runKind: 'chat' }), true);
  assert.equal((await settleChat(second.run.id)).status, 'cancelled');
  hold.resolve();
  assert.equal((await settleChat(third.run.id)).status, 'done', 'the run behind it moved up and ran');
  assert.deepEqual(started, ['first', 'third'], 'the cancelled run never started');
});

withDb('queue: waitForChatRun has no timeout while a run waits in line', async () => {
  const factory = fakeWorkerFactory();
  const hold = deferred();
  factory.setScript(async (message) => { if (said(message) === 'first') await hold.promise; return { text: said(message) }; });
  setupRunner(factory, { maxConcurrent: 1 });
  await submitChat({ sessionId: 'w-a', prompt: 'first' });
  const second = await submitChat({ sessionId: 'w-b', prompt: 'second' });
  let result = null;
  const waiter = runner.waitForChatRun(second.run.id).then((run) => { result = run; });
  await sleep(2500);
  assert.equal(result, null, 'still waiting, not handed a non-final answer');
  hold.resolve();
  await waiter;
  assert.equal(result.status, 'done');
});

withDb('queue: if the gate itself throws, the run still starts (fail open)', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript(() => ({ text: 'ran anyway' }));
  setupRunner(factory, { maxConcurrent: 1 });
  resetPiGateForTests({ maxConcurrent: 1, now: () => { throw new Error('gate clock broke'); }, onError: () => {} });
  const { run } = await submitChat({ sessionId: 'fail-open' });
  assert.equal((await settleChat(run.id)).status, 'done');
});

withDb('queue (restart): runs that were waiting in line are put back in line from their rows', async () => {
  const factory = fakeWorkerFactory();
  const hold = deferred();
  const started = [];
  factory.setScript(async (message) => { started.push(said(message)); if (said(message) === 'first') await hold.promise; return { text: `answer ${said(message)}` }; });
  const services = {
    chatProfileFor: async () => CATALOG.orchestrator,
    profileFor: () => orchestratorProfile(),
    userLookup: async (id) => (id === 'u-admin' ? admin : null),
  };
  setupRunner(factory, { maxConcurrent: 1, services });
  const first = await submitChat({ sessionId: 'r-a', prompt: 'first' });
  const second = await submitChat({ sessionId: 'r-b', prompt: 'second' });
  await sleep(100);
  assert.equal(await runStatus(second.run.id), 'queued');
  // The host restarts: memory is gone, the rows are not.
  runner.resetForTests();
  hold.resolve();
  await sleep(300);
  void first;
  assert.equal(await runStatus(second.run.id), 'queued', 'nothing marked it failed');
  setupRunner(factory, { maxConcurrent: 1, services });
  const summary = await runner.reconcileOnStartup();
  assert.equal(summary.requeued, 1);
  const settled = await settleChat(second.run.id);
  assert.equal(settled.status, 'done');
  assert.equal(settled.outcome.summary, 'answer second');
  assert.deepEqual(started, ['first', 'second']);
});

withDb('queue (drain): work still in line is left queued for the replacement host, not started', async () => {
  const factory = fakeWorkerFactory();
  const hold = deferred();
  const started = [];
  factory.setScript(async (message) => { started.push(said(message)); if (said(message) === 'first') await hold.promise; return { text: said(message) }; });
  setupRunner(factory, { maxConcurrent: 1 });
  await submitChat({ sessionId: 'd-a', prompt: 'first' });
  const second = await submitChat({ sessionId: 'd-b', prompt: 'second' });
  await sleep(100);
  const draining = runner.drainExecution({ timeoutMs: 5000, activeTurns: () => 0 });
  await sleep(100);
  hold.resolve();
  const drained = await draining;
  assert.equal(drained.drained, true);
  assert.equal(await runStatus(second.run.id), 'queued', 'still queued in the database');
  assert.deepEqual(started, ['first'], 'it was not started while shutting down');
});

withDb('shutdown drain: accepted work finalizes, pending work is left for the replacement host', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript((message, ctx) => {
    if (ctx.runKind === 'task') return { finishRun: { status: 'done', summary: 'finished during drain' } };
    return { toolCalls: [{
      toolId: 'submit_plan',
      args: { title: 'Drain job', tasks: [{ id: 't1', agent: 'worker', prompt: 'drain me' }, { id: 't2', agent: 'reviewer', prompt: 'never starts', dependsOn: ['t1'] }] },
    }], finishRun: { status: 'done', summary: 'submitted' } };
  });
  const { run } = await startChatRun({ factory });
  await settleChat(run.id);
  await runner.tick();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const running = await holder.pool.query(`SELECT id FROM orchestrator_tasks WHERE status='running'`);
    if (running.rows.length) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const drain = await runner.drainExecution({ timeoutMs: 5000, activeTurns: () => 0 });
  assert.equal(drain.drained, true);
  const tasks = await holder.pool.query(`SELECT status FROM orchestrator_tasks ORDER BY sort_order`);
  assert.equal(tasks.rows[0].status, 'done', 'accepted work finalized');
  assert.equal(tasks.rows[1].status, 'pending', 'pending work left queued for the replacement');
  await runner.tick(); // claims stay stopped after drain
  const after = await holder.pool.query(`SELECT status FROM orchestrator_tasks ORDER BY sort_order`);
  assert.equal(after.rows[1].status, 'pending', 'no new claims while drained');
});

withDb('restart: interrupted attempts are blocked for inspection, committed results are not repeated', async () => {
  const planId = randomUUID();
  await holder.pool.query(
    `INSERT INTO orchestrator_plans (id, parent_session_id, title, status, auto_run, executor_version) VALUES ($1,'parent-chat','stale','running',true,'v2')`,
    [planId]);
  await holder.pool.query(
    `INSERT INTO orchestrator_tasks (id, plan_id, agent_id, title, prompt, status, executor_version) VALUES ($2,$1,'worker','t','do','running','v2')`,
    [planId, `${planId}-t1`]);
  const attemptId = randomUUID();
  await holder.pool.query(
    `INSERT INTO orchestrator_attempts (id, task_id, status, lease_until) VALUES ($1,$2,'running',NOW() - INTERVAL '1 hour')`,
    [attemptId, `${planId}-t1`]);
  // A committed tool call from before the crash stays in the journal.
  await holder.pool.query(
    `INSERT INTO execution_tool_calls (attempt_id, id, run_ref, run_kind, operation_id, argument_digest, status, effect_state, result)
     VALUES ($1,'old-call',$2,'task','create_person','digest','ok','committed','{"person":{"id":"p1"}}')`,
    [attemptId, `${planId}-t1`]);

  const summary = await runner.reconcileOnStartup();
  assert.ok(summary.tasks >= 1);
  const task = await holder.pool.query(`SELECT status, error FROM orchestrator_tasks WHERE id=$1`, [`${planId}-t1`]);
  assert.equal(task.rows[0].status, 'blocked');
  const calls = await store.listToolCalls(attemptId);
  assert.equal(calls.length, 1, 'committed result remains inspectable');
});

// ---------------------------------------------------------------- load: the whole line, end to end

const llmGateModule = await import('../queue/llm-gate.mjs');
const llmProxyModule = await import('../queue/llm-proxy.mjs');

/** A provider that answers slowly-ish and says 429 a third of the time. */
async function flakyProvider({ rateLimitOdds = 0.33 } = {}) {
  const stats = { requests: 0, rateLimited: 0, ok: 0, inFlight: 0, peak: 0 };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      stats.requests += 1;
      stats.inFlight += 1;
      stats.peak = Math.max(stats.peak, stats.inFlight);
      setTimeout(() => {
        stats.inFlight -= 1;
        if (Math.random() < rateLimitOdds) {
          stats.rateLimited += 1;
          res.writeHead(429, { 'retry-after-ms': String(20 + Math.floor(Math.random() * 40)) });
          res.end('{"error":"rate limited"}');
        } else {
          stats.ok += 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"choices":[{"message":{"content":"ok"}}]}');
        }
      }, 25);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/v1`, stats, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

/** This host with only the LLM gate route mounted, as Pi children see it. */
async function gateHost() {
  const server = createServer((req, res) => {
    if (llmProxyModule.isLlmProxyPath(new URL(req.url, 'http://x').pathname)) return void llmProxyModule.handleLlmProxy(req, res);
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  llmProxyModule.enableLlmProxy({ origin: `http://127.0.0.1:${server.address().port}` });
  return { close: () => new Promise((resolve) => { llmProxyModule.disableLlmProxy(); server.closeAllConnections?.(); server.close(resolve); }) };
}

withDb('load: 30 chats from 6 companies and 6 specialist tasks, a provider that answers 429 a third of the time - zero rejections, caps held, everyone finishes', async () => {
  const PI_CAP = 5;
  const LLM_CAP = 4;
  const provider = await flakyProvider();
  const host = await gateHost();
  llmGateModule.resetLlmGatesForTests();
  llmGateModule.setLlmLimits('prov', { maxConcurrent: LLM_CAP, perMinute: 3000 });
  try {
    let piRunning = 0;
    let piPeak = 0;
    const started = [];
    const factory = fakeWorkerFactory();
    // What a Pi does: three model calls through its gated base URL, then it answers.
    const piWorkerWithModelCalls = (opts) => {
      const worker = factory(opts);
      const prompt = worker.prompt;
      worker.prompt = async (message, extra) => {
        piRunning += 1; piPeak = Math.max(piPeak, piRunning);
        started.push(message.split('\n')[0]);
        try {
          const base = llmProxyModule.gateBaseUrl('prov', provider.url, `execution/${opts.attemptId}`);
          for (let call = 0; call < 3; call += 1) {
            const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer sk-real' }, body: '{"messages":[]}' });
            assert.equal(res.status, 200, 'a 429 never reaches the Pi');
            await res.text();
          }
          return await prompt(message, extra);
        } finally { piRunning -= 1; }
      };
      return worker;
    };
    factory.setScript((message, ctx) => (ctx.runKind === 'task' ? { finishRun: { status: 'done', summary: 'task done' } } : { text: 'answer' }));
    setupRunner(piWorkerWithModelCalls, { maxConcurrent: PI_CAP, services: { profileFor: (agent) => profiles.resolveProfileManifest(agent, { peopleTools: true }) } });
    resetPiGateForTests({ maxConcurrent: PI_CAP }); // clean line for the measurement

    const companies = Array.from({ length: 6 }, () => randomUUID());
    const accepted = [];
    for (let i = 0; i < 30; i += 1) {
      const company = companies[i % 6];
      const result = await runner.acceptChatRun({
        session: { id: `load-${i}`, parentSessionId: null }, profile: CATALOG.orchestrator, user: admin, prompt: `chat-${i}`, images: [],
        modelId: 'm', submissionKey: `k-${randomUUID()}`, manifest: orchestratorProfile(), chatContext: { companyId: company }, sessionFile: null,
      });
      accepted.push({ i, id: result.run.id });
    }
    for (const agent of ['worker', 'reviewer']) {
      for (let plan = 0; plan < 3; plan += 1) {
        await runner.submitPlanHandler(
          { sessionId: 'parent-chat', userId: admin.id, companyId: holder.tenantId, profileId: 'orchestrator', runRef: `load-plan-${agent}-${plan}`, requestId: randomUUID() },
          { title: `Load ${agent} ${plan}`, tasks: [{ id: 't', agent, prompt: `task-${agent}-${plan}` }] });
      }
    }

    const deadline = Date.now() + 120_000;
    for (;;) {
      await runner.tick();
      const chats = await holder.pool.query(`SELECT status, COUNT(*)::int n FROM execution_runs GROUP BY status`);
      const tasks = await holder.pool.query(`SELECT status, COUNT(*)::int n FROM orchestrator_tasks GROUP BY status`);
      const count = (rows, status) => rows.rows.find((r) => r.status === status)?.n || 0;
      if (count(chats, 'done') === 30 && count(tasks, 'done') === 6) break;
      assert.equal(count(chats, 'failed') + count(chats, 'blocked') + count(chats, 'cancelled'), 0, 'no chat was rejected, failed or killed');
      assert.equal(count(tasks, 'failed') + count(tasks, 'blocked') + count(tasks, 'cancelled'), 0, 'no task was rejected, failed or killed');
      assert.ok(Date.now() < deadline, `everything finishes (chats ${JSON.stringify(chats.rows)}, tasks ${JSON.stringify(tasks.rows)})`);
      await sleep(100);
    }

    assert.ok(piPeak <= PI_CAP, `Pi count never above the cap (${piPeak} <= ${PI_CAP})`);
    assert.ok(piPeak >= 2, `the load really ran in parallel (peak ${piPeak})`);
    assert.ok(provider.stats.peak <= LLM_CAP, `provider calls never above the cap (${provider.stats.peak} <= ${LLM_CAP})`);
    assert.ok(provider.stats.rateLimited >= 5, `the provider really rate-limited (${provider.stats.rateLimited} 429s), and the Pis never saw one`);
    assert.equal(provider.stats.ok, (30 + 6) * 3, 'every model call was eventually answered, once');
    const chatStarts = started.filter((m) => m.startsWith('chat-')).map((m) => Number(m.slice(5)));
    assert.equal(new Set(chatStarts).size, 30, 'every chat ran');
    const displacement = Math.max(...chatStarts.map((n, position) => Math.abs(n - position)));
    assert.ok(displacement <= 8, `nobody was starved: the line stayed in arrival order within ${displacement} places`);
    console.log(`# load: pi peak ${piPeak}/${PI_CAP}, provider peak ${provider.stats.peak}/${LLM_CAP}, ${provider.stats.requests} upstream requests (${provider.stats.rateLimited} were 429, all absorbed), start order displacement ${displacement}`);
    const finalStats = llmGateModule.llmStats().prov;
    assert.equal(finalStats.active, 0);
    assert.equal(finalStats.queued, 0);
  } finally {
    await host.close();
    await provider.close();
  }
});

withDb('queue (60 s): every slot held for a minute - waiters are not rejected, and run the moment a slot frees', async () => {
  const factory = fakeWorkerFactory();
  const hold = deferred();
  factory.setScript(async (message) => { if (said(message) === 'hog') await hold.promise; return { text: said(message) }; });
  setupRunner(factory, { maxConcurrent: 2 });
  await submitChat({ sessionId: 'hold-a', prompt: 'hog' });
  await submitChat({ sessionId: 'hold-b', prompt: 'hog' });
  const waiting = [];
  for (let i = 0; i < 6; i += 1) waiting.push(await submitChat({ sessionId: `hold-w${i}`, prompt: `w${i}` }));
  await sleep(61_000);
  for (const w of waiting) assert.equal(await runStatus(w.run.id), 'queued', 'a minute in, every waiter is still waiting - none refused, none timed out');
  hold.resolve();
  for (const w of waiting) assert.equal((await settleChat(w.run.id, 20_000)).status, 'done');
});
