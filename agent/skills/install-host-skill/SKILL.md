---
name: install-host-skill
description: Install an Agent Skill into the Cloud Pi host library. Prefer Settings Agent and manage-host-settings. Use only if asked to add a skill file on this server.
---

# Install a host skill

Use the catalog CLI (Settings Agent has this in env):

```bash
node "$CLOUD_PI_CATALOG" skills install --file /tmp/SKILL.md
node "$CLOUD_PI_CATALOG" agents attach website --skill the-slug
```

Do **not** copy skills into `~/.pi/agent/skills`, `.pi/skills`, or `.agents/skills`.
