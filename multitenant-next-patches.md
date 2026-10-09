# Multi-tenant: what is still open (updated 2026-10-09, second pass)

Follows `multitenant-architecture.md` (root cause and layer design) and
`oct-09-2026-multitenant-test.md` (prod test results). All of it is **in code only**: not
committed, not deployed, not proven on prod.

Rule for this list: each item names the layer it belongs to. Fix at that layer, not at the
symptom. Status: `done-local` (changed and covered by a local test, still needs prod),
`open`, `untested`, `blocked`, `decided`.

## A. Fixes

| # | Layer | Item | Status |
|---|---|---|---|
| A1 | L2 company | **Every company has a Superadmin by default.** `server/companies.mjs` `createCompany` makes the company, its default records, the first Superadmin and the company-agent grants in one transaction (rolls back on any failure). Operator routes: `GET/POST /api/platform/companies`. `scripts/create-test-company.mjs` now calls it. Boot logs any company with no active Superadmin. | **done-local** (`server/companies.test.mjs`, PGlite) |
| A2 | L2 company | **Last-Superadmin guard is per company** in both places it existed (`people-service.mjs`, `users.mjs`). Open question kept: more than one Superadmin per company is allowed, at least one required; there is still no delete-user path to guard. | **done-local** (`companies.test.mjs`) |
| A3 | L2 data | **Ads Research, Company Research, ee-mail have no company on their records.** Classed as platform agents so company logins cannot use them. Real fix: add a tenant to their job/record tables, then make them company agents again. | open (needs your decision) |
| A4 | L2 data | **Row-level security covers `di.*` only.** `sessions`, `execution_runs`, `orchestrator_*`, schedules and `agent_sops` are separated in code, not by the database. `di.company_profile_field_def` has no tenant column and no RLS. | open |
| A5 | L0 platform | **Operator header is validated.** `X-Tenant-Id` must be an existing company (400 otherwise). Still open: with no header the operator acts on the bootstrap company H, so the platform is not yet a separate identity from H. | partly done-local (gate in `index.mjs`, `companyExists`; no automated test of the gate) |
| A6 | L0 platform | **Integrations and credentials are global.** WhatsApp, browser sign-ins and profiles, Google Ads, Composio, GitHub, the mail service and web search use one credential set for everyone. Decide per integration: platform-only, or per-company credentials. | open (needs your decision) |
| A7 | L3 agent input | **Legacy pooled Pi chat and AGY engine** (`chat()`, `startPiSlot`, `materializeAgyWorkspace`) cannot serve company agents: they fail with "needs a company tenant". Either retire them for company agents or give them a tenant. | open |
| A8 | Behaviour | Company admins can no longer create custom agents (`POST /api/agents` is operator-only). | open (needs your decision) |
| A9 | Migration | Existing H workspace files, attachments and old `/api/forms/<slug>` links are not moved to the new tenant paths. At boot `ensurePeopleTenant` still attaches any login with no company to the bootstrap company H (a one-time migration for pre-tenant logins). | open (alpha data only) |
| A10 | Original F4 | A refused chat no longer leaves an empty session: the assignment check now runs before `createSession` in `/api/chat`. | **done-local** (prod case `T15` written, not run) |
| A11 | L0 platform | `user_agents` rows for platform agents are **left in place** and ignored by `agent-access.mjs` (nothing is deleted). | decided |
| A12 | L0 access | **UI fixes found while checking default-deny:** `useStudio` no longer calls `POST /api/model` for a signed-in company user (it set the platform-wide default model); `/api/files` and `/api/files/raw` are now user routes limited to an assigned company agent's workspace inside the caller's company. | **done-local** (route table test; no browser run) |
| A13 | L0 access | Platform agents in the H company: H's own staff logins can no longer use platform agents (website dev, proposal, etc.) through /demo; the operator uses the owner credential. Confirm this is wanted. | open (needs your decision) |

## B. Tested locally vs not

| # | Item | Status |
|---|---|---|
| B1 | **SQL on a real Postgres engine:** the `agent_sops` migration from the old one-row-per-agent shape, the expression unique index, `ON CONFLICT`, the per-company read/save/clear. | **done-local** (`server/sops-migration.test.mjs`, PGlite). Not run on the Railway database. |
| B2 | **Route gate in `server/index.mjs`** | The table is tested (`tenancy.test.mjs`). The gate wiring itself is only syntax-checked. Prod cases T9, T10 written in `tests/multitenant/run.mjs surface`, **not run**. |
| B3 | **Anonymous access holes** (`GET /api/sessions`, `/api/messages`, `/api/files`, `/api/debug`, `/api/metrics`, `POST /api/model`) found by reading code. | Probes written (`surface` phase T9), **not run**. |
| B4 | **/demo UI under default-deny** | A test now fails if any screen under `app/demo`, `media-kit` or `db-log` calls an operator-only route. No browser run. |
| B5 | **HTTP handlers** | File sharing (company-bound read and publish token) and Media AI token binding: **done-local** (`server/tenant-handlers.test.mjs`). Still not tested: `handlePublicForm` URL parse, the Media AI HTTP routes end to end, `/company-profile/` identify wiring in `index.mjs`. |
| B6 | **Whole flows:** attachment → delegation → expense claim; scheduled runs under a company; delegated task finding the company workspace; Forward Deploy Engineer SOP edit; a company run writing `SOP.md`. | not run (prod `T12`, `T13` listed as skipped in the harness) |
| B7 | **Old harness cases never run:** T5.6–T5.8 (schedules), T8.1–T8.5 (attachments, share links, expense with attachment, workspace sharing, media). | not run |
| B8 | **Blocked:** T2.8, T7.1, T7.2, and the new T14 (operator creates a company) need the H admin password and the e-agent owner token, which are not in the vault. | blocked on credentials |
| B9 | **Local suite** | see the last line of this section. |

Last local full run: see "Result" below.

## C. Order of work

1. Decide A3, A6, A8, A13.
2. Commit, deploy; confirm `/api/health` reports the commit.
3. Run `node tests/multitenant/run.mjs surface` on prod (T9, T10, T11, T15), then the earlier `http`, `llm` phases to confirm no regression.
4. Add the missing prod cases B5 (public form link), B6, B7.
5. A4 (row-level security beyond `di.*`), A5 (platform identity separate from H), A7, A9.

Nothing here counts as done until it passes on the deployed build.

## Result of the last local run (second pass)

`node --experimental-test-module-mocks --test` over `server/**` and `document_inteligence/test/**`:
497 tests, 489 pass, 1 fail, 7 not counted as pass or fail (skipped). The one failure is
`prompt size caps` (`di-documents.md` is 4293 chars against a 4000 cap); it fails on a clean
checkout of `HEAD` too and is not caused by this work.
New in this pass: `companies.test.mjs` (4), `tenant-handlers.test.mjs` (5),
`sops-migration.test.mjs` (3), plus the screens-versus-route-table test in `tenancy.test.mjs`.
