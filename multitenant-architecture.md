# Multi-tenant architecture: root cause and layer design

Written 2026-10-09 after the multi-tenant test (`oct-09-2026-multitenant-test.md` §9).

## 1. The model we want

```
Platform                 one deployment; owns what is the same for everyone
  └─ Tenant (company)    owns all business data, files, workspace, rules, schedules
       └─ User slots     many logins per tenant; a login belongs to exactly one tenant
```

Rule: **every operation runs for exactly one tenant, and that tenant is named by the caller's
identity, never by the process.**

## 2. Root cause (traced, not patched)

The data layer follows the model: `users.company_tenant_id`, `withContext()` and row-level security.

The application layer was built for "one deployment = one company", and that model is still
there as a second, hidden rule:

1. **An ambient tenant.** `document_inteligence/host.mjs` kept `state.tenantId`, the default
   tenant chosen at boot, plus `companyHostContext()` to read it with no argument. Any code can
   ask "which tenant?" and get an answer without being told. A missing tenant is therefore never
   an error: it silently becomes tenant H.
2. **No Platform layer.** Tenant H (a real customer) doubles as the platform. The owner token,
   public endpoints, and platform defaults all run as H, so platform state and customer H data
   are the same thing.
3. **Agent inputs have no tenant in their signature.** An agent receives data through three
   channels. Only the tool channel (`ctx.companyId` → `diRunDeps` → `withContext`) carries a
   tenant. The prompt channel (company status, SOP), the file channel (workspace, attachments,
   shared files, media) and the control tools (`get_company_setup`) take none, so they use the
   ambient tenant or no tenant at all.
4. **Resources keyed by agent only.** `agent_sops` is keyed by `agent_id`; `agentWorkspace()`
   maps an agent to one folder. Both are shared by every tenant using that agent.
5. **Entry points that cannot name a tenant.** Public form URLs (`/api/forms/<slug>`) while slugs
   are unique per `(tenant_id, slug)`; `/company-profile/` is behind the owner password, so a
   tenant user cannot reach their own form.

Every finding in the test (F1–F4) and every unrun weak spot (T8) is an instance of 1–5.
Patching call sites would leave the cause and the next call site.

## 3. Layer design

### L0 Platform
Owns: agent definitions, models, skills, context pack, health, operator endpoints
(`/api/debug`, `/api/metrics`).
- Operator endpoints require operator auth.
- The owner/operator credential is a **platform** identity. It acts on a tenant only when it
  names one: `X-Tenant-Id` header or `?tenant=`. If it names none, the single bootstrap tenant is
  used, and only at operator-auth entry points (§4).

### L1 Tenancy kernel — `server/tenancy.mjs` (new, the only place tenant resolution lives)
- `tenantOf(user)`: the user's `company_tenant_id`, else throws `TenantRequired`.
- `tenantFromRun(ctx)`: `ctx.companyId`, else throws.
- `operatorTenant(req)`: resolves the tenant for an operator-authenticated request.
- `tenantDb(tenantId)`: `{ db, tenantId, asRole }` for `withContext`; `tenantId` is required.
- `bootstrapTenantId()`: used at boot and migration only.

### L2 Tenant-owned resources (each takes a `tenantId`, none read an ambient one)
| Resource | Rule |
|---|---|
| Business data (`di.*`) | `withContext` + row-level security (exists) |
| Company profile / readiness | `companyOnboardingStatus(tenantId)` |
| Agent workspace | `<workspaces>/<tenantId>/<agent>`; `agentWorkspace(agent, tenantId)` |
| SOP | `agent_sops` gets `company_id`; null = platform default, a tenant row overrides |
| Attachments and shared files | stored and published under the caller's tenant |
| Public forms | URL carries the tenant: `/api/forms/<tenantId>/<slug>` |
| Media | the caller's tenant |
| Schedules, runs, plans | `company_id` from the creating user (exists) |

### L3 Agent input assembly — one function
`buildAgentInput({ tenantId, user, agent })` returns everything an agent is given: workspace
path, SOP, company status for the prompt, attachment destination, and the tool context. Chat
runs, delegated runs and scheduled runs all use it. No other code puts tenant data in a prompt.

### L4 Enforcement
- Static guard test: ambient accessors (`operatorContext`, `bootstrapTenantId`) may only be
  imported by an allow-list of files. Adding a use fails the build.
- `agentWorkspace()` and `companyOnboardingStatus()` throw without a tenant.
- Conformance harness (`tests/multitenant/`): every route and tool is exercised as A and B with
  markers and fails if a marker lands in the other tenant.

## 4. Operator entry points (allow-list)
Boot and migration; the owner-authenticated branches of `/api/chat`, `/company-profile/*`,
file sharing and media; nothing else.

## 5. Order of work
1. L1 kernel; remove the ambient accessor; make L2 profile, control tools, orchestrator gate,
   chat prompt, legacy DI path and demo helpers take a tenant.
2. L2 workspace, SOP, attachments, file sharing, media, forms URL, company-profile auth.
3. L0 operator auth on `/api/debug` and `/api/metrics`.
4. L4 guard test and the conformance harness; rerun the T-cases on prod.

## 6. Migration notes
Alpha, no important data. Existing workspace folders move under the host tenant's id; existing
SOP rows keep `company_id = NULL` (platform default). Existing form links need the tenant
segment; the form page renders the new link.

## 7. Status (2026-10-09, local, not deployed, not proven on prod)

Done in code, each at its layer:

| Layer | Change |
|---|---|
| L1 kernel | `server/tenancy.mjs`: `tenantOf`, `tenantFromRun`, `tenantForRequest`, `tenantOfSession`, `tenantOfOwner`. `companyHostContext()` and `state.tenantId` are gone; the bootstrap tenant is `operatorTenantId()`, readable only through the kernel and `host.mjs`. |
| L0 access | `server/route-access.mjs`: every `/api/` route is public, user or operator, and an unlisted route is operator. This replaces the deny-list `wantsAuth`, which left every GET not named in it open (`/api/sessions`, `/api/messages`, `/api/files`, `/api/debug`, `/api/metrics`, `POST /api/model`). |
| L0 agents | `isPlatformAgent()` splits platform agents from company agents. `server/agent-access.mjs`: a company user can use only an assigned company agent, so platform agents cannot be assigned or used by company logins, whatever `user_agents` says. |
| L2 workspace | `agentWorkspace(agent, tenantId)`: company agents get `workspaces/tenants/<tenantId>/<slug>` and throw without a tenant. The runner picks it from the run's company. |
| L2 SOP | `agent_sops` has `company_id` (NULL = platform default). Reads fall back to the default; writes from a company, including the Forward Deploy Engineer, only touch that company's row. |
| L2 prompt | `companyOnboardingStatus(tenantId)` requires a tenant. `get_company_setup`, the roster, the chat prompt and the dispatch gate all pass the run's company. The runtime `STATE.md` journal (what the last chat did) is platform-agents only. |
| L2 files | Shared-file upload token binds `(agent, tenant)`; reads use the caller's company and need a sign-in. Chat attachments publish under the caller's company. |
| L2 forms | Public link is `/api/forms/<tenantId>/<slug>`. |
| L2 media | `mediaAction` requires a tenant; the helper's token binds the company (HMAC), and the helper is started per company and user. |
| L2 profile | `/company-profile/` is for a company admin (own company) or the operator (named company). |
| L4 | `server/tenancy.test.mjs` (route table, workspace isolation, static guard against ambient tenant). Existing suites updated; full local run: 476 pass, 1 fail (`prompt size caps`, `di-documents.md` is 4293 chars against a 4000 cap, unrelated and already failing). |

Open items:
1. **Ads Research, Company Research, ee-mail** have no company on their records, so they are classed as platform agents and unavailable to company logins until their tables carry a tenant.
2. **Legacy pooled Pi chat** (`chat()`/`startPiSlot`, used only for the AGY engine) cannot serve company agents: it fails closed. Prewarm skips company agents.
3. **Row-level security** covers `di.*` only. `sessions`, `execution_runs`, `orchestrator_*`, schedules and `agent_sops` are tenant-keyed in code, not by the database.
4. **Old data**: existing files under `workspaces/<slug>` and public form links from before this change are not migrated (alpha data only).
5. `di.company_profile_field_def` has no tenant column and no RLS (hygiene).
6. **Not run yet**: the conformance harness against the deployed build, including new anonymous-access, workspace, SOP, file-link, form-link and media cases. Nothing here counts as done until that passes on prod.
