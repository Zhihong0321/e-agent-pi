# Package Updater — PROJECT

**One job:** keep Eternalgy's live solar package / product catalog in Postgres
`prod_main` correct, through the Postgres proxy. No site, no publish.

The full schema, identity rules, table shapes, and monthly recipes already live in
[agent/roles/package.md](../../roles/package.md) and are the reference for this agent.
This file records only what that role prompt does not.

## Connection

| Item | Value |
|------|-------|
| Proxy | `https://pg-proxy-production.up.railway.app/api/sql` (POST, one statement per request) |
| Docs | `https://pg-proxy-production.up.railway.app/docs` |
| Database | `prod_main` |
| Profile | `PACKAGE_Updater` (table-level write limiter) |
| Token | `$PG_PROXY_TOKEN` (host injects it when saved on Settings → Keys → Postgres proxy) |

Verified 2026-09-03: a `read_only` token answers HTTP 403 `{"error":"This token is read_only"}` on UPDATE. SELECT works with it.

## Package google sheet (source of truth for the price list)

Operator shorthand: **Package google sheet** / **package sheet** / **Price Center**.
Do not ask for this URL; it is always this workbook.

| Item | Value |
|------|-------|
| Title | ETERNALGY PACKAGE PRICE CENTER |
| Id | `1aBCKeLnlUci2q98WwTIX77UwDqyrFFsK_1tFaSK4INU` |
| Edit | https://docs.google.com/spreadsheets/d/1aBCKeLnlUci2q98WwTIX77UwDqyrFFsK_1tFaSK4INU/edit |
| Access | Anyone with the link (CSV export works; no Google login) |
| Owner | Procurement Manager |
| Extract | `node "$CLOUD_PI_PACKAGE_SHEET" pull --live` (tab summaries) or `--tab string --packages` |

Procurement updates this sheet. That is the latest package, pricing, new package, new
product, and (by absence) what to deactivate. `prod_main` is what the proposal site
sells; the sheet is what should be true. Diff sheet → DB, then confirm before writes.

Live tabs (2026-09-04; gids are stable if a tab is renamed):

| Slug | Tab | gid | Maps to `package.type` | Notes |
|------|-----|-----|------------------------|-------|
| hybrid-v2 | HYBIRD PACKAGE v2 1JUN2026 (2) | 1152370454 | Residential | Current hybrid list. Names say `HYBIRD` (typo) |
| hybrid-res | HYBIRD Residential package | 851508429 | Residential | **Superseded.** Skip with `--live` |
| string-res | STRING Residential package | 694235366 | Residential | Current string residential |
| micro-res | MICRO Residential PACKAGE | 1964999635 | Residential | Current micro |
| string-com | String commercial | 2110465309 | Tariff B&D Low Voltage | Sheet type is `commercial` |
| ev | EV Charger | 1691649272 | EV Charger | Different columns; `Price(RM)` only |

A new tab the CLI does not know yet still appears on pull (discovered from htmlview).
Special / Roadshow is **not** in this workbook — do not deactivate those from a sheet sync.

## Who else touches these tables

- The **Proposal site** (`ee-proposal`) reads `package`, `product`, `invoice`, `customer`,
  `user`, `invoice_template` through its own `/api/sql`. Its JOIN uses
  `package.bubble_id` / `package.id` ↔ `invoice.linked_package` / `invoice.package_id`, and
  `product.bubble_id` ↔ `package.panel` / `inverter_1..4`. **Renaming or deleting a
  `bubble_id` breaks live proposals.** Use `active = false`, never DELETE.
- Product `name`, `solar_output_rating`, `inverter_rating`, and the warranty fields
  (`product_warranty`, `warranty_year`, `linear_power_warranty`, …) are shown verbatim on
  proposals and quotations when an invoice UID is loaded. Keep them customer-readable.

## Counts (2026-09-03)

| Table | Rows | Active |
|-------|-----:|-------:|
| package | 1290 | ~597 (Residential 429 · Tariff B&D 122 · Special/Roadshow 30 · EV Charger 15) |
| package_item | 6106 | — |
| product | 69 | — |
| brand, category | 0 | — |

Sheet live rows (2026-09-04 pull): hybrid-v2 131 · string-res 100 · micro-res 33 ·
string-com 122 · ev 15. Re-verify with the CLI + a SELECT; both drift.

## Observed in chat logs

- The one request that reached the proxy ("List active Residential packages for 8–12
  panels") took **one** tool call and produced a correct table. The recipe-style prompt works.
- Two other sessions failed only because `$PG_PROXY_TOKEN` was unset. The agent correctly
  refused to invent it. Keep that behaviour; the fix is on Settings → Keys.
