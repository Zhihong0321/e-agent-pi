# Host facts shared by every agent

Paste-ready. Verified on the Railway container on 2026-09-03/04 from real chat transcripts.
Agent-specific HOST.md files add to this; they do not repeat it.

## Where you are

- Your current working directory **is the whole project**. Everything you own is under it.
- Do **not** list or read `/`, `/root`, `/app`, `/storage`, or other agents' folders.
  `/app` is the studio host application, not your project. `/storage/workspace` and
  `/storage/workspaces/*` belong to other agents unless HOST.md names yours.
- The host writes `AGENTS.md` (and `.agents/skills/`) into your folder for you. They are
  instructions, not site files. Never publish, commit, or edit them.

## Attachments

- Uploads land in `_inbox/` inside your folder, prefixed with a timestamp.
- Every PDF gets a sibling `.txt` extract. Read the `.txt` first. Re-extract with
  `node "$CLOUD_PI_PDF" extract <file.pdf>` (prints JSON `{ok,text,pages}`).
- Copy keepers out of `_inbox/` with a stable filename. `_inbox/` is never published.

## Toolbox (what exists on this container)

| Present | Absent |
|---------|--------|
| `node` v22 (global `fetch` works) | `curl`, `wget` |
| `git` | `ps`, `ss`, `lsof` |
| `python3` at `/opt/scrapling/bin/python3` with `scrapling[all]` + Chromium | system `pip` |
| `scrapling` CLI at `/opt/scrapling/bin/scrapling` and the `scrapling` MCP server | |
| `/app/node_modules` has `pg` and `playwright` → use `NODE_PATH=/app/node_modules node …` | `npm install` in your folder (do not) |

Fetch a page: `node -e "fetch('URL').then(r=>r.text()).then(t=>console.log(t.slice(0,4000)))"`
or Scrapling (`scrapling extract get URL --ai-targeted`). Scrape output goes to `/tmp`.

## Host CLIs (env vars are set for you)

| Var | Use |
|-----|-----|
| `$CLOUD_PI_PDF` | `extract <pdf>` |
| `$CLOUD_PI_IMAGEN` | `generate --prompt "..." --out assets/x.png [--aspect 16:9]` (only if HOST.md says imaging is on) |
| `$CLOUD_PI_SITES` | site logins + NEWPAGES CRUD (NEWPAGES agent only) |
| `$CLOUD_PI_CATALOG` | host catalog (Settings Agent only) |
| `$CLOUD_PI_ROOT` | `/app`; fallback path for the CLIs above (`$CLOUD_PI_ROOT/server/<name>-cli.mjs`) |

If a var is missing, say so in one line and use the fallback path. Do not go looking for it.

## Env vars that are NOT yours

The host does **not** pass `DATABASE_URL`, model API keys, `RAILWAY_*`, `EE_HTML_*`, or GitHub tokens into your process. If you still see them, do not read, print, or connect with them. `DATABASE_URL` would be the studio's own database, not your project. Use only the `CLOUD_PI_*` (and, for Package Updater, `PG_PROXY_TOKEN`) vars listed above.

## Models

- **Kimi K3 cannot see images.** If the operator sends a screenshot and you are on Kimi,
  say so in one line and ask for the text or the values. Do not pretend to read it.
- Gemini / Claude via AGY can read images.

## Turn discipline

- Every turn ends with a **result** (what changed + where to look) or **one question**.
  Never end a turn on "Let me…" or after a tool call with no text.
- If the host restarts mid-task you will receive "continue from where you left off".
  Recover from `STATE.md` in your folder and `git status`/`git diff --stat`
  (git workspaces) or `ls -lt | head` (others). Do **not** read your own transcript logs.
- Reply in GitHub Markdown. No raw HTML, no BBCode.
