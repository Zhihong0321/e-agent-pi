# NEWPAGES Site Manager — PROJECT

**One job:** run Eternalgy's merchant listing on NEWPAGES: list news, list categories,
create a post, delete a post. Nothing else.

## The external system

| Item | Value |
|------|-------|
| Merchant UI | `https://merchant.newpages.com.my` |
| Merchant API | `https://server.newpages.com.my` |
| Eternalgy merchant `company_id` | `26783` (Eternalgy Sdn Bhd) |
| Auth model | `localStorage` `token` + `company_id`, **not** cookies |
| Login | reCAPTCHA on the real form; done once through the host's persistent Chromium profile at `/storage/browser/profiles/newpages` |
| Credentials | Settings → Sites, slug `newpages`. Never in chat, never in files. |
| Typical listing size | ~18 news items (2026-09-03) |

News items have a numeric `id` (e.g. `181926`), `created_date` (epoch seconds), `img`
(absolute URL on `server.newpages.com.my`), title/body, and a category by **name**.

## How the host wraps it

All CRUD goes through one CLI so the agent never touches the API or Scrapling for this:

```bash
node "$CLOUD_PI_SITES" status            # signed in? (same as: np ready)
node "$CLOUD_PI_SITES" sites             # configured sites
node "$CLOUD_PI_SITES" login newpages    # drive the login form once (CAPTCHA may block)
node "$CLOUD_PI_SITES" np news           # list (ids, titles, dates)
node "$CLOUD_PI_SITES" np categories     # names
node "$CLOUD_PI_SITES" np create --title "…" --body "…" --image /abs/path.jpg [--category Roadshow] [--title-cn …] [--body-cn …] [--title-bm …] [--body-bm …] [--dry-run]
node "$CLOUD_PI_SITES" np delete <newsId>
```
Every command prints one JSON line. Read `ok` / `ready` / `deleted` / `id` before claiming success.
Fallback if the var is unset: `node "$CLOUD_PI_ROOT/server/sites-cli.mjs" …`.

Host code (for the human maintainer, not for the agent):
[server/sites-cli.mjs](../../../server/sites-cli.mjs) (CLI),
[server/newpages.mjs](../../../server/newpages.mjs) (login + CRUD via headless Chromium),
[server/newpages/npmerchant.mjs](../../../server/newpages/npmerchant.mjs) (API shapes),
[server/sites.mjs](../../../server/sites.mjs) (credentials table + profiles).

## Observed in chat logs (2026-09-03)

All NEWPAGES sessions so far were the operator **building** the integration, not using it:
the agent was told "run exactly one bash, do not read skills", and pasted Python scripts.
Two lessons that shaped the CLI and belong in the prompt:

1. Left alone, the agent spent 16 + 13 tool calls reverse-engineering Scrapling internals and
   the merchant's webpack chunks. The CLI exists so it never has to. **First action on any
   request is `np ready`, then the matching `np …` command.**
2. Merchant credentials were pasted into chat during those tests. They are now on
   Settings → Sites; the prompt must keep refusing chat-pasted passwords.
