---
name: update-package-catalog
description: Read and update Eternalgy package/product catalog in prod_main via the Postgres proxy. Use when the operator asks to change package prices, add a product, swap panels/inverters, inspect a package BOM, or sync from the Package google sheet.
---

# Update package / product catalog

Live catalog is Postgres `prod_main` through the proxy. Connection, scope, and guardrails are in this agent's role prompt — read that first.

## Package google sheet (almost every request)

Procurement's source of truth is **ETERNALGY PACKAGE PRICE CENTER**. The operator will say "Package google sheet" — that is always:

https://docs.google.com/spreadsheets/d/1aBCKeLnlUci2q98WwTIX77UwDqyrFFsK_1tFaSK4INU/edit

Do not ask for the URL. Do not scrape `/edit`. Pull CSV in one call:

```bash
node "$CLOUD_PI_PACKAGE_SHEET" pull --live --write _inbox/package-sheet
```

Stdout is tab summaries. `--tab string --packages` (hybrid / micro / commercial / ev) for one family's rows. `--full` adds invoice text. `--live` skips the superseded `HYBIRD Residential package` tab.

Then SELECT the matching `prod_main` rows and diff: price changes, names on the sheet but not in DB (new), names in DB but not on the live tab (deactivate candidate). Confirm before writes. Skip Special / Roadshow when deactivating from the sheet.

## Call SQL

```bash
TOKEN="${PG_PROXY_TOKEN:?missing PG_PROXY_TOKEN}"
curl -sS -X POST "https://pg-proxy-production.up.railway.app/api/sql" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"db_name":"prod_main","sql":"select now() as now","params":[]}'
```

If `$PG_PROXY_TOKEN` is missing, tell the operator to save it on **Settings → Keys → Postgres proxy**, then start a new chat. Do not ask them to paste the token here.

Body: `{ "db_name": "prod_main", "sql": "...", "params": [] }`. Parameterized:

```json
{"db_name":"prod_main","sql":"select id, package_name, price from package where active is true and type = $1 order by panel_qty","params":["Residential"]}
```

Writes on a `read_only` token return HTTP 403 `{"error":"This token is read_only"}`. Stop and ask for a write packet.

## How this data is shaped

Migrated from Bubble. Integer `id` is the Postgres PK. **Every relationship uses `bubble_id` (text), not `id`.** There are no real foreign keys.

```
product.bubble_id  <── package.panel
                   <── package.inverter_1 … inverter_4
                   <── package_item.product

package_item.bubble_id  <── package.linked_package_item  (text[])
```

### Identity rules

- `bubble_id` is UNIQUE per table, required for linking. One live product (SAJ H2 4KW hybrid) has `bubble_id` null — it can't attach to a package until you set one.
- `unique_id` is unused (all null) — ignore it.
- New `bubble_id`: unique text, matching existing style — Bubble leftover `1703832486959x361642797057966100`, or a catalog slug like `prd_solar_mibet_mounting_structure_20260713`, `pitem_msig_allrisk_assured`, `1780667331000xPKGITEM1P`. Generate with epoch-ms + a short unique suffix; never reuse another row's `bubble_id`.
- `id` is serial — do not set it on INSERT.

## Tables

Counts verified 2026-09-03: **1290** packages, **6106** package_items, **69** products. `brand` = 0 rows, `category` = 0 rows.

### `product` — SKU / component

| Column | Type | Role |
|--------|------|------|
| id | int PK | Postgres id. Do not use as a join key. |
| bubble_id | text UNIQUE | **Join key.** Set this on every new product. |
| name | text | Display name. Search this. |
| label | text | Loose type tag, often null. Known: `Solar Panel`, `String Inverter`, `Micro Inverter`, `Inverter`, `Installation`, `Operation`, `LOV VOLTAGE BATTERY`. |
| description | text | Model / extra copy (e.g. `H2-5K-LS2`). |
| active | bool | Sellable. Filter `active is true` unless asked for history. |
| inventory | bool | Stocked hardware vs service line. |
| cost_price, selling_price | numeric | Unit prices (MYR). Many are `0`/null — package **price** is the selling figure, not a sum of item prices. |
| solar_output_rating | int | Panel watt (590/620/625/650) or EV charger rating. Null on inverters. |
| inverter_rating | int | Inverter kW (4, 5, 6… 75). Micro SAJ M2-1.8K uses `2`. |
| linked_brand, linked_category | text | Orphan Bubble ids (`brand`/`category` tables are empty) — copy from a sibling SKU of the same kind when inserting, never invent them. |
| image, pdf_product, warranty_* | text | Assets / warranty copy. |
| last_synced_at, created_at, updated_at, created_date, modified_date | timestamptz | Touch `updated_at`/`modified_date` on edits. |

Live product kinds (names, not a frozen list — SELECT before you act): Panels (590W/620W/650W Jinko, Astronergy 580W N5/625W N7, inactive Canadian Solar), String (SAJ R5 1P 4–8kW, SAJ R6 3P 5–50kW, SAJ C6 75kW), Hybrid H2 (1P 4–8kW, 3P 8–20kW), Micro (SAJ M2-1.0K/1.8K active, NEP BDM inactive), Services (Workmanship, Electrical Work, SEDA Application, Skylift, Installation, MSIG insurance, travel), BOM extras (MIBET mounting, MasterTec DC cable, MEGA AC cable, RCBO, MCB box, ARMORVOLT chargers, B3-16.0-LV battery).

### `package` — sellable system

| Column | Type | Role |
|--------|------|------|
| id | int PK | Postgres id. |
| bubble_id | text UNIQUE | Join key — `invoice_item.linked_package` points here. Never change it. |
| package_name | text | Title, e.g. `[1P] STRING SAJ JINKO 8 PCS 650W`. Keep in sync with panel brand/watt/qty and inverter class. |
| type | text | `Residential` · `Tariff B&D Low Voltage` · `Special / Roadshow` · `EV Charger`. |
| active | bool | On the price list (~597 active, 429 Residential). |
| special, need_approval | bool | Promo/special; approval usually true for Special/Roadshow. |
| panel_qty | int | Panel count. Null on EV Charger. Must match the panel `package_item.qty`. |
| price | numeric | Customer selling price (MYR) — **this is what a price update changes.** |
| nett_price | numeric | Floor after max discount, often `price - max_discount`. |
| max_discount | int | Max RM off — keep consistent with nett_price. |
| panel | text | `product.bubble_id` of the panel (or EV SKU). |
| inverter_1 … inverter_4 | text | `product.bubble_id`. STRING packs use `inverter_1`; some MICRO packs put the micro on `inverter_2` with `inverter_1` null — preserve the pattern of the row you clone. |
| linked_package_item | text[] | `package_item.bubble_id`s — **this is the bill of materials.** |
| invoice_desc | text | Human BOM printed on invoices — rewrite when products/qty change. |
| password | text | Ignore. Never select or echo it. |

Active mix (2026-09-03): Residential 429 · Tariff B&D 122 · Special/Roadshow 30 · EV Charger 15. Inactive rows are history — do not delete them. Example Residential 8-panel STRING (id 1): `[1P] STRING SAJ JINKO 8 PCS 590W`, price 16610/nett 13600/max_discount 3010, panel → 590W Jinko, inverter_1 → SAJ R5 4kW, BOM: panel, inverter, workmanship, MSIG, mounting, DC cable, AC cable.

### `package_item` — one BOM line

| Column | Type | Role |
|--------|------|------|
| id | int PK | Postgres id. |
| bubble_id | text UNIQUE NOT NULL | Value stored in `package.linked_package_item`. |
| product | text | `product.bubble_id`. |
| qty | int | Line qty (panel count, inverter count, usually 1 for services). |
| sort | int | Display order — panel `1`, inverter `2`, workmanship/MSIG `99`, extras `100+`. |
| inventory | bool | Copy from the product when known. |
| total_cost | int | Usually `0`/null — not a selling price. |

**Shared lines:** `pitem_msig_allrisk_assured` is on **346** packages; a few inverter lines are shared too. Before UPDATE/DELETE, count usage (see Recipes). If `used_by > 1`, insert a **new** `package_item` with a new `bubble_id` instead of editing the shared one. Most accessory lines are per-package (`pki_res_1_mibet_mounting_20260713`, `1780667331000xPKGITEM1P`) — clone that pattern.

## Recipes

List sellable packages:

```sql
select id, package_name, type, panel_qty, price, nett_price, max_discount, active
from package
where active is true
order by type, panel_qty, price
```

BOM for one package (by id):

```sql
select pkg.id, pkg.package_name, pkg.price, pi.sort, pi.qty, pi.bubble_id as item_id,
       p.name, p.label, p.bubble_id as product_id, p.solar_output_rating, p.inverter_rating
from package pkg
join package_item pi on pi.bubble_id = any(pkg.linked_package_item)
left join product p on p.bubble_id = pi.product
where pkg.id = $1
order by pi.sort nulls last, pi.id
```

Find a product:

```sql
select id, bubble_id, name, label, active, selling_price, solar_output_rating, inverter_rating
from product
where name ilike $1
order by active desc, name
```

Is this package_item shared?

```sql
select count(*)::int as used_by from package where $1 = any(linked_package_item)
```

Price update (after confirm):

```sql
update package
set price = $1, nett_price = $2, max_discount = $3, updated_at = now(), modified_date = now()
where id = $4
returning id, package_name, price, nett_price, max_discount
```

Append a BOM line:

```sql
update package
set linked_package_item = array_append(linked_package_item, $1), updated_at = now(), modified_date = now()
where id = $2
returning id, linked_package_item
```

## Monthly work, end to end

If working from the Package google sheet (almost always): pull it first, then follow this shape. Always SELECT first and wait for a go-ahead before writing.

1. **Price change** — SELECT the package(s) (see Recipes), then UPDATE `price`; if given a new nett/discount, keep `nett_price = price - max_discount` consistent with the row's existing pattern.
2. **New product** — SELECT a sibling SKU (same `label`/rating family), copy `linked_brand`/`linked_category`/warranty fields; INSERT with a new unique `bubble_id`, `active = true`. Don't attach it to packages until asked.
3. **New package** (clone an existing one) — pick the closest live package (type, STRING vs MICRO, 1P vs 3P, panel brand); INSERT missing products; INSERT **new** `package_item` rows (new bubble_ids, don't reuse another package's except known shared add-ons like MSIG); INSERT `package` with those item ids in `linked_package_item` plus `panel`/`inverter_*`/`panel_qty`/`package_name`/`invoice_desc`/`price`; leave `active = false` until told to publish.
4. **Swap panel or inverter on existing packages** — for each: UPDATE the matching `package_item.product` (and `qty` if count changes, only if not shared), UPDATE `package.panel`/`inverter_n`, UPDATE `package_name`/`panel_qty`/`invoice_desc`, recalc price if given new numbers. Typical `invoice_desc` (keep service boilerplate, change hardware lines): `8X 650W JinkoSolar TIGER NEO 3.0 Panel N-Type TOPCon` / `1X [1P] SAJ R5 4KW String Inverter` / `1X SEDA ATAP Application` / `TNB Smart Meter Application` / …
5. **Add an accessory to many packages** — INSERT one `package_item` **per package** (unique bubble_id), then append it to each package's `linked_package_item` (see Recipes). Don't append the same item bubble_id to hundreds of packages unless the operator wants a shared line like MSIG.
6. **Retire** — `update package set active = false …` (or on `product`). Do not DELETE. Confirm name + id first.

New product / new package: INSERT with a unique `bubble_id`, copy `linked_brand`/`linked_category` from a sibling SKU, set `active = true`; new package clones a close live row with new `package_item` bubble_ids and matching `panel`/`inverter_*`/`invoice_desc`.

## How to start a request

1. Mentions the sheet, prices, new packages, or deactivating missing ones → pull the Package google sheet first. Don't ask for the URL.
2. Restate the change (which type, which watt/brand, which packages).
3. SELECT current rows in `prod_main`.
4. Propose the change in plain language (N packages, old price → new price; or N new / N to deactivate).
5. On go-ahead, write one package/product at a time if the set is small, batched parameterized updates if it's a whole family.
6. SELECT back the changed rows and report ids + names + new values.
