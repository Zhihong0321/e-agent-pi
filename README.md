# Website Studio (Pi agent)

Cloud app for Railway. Users chat with named **Agents**. Each agent is a Role (prompt) plus the Skills and MCP servers attached to it. Pi **Website Dev Agent** only edits a volume workspace (static HTML/CSS/JS). This service does **not** publish to ee-html or serve a public generated site. GitHub is the intended workspace remote.

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

Volume layout is listed under **Agents = Role + Skills + MCP**.

## Product rules

- Users chat with a chosen **Agent**. An agent is **Role** (prompt) + **Skills** + **MCP** — not a shared bag of tools.
- Skills and MCP servers are installed once on the host library. Attaching them to an agent is a separate step. Unassigned capabilities are invisible to Pi.
- Each studio chat belongs to one agent and is its own Pi session. New chat does not reuse another chat's memory.
- After file edits, the **host** commits/pushes when GitHub is configured; the agent must not deploy or call a host API
- ee-html (`https://ee-html.up.railway.app/`) is a separate HTML host engine; this app never publishes there

## Agents = Role + Skills + MCP

Pi auto-discovers skills from `~/.pi/agent/skills`, `.pi/skills`, and `.agents/skills`. If the host dumped every installed skill there, every agent would see every skill. This app does not do that.

| Layer | What it is | Where it lives |
|------|-------------|----------------|
| **Library** | Installed skills and MCP server definitions. Shared catalog, not granted to anyone by default. | Volume `/storage/library/skills/<slug>/` + Postgres `skills`, `mcp_servers` |
| **Agent** | Named profile: role prompt, assigned skill IDs, assigned MCP IDs | Postgres `agents`, `agent_skills`, `agent_mcp` |
| **Chat** | One conversation with one agent | Postgres `sessions.agent_id` + a Pi session file |

### How Pi is launched per agent

The host keeps **one** Pi RPC process (Railway is a single replica). Switching agents restarts Pi with that agent's bundle:

- `--append-system-prompt` → materialized `/storage/runtime/<agent-id>/ROLE.md`
- `--no-skills` plus `--skill <library path>` for **only** the skills attached to that agent
- `--no-extensions`; if the agent has MCP, also `--extension npm:pi-mcp-adapter` and a runtime `mcp.json` that lists **only** that agent's servers
- `PI_CODING_AGENT_DIR=/storage/runtime/<agent-id>` so Pi does not read the shared `/storage/pi` skill/MCP dirs

Install **does not** attach. A skill written to the library stays unused until it is attached to an agent.

### Who can install

1. **Settings page** (password): `/settings#skills`, `/settings#mcp`, then `/settings#agents` to attach.
2. **Settings Agent** (chat): has `manage-host-settings`. It runs `node $CLOUD_PI_CATALOG` on the host — install skills/MCP **and** attach them to a chosen agent. Website Dev Agent does not get this skill.

After attach, the next chat with that agent restarts Pi with the new bundle.

Website Dev Agent is seeded with **no** extra skills and **no** MCP.

### Settings vs studio

- Studio lists agents and chats with the selected one. **Settings Agent** can install and attach from chat.
- `/settings` (password) is the same catalog in a form UI (keys stay here).

## Volume layout

| Path | Purpose |
|------|---------|
| `/storage/workspace` | Pi cwd (site files) |
| `/storage/storage` | Pi session dir |
| `/storage/pi` | Shared Pi models.json |
| `/storage/library/skills` | Host skill library (install target) |
| `/storage/runtime/<agent-id>` | Per-agent Pi dir (role, mcp.json, settings) |

## Code map

| Path | Purpose |
|------|---------|
| `app/page.tsx` | Studio UI (pick an agent, chat) |
| `app/settings.tsx` | Password-gated keys, agents, skills, MCP |
| `src/main.tsx` | `/settings` vs studio |
| `agent/ROLE.md` | Seed prompt for Website Dev Agent |
| `agent/roles/settings.md` | Seed prompt for Settings Agent |
| `agent/skills/` | Bundled skills copied into the host library on boot |
| `server/catalog-cli.mjs` | Chat-side catalog CLI (`CLOUD_PI_CATALOG`) |
| `agent/model-catalog.json` | Luna + Kimi catalog |
| `server/catalog.mjs` | `agents`, `skills`, `mcp_servers`, attachments |
| `server/runtime.mjs` | Per-agent Pi dir + `--no-skills --skill` args |
| `server/db.mjs` | `settings`, `sessions`, `messages`, `git_syncs`, `debug_events` |
| `server/index.mjs` | HTTP: `dist/` + `/api/*` (agents, skills, MCP, chat, git, health) |
| `server/pi-stream.mjs` | Pi RPC events → live chat transcript |
| `server/secrets.mjs` | Keys from Postgres |
| `server/auth.mjs` | Settings session cookie |
| `server/github.mjs` | Clone / commit / push workspace |
| `server/models.mjs` | Model availability from DB keys |

## Open

1. Add GitHub token + `owner/repo` on `/settings` so the workspace syncs.
2. Push/deploy **`railway`**, not `main`. Session management is in this branch and needs that deploy before production isolates chats.
3. Railway CLI on the Windows machine was blocked by Defender; debug via `/api/health` and `/api/debug`.
