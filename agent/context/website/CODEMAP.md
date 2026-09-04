# Website Dev Agent — CODEMAP

Snapshot 2026-09-04 from the live workspace. Line numbers drift after edits; section ids do not.

## Files

| File | Size | What it is |
|------|-----:|------------|
| `index.html` | 38.6 KB, ~690 lines | the whole site: markup + inline SVG drawings |
| `styles.css` | 37 KB, ~740 lines | tokens, components, responsive, reduced motion |
| `script.js` | 4.6 KB | draw-in, count-up, reveals, scroll rail, mobile menu, anchor offset |
| `favicon.svg` | | EE infinity mark |
| `PRODUCT.md`, `DESIGN.md` | | Impeccable product truth and visual world (read before design work) |
| `.impeccable/` | | Impeccable state: `build/state.json` (comp round left open), `review/*.png`, `surfaces/index-html.md`. Not site files. |
| `assets/fonts/`, `assets/logo/`, remaining `assets/certs/` | | see PROJECT.md; bulky unused PDFs/PNGs are not published |
| `README.md`, `Dockerfile`, `.dockerignore` | | boot heal deletes these |

## index.html — sections in order

| Line | Id / element | Content |
|-----:|--------------|---------|
| 6-10 | `<title>`, meta description, og:title/description | copy mentions "CIDB Grade G7 · SEDA RPVSP · 10,750.99 kWp · 925 projects" |
| 15-27 | JSON-LD `Organization` | name, alternateName (中文), email, identifier, sameAs (PR Center); no telephone |
| 33 | `.progress-rail #progressBar` | scroll progress |
| 35-69 | `header.site-header` + `nav.site-nav` | anchors, PR Center link :58, email CTA :62 |
| 71-82 | `#mobileMenu` | mirrors nav; PR link :78, email CTA :79 |
| 86-265 | `section.hero#top` | h1 :97 "Solar, drawn to specification.", CTA :104, inline SVG elevation drawing :110-260 (patterns `#dgrid` :123, `#hatch` :126) |
| 266-309 | `section.metrics#metrics` | SYNCED stamp :273; three `.instrument` readouts with `data-count` :287 (revenue), :295 (kWp), :303 (projects); CHECKED timestamps :288/:296/:304 |
| 310-378 | `section.capability#capability` | `#capRows` four work packages: Engineering & Design :324, Submissions & Approvals :339, Installation & Protection :354, Systems & Storage :369 |
| 379-483 | `section.register#register` | `#certTable` header :393-400 then nine `article.reg-row` :401-471 (NO., CREDENTIAL, AUTHORITY, REGISTRATION REF., SCOPE, STATUS stamp) |
| 484-578 | `section.field#field` | `#fieldGrid` three project cards with SVG micro-drawings: :517, :543, :569 |
| 579-613 | `section.procedure#procedure` | `#procRail` five steps :589-609 |
| 614-645 | `section.contact#contact` | lede :619-621 (mentions phone), email CTA :624, tel CTA :628, PR Center CTA :632, note :636 |
| 646-680 | `footer.site-footer` | brand + 中文 :656-659, `dl.footer-spec` REGISTRATION :662 / GRADE :663 / CONTACT :664 / SOURCE OF TRUTH :665, footer nav :667, legal :674 |
| 681 | `<script src="script.js">` | |

## styles.css — blocks

| Line | Block |
|-----:|-------|
| 1-240 | 30 `@font-face` rules (Archivo, Saira, Spline Sans Mono) — **URLs are `../assets/fonts/…`, which resolve to `/app/assets/…` on the live host and 404. See STATE.md.** |
| 245 | `:root` tokens (colors, hairlines, type, spacing) |
| 331 | header / title block · 383 links & buttons · 418 stamps & tags · 449 sheet frames |
| 468 | hero · 523 metrics/instruments · 557 section heads · 563 capability rows |
| 579 | register table · 614 procedure rail · 641 contact · 650 footer · 669 reveal |
| 673-729 | breakpoints 1080 / 900 / 860 / 560 px |
| 731 | `prefers-reduced-motion` |

## script.js — features

`is-ready` class for hero draw-in · `.nav-toggle` + `#mobileMenu` · `#progressBar` scaleX ·
`.reveal` IntersectionObserver → `.is-in` · `[data-count]` count-up (data-decimals, data-prefix,
data-suffix; triggered when `.instrument-strip` is 30% visible) · smooth anchor scroll with
header offset. All degrade under reduced motion.

## Concept index — "change X" → touch these

| Operator says | Locations |
|---------------|-----------|
| email address | index.html :20 (JSON-LD), :62, :79, :104, :624 (`mailto:` href + label), :664 |
| phone number | none on the PR Center — do not add one. If a leftover appears, remove JSON-LD `telephone`, contact lede, `tel:` CTA, footer CONTACT |
| company name / 中文 name | :19, :658-659, `<title>` :6, og :9 |
| registration number | :23, :662 |
| a certification (add/edit/remove) | one `article.reg-row` in :401-471 (keep NO. sequence) + og:description :10 if it names it + PRODUCT.md § Positioning |
| revenue / kWp / project count | `data-count` attrs and visible text :287, :295, :303 + CHECKED/SYNCED stamps :273, :288, :296, :304 + og:description :10 |
| a field record / project card | :517, :543, :569 (title, SVG, caption) |
| scope-of-work rows | :324, :339, :354, :369 |
| procedure steps | :589-609 |
| PR Center link | :26, :58, :78, :275, :385, :490, :632, :665 |
| colors / spacing / type | styles.css `:root` :245 only; components reference tokens |
| fonts | styles.css :1-240 `@font-face` src paths |
| animations | script.js + styles.css :669 reveal, :731 reduced motion |
| hero drawing | inline SVG index.html :110-260 |
| add an image | generate with `$CLOUD_PI_IMAGEN` into `assets/`, reference with a **relative** path (`assets/x.png`), never `/assets/…` |

## Rules baked into the markup

- Every asset path is relative because the site is served under `/app/<slug>/`.
- Zero external requests by design (fonts self-hosted, no CDN). Keep it that way.
- `data-stamp` spans get the stamp-in animation; `data-count` numbers count up.
- Section ids (`top metrics capability register field procedure contact`) are referenced by nav, mobile menu, and footer nav. Renaming one means three edits.
