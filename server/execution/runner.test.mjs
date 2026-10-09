// Execution contract tests: real dispatcher, registry, store and runner on an
// embedded Postgres; only the model responses are scripted. These prove the
// completion protocol, duplicate suppression, dependency execution,
// cancellation, capacity, restart recovery and shutdown behavior.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, pgliteAdapter } from '../../document_inteligence/core/db.mjs';
import { ensureDefaultTenant, seedTenant } from '../../document_inteligence/core/seed.mjs';

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
    operatorTenantId: () => holder.tenantId,
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
  holder.tenantId = await ensureDefaultTenant(db);
  await seedTenant(db, holder.tenantId);
  store.resetSchemaMemoForTests();
  orchestrator.resetOrchestratorSchemaMemoForTests();
  await orchestrator.ensureOrchestratorSchema();
  await store.ensureExecutionSchema();
  return pool;
}

const admin = { id: 'u-admin', role: 'admin', active: true, username: 'admin' };

function setupRunner(workerFactory, { maxConcurrent = 4, services: serviceOverrides = {} } = {}) {
  runner.initExecution({
    pool: holder.pool,
    maxConcurrent,
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

withDb('capacity: chat admission respects the shared host bound', async () => {
  const factory = fakeWorkerFactory();
  factory.setScript(() => ({ finishRun: { status: 'blocked', reasonCode: 'WAIT', summary: 'waiting' } }));
  setupRunner(factory, { maxConcurrent: 1 });
  runner.setLegacyLoadProvider(() => 1); // one legacy slot busy
  await assert.rejects(() => runner.acceptChatRun({
    session: { id: 'chat-cap' }, profile: CATALOG.orchestrator, user: admin, prompt: 'hi', images: [],
    modelId: 'm', submissionKey: `k-${randomUUID()}`, manifest: orchestratorProfile(), chatContext: { companyId: holder.tenantId },
  }), /capacity/i);
  runner.setLegacyLoadProvider(() => 0);
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
