---
name: site-browser
description: Drive a persistent headless browser for operator sites. Use when asked to log into a site, run NEWPAGES merchant news CRUD, reuse a saved Google/OAuth session, or browse while signed in. Credentials live on /signin and Settings → Sites, not in chat.
---

# Site browser (host)

Two persistent browsers exist on this host. Do **not** mix them.

1. **Shared profile** (`/storage/browser/profiles/shared`) — Google and other OAuth sessions. Drive it with the **Persistent Browser MCP** (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_auth_status`). The owner signs in at **/signin**. Cookies survive restarts.
2. **NEWPAGES profile** — merchant username/password. Drive it with `$CLOUD_PI_SITES` below.

Do **not** ask the human to paste passwords in chat. Do **not** write credentials into the workspace. Do **not** log out of Google. If `browser_auth_status` says signed out, tell them to open `/signin` and complete Google (including 2FA) there.

Prefer the Browser MCP over Scrapling when the page requires being signed in. Scrapling starts a fresh anonymous browser.

```bash
node "$CLOUD_PI_SITES" status
node "$CLOUD_PI_SITES" sites
node "$CLOUD_PI_SITES" login newpages
```

If `status` says not signed in, tell them to fill Settings → Sites (NEWPAGES merchant) and then run `login newpages`. If `$CLOUD_PI_SITES` is missing, use `$CLOUD_PI_ROOT/server/sites-cli.mjs`.

## NEWPAGES merchant (`merchant.newpages.com.my`)

First automation. Auth is a **localStorage token**, not cookies. Reads use the merchant API; creates/deletes drive the real form (reCAPTCHA).

```bash
node "$CLOUD_PI_SITES" np ready
node "$CLOUD_PI_SITES" np news
node "$CLOUD_PI_SITES" np categories
node "$CLOUD_PI_SITES" np create --title "Roadshow this weekend" --body "Come see us." --image /absolute/path.jpg --category Roadshow
node "$CLOUD_PI_SITES" np create --title "…" --image /absolute/path.jpg --dry-run
node "$CLOUD_PI_SITES" np delete 181926
```

- `image` must be an absolute path on this server (workspace file is fine: `$PWD/assets/….jpg`).
- Category is the **name** from `np categories`, not an id.
- Delete by numeric news **id**, never by row index or title.
- Commands print JSON. Read `ok` / `ready` / `deleted` / `id` before telling the user it worked.

Prefer this CLI over `curl` or raw `node fetch` for NEWPAGES.
