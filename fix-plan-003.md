# Fix Plan 003: Simple & Effective Agent Orchestration MVP

**Objective:** Ensure agent orchestration works reliably, simply, and effectively across all specialists.  
**Guiding Principle:** **Strict MVP.** This is not an enterprise hardening or production certification exercise. Do NOT add any non-essential features under any circumstances. Only implement changes that directly unblock agent orchestration from executing end-to-end.

---

## 1. Scope & MVP Guardrails

1. **Keep it MVP, Not Production-Enterprise:**
   - No multi-host failover, distributed lock managers, heavy message brokers, or multi-tenant database partitioning.
   - No speculative abstractions, complex workflow graphs, or feature bloat.
   - Orchestration must follow a direct, clean lifecycle:  
     `User prompt` → `Orchestrator plan submission` → `Specialist task assignment` → `Tool execution` → `Structured completion` → `Parent aggregation & delivery`.
2. **Forbid Non-Essential Features:**
   - Strictly forbidden: New business features, new UI dashboards, synthetic database tables, CRM redesigns, custom analytics, or complex notification systems.
   - If an item does not directly fix a broken agent dispatch, crashed worker, blocked tool call, or misreported plan outcome, **omit it**.
3. **Preserve Main-Only Rule:**
   - Commit strictly on the `main` branch.
   - Never create or switch git branches.
   - Preserve all existing user modifications in the working tree.

---

## 2. Diagnosed Orchestration Blockers & Concrete Failures

Live testing of the test suite on production (`AGENT-TEST-20261004-A`) uncovered four exact failure modes that prevented agent orchestration from executing cleanly:

| # | Orchestration Blocker | Observed Symptom | Technical Root Cause | Impact on Orchestration |
|---|---|---|---|---|
| **1** | **Worker Process Spawn Crash** | `di-fde` and `di-db` workers failed with `spawn node ENOENT` (`FDE-02`, `FDE-03`, `DB-02` checker). | In `server/execution/pi-adapter.mjs`, `cwd` was pointed to `/storage/workspaces/<slug>` which did not exist on disk. In Node.js, `spawn` with a nonexistent `cwd` throws `ENOENT`. Additionally, isolated container environments lacked the active Node executable directory in `PATH`. | Downstream tasks were aborted before execution could even start; pipeline halted at step 1. |
| **2** | **MCP Credential Forwarding Failure** | `ads-research`, `media-ai`, and `company-research` failed with `host credentials were not injected` (`ADR-01..03`, `MED-02`, `CDR-01..02`). | In `server/execution/mcp-adapter.mjs`, stdio MCP servers are started via `@modelcontextprotocol/sdk`'s `StdioClientTransport`. The SDK sanitizes the child process environment to default system variables (`HOME`, `PATH`), stripping host tokens (`ADS_RESEARCH_TOKEN`, etc.). Because `binding.env` was empty, credentials never reached the child process. | Specialists were unable to query internal host endpoints, forcing truthful error bailouts. |
| **3** | **Plan Status Aggregation Defect** | In `ODH-01`, checker task failed (`status: "failed"`), yet the plan completed with `status: "done"`. | In `server/orchestrator.mjs` (`refreshPlanStatus`), status reduction checked `running`, `error`, `blocked`, and `pending`, but omitted `row.status === "failed"`. When all tasks completed, it defaulted to `status = "done"`. | Failed validations falsely marked the parent job as successful, corrupting orchestration status reporting. |
| **4** | **Prototype & Asset Publication Gap in V2 Execution** | Prototype generated in workspace but returned 404 at public host URL (`ODH-01`, `ODH-04`). | Prototype and website publication hooks (`publishPrototypes()`, `publishToHost()`) were only attached to legacy chat SSE streams, but were never invoked upon V2 execution task finalization in `server/execution/runner.mjs`. | Validly generated prototypes were left unpublished on disk, causing independent verification checkers to fail. |

---

## 3. Detailed Fix Specifications

### Fix 1: Worker Launch Directory & Node PATH Resolution

**Target Files:** [`server/execution/pi-adapter.mjs`](file:///E:/000/UIv2/server/execution/pi-adapter.mjs) & [`server/agent-env.mjs`](file:///E:/000/UIv2/server/agent-env.mjs)

1. **Ensure Working Directory Exists:**
   Before invoking `RpcClient.start()`, recursively ensure the agent workspace exists on disk:
   ```javascript
   // server/execution/pi-adapter.mjs
   const cwd = opts.cwd || opts.workspace || profile.workspace || agentWorkspace(agent);
   await mkdir(cwd, { recursive: true });

   pi = new RpcClient({
     cliPath: PI_CLI_PATH,
     cwd,
     provider: active.provider,
     model: active.model,
     env: agentEnv(profile.agentRow || profile, { ... }),
     args,
   });
   ```
2. **Ensure Active Node Executable in `PATH`:**
   Prepend `path.dirname(process.execPath)` to `env.PATH` (and mirror to `env.Path` on Windows):
   ```javascript
   // server/agent-env.mjs
   const rawPath = from.PATH || from.Path || process.env.PATH || process.env.Path || "";
   const nodeDir = path.dirname(process.execPath);
   env.PATH = [nodeDir, "/opt/scrapling/bin", rawPath]
     .filter(Boolean)
     .join(path.delimiter);
   if (process.platform === "win32") {
     env.Path = env.PATH;
   }
   ```

---

### Fix 2: Stdio MCP Host Credential Forwarding

**Target File:** [`server/execution/mcp-adapter.mjs`](file:///E:/000/UIv2/server/execution/mcp-adapter.mjs)

Inject the necessary internal credentials into `binding.env` before instantiating `StdioClientTransport`:
```javascript
// server/execution/mcp-adapter.mjs
async function resolveBindingEnv(binding) {
  const env = { ...(binding.env || {}) };
  const port = process.env.PORT || '8080';
  env.PORT = env.PORT || port;
  if (!env.PATH && !env.Path) {
    const nodeDir = path.dirname(process.execPath);
    const rawPath = process.env.PATH || process.env.Path || '';
    env.PATH = [nodeDir, '/opt/scrapling/bin', rawPath].filter(Boolean).join(path.delimiter);
    if (process.platform === 'win32') {
      env.Path = env.PATH;
    }
  }
  if (binding.slug === 'ads-research') {
    const { adsResearchEnv } = await import('../ads-research/auth.mjs');
    Object.assign(env, adsResearchEnv('ads-research'));
  } else if (binding.slug === 'media-ai') {
    const { mediaAiEnv } = await import('../media-ai/auth.mjs');
    Object.assign(env, mediaAiEnv('media-ai'));
  } else if (binding.slug === 'company-research') {
    const { researchEnv } = await import('../company-research/auth.mjs');
    Object.assign(env, researchEnv('company-deep-research'));
  }
  return env;
}

export async function connectBinding(binding) {
  ...
  owner.ready = (async () => {
    try {
      const stdioEnv = await resolveBindingEnv(binding);
      const transport = binding.url
        ? new StreamableHTTPClientTransport(new URL(binding.url))
        : new StdioClientTransport({
            command: binding.command || process.execPath,
            args: binding.args || [],
            env: stdioEnv,
          });
  ...
}
```

---

### Fix 3: Checker & Task Status Aggregation

**Target File:** [`server/orchestrator.mjs`](file:///E:/000/UIv2/server/orchestrator.mjs)

Update `refreshPlanStatus()` so that a task or checker with status `"failed"` (or `"error"`) correctly marks the overall plan as `"failed"`, rather than defaulting to `"done"`:
```javascript
// server/orchestrator.mjs
export async function refreshPlanStatus(planId) {
  const tasks = await listTasks(planId);
  if (!tasks.length) return;
  let status = "done";
  if (tasks.some((row) => row.status === "running")) status = "running";
  else if (tasks.some((row) => row.status === "failed" || row.status === "error")) status = "failed";
  else if (tasks.some((row) => row.status === "blocked")) status = "blocked";
  else if (tasks.some((row) => row.status === "pending")) status = "queued";
  else if (tasks.every((row) => row.status === "cancelled")) status = "cancelled";
  else if (tasks.some((row) => row.status === "cancelled")) status = "cancelled";
  await getPool().query(
    `UPDATE orchestrator_plans SET status = $1, updated_at = NOW(),
     completed_at = CASE WHEN $1 = 'done' THEN COALESCE(completed_at, NOW()) ELSE NULL END WHERE id = $2`,
    [status, planId]
  );
  ...
}
```

---

### Fix 4: V2 Execution Task Finalization Publication Hooks

**Target Files:** [`server/execution/runner.mjs`](file:///E:/000/UIv2/server/execution/runner.mjs) & [`server/index.mjs`](file:///E:/000/UIv2/server/index.mjs)

1. **Trigger Hook on Task Finalization:**
   In `finalizeRun()` in `runner.mjs`, trigger `config.services.onTaskFinalized`:
   ```javascript
   // server/execution/runner.mjs
   if (config.services.onTaskFinalized) {
     try {
       await config.services.onTaskFinalized({ taskId: runRef, status: record.status, outcome: record.outcome });
     } catch (err) {
       config.services.logEvent?.('warn', `onTaskFinalized error for ${runRef}: ${err?.message || err}`);
     }
   }
   if (planId) await refreshPlanStatusSafe(planId);
   ```
2. **Execute Essential Publish Actions:**
   In `server/index.mjs` (`initExecution`), publish prototypes and website changes immediately upon successful task completion:
   ```javascript
   // server/index.mjs
   onTaskFinalized: async ({ taskId, status }) => {
     if (status !== 'done') return;
     try {
       const task = await getTaskRow(taskId).catch(() => null);
       if (!task) return;
       const agentId = task.agentId || task.agent_id;
       if (agentId === 'open-design-helper') {
         await publishPrototypes({ dir: agentWorkspace({ id: 'open-design-helper', slug: 'open-design-helper' }), prefix: 'od' }).catch(() => {});
         await publishPrototypes({ dir: agentWorkspace({ id: 'open-design-helper', slug: 'open-design-helper' }), prefix: 'proto' }).catch(() => {});
       } else if (agentId === 'app-helper') {
         await publishPrototypes({ dir: agentWorkspace({ id: 'app-helper', slug: 'app-helper' }), prefix: 'proto' }).catch(() => {});
       } else if (agentId === 'website') {
         await publishToHost().catch(() => {});
       }
     } catch (err) {
       logEvent('warn', `onTaskFinalized error: ${err?.message || err}`);
     }
   },
   ```

---

## 4. Verification & Acceptance Criteria (MVP Only)

To confirm that agent orchestration is working cleanly, verify only the following core flows:

1. **Worker Launch Verification:**
   - Run a dry-run policy check (`FDE-01` or `DB-02` inspection) with `di-fde` and `di-db`.
   - **Acceptance:** Worker launches successfully without `spawn node ENOENT`, executes schema queries, and returns structured result.
2. **MCP Credential Forwarding Verification:**
   - Execute read-only Ads Research query (`ADR-01`) or Media AI manifest lookup (`MED-01` / `MED-03`).
   - **Acceptance:** MCP tool call reaches host internal endpoint without `credentials were not injected` errors.
3. **Plan Aggregation Verification:**
   - Execute a multi-stage plan where a checker detects a mismatch.
   - **Acceptance:** When the checker returns `pass: false`, the plan status updates to `failed`, blocking dependent tasks cleanly.
4. **Prototype Publish Verification:**
   - Execute prototype generation with Open Design Helper or App Helper (`ODH-01`).
   - **Acceptance:** Assets are published to `ee-html` and the returned URL is reachable with HTTP 200.

---

## 5. Non-Essential Exclusions (Strictly Enforced)

The following areas are **explicitly excluded** to maintain MVP focus:
- ❌ **No UI Redesigns:** Do not restyle chat panels, forms, or navigation bars.
- ❌ **No Fake/Synthetic Databases:** Do not introduce mock databases, synthetic CRM layers, or complex multi-tenant migrations.
- ❌ **No Complex Email Transports:** Do not configure live SMTP or real mail delivery beyond existing mock/preview gates.
- ❌ **No Subagent Re-Architecture:** Do not rewrite the subagent launcher or replace Pi coding agent RPC.
- ❌ **No Enterprise Security Certification:** Preserve authentication and role boundaries as designed; do not invent new OAuth2/SAML flows.
