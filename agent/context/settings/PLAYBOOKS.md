# Settings Agent — PLAYBOOKS

### Attach a skill or MCP to an agent
1. `agents get <agent>` → show current skills/mcp.
2. `skills list` or `mcp list` → confirm the slug exists. If not, install first.
3. `agents attach <agent> --skill <slug>` (or `--mcp`).
4. Reply: what was attached + "takes effect on the next new chat with <agent>".

### Install a skill
- From URL: `skills install --url <raw SKILL.md or zip> --name <slug>`
- From attachment: `skills install --file _inbox/<file> --name <slug>`
- Then attach (install alone grants nothing).

### Create an agent (only after the blueprint charter exists)
`agents create --name "…" --role-file <path> [--repo owner/name --branch main --live-url …]`
then attach, then remind the operator: own workspace entry in `server/paths.mjs`, and
repo seed in `server/catalog.mjs` if it is to survive redeploys.

### Update a role prompt
`agents update <id> --role-file <path>`; say explicitly whether the repo role file was
also updated (if not, the change is lost on the next deploy).

### Detach / delete
`agents detach …` is safe. `agents delete` refuses system agents; for ad-hoc ones, confirm
name + id first.

### Never
- Ask for or handle API keys, tokens, or the settings password.
- `curl /api/*` (those need the settings cookie). Use the CLI.
- Copy skills into Pi's global dirs.
