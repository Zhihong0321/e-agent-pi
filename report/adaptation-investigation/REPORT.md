# How E Agent adapts to each company: investigation report

Date: 2026-10-12 · Scope: read-only investigation (no repo code was changed; this report, 3 probe scripts
and their outputs are the only files added, all under `report/adaptation-investigation/`).

Evidence tags used throughout:
**[RUN]** I executed it and saw the result · **[CODE]** read in source (file:line) · **[DOC]** stated in a repo doc only · **[NOT TESTED]** not verified.

---

## 0. Executive summary

| # | Your question | Short answer |
|---|---|---|
| 1 | How does E adapt to each company? | **By data, not by code.** One codebase and one set of agents serve everyone. Each company gets its own rows (profile, custom fields, issue-rules, numbering, tax codes, templates, forms, SOP text) inside a database that is walled per company. Agents do not carry company knowledge in their prompts; they read it from the company's rows through tools at run time. The company is named by the signed-in identity, never by the process. |
| 2 | Invoice/quotation: how does it handle different schemas/SOPs? | **Well for "what is required, how it is numbered, which tax, how it looks"; not for "what the lifecycle is, what documents exist, or what is printed".** A clinic and a solar installer diverged cleanly in my run (different blocking rules, numbering `BC/000001` vs `INV-2026-0001`, tax code, currency). But a company's **custom fields are enforced and stored, never printed** (templates cannot see them), the three document types and the lifecycle are fixed in code and the database, and "quotation valid 30 days" is a code constant. |
| 3 | Which AI specialists adapt the system to a company? | **Six, with clear lanes:** Company Onboarding (profile, people), **DB Manager** (custom fields, issue-rules, numbering, tax), **Template Designer** (look), **Form Designer** (forms), **Forward Deploy Engineer** (Superadmin business rules; today **expense claims only**, plus SOP text), with the **Orchestrator** only routing. Anything not expressible as data is escalated to engineering (`notes_for_engineering`). Note the lanes overlap in one place: Onboarding also holds the four DB-Manager rule tools. |
| 4 | Why doesn't this break the whole platform? | Because a company can only change **typed data in closed vocabularies**, enforced by the database (row-level security, no DDL, no DELETE, frozen issued documents, audit). I tried to break it from inside a company and every attempt stayed inside that company. **Three exceptions are weaker:** (a) company-written **HTML templates are rendered by a shared server-side Chromium with JavaScript on** [RUN]; (b) **SOP text** is free prose with a 120,000-character limit and no history; (c) **new platform defaults never reach existing companies** [RUN]. Also, the DB-Manager rule tools have **no role check** below the "which agents is this user assigned" level [RUN]. |

Test status today: Document Intelligence suite **190/191 pass**; orchestration suite **24/24**; server tenancy/SOP/company group **59/60**. The 2 failures are explained in §6 (one is old, one is caused by uncommitted work). I did not test the deployed production system.

**Code state matters.** `HEAD = origin/main = fe5d9b3`. A large **uncommitted** change set (24 modified + new files) holds the new "code routes, model only picks a key" orchestration (`server/routing.mjs`, `agent/intents.json`, router-only orchestrator). That is **not** what production runs. Where behaviour differs I say so.

---

## 1. Q1: Current setup: how E adapts to a company

### 1.1 The model

```
Platform (one deployment)        agents, role prompts, models, skills, tool registry, migrations, code
  └─ Company (tenant)            its own rows, files, workspace, SOP, schedules, runs
       └─ Users                  login = company code + username + password; roles: Superadmin / Department head / User
```

Rule written in `multitenant-architecture.md` §1: *every operation runs for exactly one tenant, and that tenant is named by the caller's identity.* [DOC], and implemented as:

| Step | What happens | Where |
|---|---|---|
| Sign-in | company code + username + password; `users.company_tenant_id` | `server/users.mjs`, migration `012_company_code.sql` |
| Tenant resolution | one place: `tenantOf(user)`, `tenantFromRun(ctx)`, `tenantForRequest`; missing tenant **throws** (no default company exists) | `server/tenancy.mjs` L17-59 [CODE] |
| Agent assignment | an agent runs for a user only if a Superadmin assigned it; platform agents are never usable by company logins | `server/agent-access.mjs`, `server/index.mjs` L2491-2498 [CODE] |
| Tools | every Document Intelligence tool call opens one transaction: `SET LOCAL ROLE di_app` + `set_config('di.tenant_id', …)` | `document_inteligence/core/db.mjs` `withContext` [CODE] |
| Database | row-level security `tenant_id = di.current_tenant()` with `WITH CHECK`; no DELETE/DDL grants for `di_app` | `sql/001_core.sql` [CODE] [RUN §3] |
| Workspace & SOP | `workspaces/tenants/<tenantId>/<agent>`; `agent_sops` row per (agent, company), falls back to a platform default | `server/paths.mjs`, `server/sops.mjs` L65-73 [CODE] |
| Process isolation | each run gets a fresh Pi runtime dir (`RUNTIME_DIR/execution/<attemptId>`) built with that run's `companyId` | `server/execution/pi-adapter.mjs` L48-63 [CODE] |

### 1.2 What a new company gets

`createCompany` (`server/companies.mjs` L31-57) does, in **one transaction**: insert `di.tenant` (a trigger creates its `company_profile`) → `seedTenantTx` → first Superadmin login → grant that Superadmin every non-platform agent. A company with no Superadmin cannot exist.

`seedTenantTx` (`document_inteligence/core/seed.mjs` L123-177) copies platform defaults into the company's rows:

| Seeded per company | Default | Notes |
|---|---|---|
| Tax codes | NT, SV8, SV6, ST10, ST5, EX (Malaysian SST) | `DEFAULT_TAX_CODES` L7-14 |
| Numbering | QT-, INV-, CN-, RCP-, C-, EXP-, S-, PO-, SQ-, SI- | `DEFAULT_SEQUENCES` L16-27 |
| Entity descriptions | what each record type means + match keys | `ENTITY_DEFS` L29-117 |
| Issue-rules per document type | `DEFAULT_WORKFLOWS` | `core/workflows.mjs` L49-83 |
| Templates | "Standard quotation", "Standard invoice" (A4) | seed L154-175 |

Then onboarding fills the **company profile** (`di.company_profile`: name, country, currency, address, tax status, payment terms, bank, logo…). Minimum readiness (name, country, business type/activity, currency, email-or-phone) gates every operational agent (`companyDispatchGate`, `server/orchestrator.mjs` L600-607 in prod; `decide()` in `server/routing.mjs` L166-204 in the rework).

### 1.3 The adaptation toolbox (all of it is data)

| Table (all tenant-scoped by RLS) | Holds | Changed through |
|---|---|---|
| `di.company_profile` (+ global `company_profile_field_def`) | who the company is, currency, terms | `update_company_profile` (Superadmin-only) |
| `di.field_def` | custom fields on customer, contact, product, package, document, payment (+ expense_claim via FDE) | `define_custom_field` |
| `di.workflow_def` | per document type: ordered rules `{check, arg, severity block|warn, message}` from a fixed vocabulary of 14 document checks (plus 2 that apply to expense claims only) | `set_workflow_rules` |
| `di.document_sequence` | prefix, padding, yearly reset, next number (forward-only) | `set_numbering` |
| `di.tax_code` | code, rate, kind | `save_tax_code` |
| `di.template` | versioned HTML; an issued document pins the template it was issued with | `save_template` |
| `di.form` / `form_version` | forms as a field list in a fixed vocabulary | Form Designer tools |
| `di.ui_config` | override-only page layout (expenses page) | Settings UI, not an agent |
| `di.expense_setting.custom` | extra categories, saved reports, FDE registry/history | FDE |
| `agent_sops` (host DB, not `di`) | company's own SOP text per agent | `save_agent_sop`, FDE, Settings page |

**How an agent "knows" a company's rules.** It doesn't. Role prompts are platform-wide files (`agent/roles/*.md`, upserted on boot by `seedSystemAgent`, `server/catalog.mjs` L800-836). At run time the agent calls `describe_schema`, `prepare_document` and reads each draft's `readiness`; the role text tells it to "trust them over your own assumptions" (`agent/roles/di-documents.md`). The only per-company text injected into a prompt is the **SOP** ("Mandatory agent SOP", `server/runtime.mjs` L138-141) and the host-verified `[Signed in …]` line (`server/roles.mjs` L46-56).

Weight of this design [RUN, probe 3]: `describe_schema` is 17.6k characters (≈4.4k tokens) per call, of which 9.6k is standard column listings that never differ between companies (`evidence/p3-context-weight.out.txt`). Tool counts: DB Manager 30, Document Agent 26, Onboarding 23.

### 1.4 Config files that steer behaviour

| File | Role |
|---|---|
| `agent/roles/*.md` (31 files) | platform-wide role prompts; capped by `agent/prompt-budgets.json` |
| `agent/intents.json` *(uncommitted)* | one owner agent per request type; code routes, model only picks a key |
| `agent/prompt-budgets.json` *(uncommitted)* | character caps per role |
| `document_inteligence/core/tools.mjs` | single registry: tool ↔ allowed agents ↔ zod input ↔ handler; read by both host and MCP server |
| `document_inteligence/sql/001…012` | schema; applied once each, additive, under an advisory lock (`core/db.mjs` `migrate`) |

---

## 2. Q2: Invoice and quotation across different companies

### 2.1 What adapts, by what mechanism, and where the limit is

| Axis | Mechanism | Hard (DB/code) or soft (prompt) | Changed by | Limit found |
|---|---|---|---|---|
| Extra data on a record (PO no., patient id, site type) | custom field, types text/number/date/boolean/select | **Hard**: validated on every save (`validateCustom`, `core/common.mjs` L123-164); unknown keys refused | DB Manager, Onboarding | type can never change; **no fields on document lines**; **never printed** (§2.3) |
| What is required before issue | issue-rules from the 14-check vocabulary; a field with `required_for: invoice.issue` becomes a blocking rule automatically | **Hard**: evaluated inside the issuing transaction (`rulesFor`, `core/documents.mjs` L127-136) | DB Manager, Onboarding | no conditional rules for documents (`when` is expense-claims only, `workflows.mjs` L113-114); no approval step; `customer_selected`, `has_lines`, `template_available` must stay blocking |
| Number format | prefix, padding, yearly reset; gap-free via `SELECT … FOR UPDATE` | **Hard** | DB Manager, Onboarding | one series per type; forward-only |
| Tax | `tax_code` rows (code, rate); per-line | **Hard** | DB Manager, Onboarding | `kind` enum is Malaysian-SST only (`sst_service|sst_sales|exempt|none`); a GST/VAT company must label itself `none` |
| Currency | `company_profile.currency` → `document.currency` | Hard | Superadmin | number format is fixed `en-MY` (`money()`, `templates.mjs` L120) |
| Look and wording | template HTML versions, logo, header | Hard (pinned at issue) | Template Designer | **JS/HTML unrestricted** (§4); custom fields invisible |
| Quotation validity / due date defaults | `prepareDocument` suggests today+30; customer `payment_terms_days` / profile terms for invoices | Code constant | engineering | no per-company setting for quotation validity (`documents.mjs` L298-304; also design doc F-9) |
| Lifecycle, document types | `doc_type CHECK IN ('quotation','invoice','credit_note')`, triggers freeze issued documents | Hard, fixed | engineering (migration + code) | a "delivery order" cannot be added with data |
| Agent conversation behaviour | company SOP text | **Soft** (prompt) | FDE, Settings | see §4 R5 |

### 2.2 Worked example: two real-shaped companies, same code [RUN, probe 1, S1]

Company **A** keeps defaults (solar installer, MYR). Company **B** (clinic, SGD) defines `document.po_number` required at invoice issue, relaxes "customer billing address" from block to warn, adds tax code `GST9` as default, sets invoice numbering to `BC/` + 6 digits without yearly reset.

| Same input (customer with no billing address, 2 hours of service) | Company A | Company B |
|---|---|---|
| Blockers on the draft | `customer_has_billing_address` | `custom_field(document.po_number)` only |
| Billing-address rule | blocks | warns |
| Issue attempt | refused | refused: "Customer PO no. (document) is required before issuing" |
| After fixing | `INV-2026-0001` | `BC/000001` |
| Tax codes visible | SST set | SST set + `GST9` (A does not see it) |

All 7 assertions passed (`evidence/p1-di-adaptation.out.txt`, S1.1-S1.7).

### 2.3 The gap that matters most for invoices [RUN, S2]

`buildContext` (`core/templates.mjs` L185-251) hands a template `doc`, `company`, `customer`, `lines`, `tax_summary`. It contains **no `custom`**. Result in the run: company B's PO number `PO-7781` was **required to issue** but **absent from the rendered invoice**; the Template Designer is told `doc.custom.po_number` is an unknown field ("prints empty"); `template_variables` lists no custom variable. A company that adds a field for its own SOP can enforce it but cannot print it, except by copying the value into the free-text `reference`/`notes`.

### 2.4 What "SOP" means for a company

Two different things share the word:

1. **Business SOP as data** (hard): readiness rules, required fields, numbering, FDE expense rules. The database enforces it; the agent cannot talk around it.
2. **Agent SOP as prose** (soft): `agent_sops`, injected into that agent's prompt as "Mandatory agent SOP". The Document Agent *may* follow it. The routing intent `company_rules` even uses "From now on, every quotation must show a validity of 14 days" as its example, but the FDE that owns that intent can only write expense rules or SOP text (`fde.mjs` L21, `tools.mjs` L78), so for quotations the rule becomes prose.

---

## 3. Q3: Which AI specialists take part in adapting E to a company

| Specialist (id) | Lane | What it can change | Authority check | Tools |
|---|---|---|---|---|
| **Company Onboarding** (`di-onboarding`) | first-run setup: profile, people, hand-offs | profile fields, people/logins, onboarding checks; **also** `define_custom_field`, `set_workflow_rules`, `set_numbering`, `save_tax_code` | profile write: Superadmin only; the four rule tools: none (see R2) | 23 |
| **DB Manager** (`di-db`) | "shape the document system to fit this company" | custom fields, issue-rules, numbering, tax codes, archive/restore, audit log, profile | profile write: Superadmin only; rest: none (R2) | 30 |
| **Template Designer** (`di-templates`) | look | template versions, default, header/logo via profile | none beyond agent assignment | 19 |
| **Form Designer** (`di-forms`) / **Form Clerk** (`di-intake`) | forms and their submissions | forms in a fixed field vocabulary with `binds_to` | publish only on user say-so; never code | 19 / 17 |
| **Forward Deploy Engineer** (`di-fde`) | a Superadmin's standing business rule → data | extra expense categories, claim fields, rules, saved reports, one SOP block; whole-agent SOP via `get/save_agent_sop` | `isAdmin` check in code; preview → fingerprint → apply; `fde_revert` | 3 + 2 SOP ops |
| **Orchestrator** (`orchestrator`) | routing only | nothing | prod: planner that also wrote SOPs; rework: `route_request` only | 1 (rework) |
| Records Clerk, Document Agent, Expenses/Procurement Clerks | *use* the adapted system | data inside the rules | identity-bound for Expenses/Procurement | 20 / 26 / 14 / 17 |
| Checker / judge (`document_inteligence/checker`) | reviews replies and gates irreversible writes | nothing | **not wired into live chat** (only `test/pi-harness.mjs` and tests call it) [CODE] | n/a |

Human roles: **Superadmin** (per company, "their word sets the rules"), **Department head**, **User**, and the **platform operator** (acts with `X-Tenant-Id`; owns code, migrations, agent prompts).

How a request reaches the right specialist: in prod the Orchestrator plans; in the uncommitted rework `agent/intents.json` maps request type → owner (`document_rules → di-db`, `document_templates → di-templates`, `company_profile → di-onboarding`, `forms_design → di-forms`, `company_rules → di-fde`) and code checks assignment and profile readiness before creating one task (`decide()` in `server/routing.mjs` L166-204).

**Where the lanes blur**

- Onboarding and DB Manager both hold the four rule tools (`tools.mjs` L586-640: `agents: [DB, ONBOARD]`). The README's rule "split agents by authority, not by verb" is not true here.
- The FDE is scoped to expense claims by a zod enum (`target_agent: z.enum(["di-expenses"])`, `tools.mjs` L78) [RUN S9.4], yet the `company_rules` intent describes it as the owner of standing rules for the whole company.
- `agent/roles/di-fde.md` tells the FDE it can change "the Orchestrator's email rules" SOP. In the rework the orchestrator receives **no SOP** (`runtime.mjs` L131-132, tested in `prompt-budget.test.mjs`), so that edit would silently do nothing.
- When none of them can express the rule, the FDE is told to "say it is not supported yet and put it in `notes_for_engineering`": the human escalation path to the platform team.

---

## 4. Q4: Why this does not break the whole platform, and where it still could

### 4.1 Containment model in one sentence

A company can change only **(a) typed data from closed vocabularies**, which the database and validators contain well, plus two **free-form channels**: **(b) prose SOP** injected into prompts, and **(c) HTML templates** rendered by a privileged browser. (a) is strong, (b) and (c) are weaker.

### 4.2 Defence in depth: what I verified

| Layer | Mechanism | Evidence |
|---|---|---|
| Identity → tenant | one kernel, throws when no tenant, no default company | `server/tenancy.mjs`; tests "kernel exports no process-wide default company", "operator request with no company is refused" pass |
| Database | RLS with WITH CHECK, `di_app` without DDL/DELETE, delete/truncate triggers, frozen issued documents, append-only audit | **[RUN]** S3.1-S3.5: A cannot read B's rows (0), cannot insert a row owned by B (RLS violation), cannot `ALTER TABLE`, cannot `DELETE` |
| Closed vocabularies | unknown rule check, unknown field, duplicate/type-changed field, standard-column shadowing, 4th document type all refused | **[RUN]** S4.1-S4.5 |
| Platform invariants | `customer_selected`, `has_lines`, `template_available` cannot be made non-blocking | **[RUN]** S4.2 |
| Immutability | a new default template does not alter an issued document | **[RUN]** S7.1-S7.2 |
| Blast radius of a bad rule | self-inflicted lock-out stayed in the company and was recoverable by re-sending the rule list; company A unaffected | **[RUN]** S4.6-S4.11 |
| Audit | every rule change recorded with agent, actor, field-level from/to | **[RUN]** S6.1 |
| Safe rollout of risky business rules | FDE: closed vocabulary, mandatory pass/fail examples, dry run, fingerprint, history, revert, `open_claims` impact count | `core/fde.mjs`, `test/fde.test.mjs` pass |
| Routing (rework) | owner chosen from a closed list in code; not-assigned and not-ready are fixed replies | orchestration group passes (24/24), includes `routing.test.mjs` |
| Per-run isolation | fresh runtime dir and company-scoped SOP per run | `pi-adapter.mjs` L48-63 [CODE] |
| Regression net | 191 DI tests, tenancy static guard, conformance harness | §6; harness last recorded on prod for build `85be430` [DOC] |

### 4.3 Residual risks, ranked

| # | Risk | Evidence | Blast radius | Severity |
|---|---|---|---|---|
| R1 | **Company-authored template HTML runs JavaScript in a shared server-side Chromium.** `save_template` only checks `{{ }}` syntax; `<script>`, external `<img>`, `<iframe>` and a 3 MB template were all **accepted** [RUN S8.1-S8.2]. The host renders with `--no-sandbox`, JS on, one shared browser for all companies (`host.mjs` L142-165). In my replica of that call: script ran, an `<img>` made the server-side browser request an internal address, and script **read a JSON endpoint that sends `Access-Control-Allow-Origin: *`** (the app's `json()` does, `server/index.mjs` L391) [RUN P2.1-P2.3]. It could not read non-CORS responses or `file://` [RUN P2.4-P2.5]; no auth cookie is sent. Not tested: a hanging script's effect on other companies' renders; that script text reaches the PDF (inferred). | platform-wide (shared browser, internal network) | **High**: low probability, high impact; an LLM-written template from an uploaded invoice is the likely route |
| R2 | **No role check on the rule-changing tools.** Only `update_company_profile` is `superadminOnly` (`tools.mjs` L554, enforced `registry.mjs` L415). A *non-admin* user got `define_custom_field`, `set_workflow_rules`, `set_numbering` to succeed [RUN S9.1-S9.3]. Real protection = "the Superadmin did not assign DB Manager/Onboarding/Template Designer to that user". | one company | **Medium** |
| R3 | **New platform defaults never reach existing companies.** `seedTenantTx` runs only from `createCompany` and `resetCompany` [CODE: graft callers]; its inserts are `ON CONFLICT DO NOTHING` (templates: only an untouched seeded default is upgraded, and only when the seed runs); no migration or boot step backfills. Simulated older company without the `supplier` sequence: `save_supplier` → *No numbering sequence for "supplier"* [RUN S5.1]; re-running the seed leaves a customised rule list untouched [RUN S5.2], so by the same code a changed default cannot reach existing rows (S5.3 is an illustration, not a test). By contrast `di.ui_config` is override-only, so default improvements do flow (`page-layout.mjs` header). Two patterns coexist. | each existing company, on first use of a newer feature | **Medium** (grows with every release) |
| R4 | **A rule can name a custom field that does not exist.** Accepted [RUN S4.6]; then every invoice in that company is unissuable and the agent cannot even fill the field [S4.7-S4.8]. Recoverable by resubmitting the rule list [S4.9]. No dry-run impact count like the FDE's `open_claims`; a newly required field blocks drafts already in flight [S4.10]. | one company | **Medium** |
| R5 | **SOP is unbounded and irreversible.** Limit 120,000 characters (`sops.mjs` L16, `registry.mjs` L255) against role caps of 900-6,500 characters; the prompt-budget test checks role files only. Whole-text replace, `clear` is a SQL DELETE, no history table (graft/grep: none). FDE reversibility covers only its marked block (`<!-- fde:start -->`). A bad SOP only mis-steers that company's agent (DB rules still hold) but cannot be rolled back. | one company | **Medium** |
| R6 | **Custom fields are enforced but not printable** (§2.3). | one company; product gap, not a safety gap | **Medium** (credibility) |
| R7 | **Malaysia is hard-coded in code paths**: `todayMY()` (UTC+8 dates), phone/SSM normalisation, SST `kind`, MyInvois wording in rule messages, `en-MY` number format, default tax set. Profile fields `country`, `language`, `business_type`, `customer_type` are stored but drive nothing; `timezone` drives only the calendar [CODE: grep]. | non-Malaysian company | **Medium** for expansion |
| R8 | **The checker is not live.** The README describes a gate before `issue_document`, `record_payment`, `void_document`, etc.; `gateWrite`/`runChecked` have no caller outside tests and the stress harness [CODE]. Real protection for irreversible writes today = DB rules + prompt + the user's explicit instruction. | all companies | **Medium** (documentation vs reality) |
| R9 | **Row-level security covers `di.*` only.** `sessions`, `execution_runs`, `agent_sops`, schedules are separated in code (`multitenant-next-patches.md` A4, open). `company_profile_field_def` is a global table (profile structure cannot differ per company). | cross-company if code regresses | **Medium** (mitigated by tests) |
| R10 | **Production proof is stale.** The last recorded prod run of the conformance harness is build `85be430` (2026-10-09). Later work (default-company removal, company codes, queue gates) and the whole routing rework are described as locally tested. Nothing here ran against production. | all | **Process** |
| R11 | **Prompt-size gate disagrees with itself.** `document_inteligence/test/checker.test.mjs` caps role prompts at 4,000 characters; `agent/prompt-budgets.json` allows 4,300 for `di-documents`. The role is 4,248 characters (4,293 with Windows CRLF), so the DI test fails on any OS. | build hygiene | **Low** |

---

## 5. Not-yet-built, but implied by the questions

1. **Per-company defaults as data** (quotation validity days, payment terms behaviour). `company_profile.settings` (jsonb) already exists and is unused by any rule.
2. **Approval / sign-off steps on documents**: no mechanism. A company needing "invoice over RM 10,000 needs manager approval" can only approximate it with SOP prose.
3. **A second numbering series for the same document type** (e.g. per branch): not supported.
4. **Tax regimes other than SST** are possible only by relabelling (`kind`); inclusive-tax and multi-component tax were not tested.

---

## 6. Test results

| Run | Command | Result | Notes |
|---|---|---|---|
| Document Intelligence | `npm test` in `document_inteligence` | **190 pass / 1 fail / 191** | failure `prompt size caps`: `di-documents.md` 4,293 > 4,000 (pre-existing, also noted in `multitenant-architecture.md` §7, see R11) |
| Orchestration | `npm run test:orchestration` | **24 / 24 pass** | routing, prompt budgets, agent prompts, roles |
| Server tenancy, SOP, companies, users, sessions, shared files | `node --experimental-test-module-mocks --test` on 10 files | **59 pass / 1 fail / 60** | failure `shared-files.test.mjs:123` expects the orchestrator's assembled role to contain the file-sharing rules; the **uncommitted** `server/runtime.mjs` change deliberately makes the orchestrator return its role file alone. A stale test, not a product defect; it should be updated before the rework is committed |
| Probe 1 (domain, in-process Postgres) | `probes/p1-di-adaptation.mjs` | 39 pass, 1 expected FAIL, 1 note | the FAIL (S2.2) is the finding "custom value not printed"; the note (S5.3) is an illustration |
| Probe 2 (Chromium) | `probes/p2-template-chromium.mjs` | P2.1-P2.5 pass, P2.6 note | replicates the host's launch options; does not import `host.mjs`; loopback server only |
| Probe 3 (context weight) | `probes/p3-context-weight.mjs` | numbers only | |

During the run I corrected two weak assertions of my own (S5.1 was passing on an unrelated "sign-in required" error; S6.2 was vacuous). Final assertions check the exact error or data they claim. Evidence files: `evidence/`.

---

## 7. Recommendations (nothing below was implemented)

Ordered by value; each removes a risk without growing a prompt, in line with `AI-Orchestration-and-agent-design.md` §0 ("code decides, the model fills in").

| Priority | Recommendation | Addresses |
|---|---|---|
| 1 | **Harden the renderer**: new browser context with `javaScriptEnabled: false`, block every request except `data:` and the company's logo origin, and reject `<script>`, `<iframe>`, `<object>`, `on*=` and external URLs in `save_template` / `preview_template`; add a size cap. | R1 |
| 2 | **Tool-level authority**: flag `define_custom_field`, `set_workflow_rules`, `set_numbering`, `save_tax_code`, `save_template`, `set_default_template` as `superadminOnly` like `update_company_profile`. One-line each; keeps "the Superadmin's word is final". | R2 |
| 3 | **Additive tenant reconcile on boot**: create missing sequences, entity defs, tax codes and default templates for every existing company, never overwrite. Longer term, store only the company's *difference* from the default (the `ui_config` pattern). | R3 |
| 4 | **Validate and preview rule changes**: reject `custom_field` rules whose field is undefined; report "N open drafts would become blocked" in `set_workflow_rules` and `define_custom_field` (the FDE already does this for claims). | R4 |
| 5 | **Expose custom values to templates** (`doc.custom.*`, `customer.custom.*`, escaped) and list them in `template_variables`. | R6 |
| 6 | **SOP hygiene**: a realistic cap (a few thousand characters), a version table with restore, covered by the budget test; fix the FDE role text about the Orchestrator SOP. | R5, §3 |
| 7 | **One owner for rule tools** (DB Manager); keep Onboarding to profile and people. Extend the FDE changeset beyond expenses (quotation/invoice rules) so `company_rules` matches what it can really do. | §3 |
| 8 | **Decide the checker**: wire the write gate into live chat, or correct the README. | R8 |
| 9 | **Run the conformance harness on the deployed build** after the rework ships, and reconcile the two prompt caps. | R10, R11 |
| 10 | **Country packs as data** (tax kinds, date/number format, phone rules) before onboarding a non-Malaysian company. | R7 |

## 8. What I did not verify

- Anything on production (no deploy, no prod credentials used).
- Model behaviour: whether an LLM actually asks for the PO number, follows a company SOP, or writes a `<script>` template when handed an invoice image. I tested the system's constraints, not the model's choices.
- The effect of a never-ending script on other companies' PDF renders (deliberately not run).
- Which unauthenticated app endpoints return CORS-open JSON (relevant to the size of R1).
- The Settings UI and `/demo` pages as a human would use them (no browser session).
- Per-company behaviour of the Google Ads, WhatsApp, Composio, GitHub and browser-sign-in integrations (global credentials; out of scope per owner note in `multitenant-next-patches.md` A6).

## Appendix A: key file map

| Topic | File : lines |
|---|---|
| Tenant kernel | `server/tenancy.mjs` L6-59 |
| Company creation | `server/companies.mjs` L31-57 |
| Seed of defaults | `document_inteligence/core/seed.mjs` L7-27, L123-177 |
| Rule vocabulary and defaults | `document_inteligence/core/workflows.mjs` L19-83, `validateRules` L90-133 |
| Custom fields, rules, numbering, tax | `document_inteligence/core/admin.mjs` L55-148 |
| Rules used at issue time | `document_inteligence/core/documents.mjs` L127-136 |
| Template context (no custom) | `document_inteligence/core/templates.mjs` L185-251 |
| PDF render | `document_inteligence/host.mjs` L142-165 |
| Tool ↔ agent registry | `document_inteligence/core/tools.mjs` (`define_custom_field` L586, `set_workflow_rules` L601, `update_company_profile` L553-554, `fdeChangeset` L77-78) |
| SOP store and injection | `server/sops.mjs` L13-18, L65-129; `server/runtime.mjs` L129-145 |
| SOP tools | `server/execution/registry.mjs` L209-271; DI tool registration L395-422 |
| FDE | `document_inteligence/core/fde.mjs` L20-22 (targets, limits) |
| Dispatch gate (prod) | `server/orchestrator.mjs` L600-607 |
| Routing (uncommitted) | `server/routing.mjs` L166-204, `agent/intents.json` |
| Page layout override pattern | `document_inteligence/core/page-layout.mjs` header |

Probes: `report/adaptation-investigation/probes/`. Outputs: `report/adaptation-investigation/evidence/`.
