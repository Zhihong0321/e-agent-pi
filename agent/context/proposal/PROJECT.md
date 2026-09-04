# Proposal Agent — PROJECT

**One job:** keep the Eternalgy Solar PV proposal site correct and current.

| Item | Value |
|------|-------|
| Repo | `github.com/Zhihong0321/ee-proposal`, branch `main` (39 commits; last human commit 2026-07-30, then Proposal Agent commits 2026-09-03/04) |
| Workspace | `/storage/workspaces/proposal` (git clone) |
| Live | `https://ee-proposal-production.up.railway.app/shell.html#proposal` — Railway deploys `main` (~1 min) |
| Runtime | `node server.js` (Node ≥18): static files + `POST /api/query` named SQL (`invoice`/`products`/`customer`/`agent`) + `POST /api/generate-pdf` + `POST /api/generate-quotation-html` + `POST /api/activity/proposal`. `POST /api/sql` is gone. |
| Data | Postgres `prod_main` tables `invoice`, `package`, `product`, `customer`, `"user"`, `invoice_template`, `activity_log` (same catalog Package Updater maintains) |

## How the site works (read this once, then never explore for it)

- `shell.html` is the app: a full-screen `<iframe#content-frame>` plus a bottom nav.
  Hash picks the page: `#proposal` → `proposal.html`, `#why-jinko` → `tiger-neo3.html`,
  `#why-eternalgy` → `why-eternalgy.html`, `#quotation` → `quotation.html`.
  `index.html` only redirects to the shell. Content pages redirect to the shell if opened
  directly (each has a guard in its first `<script>`).
- Query params travel with the iframe: `?uid=<invoice>` (aliases `invoice_uid`, `invoice`,
  `invoice_id`) loads live data; `?lang=zh` switches language.
- **Without a UID the pages show demo data** (`proposal.html` picks a random fallback
  package and invoice; `quotation.html` shows a hardcoded MX FRESH MART example). "I don't
  see my change on the live page" usually means the change is in a data-driven slot that
  only renders with a UID, or the wrong language.
- With a UID, `invoice-data.js` (browser) calls `POST /api/query` with a named query
  (`invoice`, `products`, `customer`, `agent`). Shared SQL lives in `queries.js`.
  Defaults live in `defaults.js` (`window.EternalgyDefaults` / `module.exports`).
  `pdf-generator.js` uses the same two modules on the server.
- **Language:** every page's source is English except `why-eternalgy.html`, whose source is
  Chinese. `page-i18n.js` rewrites text at runtime: EN pages get Chinese via positional
  `setAll(selector, [...])` lists and string `.replace()` maps; `why-eternalgy.html` gets
  English the same way. **Adding, removing, or reordering an element inside a selector
  list shifts every translation after it.**
- **PDF:** GEN HTML button (shell) → `/api/generate-quotation-html` → `pdf-generator.js`
  fills `html_to_pdf/quotation-standalone.html` `{{placeholders}}`. The combined PDF uses
  `proposal-pdf-{en,zh}.html`, `tiger-neo3-pdf-{en,zh}.html`, `marcap-pdf-{en,zh}.html`,
  `why-eternalgy-pdf-{en,zh}.html`, `quotation-pdf.html`. The unsuffixed `*-pdf.html`
  copies were deleted.
- Visitor analytics: `shell.html` posts view/interact events to `/api/activity/proposal`;
  harmless under `file://` (logs a fetch error).

## Default values (what shows when the DB has no value)

| Field | Default | Defined in |
|-------|---------|------------|
| Panel model | `650W JinkoSolar Panel N-Type TOPCon` | invoice-data.js:4, pdf-generator.js:145 |
| Panel warranty | `12 Years Product Warranty` / `30 Years Linear Power Warranty` | invoice-data.js:5, pdf-generator.js:146 |
| Inverter model | `SAJ String Inverter` | invoice-data.js:6, pdf-generator.js:147 |
| Inverter warranty | `10 Years Product Warranty` | invoice-data.js:7, pdf-generator.js:148 |
| Mounting structure | `10 Years Mounting Structure Warranty` (added 2026-09-04) | invoice-data.js:8, pdf-generator.js:149 |
| Installation | `1 Year Roof Leaking` · `3 Years Workmanship` · `10 Years Mounting Structure` | proposal.html renderWarranty, quotation.html:696, pdf-generator.js workmanship_warranty (×2) |
| Insurance | `3 Years MSIG Solar Insurance` — all-risk | proposal.html renderWarranty |
| Peak sun hours | 3.4 · electricity rate RM 0.55/kWh | tiger-neo3.html inputs, pdf-generator.js computeTigerNeo3Data |
| Quotation validity | 30 days | pdf-generator.js addDays, quotation.html footer |

## Company facts on this site

Certifications (proposal.html cert section + PDF mirrors): CIDB Grade G7 reg
`0120250324-WP152634`, G7 · Unlimited Tender Capacity (Building B04, Civil CE21, Electrical
M15) [updated 2026-09-03 from the PR Center]; SEDA RPVSP `SEDA/RPVSP/2024/321`; SEDA
Registered Solar PV Investor (Eternalgy Sdn Bhd); MyHijau `MyHS00025/25` for SAJ inverters.
Why-Eternalgy badges: SEDA, CIDB, Maybank Exclusive Partner, SAJ Sole Distributor of
Malaysia, SHRDC CoE Partner, Malaysia Golden Bull Award.

**Quotation templates** use the PR Center identity: `ETERNALGY SDN BHD`,
`202301029164 (1523087-A)`, `pr@eternalgy.me`, `https://ee-pr.up.railway.app/`.
No street address (the PR Center does not publish one).

Brands: Jinko (panels, Tiger Neo 3.0), SAJ (inverters, R5 1P / R6 3P / H2 hybrid / M2 micro),
MSIG (insurance). Competitors named on Why-Jinko: Canadian Solar TOPHiKu6, LONGi Hi-MO X6
Explorer / Guardian, Trina Vertex, JA Solar DeepBlue 3.0.

## Repo hygiene facts

- `.gitignore`: node_modules, logs, `.claugedex/`, `.playwright-*`, root `/*.png` except
  `msig_logo.png`. `_inbox/`, `AGENTS.md`, `.agents/` are also listed.
- `package.json` has no `test` script. Only `start`. Warranty defaults: `defaults.js`.
  Named SQL: `queries.js`.
