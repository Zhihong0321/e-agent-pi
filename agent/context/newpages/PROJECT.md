# NEWPAGES Site Manager — PROJECT

**One job:** run Eternalgy's merchant listing on NEWPAGES: news (list, categories, create,
delete) and services (list, categories, tags, create, edit, show/hide). Nothing else.

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

Services are the "Manage Services" pages — a public page per service with a header image,
one category, up to 5 tags (from a shared account-wide tag catalog, see `np services tags`),
and a WYSIWYG description, in English/Chinese/Malay. Unlike news, all three language sections
are on one screen (no tab-switching), and rows are hidden/shown instead of deleted.

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

node "$CLOUD_PI_SITES" np services              # list (ids, titles, visible)
node "$CLOUD_PI_SITES" np services categories   # names
node "$CLOUD_PI_SITES" np services tags         # existing tag catalog + max per service
node "$CLOUD_PI_SITES" np services get <id>     # full record: body, category, tags, visible
node "$CLOUD_PI_SITES" np services create --title "…" --body "…" --image /abs/path.jpg [--category X] [--tags "a,b,c"] [--title-cn …] [--body-cn …] [--title-bm …] [--body-bm …] [--dry-run]
node "$CLOUD_PI_SITES" np services edit <id> [--title "…"] [--body "…"] [--image /abs/path.jpg] [--category X] [--tags "a,b,c"] [--dry-run]
node "$CLOUD_PI_SITES" np services show <id>    # make public
node "$CLOUD_PI_SITES" np services hide <id>    # make hidden
```
Every command prints one JSON line. Read `ok` / `ready` / `deleted` / `id` / `toggled` before claiming success.
Fallback if the var is unset: `node "$CLOUD_PI_ROOT/server/sites-cli.mjs" …`.

Tag limits: `--tags` only accepts names already in `np services tags` — this automation cannot
coin brand-new tags yet, it errors naming the closest existing ones. Editing tags is add-only
(no removal yet); category and images are edited by re-supplying the flag.

Host code (for the human maintainer, not for the agent):
[server/sites-cli.mjs](../../../server/sites-cli.mjs) (CLI),
[server/newpages.mjs](../../../server/newpages.mjs) (login + CRUD via headless Chromium),
[server/newpages/npmerchant.mjs](../../../server/newpages/npmerchant.mjs) (news API shapes),
[server/newpages/npservices.mjs](../../../server/newpages/npservices.mjs) (services API shapes),
[server/newpages/np-shared.mjs](../../../server/newpages/np-shared.mjs) (shared login/session/editor helpers),
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
