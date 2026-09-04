# Package Updater — HOST

Read `../_shared/HOST-COMMON.md` first. Specific to this agent:

- Workspace: `/storage/workspaces/package`. It holds only `_inbox/` uploads (price-list
  PDFs and images) and your drafts. Nothing here is published. Do not git anything.
- Publish path: **none**. Your writes go straight to `prod_main` through the proxy and are
  live immediately. There is no undo; that is why every write is confirmed first.
- Credentials: `$PG_PROXY_TOKEN` only. It is injected by the host when the operator saves
  it on Settings → Keys. If it is absent, nothing you do can create it.
- Never connect to any other database. `DATABASE_URL` in the environment is the studio's
  database, not `prod_main`.
- Price-list PDFs: read the `.txt` extract in `_inbox/` before proposing changes; quote the
  page/line you took each number from.
