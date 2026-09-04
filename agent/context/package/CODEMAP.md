# Package Updater — CODEMAP

There is no repository. The "code" is three tables plus the Package google sheet.
Full column tables are in [agent/roles/package.md](../../roles/package.md) § Tables.
This is the concept index.

## Concept → where it lives

| Operator says | Table / column | Notes |
|---------------|----------------|-------|
| "Package google sheet" / "price sheet" | workbook `1aBCKeLnlUci2q98WwTIX77UwDqyrFFsK_1tFaSK4INU` | always this URL; pull with `$CLOUD_PI_PACKAGE_SHEET` |
| "price of package X" | sheet `Package Price` / `Price(RM)` → `package.price`; `Nett Price After Discount` → `package.nett_price` | keep `nett_price = price - max_discount` when that pattern exists on the row |
| "which panel / inverter is in package X" | sheet `PANELS TYPE` / `INVERTER MODEL` → `package.panel`, `package.inverter_1..4` → `product.bubble_id` | STRING uses `inverter_1`; some MICRO rows use `inverter_2` with `inverter_1` null |
| "BOM / what's included" | sheet `Invoice Description` + accessory columns → `package.linked_package_item` / `invoice_desc` | rewrite `invoice_desc` when hardware changes |
| "panel count" | sheet `NO PANELS` / `NUMBER OF PANELS` / `No Panel` → `package.panel_qty` **and** the panel line's `package_item.qty` | must match |
| "residential / commercial / roadshow / EV" | sheet `PACKAGE Type` → `package.type` | `commercial` on the sheet = `Tariff B&D Low Voltage`. Roadshow is not on the sheet |
| "1P / 3P", "STRING / MICRO / HYBRID" | encoded in `package.package_name` / sheet `Package Name` | e.g. `[1P] STRING SAJ JINKO 8 PCS 650W`. Sheet hybrid-v2 writes `HYBIRD` |
| "on the price list?" | present on a **live** sheet tab → should be `package.active` | missing from that tab, same family → deactivate candidate |
| "new panel watt / new inverter model" | sheet `PANELS TYPE` / `INVERTER MODEL` with no `product` row | insert `product` first (copy `linked_brand` / `linked_category` from a sibling) |
| "MSIG insurance line" | shared `package_item` `pitem_msig_allrisk_assured` on ~346 packages | never edit a shared item; insert a new one instead |
| "warranty text shown on proposal" | `product.product_warranty` / `warranty_year` / `linear_power_warranty` | read by ee-proposal `invoice-data.js` and `pdf-generator.js` |

## Sheet columns → `prod_main`

Join key: sheet `Package Name` ↔ `package.package_name`. Before matching, collapse spaces,
`HYBIRD` → `HYBRID`, and insert a space after `]` (`[1P]MICRO` → `[1P] MICRO`). The CLI
already emits `nameKey` for that. If the name still misses, match `dbType` + `panels` +
watt from `panel` + STRING/MICRO/HYBRID + 1P/3P, then confirm.

| Sheet header (any live tab) | `package` / extras |
|-----------------------------|--------------------|
| Package Name | `package_name` |
| PACKAGE Type / Package Type | `type` (map commercial → Tariff B&D Low Voltage) |
| Package Price / Price(RM) | `price` (strip `RM` and commas) |
| Nett Price After Discount | `nett_price` |
| NO PANELS / NUMBER OF PANELS / No Panel | `panel_qty` |
| INVERTER MODEL / Inverter Qty and Model | inverter product + `invoice_desc` line |
| PANELS TYPE / Panel Type | panel product |
| Invoice Description | `invoice_desc` |
| DC/AC cable, mount, Breaker, PV METER, PVC DB BOX, mc4, SPD | BOM accessory lines |

EV tab has no panel count: `EV Charger`, `Charger Warranty`, `Cable`, `Price(RM)`.

## Keys

- Every relation is on `bubble_id` (text). `id` is a Postgres serial and is never a join key.
- `unique_id` is unused (all null).
- `package.password` exists. Never SELECT or echo it.

## Reply shape the studio renders well

```
## 10 panels (12)
| id | Package | Price | Nett |
|----|---------|------:|-----:|
| 859 | [1P] HYBRID SAJ JINKO 10 PCS 620W | 21695 | 17585 |
```
One row per package, group by panel count, cap ~20 rows, offer to continue.
