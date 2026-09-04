# Proposal Agent — STATE (seed, 2026-09-04)

Host-maintained journal. Newest first. Keep ~10 entries.

## Open issues

(none)

## Recent changes

- 2026-09-04 — Marcap PDF figures come from the same TradingView scan as `marcap.html`,
  with the same fallback quote labeled as a cached snapshot.

- 2026-09-04 — quotation identity aligned to PR Center: SSM `202301029164 (1523087-A)`,
  `pr@eternalgy.me`, PR Center URL; removed Skudai address and `info@eternalgy.com`.

- 2026-09-04 `fb253a1` — "10 Years Mounting Structure Warranty" added as a default:
  `invoice-data.js`, `pdf-generator.js` (DEFAULT_MOUNTING_WARRANTY, coverage regex,
  `mounting_structure_warranty` placeholder), `proposal.html` Installation row,
  `page-i18n.js` ZH mapping "10 年支架结构保修", `quotation.html` grid row,
  `html_to_pdf/proposal-pdf-{en,zh}.html`, `quotation-pdf.html`, `quotation-standalone.html`.
  Took 3 turns / 291 tool calls without a code map. Sessions e1115bee (AGY Gemini).
- 2026-09-03 `dce2043`, `70d3b20` — CIDB certification updated G3 → G7 on `proposal.html`,
  three `proposal-pdf*` templates, `page-i18n.js` h3 "CIDB G7 注册承包商"; new G7 seal
  `logo/cidb-registered.png`; licence scan saved as `image/Eternalgy-Cert-CIDB.png`
  (not referenced). Facts taken from the PR Center. Session 36ca6eed (Pi Kimi).
- 2026-07-30 `c4de31a` — visitor activity tracking (`/api/activity/proposal`). Human commit.
