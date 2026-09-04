# agent/context — per-agent context packs

One folder per agent slug. These are the **knowledge** layer described in
[AGENT_BLUEPRINT.md](../AGENT_BLUEPRINT.md) § 5; the role files in `agent/roles/` remain
the **rules** layer.

| Folder | Agent | Files |
|--------|-------|-------|
| `_shared/` | all | `HOST-COMMON.md` (toolbox, env, attachments, turn discipline) |
| `website/` | Website Dev Agent | PROJECT, CODEMAP, PLAYBOOKS, HOST, STATE |
| `proposal/` | Proposal Agent | PROJECT, CODEMAP, PLAYBOOKS, HOST, STATE |
| `package/` | Package Updater | PROJECT, CODEMAP, PLAYBOOKS, HOST (recipes stay in `roles/package.md`) |
| `newpages/` | NEWPAGES Site Manager | PROJECT, PLAYBOOKS, HOST |
| `settings/` | Settings Agent | PROJECT, CODEMAP, PLAYBOOKS, HOST |

## Status

**Wired 2026-09-04.** `server/context-pack.mjs` `loadContextPack(agent)` is appended after
the role text in `server/runtime.mjs` `materializeAgentRuntime()` (Pi `ROLE.md`) and
`server/agy-stream.mjs` `materializeAgyWorkspace()` (AGY `AGENTS.md`). Order:
`_shared/HOST-COMMON.md`, `<slug>/HOST.md`, `PROJECT.md`, `CODEMAP.md`, `PLAYBOOKS.md`,
`STATE.md` (runtime copy at `/storage/runtime/<agent-id>/STATE.md` when present, else the
repo seed). Slug mapping: agent id `ops` → folder `settings`.

A model-aware vision line is appended from `agent/model-catalog.json` `vision` (and AGY ids).
`GET /api/agents/:id/context` returns the assembled text.

## Maintenance

- Line numbers in CODEMAP files are from the snapshot date in each file's header. After a
  large edit, refresh them (grep the anchors named in the table).
- STATE.md files here are seeds; once wired, the host owns them.
- Sizes (approx. tokens): website ≈ 3.5k, proposal ≈ 5k, package ≈ 2k (+3.5k role),
  newpages ≈ 1.5k, settings ≈ 1.5k, shared ≈ 0.8k.
