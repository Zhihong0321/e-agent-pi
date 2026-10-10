# Multi-tenant test plan: 2026-10-09

Target: **https://e-agent.up.railway.app** (prod, build `37f2fd2`, the agent marketplace port).
Database: playground. We may create, edit and delete any data, tenants or users without asking.
All data is wiped before launch.

Updated 2026-10-10: the default company is removed from the app (see `multitenant-architecture.md` §7).
The test history below keeps its original wording where it describes a past build; "the default
company" is the name used for the company that existed at boot before that change.

## 1. Goal

Prove that two companies on one server cannot see or change each other's data. The proof must hold
everywhere: in the /demo panels, in chat, in the orchestration layer (delegation, runs, schedules)
and in the new per-user agent assignment.

**In scope:** tenant isolation, agent assignment, and the orchestration plumbing (routing,
delegation, run records, permission checks, where data lands).
**Out of scope:** how smart or correct the LLM's answers are. Chats go through the real
third-party LLM, but we judge only **records** (DB rows, run and tool-call records, HTTP status
codes). We never judge the answer text. If the LLM gives a poor answer but the records are right,
the test passes.

## 2. How multi-tenancy works today (what we are testing)

| Mechanism | Where | Notes |
|---|---|---|
| A company is a `di.tenant` row | `document_inteligence/core/seed.mjs` | `seedTenant` fills defaults |
| A login belongs to one company | `users.company_tenant_id` | Read on every request |
| Business data is separated by row-level security | `withContext()` sets `di.tenant_id` and `SET ROLE di_app` | 36 of 39 `di` tables have RLS. The 3 without it are `company_profile_field_def`, `reset_backup` and `schema_migrations`, to be checked |
| /demo routes use the user's company | `demo-api.mjs`, `demo-expenses.mjs`, `demo-procurement.mjs`, `db-audit.mjs` | Scoping added in 7700399 |
| Insights are scoped | `demo-observability.mjs` → chat-logs, usage, activity | Admins see their own company only |
| Agent tools run as the chat's company | `diDeps` → `diRunDeps({ companyId: ctx.companyId })` | `ctx.companyId` comes from the chat run |
| Agent assignment | `user_agents` table | Checked by `/api/agents`, chat create, chat send, `submit_plan`, scheduled runs |
| Schedules | `scheduler/routes.mjs` uses `user.company_tenant_id` | The worker blocks a user from another company |

**Paths that used the default company** (weak spots at the time of this test, tested in T8; the
ambient read behind them is now removed):
- `server/index.mjs:1620`: expense delegation file packing read the default company
- `server/index.mjs:2467`: file-sharing routes read the default company
- `server/index.mjs:3501`: chat attachments were published under the default company
- `server/media-ai/host.mjs`: every route used the default company
- `companyOnboardingStatus()`: the orchestrator's `company_setup` read the default company's profile
- `agentWorkspace(profile)`: workspaces are per agent, **not** per company (shared folders)
- `/api/debug` and `/api/metrics` answer **without login** (HTTP 200, checked today)

## 3. Baseline (read from prod on 2026-10-09)

- 1 company: the default company, created at boot. Its name and id are not recorded here.
- 4 logins, all in the default company: 1 admin and 3 users.
- `user_agents` has 136 rows: every login has every agent (34 agents, including
  `mvp-alphabetizer`).
- 577 sessions, all with an owner; 330 execution runs and 4 schedules, all for the default company.

## 4. Debug pipeline (Phase 0)

We reuse what exists and add a small harness. None of this needs a prod deploy.

| # | Tool | Status | Use |
|---|---|---|---|
| D1 | `railway ssh --service "E Agent (PI)"` | **Verified today** (node 22, `/app`, `DATABASE_URL` set, build 37f2fd2) | Run Node scripts inside the prod container: DB reads and writes, fixture creation |
| D2 | `GET /api/health` | Exists | Confirm the build and `boot.ready` before every run |
| D3 | `GET /api/debug?since=…&level=warn` | Exists (public) | Server errors and warnings during the test window |
| D4 | `GET /api/execution/runs?sessionId=…` | Exists (owner or API token) | Run, tool-call and plan state for a chat |
| D5 | `GET /api/demo/activity` / `usage` / `chat-logs` | Exists (signed in) | Per-company views, and also checked for leaks |
| D6 | **New:** `tests/multitenant/ssh.sh <script>` | To build | Uploads a script with base64, runs it in `/app`, prints JSON, deletes it |
| D7 | **New:** `tests/multitenant/probe.mjs` | To build (draft exists) | Read-only snapshot: tenants, users by company, `user_agents`, runs, schedules and sessions by company, RLS flags. **Marker search:** finds every row containing a marker and reports its `tenant_id` / `company_id` |
| D8 | **New:** `tests/multitenant/client.mjs` | To build | HTTP client with one cookie jar per fixture login. Logs every request and response to `tests/multitenant/evidence/<run>.jsonl` |
| D9 | **New:** `tests/multitenant/run.mjs` | To build | Runs the T-cases in order, writes PASS/FAIL per case and links to the evidence lines |

**Marker rule:** every record a test creates carries `MT1009-<tenant>-<case>-<n>`, e.g.
`MT1009-A-T2-1`. The D7 marker search shows which company each record actually landed in. That is
the main evidence for every isolation case.

**Secrets:** fixture passwords are generated by the harness and saved in
`tests/multitenant/.fixtures.local.json`, which is gitignored and never committed or pasted into
chat.

## 5. Fixtures (Phase 1)

| Company | How it is created | Logins |
|---|---|---|
| **Default**, the default company (existing) | Already there | Existing admin, read-only control. We never write its business data |
| **A**, "MT1009 Alpha Sdn Bhd" | `scripts/create-test-company.mjs` via D6 | `mt-a-admin` (admin, from the script); `mt-a-user1` and `mt-a-user2` (user, created by `mt-a-admin` through `/api/demo/action` person) |
| **B**, "MT1009 Beta Sdn Bhd" | Same | `mt-b-admin`, `mt-b-user1` |

Assignments after setup:
- `mt-a-user1`: orchestrator, di-calendar, di-expenses, di-procurement, scheduler
- `mt-a-user2`: **only** the orchestrator, used for "unassigned" tests
- `mt-b-*`: all agents

Each company gets a filled profile (unique name, email and country) so its rows are easy to tell
apart.

## 6. Test cases (Phase 2)

Notation: **A→B** means "signed in as A, try to reach B's thing". Each case lists its evidence:
HTTP status (`client.mjs` log), the D7 marker search, and run records from D4.

### T1. Identity and sign-in
- [ ] T1.1 `/api/demo/me` for each fixture login returns the right `company_tenant_id`.
- [ ] T1.2 The cookie from login A sent with B's credentials header changes nothing. Each cookie maps to exactly one user.
- [ ] T1.3 A deactivated login (set `active=false` via D6) gets 401 on `/api/demo/*`.

### T2. Business data in the /demo panels
- [ ] T2.1 Profile: A changes its profile (`/api/demo/action` profile). B's `/api/demo/state` profile is unchanged. D7 shows A's tenant only.
- [ ] T2.2 People: A creates person `MT1009-A-T2-2`. B's people list doesn't show them. B updating A's `person_id` fails.
- [ ] T2.3 Customers and invoices: A creates a customer and a draft invoice, then issues it. B's state has neither. B issuing A's invoice id (`action: issue`) fails with not found.
- [ ] T2.4 Calendar: an event or invoice due date in A doesn't appear in B's `/api/demo/calendar`.
- [ ] T2.5 Expenses: `mt-a-user1` files a claim with a receipt. As B: `/api/demo/expenses`, `/claim?claim=<A id>`, `/receipt?id=<A id>` and `/report` all show nothing of A's (404 or 400, not data). D7 finds the receipt file under A's company folder.
- [ ] T2.6 Procurement: A creates a supplier, a PO and a supplier document. B's `/api/demo/procurement` and `/file?id=<A id>` show nothing of A's.
- [ ] T2.7 Seed buttons: the expenses and procurement `seed` actions run as A write only into A.

### T3. Insights
- [ ] T3.1 `/api/demo/chat-logs` as `mt-a-admin` lists A's sessions only. Opening a B session id returns `session: null`.
- [ ] T3.2 `/api/demo/usage` as `mt-a-admin` counts A's users only.
- [ ] T3.3 `/api/demo/activity` as `mt-a-admin` shows A's events only.
- [ ] T3.4 `/api/demo/db-log` as `mt-a-admin` shows A's audit rows only. As `mt-a-user1` it returns 403.
- [ ] T3.5 `/api/demo/metrics`: record what an admin of A sees. If it is host-wide, log it as a finding.
- [ ] T3.6 A plain user (`mt-a-user1`) sees only their own sessions and usage.

### T4. Agent assignment (marketplace)
- [ ] T4.1 `GET /api/demo/user-agents` as `mt-a-admin` lists A's logins only, never B's or the default company's.
- [ ] T4.2 `POST /api/demo/user-agents` from `mt-a-admin` with B's `userId` returns 404, and `user_agents` is unchanged (D7).
- [ ] T4.3 Same as `mt-a-user1` (not an admin) returns 403.
- [ ] T4.4 Untick di-expenses for `mt-a-user2`: their `/api/agents` no longer lists it.
- [ ] T4.5 `mt-a-user2` creating a chat with an unassigned agent returns 403 "Agent is not assigned to your account".
- [ ] T4.6 `mt-a-user2` posting to an existing session of a now-unassigned agent returns 403.
- [ ] T4.7 The default chat agent is still allowed for a login with zero assignments.
- [ ] T4.8 A new login created by `mt-a-admin` starts with **no** assignments. Record this as expected behaviour.
- [ ] T4.9 `/demo` UI: as `mt-a-user2`, the sections for unassigned agents are hidden, and Agent access is visible only to admins (screenshot through the built-in browser).
- [ ] T4.10 `GET /api/agents` with no cookie and no token returns 401.

### T5. Orchestration layer (uses the real LLM, judged on records only)
- [ ] T5.1 **Run carries the company:** `mt-a-user1` sends the orchestrator a request that needs a specialist (e.g. "add a calendar reminder MT1009-A-T5-1 for tomorrow 9am"). Pass: the `execution_runs` row has `company_id = A`, the child session belongs to `mt-a-user1`, and D7 finds the reminder in A only. The answer text is ignored.
- [ ] T5.2 **Same in B in parallel:** B does the same with marker `MT1009-B-T5-2` at the same time. Each marker lands only in its own company, and no run has the wrong `company_id`.
- [ ] T5.3 **Roster is scoped:** for `mt-a-user2` (orchestrator only), the `list_specialists` tool-call result in the run records contains no specialists, plus the "not assigned" note. Pass/fail comes from the tool result, not the reply.
- [ ] T5.4 **Delegation to an unassigned agent is refused:** ask `mt-a-user2` for an expense task. Pass: no child run for di-expenses exists. If `submit_plan` was attempted, its tool-call record shows `PERMISSION_DENIED`.
- [ ] T5.5 **DI tools inside agent runs:** a delegated di-expenses run for `mt-a-user1` writes its claim into A (D7). Run as `mt-b-user1`, it writes into B.
- [ ] T5.6 **Scheduler:** `mt-b-user1` creates an agent-job schedule (`/api/schedules…`). The DB row has `company_id = B`. A's schedule list doesn't show it.
- [ ] T5.7 **Schedule for an unassigned agent:** set up a schedule for `mt-a-user1` targeting di-procurement, then untick di-procurement. Pass: the next occurrence ends `blocked`/`failed` with "not assigned to the schedule owner", and nothing is written.
- [ ] T5.8 **Cross-company schedule owner:** via D6, move a schedule's `company_id` to the default company while its owner stays in A. Pass: the worker blocks it ("Account does not belong…").
- [ ] T5.9 **company_setup:** record the `company_setup` the orchestrator sees for A. If it reflects the default company's profile, log the finding (known default-company scope).
- [ ] T5.10 **Run status access:** `GET /api/execution/runs?sessionId=<A's session>` as B returns 404.

### T6. Sessions and messages
- [ ] T6.1 B listing `/api/sessions` never shows A's sessions.
- [ ] T6.2 B reading `/api/messages?sessionId=<A's>` returns 404.
- [ ] T6.3 B posting to `/api/chat` with A's session id returns 404, and no message is appended (D7).
- [ ] T6.4 B renaming or deleting A's session fails.

### T7. Owner (API token) path and default-company regression

### T8. Known weak spots (expected to fail; record exact behaviour)
- [ ] T8.1 **Chat attachment as B:** upload a PDF in B's orchestrator chat. Record which company folder the shared file lands in (expected: the default company, per the old attachment path at `index.mjs:3501`) and whether the delegated specialist in B can read it.
- [ ] T8.2 **Shared file links:** can a share URL created in A be opened by B or anonymously? Check `handleFileSharing` with default-company scope.
- [ ] T8.3 **Expense delegation with attachment** (`index.mjs:1620`) in B: where the receipt is packed, and whether the claim saves.
- [ ] T8.4 **Agent workspace sharing:** a file a delegated agent writes in A's run (marker filename). Can the same agent see it in B's run? Check through that run's tool-call records listing its workspace.
- [ ] T8.5 **Media AI** as B: assets created or listed belong to the default company.
- [ ] T8.6 **Public endpoints:** `/api/debug` and `/api/metrics` without login. Check whether any event text contains tenant business data (e.g. a marker) after T2 and T5.
- [ ] T8.7 **RLS gaps:** check whether `company_profile_field_def` holds per-tenant data. If it does, a tenant could read another's custom field definitions.

## 7. Pass / fail and severity

- **PASS:** the records prove isolation (status code plus D7 marker location plus run records).
- **FAIL-S1 (critical):** data from one company readable or writable from another, or written into the wrong company.
- **FAIL-S2:** an assignment or role check bypassed, but no cross-company data exposed.
- **FAIL-S3:** works but on the default company's scope (a T8-style weak spot) or an info leak through public endpoints.
- **Not a failure:** the LLM answer being wrong, slow or oddly worded, as long as the records are right. If the LLM never called a tool, re-run once. If it still won't, mark the case **INCONCLUSIVE (LLM)**, not FAIL.

## 8. Task list (execution order)

- [x] P0.1 Build D6 `ssh.sh`, D7 `probe.mjs` (snapshot plus marker search) and D8 `client.mjs`. Add `tests/multitenant/.fixtures.local.json` and `evidence/` to `.gitignore`.
- [x] P0.2 Before snapshot: run D7 and save `evidence/before.json`. Note the D3 `since` timestamp.
- [x] P1.1 Create companies A and B with `create-test-company.mjs` via D6. Save the logins to the fixtures file.
- [x] P1.2 As each admin: fill the profile and create the extra logins. Set assignments per §5.
- [x] P1.3 Re-run D7 and confirm the fixtures (T1.1 data).
- [x] P2.1 T1, T2, T3, T4, T6 (pure HTTP, no LLM).
- [x] P2.2 T5 (LLM chats, then read the records). Run T5.1 and T5.2 at the same time.
- [ ] P2.3 T7 regression, then T8 weak spots. (Not done: T7 needs the default company's admin password and owner token; T8.1–T8.5 not run.)
- [x] P3.1 After snapshot: run D7 and save `evidence/after.json`. Read D3 for errors in the window.
- [x] P3.2 Write §9 Results: one line per case (PASS / FAIL-Sx / INCONCLUSIVE), evidence link, and a finding list ordered by severity, each with the file:line to fix.
- [x] P3.3 Leave the fixtures in place (playground DB). List their ids in §9 for later cleanup.

## 9. Results

Run on prod `https://e-agent.up.railway.app` on 2026-10-09 (UTC 03:50–04:16). Evidence: `tests/multitenant/evidence/` (`run6-http.jsonl` is the clean HTTP run, `run7-llm.jsonl`, `run8-llm2.jsonl`, `run9-llm3.jsonl` are the LLM runs, `after.json` is the after-snapshot, `after-debug.json` and `anon-metrics.txt` are the public endpoint captures). Not committed.

**Not proven on prod for the cases not listed as PASS below.** Results come from DB records, D7 marker locations and HTTP status, not from LLM answer text.

### Case results

| Case | Result | Evidence / detail |
|---|---|---|
| T1.1 `/api/demo/me` per login | PASS | run6 |
| T1.2 forged identity headers | PASS | run6 |
| T1.3 deactivated login 401 | PASS | run6 |
| T2.1 profile isolation (A edit, B unchanged, marker in A only) | PASS | run6, `T2.1c` |
| T2.2 people isolation, B cannot update A person | PASS | run6 (B got 400, A row count 1) |
| T2.3 customer, draft, issue; B issue of A invoice refused | PASS | run6 (A issued `INV-2026-0002`; B got 400, doc still draft) |
| T2.4 calendar isolation | PASS | run6 |
| T2.5 expenses: B cannot list, read, or download A's claim/receipt | PASS | run6 (receipt stored at `/files/<sha>/…`; B got 400 on claim, receipt, report) |
| T2.6 procurement: B cannot see or read A's PO | PASS (T2.6a–c) | run6. T2.6d INCONCLUSIVE: supplier document intake is not an HTTP action |
| T2.7 seed buttons write only into A | PASS | run6 |
| T3.1–T3.4 admin scopes (chat-logs, usage, activity, db-log, 403 for plain user) | PASS | run6 |
| T3.5 `/api/demo/metrics` for A admin | PASS (no foreign ids) | run6; host-level telemetry is visible (see F3) |
| T3.6 plain user sees only own sessions and usage | PASS | run6 |
| T4.1–T4.3 user-agents scoping and admin-only gate | PASS | run6 (B assignments unchanged, 34→34) |
| T4.4 unticked agent disappears from `/api/agents` | PASS | run6 |
| T4.5 unassigned agent chat refused | PASS (403) | run6, but see F4 (session row left behind) |
| T4.6 follow-up to unassigned agent's session refused | PASS | run6 (0 messages appended) |
| T4.7 default agent with zero assignments | INCONCLUSIVE | not run |
| T4.8 new logins start with no assignments | NOTE | no HTTP route creates logins (`scripts/create-test-company.mjs` only) |
| T4.9 `/demo` UI hides unassigned sections | INCONCLUSIVE | browser screenshot not taken |
| T4.10 `/api/agents` anon 401 | PASS | run6 |
| T5.1 A run carries company A; reminder marker in A only | PASS | run7 (`A runs +1`, A-owned messages 3, marker in B = 0) |
| T5.2 B run in parallel carries company B | PASS | run7 (`B runs +1`, B-owned messages 3) |
| T5.3 roster for user2 contains no unassigned agent | PASS | run8 (`list_specialists` result empty, "not assigned" note in reply) |
| T5.4 unassigned di-expenses delegation writes nothing | PASS | run8 (0 claims, 0 child runs) |
| T5.5 delegated expense run writes into the caller's company | PASS on tenant and claimant; see F1 | run9. A `Lunch` 12.50 claim → A (claimant mt-a-user1). B claim → B (claimant mt-b-user1), but its description carries the default company's name (F1) |
| T5.6 schedule for B, not visible to A | NOT RUN | |
| T5.7 schedule for unassigned agent blocked | NOT RUN | |
| T5.8 cross-company schedule owner blocked by worker | NOT RUN | |
| T5.9 `company_setup` reflects the default company's profile | FAIL-S1 | run8 and run9. See F1 |
| T5.10 B's run status for A's session is 404 | PASS | run8 |
| T6.1 B's `/api/sessions` excludes A | PASS | run5/run6 (A has 7 sessions, none leaked) |
| T6.2 B reading A's messages → 404 | PASS | run6 |
| T6.3 B posting to A's session → 404, no message appended | PASS | run6 (messages 1→1) |
| T6.4 B rename/delete of A's session refused | PASS | run6 (404/404, title intact) |
| T8.1–T8.5 chat attachment, share links, expense delegation with attachment, workspace sharing, media AI | NOT RUN | |
| T8.6 public `/api/debug` and `/api/metrics` | FAIL-S3 | F2 and F3 |
| T8.7 RLS gap on `company_profile_field_def` | NOTE (no tenant leak) | the table has no tenant column and holds 23 global field definitions; RLS is still missing, which is hygiene only |

### Findings (by severity)

**F1. FAIL-S1 (critical, my classification): the default company's profile is used for every tenant's agent context and written into tenant records.**
- Root cause: `document_inteligence/host.mjs:425-427` `companyOnboardingStatus()` read the profile through the default-company helper (since removed), not the caller's tenant. It fed `server/index.mjs:627` (`company_setup` in the roster response) and `server/orchestrator.mjs:543`.
- Evidence: user2 of company A received "Your company profile is ready (<default company name>)" (`run8`, session `f.sessions.U2`). Company A's own profile is "MT1009 Alpha Sdn Bhd". The name shown to user2 is the default company's name, whose id is not recorded here. B's delegated claim `9baf99c3…` has description "Lunch at <default company name> (receiptless)" (`run9`).
- Note: the plan expected T5.9 to be "known default-company-scoped" and therefore S3. I classed it S1 because it is another company's business profile (name, email, phone, reg_no, address) reaching tenant A and B users, and being written into B's record. Please confirm the severity.
- Fix: resolve the company context from the caller in `companyOnboardingStatus` (or pass `tenantId` in), not from the default company.

**F2. FAIL-S3: `/api/debug` is public and exposes tenant chat text.**
- `server/index.mjs:2911` has no auth check. An anonymous request returned `chat session=3fd47b45… MT1009-A-T5-5 Please file an expense claim for me…` (`evidence/after-debug.json`).
- Fix: put `/api/debug` behind owner/admin auth, or strip message text from `debugLog` entries.

**F3. FAIL-S3: `/api/metrics` is public and shows host telemetry.**
- `server/index.mjs:2906` returns 200 anonymously. The body is 1.2 MB of host CPU, RSS, child-process and pi-alive samples (`evidence/anon-metrics.txt`). No tenant names or markers were found in it.
- Fix: require auth for `/api/metrics`, or limit it to the host operator.

**F4. Hygiene (not a data leak): a refused chat leaves an empty session row.**
- `server/index.mjs` ~3440 creates the session before `userMayUseAgent` at `:3451` returns 403. `mt-a-user2` gained 3 empty sessions from refused chats (T4.5 side-effect note).
- Fix: run the agent check before `createSession`.

**F5. Plan defects (fixed in `run.mjs`, not in the app):**
- §5 assumed the `person` action creates a login. It creates a person record only. Logins were created with the `create-user` probe op.
- Invoices need a customer `billing_address` before issue (`document_inteligence/core/workflows.mjs:65`).
- Receipts are deduplicated by file hash, so re-runs need `allow_duplicate: true`.
- The PO draft needs a supplier code (`S-0001` exists for A). The `save_supplier` route is not an HTTP action.
- Probe SQL `SELECT id … JOIN users` is ambiguous (fixed to `s.id`).

### Status since this run (added 2026-10-09, late)

The results above are the record of build `37f2fd2` and are left as they were. Later builds changed the findings:

| Finding | Status | Fixed in | Proof on prod |
|---|---|---|---|
| F1 default company profile in tenant context (and T5.9) | **Fixed** | `fe86945` | Fresh chats on build `fe86945`: no default-company name in any reply; T5.5 expense claims landed in A (EXP-2026-0017) and B (EXP-2026-0002) with no cross-company row. The two replies that still name the old demo company are the old stored plan replayed inside the earlier fixed sessions. |
| F2 `/api/debug` public | **Fixed** | `fe86945` (default-deny route table) | `surface` phase T9: anonymous callers refused. |
| F3 `/api/metrics` public | **Fixed** | `fe86945` | Same T9 check. |
| F4 refused chat leaves an empty session | **Fixed** | `fe86945` | `surface` phase T15 (44/44 pass on `fe86945`, 50/50 on `85be430`). |
| F5 plan defects | Fixed in `tests/multitenant/run.mjs` | n/a | n/a |

Still not run: T4.7, T4.9, T5.6–T5.8, T8.1–T8.5, and the supplier-document part of T2.6.
Open items and decisions (A4, A7, A13) are tracked in `multitenant-next-patches.md`.

### Fixture ids for cleanup (P3.3)

Playground records are left in place. Test-owned ids (all contain `MT1009` in name, marker, or notes):
- Companies: A `1739a61f-08a2-4112-b7f9-601111e8b949` (MT1009 Alpha Sdn Bhd), B `9baf99c3-0085-4532-b023-b2a5bbb47329` (MT1009 Beta Sdn Bhd).
- Logins: mt-a-admin, mt-a-user1, mt-a-user2, mt-a-user3, mt-b-admin, mt-b-user1 (ids in `tests/multitenant/.fixtures.local.json`, gitignored).
- Sessions: `sessions.A`, `sessions.B`, `sessions.U2` in the same fixtures file.
- Records with the `MT1009` marker, one set per HTTP run (run4 to run6 each created new ones, suffixed ` r<n>`): customers `MT1009-A-T2-3 Customer r<n>` (C-0003, C-0004, …) and their invoices (INV-2026-0001 to INV-2026-0003), PO `DRAFT-9b117028…` (run6), expense claims EXP-2026-0013/0014 (A) and the T5.5 "Lunch" claim (A) and "Lunch at <default company name>…" claim (B), person `MT1009-A-T2-2 Person r<n>`, and the T5.1/T5.2 reminder schedule in A (`sch_84097cf0…`) and B's schedule, plus orchestrator plans and execution runs created by T5.
