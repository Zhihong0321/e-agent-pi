# Website Dev Agent — STATE (seed, 2026-09-04)

Host-maintained journal. Newest first. Keep ~10 entries.

## Open issues

1. **Fonts do not load on the live site** until the next host deploy (heal rewrites
   `../assets/fonts/` → `assets/fonts/` on boot, then ee-html publish).

## Recent changes

- 2026-09-04 — boot heal drops unused `assets/certs/profile-2025.pdf`, `all-certs.pdf`,
  and `assets/solar-panel*.png` from the volume; zip also skips those names. Cert originals
  stay on the PR Center. Register copy already points there.

- 2026-09-04 — PR Center is identity source of truth: SSM `202301029164 (1523087-A)`,
  `pr@eternalgy.me`, no phone, no street address. Host heal removes the `012-345 6789`
  placeholder from `index.html` on boot.

- 2026-09-03 — contact number `012-345 6789` added in three places (contact CTA, footer,
  JSON-LD). Session a9207e92.
- 2026-09-03 — two solar-panel images generated with Imagen into `assets/`. Session 3ae833f5.
- 2026-09-02/03 — site built from scratch on the "drafting room" Impeccable direction;
  first publish to slug `e-agent-site`. Session 8c166bdb.
