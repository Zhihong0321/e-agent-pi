// Real scheduler, session inheritance, password login, HTTP host, MCP subprocess
// and expense SQL. Only the language model/catalog and PostgreSQL transport are
// fixtures; PGlite executes the application's actual PostgreSQL statements.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pgliteAdapter } from '../document_inteligence/core/db.mjs';
import { createTestCompany } from '../document_inteligence/test/company-fixture.mjs';

test('delegated expense tools inherit the authenticated owner and refuse impersonation', async t => {
  const postgres = new PGlite();
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  };
  const query = async (sql, params) => {
    const result = params?.length ? await postgres.query(sql, params) : (await postgres.exec(sql)).at(-1);
    return { rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const pool = {
    query: async (sql, params) => { const release = await acquire(); try { return await query(sql, params); } finally { release(); } },
    connect: async () => { const release = await acquire(); return { query, release }; },
    end: async () => {},
  };
  await postgres.exec('CREATE TABLE agents (id TEXT PRIMARY KEY)');
  mock.module('pg', { defaultExport: { Pool: class { constructor() { return pool; } } } });
  const agents = [{ id: 'di-expenses', slug: 'di-expenses', name: 'Expenses Clerk' }];
  mock.module('./catalog.mjs', { namedExports: {
    getAgent: async id => agents.find(agent => agent.id === id), listAgents: async () => agents,
  } });
  const db = await import('./db.mjs');
  const users = await import('./users.mjs');
  const expense = await import('./expense-session.mjs');
  const di = await import('../document_inteligence/host.mjs');
  let jobs;
  const { runTool } = await import('../document_inteligence/core/actions.mjs');
  const oldDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://localhost/expense-test';
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'expense-session-test-'));
  const clients = [];
  let host;
  try {
    await db.connectDb();
    await di.ensureDocumentIntelligence({ pool, catalog: {
      seedSystemAgent: async () => {}, getMcpServer: async () => ({ id: 'mcp' }),
      updateMcpServer: async () => {}, attachAgentResources: async () => {},
    } });
    const tenantId = await createTestCompany(pgliteAdapter(postgres), 'Expense identity test');
    await pool.query(`INSERT INTO users(id,username,password_hash,display_name) VALUES
      ('alice','alice',$1,'Alice'),('bob','bob',$1,'Bob')`, [users.hashPassword('fixture-password')]);
    // Every login belongs to a company; the fixtures' users are this company's.
    await pool.query('UPDATE users SET company_tenant_id=$1 WHERE company_tenant_id IS NULL', [tenantId]);
    const request = { headers: {}, socket: { remoteAddress: 'test' } };
    const login = async username => {
      const signedIn = await users.loginUser(request, { username, password: username === 'admin' ? '1234' : 'fixture-password' });
      return { ...signedIn, req: { ...request, headers: { cookie: `demo_session=${signedIn.token}` } } };
    };
    const admin = await login('admin'), alice = await login('alice'), bob = await login('bob');
    await pool.query(`UPDATE di.company_profile SET name='Expense identity test', country='MY',
      business_type='services', business_activity='Expense integration fixtures', email='test@example.test'
      WHERE tenant_id=$1`, [tenantId]);
    // PGlite has one connection; the runner's readiness lookup uses a second
    // connection inside its scheduling transaction. Snapshot the real readiness
    // result for that lookup, retaining every actual identity/expense function.
    const setup = await di.companyOnboardingStatus(tenantId);
    assert.equal(setup.minimum_ready, true);
    mock.module('../document_inteligence/host.mjs', { namedExports: {
      ...di, companyOnboardingStatus: async () => setup,
    } });
    jobs = await import('./orchestrator.mjs');
    await pool.query(`INSERT INTO di.company_member(tenant_id,name,user_id,email) VALUES
      ($1,'Alice','alice','alice@example.test'),($1,'Bob','bob','bob@example.test')`, [tenantId]);
    for (const person of [alice, bob]) {
      await runTool(di.diRunDeps({ workspace: () => workspace, who: person.user, companyId: tenantId }), {
        agent: 'di-expenses', tool: 'file_claim', args: {
          expense_date: '2026-10-01', merchant: `${person.user.username} merchant`, category: 'transport',
          amount: 12, no_receipt_reason: 'Test fixture has no receipt',
        },
      });
    }
    const parentFor = async person => db.createSession({ agentId: 'orchestrator', userId: person.user.id });
    const parents = { admin: await parentFor(admin), alice: await parentFor(alice), bob: await parentFor(bob) };
    let activeParent = parents.admin.id;
    const observations = [];
    host = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      const outcome = await di.handleDiRequest(req, body, { workspace: () => workspace });
      res.writeHead(outcome.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(outcome.body));
    });
    await new Promise(resolve => host.listen(0, '127.0.0.1', resolve));
    const port = String(host.address().port);
    const connect = async session => {
      const client = new Client({ name: 'expense-delegation-test', version: '1.0.0' });
      await client.connect(new StdioClientTransport({ command: process.execPath,
        args: [fileURLToPath(new URL('../document_inteligence/mcp-server.mjs', import.meta.url))],
        env: { ...process.env, ...di.diAgentEnv('di-expenses', port, session.id) },
      }));
      clients.push(client);
      return client;
    };
    const parse = result => {
      assert.notEqual(result.isError, true, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    jobs.setDispatchRuntime({ activeOrchestratorSessionId: () => activeParent, maxSlots: () => 3, runningCount: () => 0,
      runAgentTurn: async ({ sessionId, message }) => {
        const session = await db.getSession(sessionId);
        return expense.withExpenseSession(session, async () => {
          assert.doesNotMatch(message, /\[Expense identity|identity="/);
          const client = await connect(session);
          const advertised = (await client.listTools()).tools.find(tool => tool.name === 'get_expense_settings');
          assert.equal(advertised.inputSchema.properties.identity, undefined);
          const settings = parse(await client.callTool({ name: 'get_expense_settings', arguments: {} }));
          const claims = parse(await client.callTool({ name: 'list_claims', arguments: { month: 'all' } }));
          observations.push({ session, settings, claims });
          await client.close();
          return { reply: JSON.stringify({ status: 'done', summary: `Verified ${settings.me.username}` }) };
        });
      },
    });
    const dispatch = async parent => {
      activeParent = parent.id;
      const plan = await jobs.createPlan({ tasks: [{ agent: 'di-expenses', prompt: 'Call get_expense_settings and list_claims' }] });
      const result = await jobs.dispatchTask({ taskId: plan.tasks[0].id });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.status, 'done');
      return observations.at(-1);
    };
    await t.test('signed-in admin dispatches both tools as admin', async () => {
      const observed = await dispatch(parents.admin);
      assert.equal(observed.session.userId, admin.user.id);
      assert.equal(observed.settings.me.username, 'admin');
      assert.equal(observed.claims.claims.length, 2);
    });
    await t.test('regular user sees only their own claims through delegation', async () => {
      const observed = await dispatch(parents.alice);
      assert.equal(observed.settings.me.username, 'alice');
      assert.deepEqual(observed.claims.claims.map(claim => claim.merchant), ['alice merchant']);
    });
    await t.test('automatic submitted jobs use the same authenticated delegated path', async () => {
      activeParent = parents.alice.id;
      const plan = await jobs.submitPlan({ tasks: [{ id: 'expenses', agent: 'di-expenses', prompt: 'Read my expense settings and claims' }] });
      await jobs.runJobTick();
      let result;
      for (let i = 0; i < 200; i++) {
        result = await jobs.taskStatus({ planId: plan.id });
        if (result.status === 'done' || result.status === 'error') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(result.status, 'done');
      assert.equal(observations.at(-1).settings.me.username, 'alice');
    });
    await t.test('another parent or another parent plan cannot be selected by the model', async () => {
      activeParent = parents.bob.id;
      const bobPlan = await jobs.createPlan({ tasks: [{ agent: 'di-expenses', prompt: 'Bob task' }] });
      activeParent = parents.alice.id;
      await assert.rejects(jobs.createPlan({ parentSessionId: parents.bob.id, tasks: [{ agent: 'di-expenses', prompt: 'Impersonate Bob' }] }), /another parent/);
      await assert.rejects(jobs.dispatchTask({ taskId: bobPlan.tasks[0].id }), /another parent/);
      assert.equal((await jobs.taskStatus({ planId: bobPlan.id })).tasks[0].status, 'pending');
    });
    const child = await db.createSession({ agentId: 'di-expenses', parentSessionId: parents.alice.id });
    const callHost = async (sessionId, token, args = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/internal/di`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-DI-Session': sessionId },
        body: JSON.stringify({ agent: 'di-expenses', tool: 'get_expense_settings', args }),
      });
      return { status: res.status, ...await res.json() };
    };
    await t.test('a supplied identity cannot override the backend user; transport cannot change sessions', async () => {
      await expense.withExpenseSession(child, async () => {
        const code = users.expenseIdentityPrompt(bob.req, bob.user).match(/identity="([a-f0-9]+)"/)[1];
        const own = await callHost(child.id, di.diTokenFor('di-expenses', child.id), { identity: code, username: 'bob' });
        assert.equal(own.result.me.username, 'alice');
        const forged = await callHost(parents.bob.id, di.diTokenFor('di-expenses', child.id));
        assert.equal(forged.status, 401);
        const adminForgery = await callHost(child.id, di.diTokenFor('di-db', child.id));
        assert.equal(adminForgery.status, 401);
      });
      assert.match((await callHost(child.id, di.diTokenFor('di-expenses', child.id))).error, /no active expense turn/);
    });
    await t.test('missing, mismatched, disabled or logged-out ownership fails before execution', async () => {
      let executed = 0;
      const run = async () => { executed++; };
      const ownerless = await db.createSession({ agentId: 'di-expenses' });
      await assert.rejects(expense.withExpenseSession(ownerless, run), /no authenticated owner/);
      const mismatch = await db.createSession({ agentId: 'di-expenses', userId: 'bob', parentSessionId: parents.alice.id });
      await assert.rejects(expense.withExpenseSession(mismatch, run), /owning orchestrator/);
      await pool.query("UPDATE users SET active=false WHERE id='alice'");
      await assert.rejects(expense.withExpenseSession(child, run), /no active login/);
      await pool.query("UPDATE users SET active=true WHERE id='alice'");
      await expense.withExpenseSession(child, async () => {
        await users.logoutUser(alice.req);
        assert.match((await callHost(child.id, di.diTokenFor('di-expenses', child.id))).error, /Sign-in required/);
      });
      await assert.rejects(expense.withExpenseSession(child, run), /no active login/);
      assert.equal(executed, 0);
    });
    await t.test('concurrent users retain independent identities', async () => {
      await login('alice');
      const bobChild = await db.createSession({ agentId: 'di-expenses', parentSessionId: parents.bob.id });
      await Promise.all([child, bobChild].map(session => expense.withExpenseSession(session, async () => {
        const result = await callHost(session.id, di.diTokenFor('di-expenses', session.id));
        assert.equal(result.result.me.username, session.userId);
      })));
    });
    await t.test('changed ownership and expired logins revoke access during a turn', async () => {
      await expense.withExpenseSession(child, async () => {
        await pool.query("UPDATE sessions SET user_id='bob' WHERE id=$1", [child.id]);
        assert.match((await callHost(child.id, di.diTokenFor('di-expenses', child.id))).error, /ownership mismatch/);
        await pool.query("UPDATE sessions SET user_id='alice' WHERE id=$1", [child.id]);
        await pool.query("UPDATE user_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE user_id='alice'");
        assert.match((await callHost(child.id, di.diTokenFor('di-expenses', child.id))).error, /Sign-in required/);
      });
    });
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    if (host) await new Promise(resolve => host.close(resolve));
    await db.closeDb();
    await postgres.close();
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    mock.restoreAll();
  }
});
