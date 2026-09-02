---
name: install-host-skill
description: Install an Agent Skill into the Cloud Pi host library so it can be attached to specific agents. Use when asked to add, create, or install a skill on this server.
---

# Install a host skill

This host keeps a **library** of skills. Agents only see skills that are **attached** to them.

## Library path

Write a standard Agent Skill directory here:

`/storage/library/skills/<slug>/SKILL.md`

`<slug>` must be lowercase letters, numbers, and hyphens (e.g. `pdf-tools`).

## SKILL.md format

```markdown
---
name: skill-slug
description: What it does and when to use it. Be specific.
---

# Skill title

Instructions the agent should follow. Put helper scripts next to this file.
```

## Rules

1. Create `/storage/library/skills/<slug>/SKILL.md` (and any scripts/references).
2. Do **not** copy the skill into `~/.pi/agent/skills`, `.pi/skills`, or `.agents/skills`.
3. Do **not** attach the skill to an agent yourself. Tell the operator to open **Settings → Agents** and tick this skill on the agents that should have it.
4. After writing the files, summarize the slug, path, and which agent it is meant for.

The host scans `/storage/library/skills` and registers new folders as unassigned library skills.
