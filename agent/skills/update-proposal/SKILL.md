---
name: update-proposal
description: Update the Eternalgy Solar PV proposal from a text request, screenshot, or PDF invoice. Use when the operator asks to change client, package, quotation, images, or copy on the live proposal site.
---

# Update the Eternalgy proposal

Workspace is the `ee-proposal` clone. Live site: https://ee-proposal-production.up.railway.app/shell.html#proposal

## Intake

1. If `_inbox/` has new files, read them (images with the read tool; PDFs via the `.txt` extract or `node "$CLOUD_PI_PDF" extract FILE`).
2. Extract a field list before editing:

```text
client_name
client_address
invoice_number
package_name
panel_brand / panel_model / panel_qty / panel_watts
inverter_brand / inverter_model
proposal_date
amounts (if quotation)
```

3. If a field is missing, ask once. Do not invent company names or prices.

## Where to write

| Field | Typical files |
|------|----------------|
| Propose-to, address, invoice, package, date, panel/inverter tiles | `proposal.html`, `page-i18n.js` |
| Prices, line items, T&C | `quotation.html`, `page-i18n.js` |
| Why Jinko / Why Eternalgy copy | `tiger-neo3.html`, `why-eternalgy.html` |
| Chrome / nav / GEN HTML | `shell.html` |
| Live invoice-from-UID | `invoice-data.js` (only if the operator wants UID/API behavior changed) |
| Photos / logos | copy into `image/` or `logo/`, then point HTML at the new relative path |

Keep EN and 中文 in sync when `page-i18n.js` owns the string.

## Guardrails

- Do not commit `_inbox/`.
- You may `git add` / `commit` / `git push origin HEAD:main`. Never create or switch branches.
- Do not call `/api/sql` with secrets. You may read `invoice-data.js` to understand the UID flow.
- After edits, tell the operator the live URL and which fields changed. If they say push, push main — do not say git is forbidden.

## PDF CLI

```bash
node "$CLOUD_PI_PDF" extract _inbox/invoice.pdf
```

Prints JSON `{ ok, text, pages }`. Use that text; do not paste raw binary into the HTML.
