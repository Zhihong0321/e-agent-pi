// Optional embedded Postgres SQL integration test. Install @electric-sql/pglite
// outside the repo and set JOB_TEST_PGLITE to its dist/index.js absolute path.
// Run with node --experimental-test-module-mocks --test this-file.
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

test("submitted jobs execute and completed-job cleanup is selective and atomic", { skip: !process.env.JOB_TEST_PGLITE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.JOB_TEST_PGLITE).href);
  const db = new PGlite();
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  };
  const query = async (sql, params) => {
    const result = params?.length ? await db.query(sql, params) : (await db.exec(sql)).at(-1);
    return { rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const pool = {
    query: async (sql, params) => { const release = await acquire(); try { return await query(sql, params); } finally { release(); } },
    connect: async () => { const release = await acquire(); return { query, release }; },
  };
  await db.exec(`CREATE TABLE sessions (id text PRIMARY KEY,title text,updated_at timestamptz DEFAULT NOW());
    CREATE TABLE messages (id serial PRIMARY KEY,session_id text,role text,content text);
    INSERT INTO sessions (id,title) VALUES ('parent','Test chat');`);
  mock.module("./db.mjs", { namedExports: {
    getPool: () => pool,
    getSession: async id => (await pool.query("SELECT * FROM sessions WHERE id=$1", [id])).rows[0],
    createSession: async input => { const id = randomUUID(); await pool.query("INSERT INTO sessions (id,title) VALUES ($1,$2)", [id, input.title]); return { id }; },
  } });
  mock.module("./catalog.mjs", { namedExports: {
    getAgent: async id => ["worker", "worker2", "reviewer"].includes(id) ? { id, slug: id, name: id } : null,
    listAgents: async () => [],
  } });
  mock.module("./debug.mjs", { namedExports: { logEvent: () => {} } });
  mock.module("../document_inteligence/host.mjs", { namedExports: { companyOnboardingStatus: async () => ({ minimum_ready: true }) } });
  const jobs = await import(`./orchestrator.mjs?integration=${randomUUID()}`);
  const calls = [];
  let reply = ({ agentId }) => agentId === "reviewer" ? { pass: true, summary: "Verified actual state" } : { status: "done", summary: "Observed logo URL https://example.test/logo.png" };
  jobs.setDispatchRuntime({ maxSlots: () => 3, runningCount: () => 0, activeOrchestratorSessionId: () => "parent",
    runAgentTurn: async input => { calls.push(input); return { reply: JSON.stringify(await reply(input)), shared_files: [{ url: "/files/retained" }] }; },
  });
  const specs = [{ id: "find", agent: "worker", prompt: "Find the logo", checker: { agent: "reviewer", checks: ["Verify logo"] } },
    { id: "save", agent: "worker2", prompt: "Save the logo", dependsOn: ["find"] }];
  const settle = async () => {
    for (let i = 0; i < 150; i++) {
      const active = await pool.query("SELECT COUNT(*)::int n FROM orchestrator_tasks WHERE status='running'");
      if (!active.rows[0].n) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Tasks did not settle");
  };
  try {
    await t.test("full DAG runs automatically, checker gates successor and one report is persisted", async () => {
      const plan = await jobs.submitPlan({ title: "Logo job", tasks: specs });
      assert.equal(plan.status, "queued");
      assert.equal(plan.tasks.length, 3);
      await jobs.runJobTick(); await settle();
      assert.equal(calls.length, 1);
      await jobs.runJobTick(); await settle();
      assert.equal(calls[1].agentId, "reviewer");
      await jobs.runJobTick(); await settle();
      assert.equal(calls[2].agentId, "worker2");
      assert.match(calls[2].message, /example.test\/logo.png/);
      const done = await jobs.taskStatus({ planId: plan.id });
      assert.equal(done.status, "done"); assert.ok(done.completedAt);
      await jobs.runJobTick();
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM messages")).rows[0].n, 1);
      assert.equal((await jobs.jobReport(plan.id)).attempts.length, 3);
      await assert.rejects(jobs.dispatchTask({ taskId: done.tasks[0].id }), /managed by the runner/);
    });
    await t.test("failed checker blocks downstream work", async () => {
      reply = ({ agentId }) => agentId === "reviewer" ? { pass: false, summary: "Mismatch" } : { status: "done", summary: "Worker output" };
      const plan = await jobs.submitPlan({ tasks: specs });
      const start = calls.length;
      await jobs.runJobTick(); await settle(); await jobs.runJobTick(); await settle(); await jobs.runJobTick();
      const failed = await jobs.taskStatus({ planId: plan.id });
      assert.equal(failed.status, "error");
      assert.equal(failed.tasks[2].status, "blocked");
      assert.equal(calls.length - start, 2);
    });
    await t.test("submission rolls back all records on a database failure", async () => {
      await pool.query("ALTER TABLE orchestrator_tasks ADD CONSTRAINT reject_prompt CHECK (prompt <> 'force-fail')");
      const count = async () => (await pool.query("SELECT COUNT(*)::int n FROM orchestrator_plans")).rows[0].n;
      const before = await count();
      await assert.rejects(jobs.submitPlan({ tasks: [specs[0], { ...specs[1], prompt: "force-fail" }] }), /reject_prompt/);
      assert.equal(await count(), before);
    });
    await t.test("independent specialists run within capacity and cancellation survives a late reply", async () => {
      const replies = [];
      reply = () => new Promise(resolve => replies.push(resolve));
      const plan = await jobs.submitPlan({ tasks: [
        { id: "a", agent: "worker", prompt: "Independent a" },
        { id: "b", agent: "worker2", prompt: "Independent b" },
        { id: "c", agent: "worker", prompt: "Independent c" },
      ] });
      await Promise.all([jobs.runJobTick(), jobs.runJobTick()]);
      for (let i = 0; i < 100 && replies.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(replies.length, 2);
      const running = await jobs.taskStatus({ planId: plan.id });
      assert.deepEqual(running.tasks.map(task => task.status), ["running", "running", "pending"]);
      await jobs.stopTask({ taskId: running.tasks[0].id });
      replies[0]({ status: "done", summary: "Late reply after cancellation" });
      replies[1]({ status: "done", summary: "Completed independent task" });
      await settle();
      assert.equal((await jobs.taskStatus({ planId: plan.id })).tasks[0].status, "cancelled");
      reply = () => ({ status: "done", summary: "Completed queued task" });
      await jobs.runJobTick(); await settle();
      assert.equal((await jobs.taskStatus({ planId: plan.id })).status, "cancelled");
    });
    await t.test("a worker blocked on missing facts does not release its successor", async () => {
      reply = () => ({ status: "blocked", summary: "Need customer id" });
      const plan = await jobs.submitPlan({ tasks: [specs[0], specs[1]] });
      const before = calls.length;
      await jobs.runJobTick(); await settle(); await jobs.runJobTick(); await jobs.runJobTick();
      assert.equal(calls.length - before, 1);
      const blocked = await jobs.taskStatus({ planId: plan.id });
      assert.equal(blocked.status, "blocked");
      assert.equal(blocked.completedAt, null);
    });
    await t.test("expired execution is blocked and not replayed", async () => {
      const plan = await jobs.submitPlan({ tasks: [{ id: "stale", agent: "worker", prompt: "Do something" }] });
      await pool.query("UPDATE orchestrator_tasks SET status='running',lease_until=NOW()-INTERVAL '1 minute' WHERE plan_id=$1", [plan.id]);
      const before = calls.length;
      await jobs.runJobTick();
      assert.equal(calls.length, before);
      assert.equal((await jobs.taskStatus({ planId: plan.id })).tasks[0].status, "blocked");
    });
    await t.test("preview and deletion preserve unfinished jobs, newer completions, chats and artifacts", async () => {
      const old = (await jobs.listJobs()).find(job => job.status === "done");
      await pool.query("UPDATE orchestrator_plans SET completed_at='2026-09-29T15:59:59Z' WHERE id=$1", [old.id]);
      const recent = await jobs.submitPlan({ tasks: [{ agent: "worker", prompt: "Recent task" }] });
      await pool.query("UPDATE orchestrator_tasks SET status='done' WHERE plan_id=$1", [recent.id]);
      await pool.query("UPDATE orchestrator_plans SET status='done',completed_at='2026-09-29T16:00:00Z' WHERE id=$1", [recent.id]);
      const preview = await jobs.completedJobCleanup({ before: "2026-09-30" });
      assert.deepEqual([preview.plans, preview.tasks, preview.attempts], [1, 3, 3]);
      await assert.rejects(jobs.completedJobCleanup({ before: "2026-09-30", remove: true, expected: { ...preview, plans: 2 } }), /Preview again/);
      const sessions = (await pool.query("SELECT COUNT(*)::int n FROM sessions")).rows[0].n;
      await jobs.completedJobCleanup({ before: "2026-09-30", remove: true, expected: preview });
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM sessions")).rows[0].n, sessions);
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM messages")).rows[0].n, 5);
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM orchestrator_tasks WHERE plan_id=$1", [old.id])).rows[0].n, 0);
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM orchestrator_attempts a JOIN orchestrator_tasks t ON t.id=a.task_id WHERE t.plan_id=$1", [old.id])).rows[0].n, 0);
      assert.equal((await jobs.taskStatus({ planId: recent.id })).status, "done");
      assert.equal((await jobs.completedJobCleanup({ before: "2026-09-30" })).plans, 0);
    });
    await t.test("slow scrape completes and saves without a continue message or manual dispatch", async () => {
      const beforeCalls = calls.length;
      const beforeReports = (await pool.query("SELECT COUNT(*)::int n FROM messages WHERE session_id='parent'")).rows[0].n;
      reply = async ({ agentId, message }) => {
        if (agentId === "worker") {
          // Longer than the MCP script's 30-second limit; the chat turn is gone.
          await new Promise(resolve => setTimeout(resolve, 31000));
          return { status: "done", summary: "Observed Eternalgy Sdn Bhd at https://eternalgy.me/about-solar-pv-epc-company" };
        }
        assert.match(message, /Observed Eternalgy Sdn Bhd/);
        return { status: "done", summary: "Saved company legal name: Eternalgy Sdn Bhd" };
      };
      const plan = await jobs.submitPlan({
        title: "visit eternalgy.me ( scrap my company info and fill in )",
        tasks: [
          { id: "scrape", agent: "worker", prompt: "Visit https://eternalgy.me and scrape company information" },
          { id: "save", agent: "worker2", prompt: "Save the observed company information", dependsOn: ["scrape"] },
        ],
      });
      await jobs.startJobRunner();
      const deadline = Date.now() + 45000;
      let reports;
      do {
        await new Promise(resolve => setTimeout(resolve, 100));
        reports = await pool.query("SELECT content FROM messages WHERE session_id='parent' ORDER BY id");
      } while (reports.rows.length === beforeReports && Date.now() < deadline);
      assert.equal((await jobs.taskStatus({ planId: plan.id })).status, "done");
      assert.equal(calls.length - beforeCalls, 2);
      assert.equal(reports.rows.length, beforeReports + 1);
      assert.match(reports.rows.at(-1).content, /Saved company legal name: Eternalgy Sdn Bhd/);
      await jobs.runJobTick();
      assert.equal((await pool.query("SELECT COUNT(*)::int n FROM messages WHERE session_id='parent'")).rows[0].n, beforeReports + 1);
    });
  } finally { mock.restoreAll(); await db.close(); }
});
