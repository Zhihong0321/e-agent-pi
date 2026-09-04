# Package Updater — PLAYBOOKS

The six monthly recipes (price change, new product, new package, swap panel/inverter,
add accessory to many, retire) are written out in
[agent/roles/package.md](../../roles/package.md) § "Monthly work". They are the playbooks.
Below: the pre-flight, the read-only lookups that answer 80% of questions, and the
verification step every write must end with.

### Pre-flight (every chat, once)

```bash
test -n "$PG_PROXY_TOKEN" && echo token:ok || echo token:MISSING
```
If MISSING: tell the operator "save the Postgres proxy token on Settings → Keys, then start a new chat". Stop. Do not ask for the token in chat.

### Lookup: packages by panel count / type / brand

```sql
select id, package_name, type, panel_qty, price, nett_price, max_discount
from package
where active is true and type = $1 and panel_qty between $2 and $3
order by panel_qty, price
```
Params example: `["Residential", 8, 12]`. Reply as the grouped table in CODEMAP.

### Lookup: "what's in package N"

```sql
select pkg.id, pkg.package_name, pi.sort, pi.qty, p.name, p.label
from package pkg
join package_item pi on pi.bubble_id = any(pkg.linked_package_item)
left join product p on p.bubble_id = pi.product
where pkg.id = $1
order by pi.sort nulls last, pi.id
```

### Lookup: price for "brand + watt + N panels + type"

Same as the first lookup with `package_name ilike $4` (e.g. `%JINKO%650W%`). If several
rows match (STRING vs MICRO vs HYBRID, 1P vs 3P), list them all; do not pick one silently.

### Write: any UPDATE / INSERT

1. SELECT and show the current row(s) (id, name, old values).
2. State the change in one sentence: "N packages, price 16610 → 17000".
3. Wait for an explicit yes.
4. Run parameterised SQL with `WHERE id = $n` or `bubble_id = $n`. One statement per request.
5. Touch `updated_at = now(), modified_date = now()`.
6. SELECT the same rows back and report id, name, new values.

### Verify a shared `package_item` before editing it

```sql
select count(*)::int as used_by from package where $1 = any(linked_package_item)
```
`used_by > 1` → do not edit; insert a new item with a new `bubble_id` and repoint only this package.

### Never

- DELETE rows. Use `active = false`.
- Write to invoice, customer, payment, user, voucher, agent tables.
- SELECT `package.password`.
- Sum item `selling_price` to "fix" a package price.
