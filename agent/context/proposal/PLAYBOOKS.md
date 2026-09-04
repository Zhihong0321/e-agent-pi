# Proposal Agent — PLAYBOOKS

Every playbook: read only the files named, edit, run the verify step, `git add -A && git commit -m "Proposal Agent: <what>" && git push origin HEAD:main`, report files + push SHA + live URL. Target: first edit within 15 tool calls.

### Pre-flight (once per chat)
```bash
git status --short && git log -1 --oneline && ls _inbox 2>/dev/null
```
Clean tree + latest commit tells you where you are. If STATE.md lists an unfinished job, continue it.

### 1. Add or change a warranty line (default text)
When: "add a 10-year X warranty", "change workmanship to 5 years".
Read: CODEMAP § Warranty lines. `defaults.js` first.
Edit, in this order:
1. `defaults.js` — the five model/warranty strings plus installation/MSIG/valid-days.
2. `invoice-data.js` / `pdf-generator.js` — they read defaults; do not re-literal them.
3. `proposal.html` `renderWarranty` (Installation/MSIG) and demo packages if it is a panel/inverter warranty.
4. `quotation.html` live fill.
5. `html_to_pdf/proposal-pdf-en.html` and `-zh.html` Warranty block; `quotation-pdf.html` and `quotation-standalone.html` warranty rows (labels + placeholder).
6. `page-i18n.js` :192-202 add `.replace("<English>", "<中文>")`.
Verify:
```bash
grep -rn "<new English string>" --include=*.html --include=*.js . | grep -v node_modules
```
Expect hits in all files above. Then the render check (§ Verify below).
Never: edit only the live page; stop after `proposal.html` — the PDF and quotation will disagree.

### 2. Change a certification (number, grade, name, logo)
Read: `proposal.html` :919-982; `page-i18n.js` :144-157.
Edit: the `article.cert-item` in `proposal.html`; same block in `html_to_pdf/proposal-pdf-en.html` :692-745 and `-zh.html`; the positional h3/dt lists in `page-i18n.js` (same index, same count); logo file in `logo/` if supplied (keep filename or update all `src`).
If the badge list on Why-Eternalgy changes: `why-eternalgy.html` :369-374, both `why-eternalgy-pdf-*` :400-405/:420-425, `page-i18n.js` :63-70.
Verify: `grep -rn "<old value>" --include=*.html --include=*.js .` → empty.
Source of truth for cert facts: the PR Center `https://ee-pr.up.railway.app/` (fetch with node, grep for the cert name). Confirmed 2026-09-03: CIDB is G7, reg `0120250324-WP152634`, B04/CE21/M15.

### 3. Update client / proposal details from an invoice PDF or screenshot
Read: `_inbox/<file>.txt` (PDF extract) or the image (only on a vision model; on Kimi ask for text).
Extract: client name, address, invoice number, package name, panel model/qty/watt, inverter model, date, amounts. Missing → ask once.
Decide with the operator: **(a)** they want the live proposal for that invoice → it needs no edit, give them `shell.html?uid=<invoice_number>#proposal`; **(b)** they want the demo/default view changed → edit `proposal.html` `fallbackInvoices` :1035-1060 / `fallbackPackages` :988-1033 and `quotation.html` demo markup :500-580.
Never: paste invoice data into the HTML when a UID would show it live.

### 4. Change a default panel / inverter model or brand name
Edit: `invoice-data.js` :4-7, `pdf-generator.js` :145-148, `proposal.html` demo packages :988-1033, `quotation.html` :566/:575, PDF template labels if the brand name is static (`html_to_pdf/proposal-pdf-*` model rows, `quotation-*` line items "Jinko Solar PV Modules" / "SAJ String Inverter"), logos in `logo/processed/`.
Verify: grep old model string → empty.

### 5. Copy change on Why-Eternalgy
Edit Chinese in `why-eternalgy.html` (:296-377) **and** English in `page-i18n.js` `englishBodies` :48-54 (same block index) or `setAll(".block-content h2", …)` :35-41; then `why-eternalgy-pdf-en.html` :317-405 and `-zh.html`.

### 6. Copy or number change on Why-Jinko / Marcap
Edit live page, `page-i18n.js` ZH map (`applyTigerNeoChinese` :73 / `applyMarcapChinese` :211), and both `-en`/`-zh` PDF templates. Physics constants: `tiger-neo3.html` :702-743 **and** `pdf-generator.js` :260-264. Shipment figures: `marcap.html` :917-929 + :1066-1130 **and** `marcap-pdf-*` :501-509 + :565-600.

### 7. Add or replace an image
Copy from `_inbox/` into `image/` or `logo/` with a stable name; reference with `./image/x.webp` on live pages and `../image/x.webp` in PDF templates. Prefer `.webp` under `image/processed/` for photos. Never commit `_inbox/`.

### 8. Push
```bash
git add -A && git commit -m "Proposal Agent: <summary>" && git push origin HEAD:main
```
If "nothing to commit", still push. Never `checkout -b`, `switch`, or push any other branch. Report the SHA. Railway deploys in ~1 minute; live URL in PROJECT.md.

### Verify (render check, ~1 tool call)
```bash
NODE_PATH=/app/node_modules node -e '
const { chromium } = require("playwright"); const path = require("path");
(async () => { const b = await chromium.launch({ headless: true }); const p = await b.newPage();
for (const [f, sel] of [["proposal.html", ".warranty-copy span"], ["quotation.html", ".warranty-item .value"]]) {
  for (const lang of ["en", "zh"]) {
    await p.goto("file://" + path.resolve(f) + "?lang=" + lang); await p.waitForTimeout(400);
    console.log(f, lang, await p.$$eval(sel, els => els.map(e => e.textContent.trim())));
  } }
await b.close(); })();'
```
The `/api/activity/proposal` fetch error under `file://` is expected. For the GEN HTML path, `require("./pdf-generator")` needs a real UID and `DATABASE_URL`; instead grep the filled template placeholders exist: `grep -c "{{mounting_structure_warranty}}" html_to_pdf/quotation-standalone.html`.

### Do not
- Connect to `DATABASE_URL` from the environment — it is the studio's DB, not `prod_main`.
- Edit `server.js` or `/api/query` unless asked.
- Start by listing `/`, `/root`, `/app`, or `/storage`.
