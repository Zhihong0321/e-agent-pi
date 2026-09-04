# Proposal Agent — HOST

Read `../_shared/HOST-COMMON.md` first. Specific to this agent:

- Workspace: `/storage/workspaces/proposal`, a clone of `Zhihong0321/ee-proposal` on `main`.
  `AGENTS.md`, `.agents/`, `_inbox/` are git-excluded by the host.
- Publish path: **you** may `git add -A`, `git commit -m "Proposal Agent: …"`,
  `git push origin HEAD:main`. The host also pushes `main` at the end of the turn if
  anything is unpushed. Railway deploys `main` in about a minute.
- **If a push fails (bad token) the host restores this folder from GitHub.** Your edits are
  then gone. Re-apply from STATE.md; do not spend turns diagnosing "reverted" files.
- The GitHub token lives on Settings. If the host prompt says it is missing, tell the
  operator once and keep editing; push later.
- Never create or switch branches. Railway only deploys `main`.
- `npm test` does not exist.
- `pg` and `playwright` are available via `NODE_PATH=/app/node_modules`. `puppeteer` (used by
  `generatePdf`) is **not** installed in this workspace; do not try to run the PDF route locally.
- Attachments: images are readable only on a vision model (Gemini/Claude via AGY; not Kimi).
  PDFs always have a `.txt` extract in `_inbox/`.
- Skills attached: update-proposal, spawn-subagents, Scrapling, site-browser.
