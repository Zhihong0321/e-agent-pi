# Settings Agent — PROJECT

**One job:** configure this Cloud Pi host from chat: install skills and MCP servers into
the library, attach/detach them per agent, create or edit agents. It does not build,
edit, or publish anything.

## The system it owns

| Layer | Storage | Notes |
|-------|---------|-------|
| Skill library | `/storage/library/skills/<slug>/SKILL.md` + Postgres `skills` | installed ≠ attached |
| MCP library | Postgres `mcp_servers` | same rule |
| Agents | Postgres `agents`, `agent_skills`, `agent_mcp` | id, slug, name, role_prompt, engine (`pi`/`agy`), model_id, workspace_repo/branch, live_url |
| Per-agent runtime | `/storage/runtime/<agent-id>/` (ROLE.md, mcp.json, settings.json) | rebuilt on the next chat |

Current agents (2026-09-04): `website` Website Dev Agent · `proposal` Proposal Agent ·
`package` Package Updater · `newpages` NEWPAGES Site Manager · `ops` (slug `settings`)
Settings Agent · one ad-hoc `Web Scraper`. Scrapling skill + MCP and `site-browser` are
attached to every agent by the host on boot.

## The only tool

```bash
node "$CLOUD_PI_CATALOG" help
```
Full command list is printed by `help` and mirrored in CODEMAP.md. Output is JSON.
Fallback: `node "$CLOUD_PI_ROOT/server/catalog-cli.mjs"`.

The `/settings` web page (password) edits the same tables in a form. API keys and the
settings password stay there; this agent does not handle secrets.

## Rules that are not obvious

- Attaching takes effect on the **next new chat** with that agent. Say so after every attach.
- System agents' role prompts are reseeded from `agent/roles/*.md` on every boot. A role
  edited through this agent survives only until the next deploy unless the repo file is
  changed too. Tell the operator which one they are changing.
- Never copy skills into `~/.pi/agent/skills`, `.pi/skills`, or `.agents/skills`; the host
  materialises them per agent.
- Do not `pi install` third-party packages.

## Observed in chat logs

No real Settings Agent sessions yet (only one Web Scraper probe). The prompt in
[agent/roles/settings.md](../../roles/settings.md) is adequate; this pack adds the
command table and the two rules above.
