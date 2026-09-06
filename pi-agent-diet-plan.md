# Task: slim every Pi agent's fixed per-turn context

You are working in `E:\000\UIv2` (Node server that launches `@earendil-works/pi-coding-agent` 0.84.4 per agent, deployed on Railway via `git push origin main:railway`). Other sessions edit this worktree concurrently: never `git stash`, `checkout`, or `reset` files you did not touch. Commit only the files you changed.

## Why

Pi's own harness is already small. Measured on this install:

| Source | ~tokens per turn |
|---|---|
| Pi default coding system prompt | 400 |
| Pi built-in tools read/bash/edit/write | 630 |
| Host reply-style block (`server/reply-style.mjs`) | 210 |
| Role prompt `agent/roles/sales.md` (26 KB) | 6,600 |
| Role prompt `agent/roles/package.md` (14.7 KB) | 3,700 |
| Context pack, proposal | 6,000 |
| Context pack, website | 5,000 |
| Context pack, package | 4,300 |
| Context pack, newpages | 3,200 |
| Context pack, settings | 2,400 |

The role prompts and context packs are 3x to 13x the Pi harness. Do not fork or rebuild Pi. Use its existing CLI flags and move always-on prose into on-demand skills.

## Where things live

- `server/runtime.mjs` — `materializeAgentRuntime()` writes `ROLE.md` (role prompt + reply style + imagen + context pack) into `RUNTIME_DIR/<slot>`; `buildPiArgs()` builds the Pi CLI args (`--append-system-prompt ROLE.md`, `--no-skills`, `--no-extensions`, `--skill <dir>` per attached skill, `--extension` for MCP adapter / subagents).
- `server/index.mjs` ~L660-L720 — `refreshSlotRuntime()`, `startSlotClient()`; calls the two functions above and spawns `RpcClient`.
- `server/context-pack.mjs` — `loadContextPack()` concatenates `agent/context/<slug>/{HOST,PROJECT,CODEMAP,PLAYBOOKS,STATE}.md` plus `agent/context/_shared/HOST-COMMON.md`; `previewContextPack()` reports per-part byte sizes; `contextPackFingerprint()` decides when a pack edit forces a Pi restart.
- `server/catalog.mjs` — `agents` table (`role_prompt`, `model_id`, no profile/thinking column yet), `agent_skills` join, `seedSystemAgent()` seeds the seven system agents from `agent/roles/*.md`.
- `agent/roles/*.md` — role prompts: website (default), settings, proposal, newpages, package, afa-rate, sales.
- `agent/skills/*/SKILL.md` — existing skills (install-host-skill, manage-host-settings, site-browser, spawn-subagents, update-package-catalog, update-proposal). Pi loads each skill as a one-line description in the system prompt and reads the body only when invoked.
- `agent/model-catalog.json`, `server/models.mjs` — model catalog; no thinking level anywhere yet.

Pi CLI flags available (verified with `npx pi --help`): `--system-prompt <text>` (replaces the default coding prompt), `--no-builtin-tools`, `--tools <a,b>`, `--exclude-tools <a,b>`, `--thinking off|minimal|low|medium|high|xhigh|max`, and a `:<thinking>` suffix on `--model`.

## Deliverables

### 1. Per-agent tool profile

Add a `tool_profile` column to `agents` (TEXT, default `coding`) with a migration in `server/catalog.mjs`, seed it per system agent, and expose it in the manage API / settings UI where `model_id` is already editable. Profiles:

| Profile | Pi flags | Agents |
|---|---|---|
| `coding` | default prompt, built-in read/bash/edit/write | website, proposal, newpages |
| `ops` | `--system-prompt <short non-coding prompt>` + `--tools read,bash` (no edit/write) | settings, package, afa-rate |
| `assistant` | `--system-prompt <short non-coding prompt>` + `--no-builtin-tools` (MCP tools only) | sales, once its raw `curl` fallbacks are moved out (see 2) |

Rules:
- Any agent whose attached skills shell out to host CLIs (`$CLOUD_PI_CATALOG`, `$CLOUD_PI_IMAGEN`, `$CLOUD_PI_SITES`, `$CLOUD_PI_PDF`, `$CLOUD_PI_PACKAGE_SHEET`) or to `curl` must keep `bash`. Derive this from the skill list at launch and log a warning if a profile would strip a tool a skill needs; fall back to `ops` rather than break the agent.
- The short non-coding system prompt goes in a new `server/agent-profiles.mjs` and must be under 60 words: who is reading (phone, non-technical), answer first, use MCP tools, never claim to have edited files. The existing reply-style block stays appended.
- `buildPiArgs()` takes the profile and emits the flags. Keep `--no-skills --no-extensions --no-prompt-templates` for all profiles.

### 2. Role prompts and context packs on a diet

Target: no role prompt over 3 KB, no context pack over 8 KB, measured with `previewContextPack()`.

- **sales** (`agent/roles/sales.md`, 26 KB): keep only identity, the read-only rule, the MCP-first rule, and the reply contract (paste tool HTML verbatim, fence included). Move everything else into a new skill `agent/skills/sales-reports/SKILL.md` (tool-by-tool reference, SQL fallbacks, stock API curls, edge cases). Move stock-inventory procedures into `agent/skills/stock-inventory/SKILL.md`. If the SQL/curl fallbacks are still needed after the MCP server covers every question, keep them in the skill and give sales the `ops` profile; otherwise `assistant`.
- **package / procurement** (`agent/roles/package.md`, 14.7 KB): keep identity, proxy rule, write-limiter profile, and pointers to other agents. Move the catalog schema, query recipes, and update procedures into the existing `agent/skills/update-package-catalog/SKILL.md` or a new `agent/skills/package-db-reference/SKILL.md`.
- **context packs** (`agent/context/<slug>/`): for proposal and website, shrink `PLAYBOOKS.md` to a list of playbook names with one line each and move the step-by-step bodies into a per-agent skill (`agent/skills/<slug>-playbooks/SKILL.md`). Trim `CODEMAP.md` to files the agent actually edits; `previewContextPack()` already lists CODEMAP paths missing from the workspace, delete those entries. Keep `HOST.md` and `PROJECT.md` but cut repeated material already in `_shared/HOST-COMMON.md`.
- Register every new skill in the catalog seed so it is attached to the right agent by default, and add its `--skill` path via the existing attachment flow (do not hardcode paths in `buildPiArgs`).
- Do not change agent behaviour contracts: the operator-facing rules (read-only, verbatim HTML report paste, no direct DATABASE_URL, push only to the deploy branch) must survive in the role prompt, not only in a skill.

### 3. Thinking level

- Add `thinking_level` to `agents` (TEXT, nullable). Seed: website/proposal/newpages `null` (provider default), settings/package/afa-rate `low`, sales `minimal`.
- In `buildPiArgs()`, when set, pass `--thinking <level>`. Confirm first (read `node_modules/@earendil-works/pi-coding-agent/docs/models.md`) whether the flag or the `:<level>` model suffix is honoured for non-Anthropic providers in RPC mode; if a provider rejects it, the launcher must strip it and log, not fail the spawn.
- Expose it beside `tool_profile` in the settings UI.

### 4. System prompt stable within a session

- Audit `refreshSlotRuntime()` and `runtimeInputsHash()` in `server/index.mjs`: confirm nothing time-varying (timestamps, session ids, journal tails) is written into `ROLE.md` between Pi restarts. `loadContextPack()` inlines the runtime `STATE.md` journal; make sure a journal append during a live session does not rewrite `ROLE.md` or restart Pi (the fingerprint already excludes runtime STATE, verify the hash in `index.mjs` does too).
- Move the vision line and any per-model text to the end of `ROLE.md` so the long stable prefix comes first (prompt caches are prefix-based).
- Add a `GET /api/agents/:id/prompt-size` (or extend the existing preview endpoint) returning the assembled `ROLE.md` byte count, the profile, the tool list, and the thinking level, so the effect is visible without reading logs.

## Verification

1. `node --test server/` passes; add tests for `buildPiArgs()` covering the three profiles and the skill-needs-bash fallback.
2. For each of the seven system agents, print before/after: `ROLE.md` bytes, tool names, thinking level. Put the table in your final report.
3. Start one `assistant`-profile agent and one `ops`-profile agent locally and confirm via the RPC event stream that the tool list matches and a turn completes.
4. Deploy with `git push origin main:railway`, then hit the new prompt-size endpoint on Railway for every agent and include the numbers.

Report what you changed, the size table, and anything you could not verify.
