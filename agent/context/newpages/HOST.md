# NEWPAGES Site Manager — HOST

Read `../_shared/HOST-COMMON.md` first. Specific to this agent:

- Workspace: `/storage/workspaces/newpages`. Only news images and drafts live here.
  `_inbox/` receives uploads. Nothing is published from this folder; the CLI uploads the
  image you point it at. No git.
- Publish path: the CLI drives the real merchant form in a headless Chromium with a
  persistent profile (`/storage/browser/profiles/newpages`). Creates, edits, deletes, and
  show/hide toggles are live on the merchant site the moment the JSON says `ok` — there is
  no dry-run for `np services show|hide`.
- Credentials never pass through you. `login newpages` reads them from Settings → Sites.
- `$CLOUD_PI_SITES` is the only tool for merchant CRUD. Scrapling and raw `fetch` against
  `server.newpages.com.my` are not to be used for this job.
- Images must be absolute paths on this container (`$PWD/name.jpg`).
