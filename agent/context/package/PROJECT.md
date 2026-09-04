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

Re-verify with a SELECT before quoting these; they drift monthly.
(Live re-check from this workstation was not possible on 2026-09-04; the numbers above
are from the 2026-09-03 verification recorded in the role file.)

## Observed in chat logs

- The one request that reached the proxy ("List active Residential packages for 8–12
  panels") took **one** tool call and produced a correct table. The recipe-style prompt works.
- Two other sessions failed only because `$PG_PROXY_TOKEN` was unset. The agent correctly
  refused to invent it. Keep that behaviour; the fix is on Settings → Keys.
