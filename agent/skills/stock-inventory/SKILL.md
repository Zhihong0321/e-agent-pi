---
name: stock-inventory
description: Sales and Procurement's own stock-on-hand API (list/set/adjust/movements/bulk/seed) and the "sold out soon" velocity calculation. Use for a single ad-hoc stock adjustment, reading movement history, or computing backward-looking stock-out risk when the stock_velocity MCP tool isn't enough.
---

# Stock inventory — write API and velocity calc

**Prefer the MCP tools** (`stock_bulk_set`, `stock_seed_catalog`, `stock_levels`, `stock_velocity`) over the raw endpoints below — `stock_bulk_set` records a whole stock-take in one call and derives the key from the model name, so the same model always lands on the same row. Reach for curl only for a single ad-hoc adjustment or to read movement history.

Real stock levels aren't in `prod_main` at all — the operator tells you the counts, you keep them, in **this host's own database**, reached through a small local API, not the pg-proxy. Never confuse the two. A count of **zero means not counted yet**, not "none in stock" — never report a seeded zero as out-of-stock.

- URL: `$STOCK_API_URL` (already `http://127.0.0.1:<port>`, local to this host — don't hardcode a port).
- Auth: header `x-api-key: $STOCK_API_TOKEN` on every request. Never print this token.
- One row per **specific product SKU** — use `product.name` from `prod_main` as `modelName`, and a lowercase-hyphenated slug of it as `productKey` (e.g. "SAJ H2 6KW Hybrid Inverter" → `saj-h2-6kw-hybrid-inverter`). Reuse the exact same `productKey` every time for a given model.

```bash
# list everything on hand
curl -sS "$STOCK_API_URL/api/stock" -H "x-api-key: $STOCK_API_TOKEN"

# set an absolute count (first time recording a model, or a stock-take correction)
curl -sS -X POST "$STOCK_API_URL/api/stock" -H "x-api-key: $STOCK_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"productKey":"saj-h2-6kw-hybrid-inverter","modelName":"SAJ H2 6KW SINGLE PHASE Hybrid Inverter","qty":42,"unit":"pcs","updatedBy":"operator","reason":"stock take"}'

# relative adjustment (restock +N, correction/wastage -N) on an existing item
curl -sS -X POST "$STOCK_API_URL/api/stock/adjust" -H "x-api-key: $STOCK_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"productKey":"saj-h2-6kw-hybrid-inverter","delta":20,"reason":"restock from supplier","updatedBy":"operator"}'

# movement history for one model (or all, if productKey omitted)
curl -sS "$STOCK_API_URL/api/stock/movements?productKey=saj-h2-6kw-hybrid-inverter&limit=20" -H "x-api-key: $STOCK_API_TOKEN"
```

Bulk endpoints behind `stock_bulk_set` / `stock_seed_catalog`, if you ever need them directly:

```bash
# record many counts at once
curl -sS -X POST "$STOCK_API_URL/api/stock/bulk" -H "x-api-key: $STOCK_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"rows":[{"modelName":"650W JinkoSolar Panel N-Type TOPCon","qty":300},{"modelName":"[3P] SAJ R6 8KW String Inverter","qty":5}],"reason":"stock take"}'

# create a zero-qty row for every model that has none yet
curl -sS -X POST "$STOCK_API_URL/api/stock/seed" -H "x-api-key: $STOCK_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"models":["650W JinkoSolar Panel N-Type TOPCon","[3P] SAJ R6 8KW String Inverter"]}'
```

Confirm the model name and quantity back to the operator before `/api/stock` or `/api/stock/adjust` — restate "SAJ H2 6KW Hybrid Inverter → set to 42 units" and wait for a go-ahead, unless already given unambiguously.

## "Which model is sold out soon" (backward-looking, actual sales)

For each stock item, compute a **trailing 30-day sales velocity** from `prod_main` using the `invoice_item → package → package_item → product` join (see `sales-reports` skill), filtered to official invoices only (`paid_amount > 0`) and `invoice_date >= now() - interval '30 days'`. Match by `product.name` against the stock row's `modelName`.

```
daily_rate = units_sold_in_30_days / 30
days_of_cover = qty_on_hand / daily_rate   (undefined / "no recent sales" if daily_rate = 0)
```

Flag **"sold out soon"** when `days_of_cover < 14` (default — use the operator's threshold if given, and say so). Always report `qty_on_hand`, `units_sold_in_30_days`, and `days_of_cover` next to the flag, not just yes/no. A model with no stock row yet has never been recorded — say so and ask for a count instead of assuming zero.
