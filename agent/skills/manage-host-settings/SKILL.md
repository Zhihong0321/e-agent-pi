---
name: manage-host-settings
description: Install skills and MCP on this Cloud Pi host and attach them to specific agents. Use when asked to add a skill, add MCP, grant a tool to an agent, or change an agent's role.
---

# Manage host settings from chat

This skill is for **Settings Agent** only. Do not attach it to Website Dev Agent.

The catalog CLI is `node "$CLOUD_PI_CATALOG"`. Always print JSON. Parse `ok` before telling the user it worked.

## Mental model

1. **Install** = library (everyone can *see it in Settings*; no agent can *use* it yet)
2. **Attach** = tick it on one agent
3. Next chat with that agent restarts Pi with only that agent's role + skills + MCP

## List what exists

```bash
node "$CLOUD_PI_CATALOG" agents list
node "$CLOUD_PI_CATALOG" skills list
node "$CLOUD_PI_CATALOG" mcp list
node "$CLOUD_PI_CATALOG" agents get website
```

Agents are referred to by `id` or `slug` (`website`, `ops` / Settings Agent, or a name you created).

## Install a skill

From pasted markdown (write a temp file in `/tmp` first if it is long):

```bash
node "$CLOUD_PI_CATALOG" skills install --file /tmp/SKILL.md
```

From a raw SKILL.md URL:

```bash
node "$CLOUD_PI_CATALOG" skills install --url "https://raw.githubusercontent.com/org/repo/main/SKILL.md"
```

That only **installs**. Then attach:

```bash
node "$CLOUD_PI_CATALOG" agents attach website --skill the-skill-slug
```

Detach:

```bash
node "$CLOUD_PI_CATALOG" agents detach website --skill the-skill-slug
```

Repeat `--skill` / `--mcp` to change several at once.

## Install MCP

```bash
node "$CLOUD_PI_CATALOG" mcp add \
  --name github \
  --command npx \
  --args "-y @modelcontextprotocol/server-github" \
  --env '{"GITHUB_TOKEN":"..."}' \
  --description "GitHub issues and repos"
```

HTTP MCP:

```bash
node "$CLOUD_PI_CATALOG" mcp add --name docs --url "https://example.com/mcp" --description "Docs search"
```

Then attach:

```bash
node "$CLOUD_PI_CATALOG" agents attach website --mcp github
```

Do not echo env secrets back in chat unless the operator asks.

## Agents and roles

```bash
node "$CLOUD_PI_CATALOG" agents create --name "Docs Agent" --short D --color blue --role-file /tmp/ROLE.md
node "$CLOUD_PI_CATALOG" agents update website --role-file /tmp/ROLE.md
```

`--role` can pass the prompt inline for short roles.

Do **not** attach `manage-host-settings` to other agents. Keep Settings Agent as the only one that can change the catalog.

## After a change

Say what you installed, which agent it is attached to, and that the **next message** in that agent's chat loads it. Do not claim it is live in the current Website Dev Agent turn.
