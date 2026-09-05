# Website Studio (Pi agent)

Cloud app for Railway. Users chat with named **Agents**. Each agent is a Role (prompt) plus the Skills and MCP servers attached to it. Pi **Website Dev Agent** edits a volume workspace (static HTML/CSS/JS). The **host** zips that workspace and publishes it to [ee-html](https://ee-html.up.railway.app/) (`/app/<slug>/`). The agent must not git-commit or call the host API.

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
- After file edits, the **host** zips the workspace and publishes to ee-html; the agent must not git-commit, deploy, or call the host API.
- **Proposal Agent** is the exception: it edits a separate clone of `Zhihong0321/ee-proposal`. The host commits and pushes; Railway deploys the live proposal. The agent still must not run git itself.
- **Package Updater** maintains `package` / `package_item` / `product` in `prod_main` through the Postgres proxy. It does not publish a site.
- Live site (Website Dev Agent): `https://ee-html.up.railway.app/app/<slug>/` (default slug `e-agent-site`)
- Live site (Proposal Agent): `https://ee-proposal-production.up.railway.app/shell.html#proposal`

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
- If `spawn-subagents` is attached, also `--extension agent/extensions/subagents.ts` (in-process `spawn_subagent` tool). Children share the workspace, cannot nest, and cap at three running
- `PI_CODING_AGENT_DIR=/storage/runtime/<agent-id>` so Pi does not read the shared `/storage/pi` skill/MCP dirs

Install **does not** attach. A skill written to the library stays unused until it is attached to an agent.

### Who can install

1. **Settings page** (password): `/settings#skills`, `/settings#mcp`, then `/settings#agents` to attach.
2. **Settings Agent** (chat): has `manage-host-settings`. It runs `node $CLOUD_PI_CATALOG` on the host — install skills/MCP **and** attach them to a chosen agent. Website Dev Agent does not get this skill.

After attach, the next chat with that agent restarts Pi with the new bundle.

Website Dev Agent is seeded with **Scrapling** (skill + MCP) for live page fetches and **spawn-subagents**. **Impeccable** is installed into the library on boot but **not** auto-attached; attach it via Settings Agent for a from-scratch redesign. **Proposal Agent** is seeded with `update-proposal` + spawn-subagents. It clones [Zhihong0321/ee-proposal](https://github.com/Zhihong0321/ee-proposal) into `/storage/workspaces/proposal`, edits from text/image/PDF, and the host git-pushes so Railway deploys https://ee-proposal-production.up.railway.app/shell.html#proposal. **Scrapling is default on every agent**, including Settings Agent. Boot always reloads Website Dev Agent's role from `agent/ROLE.md` so the git/GitHub ban and ee-html rules actually apply (Postgres used to keep the first seed forever).

On boot the host runs `npx impeccable install --providers=pi --scope=project` in a staging directory and copies `.pi/skills/impeccable` into `/storage/library/skills/impeccable`. It does **not** attach it to Website Dev Agent and does **not** install into the GitHub workspace.

`/impeccable init` writes `PRODUCT.md` (and later `DESIGN.md`) in the workspace; those files *are* site artifacts and should sync. Refresh the pack with Settings Agent: `node $CLOUD_PI_CATALOG skills install-impeccable --force`.

On boot the host also downloads the official Scrapling Agent Skill zip into `/storage/library/skills/scrapling-official`, registers the `scrapling` MCP server (`/opt/scrapling/bin/scrapling mcp`), and attaches both to **every** agent. New agents get the same grant. The Docker image installs Python, `scrapling[all]`, and Chromium. Refresh with `node $CLOUD_PI_CATALOG skills install-scrapling --force`.

### Settings vs studio

- Studio lists agents and chats with the selected one. **Settings Agent** can install and attach from chat.
- `/settings` (password) is the same catalog in a form UI (keys stay here).

## Volume layout

| Path | Purpose |
|------|---------|
| `/storage/workspace` | Pi cwd for Website Dev Agent (site files) |
| `/storage/workspaces/<slug>` | Pi cwd for every other agent (unknown slugs included; ops → `settings`) |
| `/storage/workspaces/proposal` | Pi cwd for Proposal Agent (`ee-proposal` clone) |
| `/storage/storage` | Pi session dir |
| `/storage/pi` | Shared Pi models.json |
| `/storage/library/skills` | Host skill library (install target) |
| `/storage/browser/profiles` | Persistent Chromium profiles (site logins) |
| `/storage/runtime/<agent-id>` | Per-agent Pi dir (role, mcp.json, settings) |

## Code map

| Path | Purpose |
|------|---------|
| `app/page.tsx` | Studio UI (pick an agent, chat) |
| `app/settings.tsx` | Password-gated keys, agents, skills, MCP |
| `src/main.tsx` | `/settings` vs studio |
| `agent/AGENT_BLUEPRINT.md` | SOP for adding an agent: charter, workspace, capabilities, context pack, acceptance test |
| `agent/context/<slug>/` | Per-agent context packs; wired by `server/context-pack.mjs` into Pi ROLE.md and AGY AGENTS.md |
| `server/context-pack.mjs` | Load pack, vision line, auto-continue, recovery snapshot, STATE.md journal |
| `server/agent-env.mjs` | Allowlisted env for agent child processes |
| `agent/ROLE.md` | Seed prompt for Website Dev Agent |
| `agent/roles/proposal.md` | Seed prompt for Proposal Agent |
| `agent/roles/package.md` | Seed prompt for Package Updater (prod_main catalog) |
| `agent/roles/settings.md` | Seed prompt for Settings Agent |
| `agent/skills/` | Bundled skills copied into the host library on boot |
| `server/catalog-cli.mjs` | Chat-side catalog CLI (`CLOUD_PI_CATALOG`) |
| `server/package-sheet.mjs` | Package Price Center Google Sheet CSV pull + parse |
| `server/package-sheet-cli.mjs` | Package Updater CLI (`CLOUD_PI_PACKAGE_SHEET`) |
| `agent/model-catalog.json` | Luna + Kimi + GLM 5.3 + OpenCode GO (GLM 5.3 Flash, Qwen 3.8 Flash, DeepSeek V4 Flash Vision) + Hive AI (GLM 5.3 Flash) catalog |
| `server/catalog.mjs` | `agents`, `skills`, `mcp_servers`, attachments |
| `server/impeccable.mjs` | Official Impeccable Pi skill → library + Website Dev Agent |
| `server/scrapling.mjs` | Official Scrapling skill zip + MCP → library + every agent |
| `server/sites.mjs` | Per-site username/password + persistent headless login |
| `server/newpages.mjs` | NEWPAGES merchant news CRUD (first site automation) |
| `server/runtime.mjs` | Per-agent Pi dir + `--no-skills --skill` args + optional subagent extension |
| `agent/extensions/subagents.ts` | In-process `spawn_subagent` for Cloud Pi (not a third-party npm package) |
| `agent/skills/spawn-subagents/` | Skill that teaches when to delegate; attaching it also loads the extension |
| `server/db.mjs` | `settings`, `sessions`, `messages`, `git_syncs`, `debug_events` |
| `server/index.mjs` | HTTP: `dist/` + `/api/*` (agents, skills, MCP, chat, git, health) |
| `server/pi-stream.mjs` | Pi RPC events → live chat transcript |
| `server/secrets.mjs` | Keys from Postgres |
| `server/auth.mjs` | Settings session cookie |
| `server/ee-html.mjs` | Zip workspace and POST to the HTML host engine |
| `server/github.mjs` | Optional GitHub clone (not used for publishing) |
| `server/models.mjs` | Model availability from DB keys |

## Open

1. Add the HTML host API key on `/settings` (or Railway `EE_HTML_API_KEY`). Saving keys or clicking **Publish workspace now** posts the zip to ee-html; Website Dev Agent chats do the same.
2. Push/deploy **`railway`**, not `main`.
3. Railway CLI on the Windows machine was blocked by Defender; debug via `/api/health` and `/api/debug`.
