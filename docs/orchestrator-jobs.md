# Executable orchestrator jobs

The orchestrator calls `submit_plan` once with the full assignment graph. The
host validates IDs, prompts, handlers, checker specifications and dependency
cycles before storing the manifest and expanded task graph in one Postgres
transaction. A successful response means the complete job is durably queued.
No JSON files or additional `dispatch_task` calls are needed.

```json
{
  "title": "Find and save the company logo",
  "tasks": [
    {
      "id": "inspect",
      "agent": "actual-specialist-id-from-roster",
      "prompt": "Inspect the supplied website and return one logo URL and its source page.",
      "acceptanceCriteria": ["Return the logo URL and source page"],
      "checker": null
    },
    {
      "id": "save",
      "agent": "di-onboarding",
      "prompt": "Save the observed logo URL using the dependency result as evidence.",
      "dependsOn": ["inspect"]
    }
  ]
}
```

An optional checker has `{ "agent": "roster-id", "checks": ["specific check"] }`.
The host inserts a checker task and adds it to all downstream dependencies.
Workers return JSON `{ "status": "done|blocked|failed", "summary": "evidence and
artifact URLs" }`; checkers return `{ "pass": true, "summary": "evidence" }`.
Malformed/empty replies fail rather than silently completing a task. A failed
checker blocks downstream work. There are no automatic side-effect retries:
inspect the recorded result/child chat and submit a revised plan when necessary.

The scheduler runs every five seconds after boot. It claims tasks under a
Postgres advisory transaction lock, respects host capacity, avoids assigning
concurrent work to the same specialist, and passes completed dependency results
to workers. Execution heartbeats expire after two minutes. Interrupted tasks
are blocked for inspection, not automatically replayed. Pending work survives
host restarts. Cancelling a task prevents a late reply from completing it.

Plans are immutable after submission. Full outcomes, shared artifact references
and execution attempts are stored in Postgres. Dependency prompts contain
bounded excerpts. When a job finishes or needs intervention, its report is
persisted in the parent chat. Use `task_status` for the latest complete job state.
The Settings Jobs tab provides recent jobs and their combined output reports.

## Completed job cleanup

Open `/settings#jobs`, choose **Completed before**, and preview cleanup. The
selected date is exclusive at midnight in `Asia/Kuala_Lumpur`. Confirming the
displayed counts deletes only fully successful jobs completed before that time,
including their task records and cascading attempt/checker records. If the
counts changed since preview, the host requires another preview.

Running, queued, blocked, failed and cancelled jobs are preserved. Parent and
child chat history and generated/shared files are preserved. Cleanup does not
remove artifact files from disk or delete business records created by agents.
Older completed plans receive a completion timestamp from their last task
update during schema migration. There is no automatic retention schedule.

Settings endpoints require the existing settings authentication:

- `GET /api/settings/jobs`: most recent 50 jobs.
- `GET /api/settings/jobs?planId=...`: full manifest, tasks, outputs and attempts.
- `POST /api/settings/jobs/cleanup`: `{ "before": "YYYY-MM-DD" }` previews counts.
- Same POST with `remove: true` and the preview in `expected` clears those jobs.

## Verification

Run the policy and MCP tests with:

```powershell
node --test server/job-policy.test.mjs server/orchestrator.test.mjs server/orchestrator-mcp.test.mjs
```

The optional SQL integration test uses embedded Postgres rather than an account
database. Install its test runtime outside the repo:

```powershell
npm install --prefix "$env:TEMP/uiv2-job-tests" --no-save --no-package-lock @electric-sql/pglite
$env:JOB_TEST_PGLITE = Join-Path $env:TEMP 'uiv2-job-tests/node_modules/@electric-sql/pglite/dist/index.js'
node --experimental-test-module-mocks --test server/orchestrator-jobs.integration.test.mjs
```

This verifies transactional submission, full DAG execution, checker barriers,
parallel capacity, cancellation, interrupted execution and selective cleanup.
Agent execution is stubbed; real specialist/model behavior is not exercised.
