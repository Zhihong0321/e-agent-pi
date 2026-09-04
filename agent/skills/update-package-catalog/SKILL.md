---
name: update-package-catalog
description: Read and update Eternalgy package/product catalog in prod_main via the Postgres proxy. Use when the operator asks to change package prices, add a product, swap panels/inverters, inspect a package BOM, or sync from the Package google sheet.
---

# Update package / product catalog

Live catalog is Postgres `prod_main` through the proxy. Full schema and join rules are in this agent's role prompt. Read that first.

## Package google sheet (almost every request)

Procurement's source of truth is **ETERNALGY PACKAGE PRICE CENTER**. The operator will say "Package google sheet" — that is always:

https://docs.google.com/spreadsheets/d/1aBCKeLnlUci2q98WwTIX77UwDqyrFFsK_1tFaSK4INU/edit

Do not ask for the URL. Do not scrape `/edit`. Pull CSV in one call:

```bash
node "$CLOUD_PI_PACKAGE_SHEET" pull --live --write _inbox/package-sheet
```

Stdout is tab summaries. `--tab string --packages` (hybrid / micro / commercial / ev) for one family's rows. `--full` adds invoice text.

Then SELECT the matching `prod_main` rows and diff: price changes, names on the sheet but not in DB (new), names in DB but not on the live tab (deactivate). Confirm before writes. Skip Special / Roadshow when deactivating from the sheet.

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

## Tables you may change

`package`, `package_item`, `product` only. Relationships are `bubble_id` text, not integer `id`.

## Recipes

List sellable packages:

```sql
select id, package_name, type, panel_qty, price, nett_price, max_discount, active
from package
where active is true
order by type, panel_qty, price
```

BOM for one package (by name or id):

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

If `used_by > 1`, insert a new item row instead of updating the shared one.

Price update (after confirm):

```sql
update package
set price = $1,
    nett_price = $2,
    max_discount = $3,
    updated_at = now(),
    modified_date = now()
where id = $4
returning id, package_name, price, nett_price, max_discount
```

Append a BOM line:

```sql
update package
set linked_package_item = array_append(linked_package_item, $1),
    updated_at = now(),
    modified_date = now()
where id = $2
returning id, linked_package_item
```

New product: INSERT with a unique `bubble_id`, copy `linked_brand` / `linked_category` from a sibling SKU, set `active = true`. New package: clone a close live row; new `package_item` bubble_ids; set `panel` / `inverter_*` / `invoice_desc` to match.

## Guardrails

- Confirm before writes. Repeat package id + name + old → new values.
- Deactivate (`active = false`) instead of DELETE.
- Do not SELECT `package.password`.
- Do not write invoice, customer, or other tables.
- Do not run git.
