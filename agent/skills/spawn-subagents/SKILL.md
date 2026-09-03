---
name: spawn-subagents
description: Fan independent work out to isolated in-process sub-agents (scout, researcher, worker, reviewer) on this Cloud Pi host. Use when a task splits into parallel recon, research, implementation, or review.
---

# Spawn sub-agents

This skill is paired with a host extension. Attaching it also loads `spawn_subagent`, `subagent_status`, and `stop_subagent`. Children run **in-process** (no extra Pi CLI, no tmux). They share the workspace. They cannot spawn further agents.

Do not `pi install` anything. Do not copy skills into `~/.pi/agent/skills`.

## When to spawn

- Two or more **independent** jobs (different pages, recon vs implement, implement vs review).
- A long recon that would crowd this conversation with file dumps.
- A second pair of eyes (`reviewer`) after `worker` edits.

Do **not** spawn for a tiny one-file tweak you can do in this turn.

## How

```text
spawn_subagent
  agent: scout | researcher | worker | reviewer
  description: short label
  prompt: self-contained task with paths and done-when
  run_in_background: true   # when firing more than one, or when you can keep working
```

- `scout` — read-only map of files / flow / risks.
- `researcher` — workspace + optional `scrapling` CLI for live pages. Scrape to `/tmp`.
- `worker` — edit files in the workspace.
- `reviewer` — read-only review. Does not edit.

Give each child everything it needs. It does not see this chat.

For two or more independent jobs, call `spawn_subagent` several times in one turn with `run_in_background: true`. Do not poll. A completion message arrives when each child finishes. Use `stop_subagent` with the `sa-xxxx` id to cancel.

Cap: three children running at once on this host (queued after that). Keep prompts tight.

## After they finish

Synthesize. Apply reviewer feedback yourself or with another `worker`. Then tell the human what changed and the live ee-html URL. You still do not publish; the host does.
