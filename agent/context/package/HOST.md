# Package Updater — HOST

Read `../_shared/HOST-COMMON.md` first. Specific to this agent:

- Workspace: `/storage/workspaces/package`. It holds only `_inbox/` uploads (price-list
  PDFs and images), sheet pulls under `_inbox/package-sheet/`, and your drafts. Nothing
  here is published. Do not git anything.
- Publish path: **none**. Your writes go straight to `prod_main` through the proxy and are
  live immediately. There is no undo; that is why every write is confirmed first.
- Credentials: `$PG_PROXY_TOKEN` only. It is injected by the host when the operator saves
  it on Settings → Keys. If it is absent, nothing you do can create it.
- Sheet CLI: `$CLOUD_PI_PACKAGE_SHEET` (this agent only). Pull the Package google sheet
  with `node "$CLOUD_PI_PACKAGE_SHEET" pull --live --write _inbox/package-sheet`.
  Never open the Google Sheets editor. Never Scrapling the `/edit` URL.
- Never connect to any other database. `DATABASE_URL` in the environment is the studio's
  database, not `prod_main`.
- Price-list PDFs: read the `.txt` extract in `_inbox/` before proposing changes; quote the
  page/line you took each number from. Prefer the Google Sheet over a PDF when both exist.
