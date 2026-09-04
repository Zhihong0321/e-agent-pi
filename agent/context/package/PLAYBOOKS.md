# Package Updater — PLAYBOOKS

The six monthly recipes (price change, new product, new package, swap panel/inverter,
add accessory to many, retire) are written out in
[agent/roles/package.md](../../roles/package.md) § "Monthly work". They are the playbooks.
Below: the pre-flight, **the sheet pull** (99% of chats start here), the read-only
lookups, and the verification step every write must end with.

### Pre-flight (every chat, once)

```bash
test -n "$PG_PROXY_TOKEN" && echo token:ok || echo token:MISSING
```
If MISSING: tell the operator "save the Postgres proxy token on Settings → Keys, then start a new chat". Stop. Do not ask for the token in chat.

### Pull: Package google sheet (do this first)

When: operator says "Package google sheet", "latest prices", "sync packages", "new package",
"deactivate what's not on the list", or pastes the Price Center URL.

```bash
node "$CLOUD_PI_PACKAGE_SHEET" pull --live --write _inbox/package-sheet
```

That is **one** tool call. Stdout is tab summaries (counts, columns, price range, sample names).
Full rows go to `_inbox/package-sheet/packages.json` and `<slug>.csv`. For one family:

```bash
node "$CLOUD_PI_PACKAGE_SHEET" pull --tab string --packages
```

(`hybrid` / `micro` / `commercial` / `ev`). `--full` adds invoice text.
Never `fetch` the `/edit` URL. Never Scrapling / screenshot the workbook.

### Sync sheet → `prod_main` (prices, new, missing)

When: monthly update, or "make the catalog match the sheet".

Read: CLI JSON, then SELECT active rows of that `type` (`id, package_name, panel_qty, price, nett_price, max_discount, active`).

1. Match on `nameKey` vs `lower(btrim(package_name))` after `HYBIRD`→`HYBRID`. If miss, match type + panel count + watt + STRING/MICRO/HYBRID; list unmatched, do not guess.
2. **Price change:** sheet `price`/`nett` ≠ DB → propose UPDATE. Set `max_discount = price - nett` when the row already follows that pattern.
3. **New package:** on the sheet, not in DB → clone the closest live package (role recipe 3). New product first if the panel/inverter SKU is new (role recipe 2). Leave `active = false` until told to publish.
4. **Deactivate:** in DB `active is true` for that family, **not** on the live tab → propose `active = false`. Never this for Special / Roadshow. Never DELETE.
5. Confirm the three lists (N price, N new, N deactivate) with names + old → new. Then write.

Done when: SELECT back matches the sheet for that family, and you reported ids.

Never: deactivate from the superseded `hybrid-res` tab; use `hybrid-v2`. Never sum item prices to invent a package price.

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
- Scrape the Google Sheets editor when `$CLOUD_PI_PACKAGE_SHEET` exists.
