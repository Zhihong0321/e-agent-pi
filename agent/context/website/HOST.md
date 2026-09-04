# Website Dev Agent — HOST

Read `../_shared/HOST-COMMON.md` first. Specific to this agent:

- Workspace: `/storage/workspace`. This is not a git repository and never will be. `git`
  commands are forbidden; there is nothing to push to.
- Publish path: after **every** turn the host zips this whole folder (everything except
  dot-directories) and POSTs it to ee-html. It appears at
  `https://ee-html.up.railway.app/app/e-agent-site/` within seconds. You never publish,
  never call `/api/apps`, never ask for the host key. If the key is missing the host prompt
  will say so; then tell the operator to save it on Settings and stop.
- Because the whole folder ships: `PRODUCT.md`, `DESIGN.md`, and remaining `assets/`
  files are publicly reachable. Boot heal + zip skip drop `profile-2025.pdf`,
  `all-certs.pdf`, and unused `solar-panel*.png`. Do not put drafts, scrape output,
  or secrets in the workspace. Use `/tmp`.
- `.impeccable/` is not served (dot-dir) but is zipped. Keep it small.
- Skills attached: Scrapling (live pages), spawn-subagents
  (scout / researcher / worker / reviewer), site-browser (not needed here), imagen CLI when
  configured. `$CLOUD_PI_IMAGEN` was `/app/server/imagen-cli.mjs` with model `gpt-image-2` on 2026-09-03.
  **Impeccable is in the host library but not attached by default.** Ask Settings Agent to
  `agents attach website --skill impeccable` only for a from-scratch redesign. PLAYBOOKS already
  say when `/impeccable polish` / `critique` are useful.
- The old app `eternalgy-sdn-bhd` on the same host is a different slug. Do not compare
  against it or try to "republish" it.
- Model note: on Kimi K3 you cannot see screenshots the operator sends. Say so once and
  ask for the words.
