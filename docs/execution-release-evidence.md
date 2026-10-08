# Execution release evidence

Status: **candidate verification in progress; not deployed**.

## Baseline

- Repository: `E:\000\UIv2`
- Branch: `main`
- Baseline revision: `af45b279c99c3fcfcbaebd88ca8c0353cc53f80a`
- Working tree: pre-existing user changes were present before this task; no reset, stash, branch, or deployment was performed.
- Lockfile: `package-lock.json` must be captured with the final tested revision.

## Reproduced blockers and current closure

| Blocker | Evidence | Current state |
|---|---|---|
| Specialist task omitted effective model | `server/execution/runner.mjs` task path previously called `runAgent` without `runKindOpts.modelId`; `pi-adapter.mjs` requires exact available model | Fixed in candidate: model is resolved at admission, stored in `profile_snapshot.modelId`, and passed to task worker. Real configured-model smoke remains blocked until isolated DB/model credentials are supplied. |
| Claimed task retained stale deadline | SQL returned only generation while dispatched row retained old deadline | Fixed in candidate: claim returns `generation, deadline_at`; deadline is clamped to plan request deadline. |
| Worker start/attempt failure cleanup | Worker construction and attempt insertion were outside guaranteed cleanup | Fixed in candidate: worker creation/startAttempt are inside outer try/finally; worker disposal, token revocation, active-attempt removal and chat capacity release are guaranteed. |
| Duplicate local effects | Journal insert occurred after mutation | Fixed in candidate: call identity is reserved as `running` before operation execution; same-key replays settle from the persisted row; same-key altered operation/arguments conflict. PGlite regression passes; real multi-connection PostgreSQL proof is still required. |
| Advisory lock/capacity | Lock boolean ignored; task rows and process reservation could double count | Fixed in candidate: failed advisory lock rolls back/no-ops, and task capacity uses durable running rows while process counter covers chat admission. Real two-host PostgreSQL proof remains required. |
| Host MCP not wired / duplicate worker MCP | Boot omitted adapter and Pi added MCP extension | Fixed in candidate: adapter is supplied to execution services, external tools register through canonical dispatcher, migrated Pi worker no longer starts the MCP extension, and shutdown closes adapter connections. Real production-equivalent HTTP/worker fixture remains required. |
| Migration allowlist incomplete | Only Orchestrator/DI were marked migrated | Fixed in candidate for non-AGY catalog agents; AGY remains explicitly outside the migrated set pending a contract-compliant adapter. Coverage table and live roster reconciliation remain required. |
| Client retry/replay | Client omitted stable submission key; replay used latest assistant message | Fixed in candidate: client creates one key per intentional message and passes it through continuation retries; server stores payload digest and rejects changed payloads; replay includes persisted run outcome. Browser black-box proof remains required. |

## Verification performed

### Passing

- `npm run build` — **PASS** (Vite production bundle generated).
- `node --test server/runtime.test.mjs server/pi-idle.test.mjs server/context-pack.test.mjs server/browser-lock.test.mjs server/browser-session.test.mjs` — **PASS, 29 tests**.
- `npm test` / `npm run test:execution` — **PASS, 21 tests**, executed as four isolated Node processes to prevent MCP stdio child-process interference.
- The execution suite covers people (3), dispatch (2), runner (12), and MCP adapter (4): all passed.
- `node --experimental-test-module-mocks --test --test-concurrency=1 server/execution/dispatch.test.mjs server/execution/runner.test.mjs` — **PASS, 14 tests** when run directly.
- `node --test --test-concurrency=1 server/execution/mcp-adapter.test.mjs` — **PASS, 4 tests**, including real stdio handshake, timeout/unknown outcome and credential isolation.
- `node --check` on modified execution/boot modules — **PASS**.
- `git diff --check` — **PASS**.

### Failed, skipped, or blocked

- `npm run lint` — **FAIL**: repository lint reports thousands of repository-wide/generated-output issues; this is not a clean release gate. The changed execution files pass focused ESLint after cleanup; the remaining focused issue is no longer present. The full-repository failure must still be triaged before Gate A.
- Execution tests without `--experimental-test-module-mocks` — **BLOCKED/FAIL** on this Node runtime because `mock.module` is unavailable unless the experimental module-mocks flag is supplied. The package script must encode the required flag or the test fixtures must be migrated.
- `npm ci` — **not run yet**; it mutates the dependency installation and must be run only as an authorized verification action against the lockfile.
- Real PostgreSQL multi-connection concurrency/effect/lease tests — **not run**; disposable `DATABASE_URL` is required.
- Real Pi worker + authenticated model specialist smoke — **not run**; isolated model credentials, database, identity, and bridge configuration are required.
- Real HTTP MCP fixture through worker/bridge/dispatcher — **not run**; current passing fixture is real stdio only.
- Release Docker image, migration idempotence, backup/restore and rolling overlap — **not run**; isolated release services are required.
- Browser disconnect/reload black-box status recovery — **not run**.

## Required release commands

```powershell
npm ci
npm run build
npm run lint
node --experimental-test-module-mocks --test --test-concurrency=1 server/execution/people-service.test.mjs server/execution/dispatch.test.mjs server/execution/runner.test.mjs server/execution/mcp-adapter.test.mjs
node --experimental-test-module-mocks --test --test-concurrency=1 server/expense-session.integration.test.mjs server/orchestrator-jobs.integration.test.mjs server/context-pack.test.mjs
git diff --check
```

Do not call build-only output, PGlite, fake workers, or a successful MCP unit test proof of production readiness.

## Migration and ownership coverage

- Common runner: `server/execution/runner.mjs` for migrated Pi chat and v2 specialist tasks.
- Host authorization: `server/execution/dispatch.mjs`, `routes.mjs`, `agent/extensions/host-tools.ts`.
- Durable truth: `execution_runs`, `execution_tool_calls`, `execution_events`, `orchestrator_plans/tasks/attempts`.
- Host MCP owner: `server/execution/mcp-adapter.mjs`; migrated Pi worker does not start `MCP_ADAPTER_EXTENSION`.
- AGY: explicit legacy/unsupported-for-v2 adapter boundary until it passes the same completion, cancellation, deadline, effect, and recovery contract.
- Excluded agents remain catalog-registered; functional-test exclusion is not removal.

## Deployment/rollback procedure (not executed)

1. Build and tag the exact Linux image from the tested revision; do not deploy an untested working tree.
2. Run migrations twice against a disposable restored PostgreSQL database and verify existing sessions/business records.
3. Start the image with isolated credentials, disposable company, configured model and required MCP fixtures; check readiness, worker cleanup and shutdown.
4. Only after separate authorization, deploy with the tested Railway configuration and verify the image/revision, migrations, roster, one read-only Orchestrator-to-specialist request, and UI refresh recovery.
5. Rollback uses the previous deployable image and forward-compatible schema; do not run destructive down-migrations. Reconcile any committed/unknown external effects before retrying.

## Gate status

**Gate A — Build complete: BLOCKED.** Build and deterministic execution layers pass, but lint is failing and mandatory real PostgreSQL, real worker/model, HTTP MCP, release-image, and browser recovery checks remain unverified. No production readiness or deployment claim is made.
