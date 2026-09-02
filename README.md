# Website Studio (Pi agent)

Cloud app for Railway. Pi **Website Dev Agent** only edits a volume workspace (static HTML/CSS/JS). This service does **not** publish to ee-html or serve a public generated site. GitHub is the intended workspace remote.

## Status snapshot

**Recorded:** 2 September 2026, 18:22 (UTC+8) / 10:22 UTC  
**Source:** `GET https://e-agent.up.railway.app/api/health`

| Check | State |
|------|--------|
| Boot | `ready`, `ok: true` |
| Node | v22.23.2, listen `0.0.0.0:8080` |
| Postgres | connected (`DATABASE_URL`) |
| Volume | `/storage` (`RAILWAY_VOLUME_MOUNT_PATH` set) |
| Workspace files | 1 |
| Cavoti key (Postgres) | set |
| Kimi key (Postgres) | set |
| Models configured | 2 (`gpt-5.6-luna`, `kimi-k3`) |
| Active model | `kimi-k3` |
| GitHub token / repo | not set — workspace git disconnected |
| Railway service | `E Agent (PI)` / production |
| Replica | one (volume requires a single replica) |

Re-check live state yourself; do not ask the user to paste logs:

- Studio: https://e-agent.up.railway.app/
- Settings: https://e-agent.up.railway.app/settings
- Health: https://e-agent.up.railway.app/api/health
- Debug: https://e-agent.up.railway.app/api/debug
- Railway hostname: `blissful-warmth-production-57c5.up.railway.app`

Settings password is stored in Postgres (seeded `eternalgy2026`). API keys and GitHub credentials are **not** Railway variables — they are edited on `/settings` and saved in the `settings` table.

## Git

- App repo: https://github.com/Zhihong0321/e-agent-pi
- Deploy branch: **`railway`** (not `main`)
- Local path: `E:\000\UIv2`

## Railway setup

1. Service from GitHub `Zhihong0321/e-agent-pi`, branch `railway`
2. PostgreSQL plugin → `DATABASE_URL`
3. Volume mounted at **`/storage`** (one replica)
4. Dockerfile start: `node server/index.mjs`
5. Process listens first, then boots Postgres / volume / git

Volume layout:

| Path | Purpose |
|------|---------|
| `/storage/workspace` | Pi cwd (site files) |
| `/storage/storage` | Pi session dir |
| `/storage/pi` | Pi agent dir |

## Product rules

- Agent works **only** in the workspace cwd (`agent/ROLE.md`)
- After file edits, the **host** commits/pushes when GitHub is configured; the agent must not deploy or call a host API
- ee-html (`https://ee-html.up.railway.app/`) is a separate HTML host engine; this app never publishes there

## Code map

| Path | Purpose |
|------|---------|
| `app/page.tsx` | Studio UI |
| `app/settings.tsx` | Password-gated settings |
| `src/main.tsx` | `/settings` vs studio |
| `agent/ROLE.md` | Agent prompt |
| `agent/model-catalog.json` | Luna + Kimi catalog |
| `server/index.mjs` | HTTP: `dist/` + `/api/*` |
| `server/db.mjs` | `settings`, `messages`, `git_syncs`, `debug_events` |
| `server/secrets.mjs` | Keys from Postgres |
| `server/auth.mjs` | Settings session cookie |
| `server/github.mjs` | Clone / commit / push workspace |
| `server/models.mjs` | Model availability from DB keys |

## Open

1. Add GitHub token + `owner/repo` on `/settings` so the workspace syncs.
2. Push/deploy **`railway`**, not `main`.
3. Railway CLI on the Windows machine was blocked by Defender; debug via `/api/health` and `/api/debug`.
