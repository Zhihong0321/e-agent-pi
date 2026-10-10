# Per-tenant custom page: Expenses pilot

Status: **built and verified locally (2026-10-04); not committed, not deployed** · written 2026-10-03 · scope: the `/demo` **Expenses** page only.

See section 13 for what was built, what differed from this plan, and what is left.

If this works, the same mechanism carries to Procurement and the other pages (see section 10).

---

## 1. Goal

Each company (tenant) can change how the Expenses page looks, and the choice is stored in the database, not in code. Every tenant starts on the **default** layout. An admin can **restore the default** at any time.

**Non-goals for this pilot:** agent customization, nav/page-heading changes, drag-and-drop, free-form layout, tenant HTML/CSS/JS, making the host truly multi-tenant, other pages.

## 2. Decisions (locked unless you change them)

| # | Decision | Why |
|---|---|---|
| D1 | The database holds a **JSON config**, never JSX/HTML to run | Security and maintenance. The page stays code; only choices are data. |
| D2 | **Default lives in code. The tenant row stores only the difference.** | "Restore default" = remove the override. Code improvements still reach tenants who customized something else. No per-tenant copy of the default. |
| D3 | **Restore = soft delete** of the override row | Every `di` table forbids DELETE (no grant + trigger). Soft delete also keeps history, same as custom fields. |
| D4 | **Look only, no rules.** Required fields, categories, limits stay in the existing policy tables | The agent already reads those. A page tweak must not make page and agent disagree. |
| D5 | **Locked items can be renamed but not hidden** | Hiding what the filing rules need would break the form. |
| D6 | Only **admins** can customize. Everyone sees the result. | Enforced on the server, not just by hiding a button. |
| D7 | The layout code uses **plain functions called from the demo route**, not entries in `core/tools.mjs` | The agent's tool list stays identical. Agent parity is a later step. |
| D8 | A broken or outdated stored config **falls back to the default**, flagged for the admin | A bad config must never blank the page. |

## 3. Facts this plan relies on (checked in the code on 2026-10-03)

- The panel loads from `GET /api/demo/expenses` via `panelState` in `server/demo-expenses.mjs`. Adding a `layout` field is additive, so an old cached client keeps working.
- `ExpensesPanel` in `app/demo/expenses.tsx` hard-codes the stat tiles, table columns, status chips, drawer rows and form fields. The refactor is the main work.
- `withContext(db, { tenantId, actor, agent }, fn)` already scopes a transaction to one tenant. The receipt route uses it directly, so the layout can too.
- Tests already build **two tenants** (`tenantA` / `tenantB`) on PGlite and run as the `di_app` role, so a missing grant or RLS policy would fail a test.
- Tenant data lives in `di.*` tables with: `tenant_id`, RLS policy, no-delete and no-truncate triggers, audit trigger, `custom jsonb`, `deleted_at`. The pattern to copy is the end of `sql/006_expense_claims.sql`.
- `sql/` ended at `007_procurement.sql` when this was written (`008_audit_protection.sql` has since been added by another session). Migrations run at boot, once each, in name order, under an advisory lock.
- `.ex-stats` is hard-coded to 5 columns in `expenses.css`. It must become flexible when tiles are hidden.
- `panelState` does **not** pass the company's policy fields to the page, so tenant-defined fields never show in the claim form today. This is an existing gap, out of scope here (section 10).
- The page title block (eyebrow, h1, subtitle) and the nav label live in shared `app/demo/page.tsx`. They are out of scope for the same reason.

**Baseline before any change**
- `node --test test/expenses.test.mjs test/expense-policy.test.mjs` (in `document_inteligence/`): 40 pass, 0 fail, ~17 s.
- `npx eslint app/demo/expenses.tsx server/demo-expenses.mjs`: 5 existing problems in `expenses.tsx` (4 errors, 1 warning). Do not add any.
- `npx tsc --noEmit`: 4 errors repo-wide, none in `app/demo/expenses.tsx`.

## 4. Data model

New file `sql/009_ui_config.sql` (check `ls sql` first; use the next free number).

```sql
CREATE TABLE IF NOT EXISTS di.ui_config (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT di.current_tenant() REFERENCES di.tenant(id),
  page         text NOT NULL CHECK (page ~ '^[a-z][a-z0-9_]{0,47}$'),   -- 'expenses'
  config       jsonb NOT NULL DEFAULT '{}',   -- sparse override, never a copy of the default
  rev          integer NOT NULL DEFAULT 1,    -- +1 per save; stops two admins overwriting each other
  default_rev  integer NOT NULL,              -- revision of the code default when saved (informational)
  custom       jsonb NOT NULL DEFAULT '{}',
  created_at, created_by, updated_at, updated_by, deleted_at, deleted_by   -- same as the other tables
);
CREATE UNIQUE INDEX IF NOT EXISTS di_ui_config_page_idx
  ON di.ui_config (tenant_id, page) WHERE deleted_at IS NULL;
```

Then copy the standard hardening block from 006: `di_no_delete`, `di_no_truncate`, `di_touch`, `di_audit` triggers, `ENABLE ROW LEVEL SECURITY`, the `di_tenant_isolation` policy, and `GRANT SELECT, INSERT, UPDATE ... TO di_app`.

**Lifecycle:** no row = default. Save = insert (first time) or update `rev + 1`. Restore = set `deleted_at` on the active row. Saving again after a restore inserts a fresh row; old rows stay as history.

## 5. Config shape and what each block allows

Stored override (every key optional):

```json
{
  "kicker":  "CLAIMS",
  "tiles":   { "order": ["claims","pending"], "hidden": ["rejected"], "labels": { "claimed": "Total filed" } },
  "columns": { "order": [], "hidden": [], "labels": {} },
  "chips":   { "order": [], "hidden": [], "labels": {} },
  "detail":  { "order": [], "hidden": [], "labels": {} },
  "form":    { "hidden": [], "labels": {} }
}
```

| Block | Item ids (default label) | Locked (cannot hide) | Reorder |
|---|---|---|---|
| `kicker` | text, default "EXPENSE CLAIMS" | n/a | n/a |
| `tiles` | claims, claimed, approved, pending, rejected | none | yes |
| `columns` | claim, claimant (admin view only), date, merchant, category, amount, status | claim (pinned first), amount, status | yes, except `claim` |
| `chips` | all, submitted ("Pending"), approved, rejected | all | yes |
| `detail` (drawer rows) | claimant, date, category, tax, paid_by, description, submission, reviewed_by, review_note, no_receipt | none | yes |
| `form` | claimant (admin only), date, amount, merchant, category, payment_method, tax_amount, description, receipts | claimant, date, amount, merchant, category, receipts | **no** in v1 |

Rules:
- A label is plain text, 1 to 40 characters after trimming, no control characters. React escapes it on render.
- A status label (for example "Pending") is **one setting** that drives both the chip and the status badge, so they never disagree.
- Limits: at most 20 ids per list, whole config at most 4 KB.
- Admin-only items (`claimant`) stay admin-only whatever the config says.

## 6. Resolve and validate (core logic)

New file `core/page-layout.mjs`, plain JS in the same style as `core/workflows.mjs` (throws `DiError` with readable messages).

- `DEFAULT_LAYOUTS.expenses`: `{ rev, kicker, blocks }` with every id, default label, `locked`, `pinned`.
- `resolveLayout(defaults, override)`, lenient (used on every read):
  - items = default order; apply `order` for known ids only, then append any default ids not mentioned (so a new default item shows up for customized tenants);
  - force pinned items first; ignore hidden ids that are locked; ignore unknown ids; use the default label if a label is invalid;
  - returns each item as `{ id, label, default_label, visible, locked }` so the editor can show hidden items too.
- `validateOverride(page, input)`, strict (used on save): reject unknown ids, hiding locked ids, duplicates, bad labels, oversize, reordering `form`.
- `normalizeOverride(defaults, input)`: drop anything equal to the default. If nothing is left, the save becomes a **restore**, so the "Customized" badge turns off by itself.
- `loadLayout(tx, page)`: reads the active row, resolves it, returns `{ page, rev, default_rev, customized, override_invalid, ... }`. If stored JSON fails validation, return the default with `override_invalid: true`.
- `saveLayout(tx, page, input, { who, expected_rev })`: admin only; `expected_rev` is `0` when no override exists. A mismatch or a unique-index clash gives "Someone else changed this page. Reload and try again."
- `resetLayout(tx, page, { who })`: admin only; soft-deletes the active row; returns `{ reset: boolean }`.

## 7. API

All through the existing `/api/demo/expenses` route.

| Call | Who | Result |
|---|---|---|
| `GET /api/demo/expenses` | any signed-in user | existing panel data plus `layout` |
| `POST` `{ action: "layout_save", config, expected_rev }` | admin | `{ result: { layout } }` |
| `POST` `{ action: "layout_reset" }` | admin | `{ result: { layout, reset } }` |

`layout_save` and `layout_reset` call `withContext` directly (as the receipt route does), not `runTool`.

## 8. Build plan and checklist

Rough effort for one developer: about 1 to 2 weeks in total. Each phase ends with its own check.

### Phase 0: Preflight (before touching code)
- [x] `git status` and `git log -5 -- app/demo/expenses.tsx server/demo-expenses.mjs`: confirm no other session is editing these files. At the start of this session `server/index.mjs` and `app/demo/style.css` already had other people's edits, so this plan avoids both.
- [x] `ls document_inteligence/sql`: confirm the next free migration number.
- [ ] Confirm whether the Expenses area is already live on Railway. **Not verified**: this pilot depends on it.
- [x] Read how `server/index.mjs` handles a failure in `ensureDocumentIntelligence` at boot, to know what a failed migration would do.
- [x] Capture **before** screenshots of the page with demo data (admin, 1280 px: list, open drawer, claim form; regular user, 1280 px; admin at 375 px). They are the regression baseline for Phase 4.

### Phase 1: Database and core module
- [x] Write `sql/009_ui_config.sql` (table, partial unique index, hardening block, grants).
- [x] Write `core/page-layout.mjs` (defaults, `resolveLayout`, `validateOverride`, `normalizeOverride`, `loadLayout`, `saveLayout`, `resetLayout`).
- [x] Keep `core/tools.mjs` untouched.

### Phase 2: Core tests
New `test/page-layout.test.mjs`, reusing the two-tenant setup pattern from `test/expense-policy.test.mjs`.
- [x] No override gives exactly the default, `customized: false`.
- [x] Order, hide and rename resolve correctly. Unknown ids are ignored.
- [x] A new default item appears for a tenant that already customized (pass a changed defaults object).
- [x] Locked items cannot be hidden: rejected on save, ignored on read.
- [x] Bad labels (empty, over 40, control characters) and oversize configs are rejected.
- [x] **Tenant isolation:** tenant A saves; tenant B still gets the default.
- [x] Restore returns A to the default; a second restore returns `reset: false`; saving again works; old rows still exist (soft-deleted), and the audit log recorded the changes.
- [x] Saving a config equal to the default behaves as a restore.
- [x] A non-admin cannot save or restore (`/Only an admin/`).
- [x] A stale `expected_rev` is refused with the "changed by someone else" message.
- [x] Garbage stored directly in `config` returns the default with `override_invalid: true`.
- [x] Run the baseline files again: `expenses.test.mjs` still asserts the Expenses Clerk's exact tool list, which proves D7.

### Phase 3: Route
- [x] `panelState` also loads the layout (in parallel with the existing calls) and returns `layout`.
- [x] Add the `layout_save` and `layout_reset` cases to `act` in `server/demo-expenses.mjs`.
- [x] Check with curl as admin and as a regular user: reading works for both; saving works for admin only.

### Phase 4: Front end renderer (no new feature yet)
Do this as a **behaviour-neutral refactor first**.
- [x] Add `layout` to the `Panel` type.
- [x] Replace the hard-coded tiles, columns, chips, drawer rows and form fields with lookups keyed by id. An unknown id from a newer server is skipped, not a crash.
- [x] Make `.ex-stats` flexible (`repeat(auto-fit, minmax(…, 1fr))`) so hidden tiles leave no gap.
- [x] Decide and implement how the form grid behaves when one field of a pair is hidden (the other should span the full width), and check it at 375 px.
- [x] Use `layout.kicker` for the panel kicker.
- [x] Take **after** screenshots with the default layout and compare with the Phase 0 baseline. There must be no visible change.
- [x] `npx eslint` on the touched files: no more than the 5 baseline problems. `npm run build` passes.

### Phase 5: Customize panel
- [x] New `app/demo/expenses-layout.tsx` (keeps `expenses.tsx` from growing) and its styles in `expenses.css`. Do not touch `style.css`.
- [x] Admin-only **Customize page** button in the panel header. A **Customized** badge shows when `layout.customized` is true.
- [x] Modal with one section per block: a show/hide checkbox (disabled with a lock icon when locked), a label input, and real up/down buttons with `aria-label`s where reorder is allowed. Plus the kicker field.
- [x] Footer: **Restore default** (confirm first, as "Close submission" does), **Cancel**, **Save** (disabled until something changed).
- [x] Show a clear warning when `override_invalid` is true, and a clear message on a revision conflict (reload and retry).
- [x] No new eslint errors. The modal wrapper must satisfy `jsx-a11y` (the existing claim modal already trips it; do not copy that pattern).
- [x] After a save or restore, the page re-renders from the returned layout without a full reload.

### Phase 6: End-to-end check
Local server with the throwaway `pg`-over-PGlite shim (boot takes about 90 s), then the browser pane.
- [x] Admin: hide a column, rename "Claimant" to "Employee", hide a tile, save. The page updates.
- [x] Reload: the change persists.
- [x] Regular user: sees the customized page, has no Customize button, and a direct `layout_save` POST is refused.
- [x] Restore default: the page matches the Phase 0 baseline again.
- [x] A hand-corrupted stored config: the page still renders the default and the admin sees the warning.
- [x] Two admins: the second save gets the conflict message.
- [x] 375 px: the page and the Customize modal are usable.
- [x] Second-tenant proof stays in the automated tests (the local host runs one tenant).

### Phase 7: Docs and ship
- [x] Add a "Customizing the Expenses page" section to `document_inteligence/README.md` (what is customizable, what is not, how restore works).
- [x] `graft build`, then check `git status` for side effects such as a rewritten `.claude/skills/graft/SKILL.md`.
- [ ] Commit on `main` only. Never create a branch. Stage only this feature's files, through a private index (other sessions share the index and push to `main`), and push right away.
- [ ] Deploy with `git push origin main:railway` (never `railway up` from this dirty folder). Poll `railway deployment list` for a new deployment instead of assuming a build started.
- [ ] After deploy, confirm the migration applied and `GET /api/demo/expenses` returns `layout.customized: false`. If you want a live round trip on production, ask the owner first and finish with Restore default.

## 9. Definition of done (pilot passes when all are true)

- [x] Tenant A hides a column and renames one; tenant B is unchanged (automated test).
- [x] Restore default returns tenant A to the default.
- [x] A broken stored config falls back to the default instead of breaking the page.
- [x] A non-admin cannot edit, on the server.
- [x] A change to the default in code reaches tenant B without overwriting tenant A's choices.
- [x] The Expenses Clerk's tool list is unchanged.
- [x] Baseline tests still pass; eslint is no worse than baseline; `npm run build` passes.

## 10. Out of scope now, in rough order of value

1. **Real multi-tenant host.** Done (this item was obsolete once the default company was removed). The host no longer pins a company: there is no default company, a signed-in user's requests use their own company, and an owner-credential request names its company with `X-Tenant-Id`. Company agent workspaces are per company (see `multitenant-architecture.md` §7). The layout code was already tenant-correct because it only sees a tenant-scoped transaction.
2. Nav label and visibility, and the page heading (shared `page.tsx`).
3. Show the company's own policy fields in the claim form (the existing gap in `panelState`).
4. Agent parity: a config tool, `policySummary` awareness, per-tenant tool on/off, and a capped instruction note, kept out of `ROLE.md` to avoid one warm process per tenant.
5. Live preview in the editor, and "reset this section".
6. Procurement and the other pages. Procurement has several views and will show whether the block set is enough.
7. A conversational "Page Designer" agent, modelled on the Form Designer.

## 11. Risks and watch-outs

- **Refactor regression** is the biggest day-to-day risk. That is why Phase 4 is behaviour-neutral and compared against screenshots.
- **Shared worktree:** other sessions edit this repo at the same time. Never `git stash`, `checkout --` or `reset`; touch only the files listed below.
- **Rename drift:** one status label feeds both chip and badge; keep it that way.
- **Hiding information on purpose:** a tenant can hide reviewer notes from claimants' drawers. That is their choice; it does not change the stored data.
- **Migration:** additive table only. Rolling back the code leaves an unused table, which is harmless.

## 12. Files

| New | Changed | Do not touch |
|---|---|---|
| `sql/009_ui_config.sql` | `server/demo-expenses.mjs` | `core/tools.mjs` |
| `core/page-layout.mjs` | `app/demo/expenses.tsx` | `app/demo/page.tsx` |
| `test/page-layout.test.mjs` | `app/demo/expenses.css` | `app/demo/style.css` |
| `app/demo/expenses-layout.tsx` | `README.md` (this folder) | `server/index.mjs` |

## 13. Build notes (2026-10-04)

**Built (all uncommitted in the shared worktree):** `sql/009_ui_config.sql`, `core/page-layout.mjs`, `test/page-layout.test.mjs`, `app/demo/expenses-layout.tsx`; changed `server/demo-expenses.mjs`, `app/demo/expenses.tsx`, `app/demo/expenses.css`, `README.md`. Untouched, as planned: `core/tools.mjs`, `app/demo/page.tsx`, `app/demo/style.css`, `server/index.mjs`.

**Where it differs from the plan above**
- The migration is **009**: `008_audit_protection.sql` was added by another session meanwhile.
- **D8, softened:** a stored layout that no longer fits is not thrown away whole. What still fits is applied, the admin sees "Needs attention", and the page never breaks. Garbage that can't be read at all gives exactly the default.
- The form item `receipts` is named after the real button ("Add receipt (photo, screenshot or PDF)") so renaming it does something visible.
- The heading is upper-cased by CSS so a company's "Claims" matches the design.
- Resolved items also carry `pinned` (the editor needs it). If the layout can't be read at all, the route logs a warning and sends the default with `unavailable: true` (the Customize button hides).
- A real `<button class="ex-btn">` loses to the global `.di-demo button` rule (14px, regular), so the editor sets its own type size and weight.

**Verified**
- `node --test test/*.test.mjs` in `document_inteligence/`: 189 tests, 188 pass. The one failure is the existing `prompt size caps` (di-documents.md is 4346 chars, cap 4000), unrelated to this work.
- `page-layout.test.mjs`: 19 tests. Deliberately breaking the stale-edit check was caught; with the explicit tenant filter removed, isolation still held, which shows row-level security is active under `di_app` in these tests.
- ESLint: still the 5 existing problems in `expenses.tsx`, none new. `tsc`: nothing in the touched files. `vite build`: passes.
- Pixel comparison against the original code (same data, back to back): all six views identical on the default layout (admin and regular user, list / claim panel / filing form / phone). The only admin difference is the new Customize button.
- Browser end-to-end (13 checks): editor, hide / rename / reorder, persistence across reload, regular user sees it but cannot edit (UI and direct API), two admins, damaged layout, restore default, default-equal save = restore, hidden status filter, phone width.

**Not done**
- Not committed, not pushed, not deployed.
- **Not verified:** whether the Expenses area is live on Railway, and the real-host path (`ensureDocumentIntelligence` on the production `pg` pool). The local harness used the real DI code on in-memory Postgres (PGlite). A failed DI migration at boot is caught and logged by `server/index.mjs` (`document-intelligence failed`) and leaves DI unavailable.
- Real second company is only covered by the automated tests; the host still runs one.
