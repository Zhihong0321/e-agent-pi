# Website Dev Agent — PROJECT

**One job:** build and maintain Eternalgy Sdn Bhd's public company website, a static
HTML/CSS/JS bundle in this workspace, published by the host to ee-html.

| Item | Value |
|------|-------|
| Live URL | `https://ee-html.up.railway.app/app/e-agent-site/` (slug `e-agent-site`) |
| Not ours | `https://ee-html.up.railway.app/app/eternalgy-sdn-bhd/` is an older, separate publish. Ignore it. |
| Workspace | `/storage/workspace` |
| Publish | host zips the whole workspace after every turn and POSTs it to ee-html |
| Design system | Impeccable world "Engineering specification / drafting room" — see `DESIGN.md` in the workspace |
| Product brief | `PRODUCT.md` in the workspace (Impeccable schema) |

## What the site is

A single-page premium company profile. Purpose: make a young, heavily-credentialed solar
installer read as the trustworthy premium choice, ending in one action: email
`pr@eternalgy.me`. Voice: confident, evidence-led, engineering-grade. Every claim must trace
to the PR Center.

**The PR Center `https://ee-pr.up.railway.app/` is a knowledge vault, not a design
reference.** The operator said so explicitly (2026-09-03). Take facts from it; never copy
its layout.

## Company facts (as published on the live site, 2026-09-04)

| Fact | Value | Source line |
|------|-------|-------------|
| Legal name | Eternalgy Sdn Bhd · 恒能 · 恒久能源 | index.html:19, :658 |
| Registration | `202301029164 (1523087-A)` — PR Center header | index.html JSON-LD + footer |
| Email | `pr@eternalgy.me` | index.html |
| Phone | none published — PR Center has no phone; do not invent one | — |
| Address | none published — PR Center has no street address | — |
| CIDB | Grade G7, reg `0120250324-WP152634`, scopes B04 · CE21 · M15, unlimited tender capacity | index.html:401-407 |
| SEDA RPVSP | `SEDA/RPVSP/2024/321` | :409-415 |
| SEDA RPVI | Official RPVI directory (PPA & leasing) | :417-423 |
| MyHijau | `MyHS00025/25`, SAJ inverter range, 60% GITA | :425-431 |
| Maybank | Preferred Solar PV Partner | :433-439 |
| SAJ | Malaysia sole distributor (50MW PV + 10MWh BESS) | :441-447 |
| SHRDC | Center of Excellence partner (BESS training) | :449-455 |
| Golden Bull Award 2024 | Outstanding Enterprise, RE growth | :457-463 |
| MPiA | Corporate member | :465-471 |
| Metrics (synced 2026-07-24) | RM 28,149,508.59 revenue · 10,750.99 kWp installed · 925 projects | :287, :295, :303 |
| Field records shown | P-25128 Johor · P-25127 Johor · P-24978 Selangor | :517, :543, :569 |

**Source of truth:** `https://ee-pr.up.railway.app/` (verified 2026-09-04). SSM
`202301029164 (1523087-A)`, email `pr@eternalgy.me`. No phone, no street address.
The quotation templates previously used a different reg (`202201018137`), Skudai
address, and `info@eternalgy.com` — those are not on the PR Center.

## Brand tokens

Ground `#060b08` · Panel `#0a120d` · Plate `#0e1912` · Ink `#eef4ef` · Dim ink `#9fb8ac` ·
Emerald `#10b981` / `#34d399` · Gold `#f59e0b` (seals and refs only).
Type: Saira (display), Archivo (body), Spline Sans Mono (annotation), all self-hosted in
`assets/fonts/` (30 woff2 subsets). Full spec in `DESIGN.md`.

## Assets on disk

- `assets/logo/` — eternalgy.png, mark-dark/light, horiz-dark/light, horiz-cn-dark/light, jinko.svg, saj.png, seda.png, cidb.png, myhijau.png, goldenbull.png
- `assets/certs/` — PNG of each credential if present. Profile / all-certs PDFs are **not**
  published (boot heal deletes them; zip skips the names). Use the PR Center for the documents.
- `assets/solar-panel.png` / `solar-panel-2.png` — unused Imagen files; boot heal deletes them.
- `favicon.svg`

## Stale docs in the workspace (do not trust blindly)

- `README.md` — written by a confused session; describes a GitHub → Railway → Dockerfile deploy that does not exist here. The host publishes to ee-html. Safe to delete.
- `Dockerfile`, `.dockerignore` — same session, unused by the host. Safe to delete.
- `PRODUCT.md` § "Evidence on Hand" says no logo files exist; they now do (see above).
