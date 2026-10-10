# Document Intelligence

A corporate admin/document assistant for UIv2, built as focused **Pi micro-agents** over one
standard Postgres schema (`di`). The goal is agents that don't just "make an invoice PDF"
but run the proper workflow: recognise the customer, check the catalogue, ask what's
missing, draft, issue with a gap-free number, render, and track payment.

Status: **MVP / working demo**. Single operator (no user management yet), multi-tenant
ready in the database, closed system (no external services besides the LLM).

## Files created for users

**Agents create files. The host publishes files. Chat displays the returned attachment.**

Use one persistent shared-files folder, one publisher, and one download route. Agent
workspaces are working directories, not the permanent address of a shared file.

```text
Storage: /storage/files/<company-id>/<file-id>/<filename>
Link:    https://<app-host>/files/<file-id>/<filename>
```

- Every Pi agent has `share_file({ path: "workspace/file.pdf" })`. Shell-capable engines
  use `node "$CLOUD_PI_SHARE_FILE" "workspace/file.pdf"`, which calls the same publisher.
- Invoices, quotations, PDF previews, form previews and CSV exports publish automatically.
  `get_document` returns the existing PDF's `pdf.link`; legacy workspace PDFs are copied
  into shared storage on lookup without reissuing. Only the saved PDF reference changes.
- The host returns `shared_files` references containing `id`, `name`, `bytes`, `url`, and
  `link`. Chat renders these directly. Orchestrator saves and passes the references with
  the task result; it does not reconstruct URLs from filenames or agent IDs.
- Files persist on the mounted `/storage` volume. A file ID hashes the filename and copied
  contents: sharing the same version returns the same link; changed contents get a new
  link. Publishing never overwrites a previous version.
- Downloads use the existing owner login and the host-selected company. The current host
  is still single-operator/default-company; this change does not add user management.
- Shared files remain until explicitly deleted. Company onboarding reset does not remove
  them. Old `/api/files/raw` URLs remain supported for historical workspace links.

Never give users `file://`, `/storage/`, or relative workspace paths as new download links.
Never add an agent/session parameter to a shared-file URL. Existing files should be looked
up or published using the same function, rather than repaired by rewriting agent prose.

Implementation and extension rules: [about-file-system.md](about-file-system.md).

---

## 1. The idea in one picture

```
 You ──chat──▶ Records Clerk ─┐                     ┌─ Template Designer
 (paste name card)            │                     │
 You ──chat──▶ Document Agent ┼─ MCP tools (stdio) ─┼─ DB Manager
 You ──chat──▶ Orchestrator ──┘   mcp-server.mjs    │
               (dispatches text tasks to any of them)
                                     │  POST /api/internal/di   (per-agent HMAC token)
                                     ▼
                     UIv2 host  ─ host.mjs ─ core/actions.mjs
                        authorise(agent, tool) → validate(zod) → run
                                     │
                                     ▼  one transaction:  SET LOCAL ROLE di_app
                                        set_config(di.tenant_id / di.actor / di.agent)
                     Postgres schema `di`
                        RLS per tenant · no DELETE · frozen issued docs · audit trigger
```

Three design rules drive everything:

1. **Safety is enforced by the database, not the prompt.** Prompts can be talked around;
   grants, triggers and row-level security can't.
2. **Intelligence is data.** What a document needs before it can be issued lives in
   `di.workflow_def`; what a record means lives in `di.entity_def`; company-specific fields
   live in `di.field_def`. Agents read these instead of guessing, and the DB Manager can
   change them per company without code.
3. **Split agents by authority, not by verb.** Create and edit a document share the same
   knowledge, so they're one agent. Changing company rules is a different *authority*, so
   it's a different agent.

---

## 2. The micro-agents

| Agent (id) | One job | Talks to you directly? |
|---|---|---|
| **Records Clerk** (`di-records`) | Customers, contacts, products, packages. Name card and lead-form intake with duplicate matching. | Yes (home tile). Paste name cards here: images don't pass through the Orchestrator. |
| **Document Agent** (`di-documents`) | Quotation / invoice / credit note lifecycle, PDFs, payments; quotations from order-form submissions. | Yes (home tile) |
| **Template Designer** (`di-templates`) | Versioned HTML templates, previews, company header. | Via Orchestrator or the agent list |
| **DB Manager** (`di-db`) | Company profile, custom fields, readiness rules, numbering, tax codes, archive/restore, audit log. | Via Orchestrator or the agent list |
| **Form Designer** (`di-forms`) | Designs forms from a fixed field vocabulary, previews, publishes/closes public links, versions live forms. Never sees submissions. | Yes (home tile) |
| **Form Clerk** (`di-intake`) | Reviews submissions per form, marks spam, links job reports to customers/invoices, summarises, exports CSV. Treats answers as untrusted. | Yes (home tile) |
| **Expenses Clerk** (`di-expenses`) | Employee expense claims: reads receipts (photo, screenshot, PDF), files them for the signed-in user, groups claims into a monthly submission by the company's cut-off day, lets admins approve/reject/close, produces the claim report. See [Expense claims](#expense-claims). | Yes (home tile). Receipts must go straight to it: images don't pass through the Orchestrator. |
| **Procurement Clerk** (`di-procurement`) | Suppliers, the quotations and invoices they send, draft and issued purchase orders (PDF), goods received, and invoice-vs-PO checks before payment. See [Procurement](#procurement). | Yes (home tile). Send supplier documents straight to it. |

All run on the `assistant` tool profile: **no general file editing, shell or SQL**.
Business operations use the `document-intelligence` MCP server, which shows each agent
only its own tools. The common `share_file` tool can publish an existing workspace file.
Role prompts: `agent/roles/di-*.md`.

The tool ↔ agent matrix is the `agents` array on each entry in
[`core/tools.mjs`](core/tools.mjs). That one registry is read by both the MCP server
(to advertise tools) and the host (to authorise calls), so they cannot disagree.

---

## 3. Safety model (what's guaranteed, and where)

| Guarantee | Enforced by | Where |
|---|---|---|
| Nothing is ever hard-deleted | `di_app` has no DELETE/TRUNCATE grant **and** a `BEFORE DELETE/TRUNCATE` trigger on every table (stops the owner role too) | `sql/001_core.sql` → `di.forbid_delete` |
| Removal = soft delete, restorable | `deleted_at/deleted_by` columns; `archive_*` / `restore_record` tools | `core/admin.mjs` → `archiver`, `restoreRecord` |
| Agents can't change structure (DDL) | `di_app` owns nothing and has no CREATE; the "schema customisation" is rows in `field_def` / `workflow_def` | `sql/001_core.sql` grants |
| Company A never sees company B | RLS policy `tenant_id = di.current_tenant()` on every table, `WITH CHECK` too | `sql/001_core.sql` DO-loop |
| Issued documents are frozen | `di.guard_document` trigger: after draft, only status/payment/void/pdf/e-invoice fields may change; `guard_document_line` blocks line changes | `sql/001_core.sql` |
| Numbers are gap-free | Assigned only at issue, inside the issuing transaction, with `SELECT … FOR UPDATE` on the sequence row | `core/common.mjs` → `nextNumber` |
| Every change is attributable | `AFTER INSERT/UPDATE` trigger writes before/after + actor + agent; `di_app` can't UPDATE/DELETE the log | `di.audit` trigger, `di.audit_log` |
| An agent can't use another agent's tools | Tool not advertised (MCP) **and** refused by host (`allowed()`) **and** the per-agent HMAC token can't be replayed as a different agent | `core/tools.mjs`, `host.mjs` |
| Agents never hold DB credentials | MCP server calls the host over HTTP; `DATABASE_URL` stays in the host process | `mcp-server.mjs`, `server/agent-env.mjs` |

If the connecting Postgres user can't create or use the `di_app` role, boot logs
`role separation: false` and everything still works, but only the triggers and app-level
checks protect you. On Railway's default `postgres` superuser the role works.

---

## 4. Data model

```
tenant ─┬─ customer ─┬─ contact
        │            └─ attachment (name card image + extracted JSON)
        ├─ product ── package_item ── package
        ├─ tax_code                       (SST: NT default, SV8, SV6, ST10, ST5, EX)
        ├─ document ─┬─ document_line     (copies price/tax/description at the time)
        │   (quotation│invoice│credit_note, source_document_id = quote→invoice link)
        │            └─ payment_allocation ── payment
        ├─ document_sequence              (QT-/INV-/CN-/RCP- yearly; C- customer codes)
        ├─ template                       (versioned HTML; documents pin template_id at issue)
        ├─ entity_def                     (what each record type means, how to match it)
        ├─ field_def                      (custom fields: type, options, required_for)
        ├─ workflow_def                   (readiness rules per doc_type + transition)
        └─ audit_log
```

Every table has `id uuid`, `tenant_id`, `custom jsonb`, `created_*`, `updated_*`,
`deleted_*`. Issued documents also freeze `customer_snapshot` and `issuer_snapshot`, so
editing a customer or your company profile later never changes an old PDF.

MyInvois (LHDN e-invoice) is prepared, not integrated: `tin`, `msic_code`, `sst_no` on
tenant/customer, `einvoice_uuid/status/qr_url/validated_at` on document, and warning-level
readiness rules for a missing TIN.

### Document lifecycle

```
quotation: draft ─issue─▶ issued ─▶ accepted ─convert─▶ converted  (+ new invoice draft)
                              └──▶ rejected | expired | void
invoice:   draft ─issue─▶ issued ─pay─▶ partially_paid ─pay─▶ paid
                              └──▶ void (only if unpaid)
draft:     ─cancel─▶ cancelled (soft-deleted)
```

---

## 5. How "document intelligence" works

**Readiness rules.** A rule is `{check, arg?, severity: block|warn, message}`. The
`check` names a function in the fixed vocabulary `CHECKS` in
[`core/workflows.mjs`](core/workflows.mjs) (e.g. `customer_has_billing_address`,
`date_set:due_date`, `issuer_profile_complete`, `custom_field:document.po_number`).
Defaults per document type are in `DEFAULT_WORKFLOWS`, seeded into `di.workflow_def` per
tenant. Custom fields with `required_for: "invoice.issue"` become blocking rules
automatically (`rulesFromFieldDefs`).

**`prepare_document`** is the "think before acting" step. From the user's own words it:
resolves the customer (via `matchCustomer`), resolves each item against the catalogue,
evaluates the readiness rules against a *virtual* draft, and returns `questions`,
`warnings`, `suggestions` (e.g. valid_until = today + 30) and a price estimate. It writes
nothing. The Document Agent's prompt makes it call this first and ask all questions in one
message.

**Customer matching** (`matchCustomer` in [`core/records.mjs`](core/records.mjs)) scores
candidates: same SSM reg no or TIN 100 · same email 90 · same phone 75 · same name 80 ·
same company email domain 60 · similar name 55/30 · +15 if the person is already a
contact. Verdict: `existing` ≥ 90, `possible` 40–89, `new`. Normalisation is
Malaysia-aware: `012-345 6789` → `60123456789`; `202301012345 (1500000-A)` → the 12-digit
SSM number; "Sdn Bhd", "Enterprise" and similar are ignored in names; free-mail domains
don't count as a company domain.
`save_customer` refuses to create an `existing` match unless `allow_duplicate`.
`save_name_card` on an existing customer **only fills blanks**, never overwrites.

### Forms

```
form (slug = public link, draft | published | closed)
  └─ form_version  schema = field list JSON; draft -> published (frozen by trigger) -> retired
       └─ form_submission  data = validated answers JSON, pinned to its version; answers frozen by trigger
                           status new -> reviewed -> processed (linked customer/document) | spam
```

- **No code from agents.** A form is a field list in the vocabulary `FIELD_TYPES`
  ([`core/forms.mjs`](core/forms.mjs)). One fixed page ([`core/formpage.mjs`](core/formpage.mjs))
  renders every form with escaped text and a single CSP-nonced script; the same field list
  validates every submission on the server (unknown keys dropped, types normalised,
  phone/email cleaned).
- **Never collected:** passwords, PINs, OTP/TAC, card numbers/CVV, banking logins
  (`FORBIDDEN`, refused at save). Personal data blocks publishing until `consent_text` is set;
  the agreed text is stored on each submission.
- **Uploads:** images/PDF only, type checked from file bytes; ≤10 MB per file, ≤5 files per
  field, ≤25 MB per submission, 1000 MB per tenant (`LIMITS`). Forms can go lower, never
  higher. Files land in the Form Clerk's workspace under `form-uploads/`.
- **Public route:** `GET/POST /api/forms/<slug>` (`handlePublicForm` in `host.mjs`, no login):
  capped body, 10 submissions per IP per form per 10 min, hidden honeypot field,
  `closes_at` / `max_submissions`. No agent sits in this path.
- **Meaning, not labels:** `binds_to` (`customer.name`, `contact.email`,
  `line.<SKU>.quantity`, `survey.<metric>`…) is how `intake_submission` (Records Clerk) and
  `prepare_document`/`create_draft` `from_submission` (Document Agent) turn answers into
  records, reusing name-card matching (fill blanks only) and the document procedure. A
  processed submission is never turned into a second record.
- **Summaries** exclude spam by default and never pool differently shaped questions (a 1–5
  and a 1–10 rating are reported per form).

---

### Expense claims

```
expense_setting (cut-off day, currency)        one row per company
expense_batch   (monthly submission)           open -> closed (frozen by trigger; report stored)
  └─ expense_claim   EXP-yyyy-nnnn             submitted -> approved | rejected | withdrawn
       └─ expense_receipt                      insert-only; file in shared storage, sha256 for duplicates
```

- **One receipt = one claim.** A claim joins the monthly submission by the day it was **filed**:
  with cut-off day 10, claims filed 11 Sep to 10 Oct belong to the October submission
  (`cycleFor` in [`core/expenses.mjs`](core/expenses.mjs)). Filed after that month is closed? It
  rolls to the next one. Changing the cut-off day re-files claims still in open submissions.
- **Closing a month** (`close_monthly_submission`, admin): refuses while claims are pending unless
  `carry_forward_pending`; freezes the claims (database trigger, not the prompt); stores the final
  report PDF. Pending claims can't be left behind silently.
- **Who is acting** is not left to the model. Each chat turn for this agent ends with an
  `[Expense identity: ...]` line carrying a random code the host minted for the signed-in user
  (`expenseIdentityPrompt` in `server/users.mjs`). The tools take it as `identity`; `runTool`
  resolves it (`deps.resolveIdentity`) to `{id, username, role}`, records the username as the audit
  actor, and passes it to the handler. **Admins** see and approve everything and file for anyone;
  **regular users** see only their own claims. No identity (e.g. dispatched by the Orchestrator)
  means every expense tool refuses. The `/demo` routes call the same tools with the signed-in user
  passed in directly (`deps.who`).
- **Receipts** are chat attachments (`_inbox/...`). `loadReceipts` ([`core/receipts.mjs`](core/receipts.mjs))
  checks the path, size and the real file type from the bytes, publishes a durable copy to shared
  storage, and the claim stores its link and SHA-256: the same file can't back two claims unless the
  user confirms.
- **Reports** ([`core/expense-report.mjs`](core/expense-report.mjs)): one A4 PDF per submission
  (or per claimant), grouped by person with subtotals, category summary, sign-off lines and an
  appendix of image receipts. An open month is a DRAFT; closing fixes the final file. `claims`
  also export to CSV with spreadsheet-formula protection.
- **Demo data:** `/demo` > Expenses > "Load demo claims" (admin) files ~12 claims with generated
  sample receipts across a closed and an open month, through the same code
  ([`core/expense-demo.mjs`](core/expense-demo.mjs)). It is idempotent; "Reset & Start Fresh" in
  company onboarding removes it (closed months can't be edited, by design).
- Not built: foreign-currency claims (refused with a clear message), mileage rates, per-category
  limits, emailing the report, payment of approved claims.

#### Customizing the Expenses page

An admin can change how the `/demo` Expenses page looks for their company: **Customize page** in
the panel header. Everything else on this page (what claims are required to carry, categories,
limits) is policy, above, and is not touched by this.

- **What can change:** the small heading above the month; which summary tiles, table columns,
  status filters, claim-detail rows and optional filing-form fields show; their names; and the
  order of tiles, columns, filters and detail rows. Claim, Amount and Status (table) and date,
  total, merchant, category and the receipt (form) can be renamed but never hidden, because the
  page needs them. A status name is one setting: renaming "Pending" renames the filter and every
  badge.
- **Where it lives:** the default layout is code ([`core/page-layout.mjs`](core/page-layout.mjs)).
  A company's row in `di.ui_config` ([`sql/009_ui_config.sql`](sql/009_ui_config.sql)) holds only
  what it changed, so improvements to the default still reach companies that customized something
  else, and **Restore default** just soft-deletes the row (the old choices stay as history and in
  `di.audit_log`). Choices equal to the default are not stored: saving them is a restore.
- **Safety:** admin only, checked on the server; one company never sees another's row (RLS);
  every save names the revision it started from, so two admins can't silently overwrite each
  other; a stored layout that no longer fits is partly ignored and flagged ("Needs attention")
  instead of breaking the page; labels are plain text, 40 characters at most.
- **The agent does not see or change it.** The layout is not a tool; the Expenses Clerk's tool
  list is unchanged (a test guards this).
- **Adding a customizable page:** add it to `PAGES` in `core/page-layout.mjs`, return
  `loadLayout(...)` from the page's route, draw items by id from the response (see
  `TILES`/`COLUMNS`/`DETAIL` in `app/demo/expenses.tsx`), and reuse `LayoutEditor`.
- Tests: `test/page-layout.test.mjs` (rules, two-company isolation, restore, history, stale edits).

### Procurement

```
supplier (S-0001)
  ├─ supplier_document   quotation (SQ-) | invoice (SI-)   what they sent us: evidence, frozen, file kept
  └─ purchase_order (PO-) ── purchase_order_line (received_qty) ── goods_receipt (insert-only)
        draft -> issued (admin: number + freeze) -> partially_received -> received | cancelled
```

- **Own tables, not the sales documents.** The buying side has different rules: the supplier's number
  is theirs, our PO number is ours, and what they send is evidence, not something we edit.
- **Recording** (`record_supplier_document`): the model reads the attached quotation/invoice
  (their number, dates, lines, tax, grand total) and the file is kept through the same receipt loader
  as expense claims. A duplicate (same supplier + their number, or the same file) is refused until the
  user confirms; a wrong document is voided and re-recorded.
- **PO lifecycle** (`core/procurement.mjs`): anyone signed in drafts (`create_po_draft`, optionally
  `from_quotation`) and edits drafts; only an **admin** issues (`issue_po`: next `PO-yyyy-nnnn`, frozen
  by trigger, PDF made and stored) or cancels (`cancel_po`: reason, nothing received, no live invoice).
  `receive_goods` records what arrived against lines; the database refuses receiving more than was
  ordered, and the order moves to `partially_received` / `received` by itself.
- **The match** (`judgeMatch`): an invoice linked to a PO is compared with the PO total (1% / RM 1
  tolerance), with everything billed so far on that PO, and with the value of goods received. Issues
  are reported when recording and in `get_supplier_document`. `set_supplier_invoice_status` refuses to
  mark a non-matching invoice **paid** unless `confirm_mismatch=true`, which the prompt reserves for
  after the user has heard the issues. Paid and void are final. Due dates default to the supplier's
  payment terms; `procurement_overview` lists overdue, due-soon, disputed, late deliveries and
  invoices that don't match their PO.
- **Who may do what** reuses the Expenses Clerk identity mechanism (`[Procurement identity: ...]`
  line, `identity` on every tool): drafting, recording and receiving are open to any signed-in user;
  issue, cancel, paid and void are admin only, enforced in the domain code, and gated in the checker.
- **/demo:** "06 Procurement" (`app/demo/procurement.tsx`, `server/demo-procurement.mjs`) shows POs,
  invoices, quotations and suppliers with a detail drawer (issue, receive, mark paid, dispute, PDF) and
  an admin "Load demo data" button (`core/procurement-demo.mjs`) that files four suppliers and a spread
  of states through the same code.
- Not built: partial payments, foreign-currency documents, editing an issued PO (cancel and redraft),
  emailing the PO to the supplier, approval limits.

---

## 6. File map

```
document_inteligence/
  sql/001_core.sql      schema, triggers, RLS, di_app role + grants (the safety model)
  core/
    db.mjs              pg / PGlite adapters, migrate(), withContext() (role + tenant per tx)
    tools.mjs           ★ tool registry: zod input, allowed agents, handler. Start here.
    actions.mjs         runTool(): authorise → validate → run → PDF after commit
    common.mjs          DiError, nextNumber (gap-free), validateCustom, MY phone/SSM/name normalisers
    records.mjs         customers, contacts, matchCustomer, saveNameCard
    catalog.mjs         products, packages, tax codes, findCatalog
    documents.mjs       prepare/create/update/issue/convert/void, payments, renderDocumentHtml
    admin.mjs           company profile, describeSchema, custom fields, rules, numbering, templates, audit, archive
    workflows.mjs       CHECKS vocabulary, DEFAULT_WORKFLOWS, evaluate()
    templates.mjs       logic-less template engine, render context, default A4 templates
    seed.mjs            idempotent per-company seed (tax, numbering, rules, templates), run when a company is created
  mcp-server.mjs        stdio MCP server; DI_AGENT picks the tool set; forwards to host
  core/expenses.mjs     expense claims + monthly submissions (cut-off math, filing, review, closing)
  core/receipts.mjs     receipt files from chat attachments: checks, durable copy
  core/expense-report.mjs  claim report PDF/HTML + CSV
  core/expense-demo.mjs    demo claims for /demo
  core/procurement.mjs     suppliers, supplier quotations/invoices, POs, goods received, the invoice match
  core/procurement-report.mjs  purchase order PDF
  core/procurement-demo.mjs    demo procurement data for /demo
  host.mjs              UIv2 glue: boot, agent cards, per-agent tokens, /api/internal/di, Chromium PDF
  test/di.test.mjs      domain + safety tests on PGlite (real Postgres engine, in-process)
  test/mcp.test.mjs     real MCP protocol round-trip per agent, token replay refused
  package.json          dev-only (PGlite for tests); runtime deps come from the root package

agent/roles/di-records.md · di-documents.md · di-templates.md · di-db.md   role prompts
```

Touch points in the rest of UIv2 (keep these in sync if you move things):

| File | What |
|---|---|
| `server/index.mjs` | imports `host.mjs`; boot step `document-intelligence` (after `orchestrator-mcp`); route `POST /api/internal/di`; `wantsAuth` bypass for that route (it's authenticated by per-agent token instead) |
| `server/agent-env.mjs` | `Object.assign(env, diAgentEnv(agent, …))` injects `DI_AGENT`, `DI_TOKEN`, `DI_URL` into DI agents only |
| `server/catalog.mjs` | `seedSystemAgent` is exported so `host.mjs` can upsert the agents |
| `.dockerignore` | excludes `document_inteligence/node_modules` (dev-only PGlite) |

Generated PDFs land in each agent's workspace (`<WORKSPACES_DIR>/di-documents/documents/QT-2026-0001.pdf`,
template previews under `di-templates/previews/`). Agents return a workspace-relative
markdown link that the chat UI opens through `/api/files/raw`.

---

## 7. Running and testing

```bash
cd document_inteligence && npm install     # once: installs PGlite (dev only)
npm test                                   # 52 tests, ~15 s, no database needed
```

In UIv2 nothing extra is needed: on boot the host migrates `di`, registers the four agents and
the MCP server. Boot creates no company: a fresh database has zero companies. Create one with
`POST /api/platform/companies` (or `scripts/create-test-company.mjs`); `createCompany` makes the
company, seeds it and creates its first admin login. Look for
`document-intelligence ready (migrations: …; role separation: true)` in the event log.

**First run in the app:** a new company has no address, so issuing is blocked
(by design) until you tell the **DB Manager** your company details (name, legal name,
SSM, address, bank details; TIN/SST/MSIC for MyInvois later).

Demo script:
1. Records Clerk: paste a name card → "record this customer".
2. Records Clerk: "add product Solar panel 550W, RM650, sales tax 10%" (a few of these, plus a package).
3. Document Agent: "quotation for Acme, the 10kWp package and installation" → answer its
   questions → "issue it" → PDF link.
4. Document Agent: "Acme accepted QT-2026-0001, make the invoice" → "issue" → "they paid 10k by IBG".

---

## 8. How to extend

**Add a tool.** Write the domain function `(tx, args) => result` in the right `core/*.mjs`
module (throw `DiError` for user-facing refusals). Register it in `TOOLS` in `core/tools.mjs` with a
zod `input`, a description written *for the model* (when to use it, what it refuses), and
the `agents` allowed. Nothing else to wire: the MCP server and host both pick it up. Add a
test in `test/di.test.mjs`. If the tool needs a PDF, set `pdf: (result) => documentId` or
`previewPdf: true`.

**Add a readiness check.** Add a function to `CHECKS` in `core/workflows.mjs`
(`(ctx, arg) => boolean`, ctx = `{doc, lines, customer, contact, tenant, template}`). Use
it in `DEFAULT_WORKFLOWS` (new tenants) or let the DB Manager add it via
`set_workflow_rules` (existing tenants: seeding never overwrites an existing
`workflow_def`).

**Add a standard column/table.** New file `sql/002_<name>.sql` (never edit an applied
migration; `migrate()` runs each file once, tracked in `di.schema_migrations`). Keep
the conventions: common columns, then add the table to the trigger/RLS loop (copy the DO-block
pattern), and re-run the `di_app` grants at the end of the file. Add the column to the
whitelist arrays in the matching core module (`CUSTOMER_FIELDS`, `PRODUCT_FIELDS`, …) and
the zod shape in `tools.mjs`. Prefer a custom field (`define_custom_field`) when only one
company needs it.

**Add a document type** (e.g. delivery order, receipt PDF): extend the `doc_type` CHECK in
a new migration, `DOC_TYPES` in `documents.mjs`, the zod enums, `DEFAULT_WORKFLOWS`, a
sequence in `DEFAULT_SEQUENCES`, a default template in `templates.mjs` and `seed.mjs`.

**Add a micro-agent.** Add it to `AGENTS` in `tools.mjs` and `AGENT_CARDS` in `host.mjs`,
write `agent/roles/<id>.md` (knowledge first, rules last; see `agent/AGENT_BLUEPRINT.md`),
and list it in the `agents` array of the tools it needs.

**Change a template's look.** Ask the Template Designer. It saves a new version, and
old documents keep theirs. The seeded default only changes for *new* companies.

---

## 8a. Checker agent (`checker/`)

Workers are not made reliable by growing their prompts. They stay small; a separate checker
compares **input vs result** and sends failures back to the same worker with a reason.

```
user ─▶ worker ─▶ [gate: irreversible write?] ─▶ write ─▶ reply ─▶ [check] ─▶ user
          ▲__________________ fail + reason (max 2 retries) ________________|
```

| Part | File | What |
|---|---|---|
| Gate | `checker/index.mjs` `gateWrite` | Before `issue_document`, `record_payment`, `void_document`, `convert_to_invoice`, `set_quotation_status`, `set_numbering`, `save_customer{allow_duplicate}`: judge asks "did the user ask for exactly this?" A block returns a tool error to the worker; nothing is written. |
| Code checks | `checker/checks.mjs` | Exact, no model: reasoning-tag leak, empty reply, document/customer numbers that don't exist, status claims that don't match the database. |
| Judge | `checker/judge.mjs`, `checker/prompts/*.md` | One JSON-only model call with a tiny context: request, tool log, stored facts, reply, every agent's tool names. Default `glm-5.3-flash` on OpenCode Go (a different family from the workers); override with `DI_CHECKER_BASE_URL` / `DI_CHECKER_API_KEY` / `DI_CHECKER_MODEL` / `DI_CHECKER_REASONING`. |
| Loop | `checker/loop.mjs` `runChecked` | Retry in the same session with the checker's reasons; after 2 retries the reply goes out with "Checker could not confirm this reply: …". |

Judge errors fail open (recorded as `judgeError`), so a flaky checker never blocks work.
Size caps in `test/checker.test.mjs` fail the build if a role prompt passes 4000 chars or a
checker prompt passes 1200. **A new failure mode becomes a check here, not a prompt line.**

Stress tests run through `test/pi-harness.mjs` with the checker on
(`node test/manual-pi-edge-eval.mjs [count] [--no-checker]`). `node test/replay-checker.mjs
<report.json> [steps]` re-judges a finished run without re-running the workers.

Not yet wired into the live UIv2 chat (only the stress-test harness uses it).

---

## 9. Known limits and next steps

In rough priority order:

1. **Users and roles.** Today every call runs as actor `owner`. Next: pass the signed-in
   user to `/api/internal/di` (the host knows the chat session), store `app_user(role)`,
   and let `allowed()` check role × tool, e.g. sales can use Records Clerk and Document
   Agent but not archive, DB Manager or void. The DB layer needs no change: `di.actor`
   is already recorded on every audit row.
2. **Tenant selection.** Agents act on the company stored on the run, schedule or delegated
   task. A signed-in user's company comes from `users.company_tenant_id`; an owner-credential
   chat names its company with `X-Tenant-Id`. The RLS plumbing already takes any tenant id.
3. **Images through the Orchestrator.** `dispatch_task` forwards text only, so name cards
   must go straight to the Records Clerk. Forwarding `_inbox/` attachments to specialists
   would fix it.
4. **Credit notes.** The type, numbering and template slot exist; a proper `credit_invoice`
   tool (link to the invoice, negative allocation) does not.
5. **MyInvois submission.** Fields and warnings exist; the LHDN API integration
   (submission, validation UUID, QR) is not built (it would be the first external call).
6. **Forms.** Public links carry the company in the URL (`/api/forms/<tenantId>/<slug>`), so
   they do not depend on a default company. Rate limits are in memory (per process, reset on restart). Uploads
   live on the app's disk, not object storage, and have no virus scan. No conditional
   (show-if) fields, no email/WhatsApp notification on new submissions.
6. **Email / send.** Documents are rendered, not sent.
7. **Reporting.** Aging, sales by customer/product: add read-only tools over views.
8. **Real DDL for heavy customisation.** Custom fields (JSONB, validated) cover most
   needs; if a company needs indexed/typed columns, add a DB-Manager *proposal* flow that
   writes a migration file for a human to apply, never direct DDL.
