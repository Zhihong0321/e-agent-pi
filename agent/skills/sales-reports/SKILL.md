---
name: sales-reports
description: Schema, business rules, and SQL fallbacks for Sales and Procurement's sales/payment/outstanding/installation-status questions on prod_main. Use when the sales-data MCP tools don't cover a question, a tool errors, or you need to understand what a tool's numbers mean.
---

# Sales reports — schema and fallback SQL

Prefer the `sales-data` MCP tools (`received_payment`, `sales_summary`, `unpaid_outstanding`, `invoice_status`, `demand_pipeline`, `stock_velocity`, `stock_levels`) — paste their HTML output verbatim. Everything below is for a genuinely ad-hoc question none of them cover, understanding a number a tool returned, or a tool erroring.

## Connection (fallback only)

Talk to Postgres **only** through the proxy, with the **read-only** token below. Do not invent a `DATABASE_URL`. Do not attempt INSERT/UPDATE/DELETE — the token is read-only and the proxy rejects writes anyway.

- Proxy: `https://pg-proxy-production.up.railway.app/`, SQL: `POST /api/sql`, Database: `prod_main`, Access: read_only.
- Token: `$SALES_PG_PROXY_TOKEN` from the host vault (Settings → Keys → Sales DB access). Never print it. If missing, tell the operator to save it there and start a new chat.
- The token **expires** (`$SALES_PG_PROXY_EXPIRES_AT`, currently 2026-10-15). Past that, auth failures mean a fresh token is needed — don't try to work around it.

```bash
curl -sS -X POST "https://pg-proxy-production.up.railway.app/api/sql" \
  -H "Authorization: Bearer $SALES_PG_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"db_name":"prod_main","sql":"select now() as now","params":[]}'
```

Use `params` for values (`$1`, `$2`, …). One SQL statement per request.

## Scope

**May read:** `invoice`, `invoice_item`, `payment`, `submitted_payment`, `seda_registration`. Lookup-only: `package`, `package_item`, `product` (which model on an invoice), `customer`, `agent` (name/id only, no other PII). **May not write anything in `prod_main`.**

## The tables

### `invoice` — quotation *and* invoice, same table

Verified (2026-09-04): 8,712 rows; 8,100 are `is_deleted = false AND is_latest = true` — that's the working set. `is_deleted = true` is trash; `is_latest = false` is a superseded version — always filter `is_latest = true`.

| Column | Role |
|---|---|
| `bubble_id` | Join key — `payment.linked_invoice` / `submitted_payment.linked_invoice` point here. |
| `invoice_number` | Human number, e.g. `INV-1011513`. |
| `total_amount` | The quoted/invoiced amount (RM) — sum this for "sales value". |
| `paid_amount`, `balance_due` | **Stale, do not trust** — always 0 / out of sync. Compute from `payment` instead. |
| `status` | Not a reliable stage signal (mostly `draft`/`deleted`) — use the paid-amount rule instead. |
| `is_deleted`, `is_latest` | Filter `is_deleted = false AND is_latest = true` unless asked for history. |
| `invoice_date`, `created_at` | Date-range questions; prefer `invoice_date`, fall back to `created_at`. |
| `linked_customer`, `linked_agent` | Bubble ids into `customer`/`agent`. |

### `payment` — verified/received payment ("Payment = verified payment")

4,132 rows, `sum(amount)` ≈ RM 32.27M (2026-09-04). The **only** source of truth for money actually received. `bubble_id` id, `linked_invoice` → `invoice.bubble_id`, `amount` RM received, `payment_date`, `verified_by`.

### `submitted_payment` — NOT verified, never count as received

1,418 rows, almost all `status = 'deleted'`. Staging table for proofs before verification into `payment`. Mention only if explicitly asked about pending submissions.

### `invoice_item` — line items: product/package + qty per invoice

32,881 rows, only ~20,172 have `linked_invoice` set — always filter to rows that join. `linked_package` → `package.bubble_id` (the common case); `linked_product` → `product.bubble_id`, **only** for standalone extras (null on package lines). `qty` is almost always `1` here (1 of this line, not the unit count inside a package). `description` is free text — **never parse it for model/qty**, use the joins below.

**Real per-model unit counts on an invoice** — join through the package's bill of materials, `coalesce(pi.qty, 1) * ii.qty`:

```sql
select prod.name as model, sum(coalesce(pi.qty, 1) * ii.qty) as units
from invoice_item ii
join invoice i on i.bubble_id = ii.linked_invoice
left join package pkg on pkg.bubble_id = ii.linked_package
left join package_item pi on pi.bubble_id = any(pkg.linked_package_item)
left join product prod on prod.bubble_id = coalesce(pi.product, ii.linked_product)
where i.is_deleted = false and i.is_latest = true
group by prod.name
```

**Use `coalesce(pi.qty, 1)`, not bare `pi.qty`** — a standalone extra has no matching `package_item` row, so a bare multiply silently zeroes that model's units (confirmed live: `B3-16.0-LV` battery came back `null` until this fix).

### `seda_registration` — SEDA / NEM application status

Via `invoice.linked_seda_registration → seda_registration.bubble_id`. Only `seda_status` matters: `null` (71%, not submitted), `Pending`, `Submitted`, `Approved`, `APPROVED BY SEDA`, `DEMO`. Treat **approved** as `seda_status ilike '%approved%' and seda_status <> 'DEMO'` — wording isn't consistent.

## The operator's business rule (use this, not `status`)

> 0 paid = quotation. Invoice with paid amount > 0 = official invoice.

"Paid amount" = **sum of `payment.amount`** linked to the invoice, not `invoice.paid_amount` (stale/0):

```sql
select
  i.id, i.bubble_id, i.invoice_number, i.total_amount, i.invoice_date,
  coalesce(sum(p.amount), 0) as paid_amount,
  i.total_amount - coalesce(sum(p.amount), 0) as unpaid_amount,
  case when coalesce(sum(p.amount), 0) > 0 then 'invoice' else 'quotation' end as kind
from invoice i
left join payment p on p.linked_invoice = i.bubble_id
where i.is_deleted = false and i.is_latest = true
group by i.id, i.bubble_id, i.invoice_number, i.total_amount, i.invoice_date
```

Build every report from this shape, not from `invoice.paid_amount`/`balance_due`.

**"Current sales"** — value of official invoices (`kind = 'invoice'`) filtered by `invoice_date`, or all quoted+invoiced value (`kind` either) if the operator wants everything — ask if unclear, default to official invoices only, and state which you used.
**"Unpaid/outstanding"** — sum `unpaid_amount` `where kind = 'invoice'` (a pure quotation isn't a receivable yet).

## Installation status (inferred — not a tracked field)

Always label **estimated**, never verified fact. `payment_pct = paid_amount / nullif(total_amount, 0)`:

1. `payment_pct > 0.01` → **deposited**.
2. SEDA approved **and** `payment_pct > 0.60` → **ready to install**.
3. `payment_pct >= 0.99` → **installed** (operator's rule: full payment ≈ installed; `>= 0.99` not `= 1` for rounding/overpayment).

Report the highest tier that matches, with the actual `payment_pct` and SEDA status alongside — e.g. "≈installed (est.) — 100% paid, SEDA Approved", never a bare yes.

## Committed demand by model (forward-looking)

"How many units do orders already on the books need" — pair with `stock_levels` before calling it a stock-out risk. Every invoice with `paid_amount > 0` is committed demand; classify into exactly one tier, highest-confidence wins:

1. **Confirmed pipeline** — `payment_pct > 0.599` and SEDA approved. Caveat always: no tracked install-completed date, so this can overstate near-term stock leaving — some units may already be installed with final payment simply delayed.
2. **Soft pipeline** — `payment_pct > 0` and not tier 1. A real order, but the operator says this commonly drags 1–2 months waiting on SEDA + reaching 60% payment.

```sql
with paid as (
  select i.id, i.bubble_id, i.invoice_number, i.total_amount, i.invoice_date,
         coalesce(sum(p.amount), 0) as paid_amount, i.linked_seda_registration
  from invoice i
  left join payment p on p.linked_invoice = i.bubble_id
  where i.is_deleted = false and i.is_latest = true
  group by i.id, i.bubble_id, i.invoice_number, i.total_amount, i.invoice_date, i.linked_seda_registration
),
classified as (
  select p.*, p.paid_amount / nullif(p.total_amount, 0) as payment_pct, sr.seda_status,
    case when p.paid_amount / nullif(p.total_amount, 0) > 0.599
           and sr.seda_status ilike '%approved%' and sr.seda_status <> 'DEMO'
         then 'confirmed' else 'soft' end as tier
  from paid p
  left join seda_registration sr on sr.bubble_id = p.linked_seda_registration
  where p.paid_amount > 0
)
select c.tier, prod.name as model, sum(coalesce(pi.qty, 1) * ii.qty) as units, count(distinct c.id) as invoices
from classified c
join invoice_item ii on ii.linked_invoice = c.bubble_id
left join package pkg on pkg.bubble_id = ii.linked_package
left join package_item pi on pi.bubble_id = any(pkg.linked_package_item)
left join product prod on prod.bubble_id = coalesce(pi.product, ii.linked_product)
where prod.name is not null
group by c.tier, prod.name
order by c.tier, units desc
```

Verified live (2026-09-05): 48 confirmed invoices (≈RM1.34M) vs 1,424 soft (≈RM42.8M). Report `units` per model per tier against `stock_levels.qty_on_hand`, not trailing-30-day velocity (that's the `stock-inventory` skill). Always state which tier(s) you included, restate the tier-1 caveat, show `invoices` alongside `units`.

**"Is invoice X paid/installed"** — one query answers both: the join above plus the installation-status estimate and per-model units for that invoice's `bubble_id`.
