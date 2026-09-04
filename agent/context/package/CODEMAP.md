# Package Updater — CODEMAP

There is no repository. The "code" is three tables. Full column tables are in
[agent/roles/package.md](../../roles/package.md) § Tables. This is the concept index.

## Concept → where it lives

| Operator says | Table / column | Notes |
|---------------|----------------|-------|
| "price of package X" | `package.price` (selling), `package.nett_price`, `package.max_discount` | keep `nett_price = price - max_discount` when that pattern exists on the row |
| "which panel / inverter is in package X" | `package.panel`, `package.inverter_1..4` → `product.bubble_id` | STRING uses `inverter_1`; some MICRO rows use `inverter_2` with `inverter_1` null |
| "BOM / what's included" | `package.linked_package_item` (text[]) → `package_item.bubble_id` → `package_item.product` → `product.bubble_id` | `invoice_desc` is the human copy of the same BOM; rewrite it when hardware changes |
| "panel count" | `package.panel_qty` **and** the panel line's `package_item.qty` | must match |
| "residential / commercial / roadshow / EV" | `package.type` | `Residential` · `Tariff B&D Low Voltage` · `Special / Roadshow` · `EV Charger` |
| "1P / 3P", "STRING / MICRO / HYBRID" | encoded in `package.package_name` only | e.g. `[1P] STRING SAJ JINKO 8 PCS 650W` |
| "on the price list?" | `package.active` | never DELETE |
| "new panel watt / new inverter model" | `product` row: `name`, `label`, `solar_output_rating` or `inverter_rating`, `linked_brand`, `linked_category` (copy from sibling) | new unique `bubble_id` |
| "MSIG insurance line" | shared `package_item` `pitem_msig_allrisk_assured` on ~346 packages | never edit a shared item; insert a new one instead |
| "warranty text shown on proposal" | `product.product_warranty` / `warranty_year` / `linear_power_warranty` | read by ee-proposal `invoice-data.js` and `pdf-generator.js` |

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
