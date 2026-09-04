# Proposal Agent — CODEMAP

Snapshot of `ee-proposal@fb253a1` (2026-09-04). Line numbers drift; ids and function names do not.

## Files

| File | Lines | Role |
|------|------:|------|
| `shell.html` | 560 | app shell: iframe, hash routing, bottom nav, language toggle, GEN HTML button, activity beacons. Hash→file map `pages` :80; nav labels `pageLabels`/`pagesConfig` :186; GEN HTML :378-423 |
| `proposal.html` | 1249 | main page. Markup :794-982; JS :986-1247 (`fallbackPackages` :988, `fallbackInvoices` :1035, `getInverters` :1079, `renderWarranty` :1097, `brandLogoMarkup` :1138, `renderProposal` :1171, `loadInvoiceUid` :1219) |
| `quotation.html` | 727 | quotation page. Markup :490-636; JS :638-725 (`loadQuotation` :668) |
| `tiger-neo3.html` | 1297 | "Why Jinko": 5 comparison articles + 10-year summary + embedded `marcap.html` iframe :686. Physics constants :702-743. `loadInvoiceUid` :1223 |
| `marcap.html` | 1694 | Jinko market cap + top-5 shipments; Chart.js CDN :21; TradingView fetch :1284; `shipmentRows` :1066-1130; fallback quote :1055 |
| `why-eternalgy.html` | 383 | five strengths; **source language Chinese**; cert badges :369-374; images :298, :313, :328, :344, :359 |
| `page-i18n.js` | 402 | runtime translation. EN early-return :7; `applyWhyEternalgyEnglish` :27; `applyTigerNeoChinese` :73; `applyProposalChinese` :119 (cert h3 list :144, dt list :150, warranty replaces :192-202); `applyMarcapChinese` :211; MutationObserver re-apply :393 |
| `invoice-data.js` | | browser data layer: `EternalgyDefaults`, `runQuery` → `/api/query`, `normalizeBundle`, `fetchInvoiceBundle`, `window.EternalgyInvoiceData` |
| `defaults.js` | | single source for panel/inverter/warranty/quotation-valid defaults (UMD) |
| `queries.js` | | named SQL: `invoice`, `products`, `customer`, `agent` |
| `pdf-generator.js` | | server data layer using `defaults.js` + `queries.js`; PDF + GEN HTML |
| `server.js` | | routes; `POST /api/query`; `POST /api/sql` returns 404 |
| `logo/`, `logo/processed/`, `image/`, `image/processed/`, `fonts/`, `video/` | | assets (see § Assets) |

## Concept index — "change X" → touch these

### Warranty lines
| Where | What |
|-------|------|
| `defaults.js` | **source of truth** (`PANEL_*`, `INVERTER_*`, `MOUNTING_WARRANTY`, `INSTALLATION_WARRANTY_LINES`, `INSURANCE_LINE`, `QUOTATION_VALID_DAYS`) |
| `proposal.html` `renderWarranty` | Installation + MSIG from `EternalgyDefaults` |
| `invoice-data.js` / `pdf-generator.js` | read `defaults.js`; do not re-literal the strings |
| `quotation.html` | live fill from defaults; demo grid labels |
| `html_to_pdf/proposal-pdf-{en,zh}.html` | PDF EN/ZH static list |
| `html_to_pdf/quotation-pdf.html`, `quotation-standalone.html` | `{{…warranty…}}` filled from pdf-generator |
| `page-i18n.js` :192-202 | EN→ZH `.replace()` map; add a line per new English string |

### Certification block (proposal)
`proposal.html` :919-982 (4 `article.cert-item`; CIDB :924-937) ·
`html_to_pdf/proposal-pdf-en.html` :692-745 · `-zh.html` same block ·
`page-i18n.js` :144-149 (h3 list, positional) and :150-157 (dt list, positional) ·
logo files `logo/cidb-registered.png`, `logo/Seda-Malaysia001.png`, `logo/myhijau_plain.jpg`.
Why-Eternalgy badge list (6 names): `why-eternalgy.html` :369-374 · `why-eternalgy-pdf-en.html` :400-405 · `-zh.html` :420-425 · `page-i18n.js` :63-70.

### Client / invoice fields (data-driven slots)
`proposal.html`: `[data-customer-name]` :802, `[data-installation-address]` :804, `[data-invoice-number]` :824, `[data-package-name]` :828, `[data-proposal-date]` :832, `[data-status]` :838, metrics :844-865, spec table :870-911.
`quotation.html` ids: `#invoice-number` :502, `#invoice-date` :504, `#bill-name` :511, `#site-address` :512, `#agent-*` :515-519, `#system-size` :526, `#panel-config` :530, `#package-label/-subtext/-qty/-amount` :556-561, `#panel-model` :566, `#panel-count` :568, `#inverter-model` :575, `#subtotal-amount` :597, `#quoted-total` :601, warranty ids :609-623 (`#mounting-warranty` :617), `#summary-note` :627, `#tnc-copy` :631, `#agent-signature` :632.
Demo values live in the same markup (MX FRESH MART, INV-1009339, 24 × 650W). Change the demo there; live values come from SQL.

### Company identity in quotation templates
Source: PR Center. Values live in `defaults.js` (`COMPANY_REG`, `COMPANY_EMAIL`, `COMPANY_PR_URL`)
and the letterheads of `html_to_pdf/quotation-pdf.html` + `quotation-standalone.html`.
SSM `202301029164 (1523087-A)`, email `pr@eternalgy.me`, no street address.

### Why-Jinko content
Live `tiger-neo3.html` (EN source) + `page-i18n.js` :73-117 (ZH) + `html_to_pdf/tiger-neo3-pdf-en.html` + `-zh.html`. Competitor names appear 6× each (live :446/:497/:543/:589/:635, JS config :700-740, both PDF variants, dead `-pdf.html`, and the stale test). Physics constants :702-743 mirror into `pdf-generator.js` :260-264.

### Marcap content
Live `marcap.html` (stat board :914-936, `shipmentRows` :1066-1130, observations :1029-1048) + `page-i18n.js` :211-366 + `marcap-pdf-{en,zh}.html` static tables :565-600 and prose :650-712. PDF figures: `pdf-generator.js` `fetchMarcapData()` (TradingView, same fallback as `marcap.html`).

### Why-Eternalgy copy
Source is Chinese in `why-eternalgy.html` :296-377; English lives in `page-i18n.js` :27-70 (`englishBodies` :48-54 is positional per block); PDF copies `why-eternalgy-pdf-en.html` :317-405 and `-zh.html`.

### Navigation / page labels
`shell.html` `pageLabels`/`pagesConfig` :186 (EN/ZH labels) and the `pages` hash map :80.

### Images / logos
`logo/eternalgy.png`, `logo/processed/jinko-logo.svg`, `logo/processed/saj-logo.{webp,jpg}`, `msig_logo.png` (root), `logo/cidb-registered.png`, `logo/Seda-Malaysia001.png`, `logo/myhijau_plain.jpg`, `image/certification.png`, `image/processed/*.webp`, `group-photo.jpg`. PDF templates reference the same files with `../` and pdf-generator inlines them as base64. Root `*.png` screenshots are gitignored (keep `msig_logo.png`).

## PDF templates (`html_to_pdf/`)

| Family | Loaded | Placeholders |
|--------|--------|--------------|
| proposal | `-en`, `-zh` | 16 (`customer_name`, …) |
| quotation | `quotation-pdf.html` (combined PDF), `quotation-standalone.html` (GEN HTML) | 29 + `logo_data_uri` (standalone) |
| tiger-neo3 | `-en`, `-zh` | 24 |
| marcap | `-en`, `-zh` | 5, filled by `fetchMarcapData()` |
| why-eternalgy | `-en`, `-zh` | 0 |

ZH variants swap the Google Fonts link for local `../fonts/noto-sans-sc-*.woff2` `@font-face`.
**Mirror rule:** any visible string on a live page usually exists in its `-en` and `-zh`
templates too. Change all three or say explicitly which you left.
