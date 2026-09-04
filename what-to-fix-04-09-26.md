# What to fix — 2026-09-04

Findings from a full read of the agent chat logs, the host code, and each agent's project.
Written for an implementing agent. Every item says **where**, **what**, **how**, **verify**.
Do them in the order listed inside each section; sections are independent.

Context you need first:
- [agent/AGENT_BLUEPRINT.md](agent/AGENT_BLUEPRINT.md) — the SOP these fixes implement.
- [agent/context/README.md](agent/context/README.md) — the per-agent context packs (written, not wired).
- Deploy: local `main` → `git push origin main:railway`. Railway builds the Dockerfile; several minutes.
- Live checks: `https://e-agent.up.railway.app/api/health`, `/api/debug`, `/api/sessions`, `/api/messages?sessionId=`.

---

## A. Host (this repo) — wiring and guards

### A1. Wire the context packs into the prompt  — **priority 1**
- **Where:** [server/runtime.mjs](server/runtime.mjs) `materializeAgentRuntime()` (Pi) and [server/agy-stream.mjs](server/agy-stream.mjs) `materializeAgyWorkspace()` (AGY). Both build `role + extras`.
- **What:** after the role text, append, each only if the file exists:
  `agent/context/_shared/HOST-COMMON.md`, then `agent/context/<slug>/HOST.md`, `PROJECT.md`, `CODEMAP.md`, `PLAYBOOKS.md`, `STATE.md`.
  Slug mapping: agent id `ops` → folder `settings`; otherwise `agent.slug`.
- **How:** one helper in a new `server/context-pack.mjs`: `loadContextPack(agent) → string`. Read with `readFile(...).catch(() => "")`. Join with `\n\n`. Call it from both materialize functions so Pi's `ROLE.md` and AGY's `AGENTS.md` get identical text.
- **Also:** `resolveAgentProfile` / `agentBundleKey` in [server/index.mjs](server/index.mjs) hashes the role text to decide whether to restart Pi. Include the pack text (or the pack files' mtimes) in that key, or a pack edit will not reach a running Pi.
- **Verify:** `GET /api/debug` (or a new `GET /api/agents/:id/context`, see A6) shows the assembled text; a new Website Dev chat answers "where is the live site and what is broken with fonts?" with zero tool calls.

### A2. Environment allowlist for agent processes  — **priority 1 (security)**
- **Where:** [server/index.mjs](server/index.mjs) `getClient()` → `new RpcClient({ env: { ...process.env, … } })` (~line 420) and [server/agy-stream.mjs](server/agy-stream.mjs) `chatAgy()` → `spawn(bin, args, { env: { ...process.env, … } })`.
- **What:** the agent child currently inherits `DATABASE_URL`, `CAVOTI_API_KEY`, `KIMI_API_KEY`, `EE_HTML_*`, `GITHUB_*`, `RAILWAY_*`. The Proposal agent on AGY connected to the studio's own Postgres with it (session `e1115bee`, 2026-09-03).
- **How:** build `agentEnv(agent)` from an allowlist: `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR`, `NODE_PATH`, `PI_*`, `CLOUD_PI_*`, `SCRAPLING_BIN`, plus per-agent grants: `PG_PROXY_TOKEN` only for `package`; `GITHUB_TOKEN`-style values are not needed by the agent (the host pushes; the Proposal clone's remote should carry credentials via the host's git config or an askpass helper, not env). Pi model keys go into the per-agent `models.json` the host already writes, not env. AGY needs `HOME` so it finds `~/.gemini`.
- **Verify:** in a Website Dev chat run `env | grep -ci "database_url\|api_key"` → 0. Package Updater still sees `PG_PROXY_TOKEN`. Proposal push still works (host-side push path).

### A3. Auto-continue when a turn ends without a result  — **priority 1**
- **Where:** [server/index.mjs](server/index.mjs) `/api/chat` handler, after `turn` resolves (both engines).
- **What:** ~10 of ~28 user messages in the logs were "continue", "retry", "go", "so? you done or what?". Turns ended with text like "Let me read the i18n logic…" or with a tool call and no text.
- **How:** if `turn.text.trim()` is empty, or matches `/^(let me|i('| wi)ll|next,? i)/i` and ends without a question mark, and the turn made ≥1 tool call, send one follow-up message `"Continue. Finish the task and end with a result or one question."` on the same session, at most **2** times per user message. Persist the follow-up as an assistant continuation (not as a user message) so the transcript stays clean; stream it on the same SSE response.
- **Verify:** re-run the redesign prompt from session `bef60f28` ("i want a redesign… use your design skill"); the user should never need to type "continue".

### A4. Restart recovery message carries state  — **priority 2**
- **Where:** wherever the host injects `"The previous turn was cut off by a host restart. Continue the same task…"` (grep that string in `server/`).
- **What:** on AGY the agent spent ~20 tool calls reading its own 288 KB brain transcript to recover.
- **How:** append to that message: `git status --short` + `git diff --stat` (git workspaces) or `ls -lt | head -20` (others), and the tail of `agent/context/<slug>/STATE.md`. Tell it explicitly: "Do not read transcript logs."
- **Verify:** kill the container mid-turn on a Proposal task; the continuation turn's first tool call is an edit or a `git diff`, not `list_dir /root/.gemini`.

### A5. STATE.md journal written by the host  — **priority 2**
- **Where:** end of `/api/chat` turn, after publish/push.
- **What:** append one entry to `agent/context/<slug>/STATE.md` **in the runtime copy** (not the repo): date, session id, files changed (`git diff --stat HEAD~1` for git workspaces; mtime scan since turn start for others), first 200 chars of the assistant's final text, push SHA / publish result. Keep the last 10 entries under `## Recent changes`; leave `## Open issues` untouched (human-edited).
- **How:** store the journal at `/storage/runtime/<agent-id>/STATE.md`; A1 reads that file when present and falls back to the repo seed.
- **Verify:** after two chats the runtime STATE.md has two entries and the next chat's prompt contains them.

### A6. Context preview + per-turn metrics  — **priority 2**
- **Where:** [server/index.mjs](server/index.mjs) routes; [server/debug.mjs](server/debug.mjs) / [server/metrics.mjs](server/metrics.mjs).
- **What:** `GET /api/agents/:id/context` → `{ text, tokensApprox, parts:[{file, bytes}], missingFiles }` where `missingFiles` lists CODEMAP paths (`file:line` patterns) that no longer exist in the workspace. Per turn, log to `debug_events`: `toolCalls`, `callsBeforeFirstEdit` (first `edit`/`write`/`replace_file_content`), `autoContinues`, `endedWithoutText`.
- **Verify:** `/api/agents/proposal/context` returns ~5k tokens; `/api/debug` shows the counters after a chat.

### A7. New agents must not share the Website workspace  — **priority 2**
- **Where:** [server/paths.mjs](server/paths.mjs) `agentWorkspace()` falls through to `WORKSPACE` (`/storage/workspace`) for unknown agents.
- **How:** default to `path.join(WORKSPACES_DIR, slug)` for any agent that is not `website`/`ops`; `mkdir` it in boot next to the newpages/package mkdirs in [server/index.mjs](server/index.mjs) (~line 894). Keep `ops` on the website workspace only if you decide Settings Agent needs uploads there; otherwise give it `/storage/workspaces/settings`.
- **Verify:** `agents create --name Test` via the catalog CLI, chat once, `ls /storage/workspaces/` shows the new folder and `/storage/workspace` is untouched.

### A8. Model-aware vision line  — **priority 3**
- **Where:** A1's helper.
- **What:** append `- This model CANNOT see images. Ask for the text or the values.` when the session model is `kimi-k3` (or any model without vision in `agent/model-catalog.json`; add a `vision: boolean` field there), else `- This model can read images you attach.` Remove the unconditional "Images are also passed as vision input" claim from [agent/roles/proposal.md](agent/roles/proposal.md).
- **Verify:** Proposal chat on Kimi with a screenshot replies in one line that it cannot see it and asks for the values (session `36ca6eed` showed the dead end).

### A9. Trim the role files to rules only  — **priority 3**
- **Where:** [agent/ROLE.md](agent/ROLE.md), [agent/roles/proposal.md](agent/roles/proposal.md), [agent/roles/settings.md](agent/roles/settings.md), [agent/roles/newpages.md](agent/roles/newpages.md).
- **What:** once A1 ships, the packs carry the knowledge; the role files should keep identity, scope, hard rules, git policy, reply format, turn discipline (≈300 tokens). Do **not** trim [agent/roles/package.md](agent/roles/package.md); its schema/recipes are the pack for that agent.
- **Verify:** `GET /api/agents/website/context` total stays ≤ 6k tokens.

### A10. Impeccable only on request  — **priority 3**
- **Where:** [server/impeccable.mjs](server/impeccable.mjs) attaches Impeccable to Website Dev on every boot.
- **What:** the init/comp/concept-seed flow burned 3 turns with 0 edits on Kimi (session `bef60f28`). `PRODUCT.md`/`DESIGN.md` already exist.
- **How:** keep it installed in the library; stop auto-attaching on boot; the website PLAYBOOKS already say when to use `polish`/`critique`. Attach via Settings Agent when a from-scratch redesign is wanted.
- **Verify:** `agents get website` no longer lists `impeccable` after a redeploy; the pack's redesign playbook still works without it.

---

## B. Website workspace (`/storage/workspace`, published to ee-html)

Do these through a Website Dev Agent chat once A1 is live, or by hand via `/api/files/raw`.

### B1. Fonts 404 on the live site  — **priority 1**
- **Where:** `styles.css` lines 1–240, 30 `@font-face` rules, `src: url("../assets/fonts/…")`.
- **What:** from `/app/e-agent-site/styles.css` that resolves to `/app/assets/fonts/…` → HTTP 404 (verified 2026-09-04). The site renders in system fonts.
- **How:** replace `url("../assets/fonts/` → `url("assets/fonts/` (all 30).
- **Verify:** `grep -c '\.\./assets/fonts' styles.css` → 0; after publish, the network panel loads `/app/e-agent-site/assets/fonts/Saira-700-n-0000.woff2` with `font/woff2`.

### B2. Remove stray files  — **priority 2**
- `README.md` (invented Railway/Dockerfile deploy steps), `Dockerfile`, `.dockerignore` — written by a confused session on 2026-09-03; unused by the host; README is publicly served.
- **Verify:** `ls` shows none of the three; live `…/e-agent-site/README.md` → 404 (or index fallback).

### B3. Placeholder phone number  — **operator decision**
- `012-345 6789` at `index.html` lines 22 (JSON-LD), 620, 628-629, 664 came from a test request "0123456789". Ask the operator for the real number or remove all four.

### B4. Company identity conflict  — **operator decision**
- Website: reg `202301029164 (1523087-A)`, `pr@eternalgy.me`, no address.
- Proposal quotation templates: reg `202201018137`, "No. 8, Jalan Pulai Perdana 11, Taman Sri Pulai Perdana, 81300 Skudai, Johor", `info@eternalgy.com`.
- Decide which is right; then fix the other side (see C6).

### B5. 16 MB PDF ships with every publish  — **priority 3**
- `assets/certs/profile-2025.pdf` (16 MB) plus ~15 MB of other cert PNG/PDFs. Nothing on the page links to them. Either link them from the register rows or move them out of the workspace.

### B6. Leftover Impeccable comp round  — **priority 3**
- `.impeccable/build/state.json` shows an open comp round from the abandoned 2026-09-03 redesign. Reset it (`node <impeccable>/scripts/build-phase.mjs reset` or delete `.impeccable/build/`) so a future `/impeccable` command does not resume it.

### B7. Two unused generated images  — **priority 3**
- `assets/solar-panel.png` (2.6 MB), `assets/solar-panel-2.png` (1.8 MB). Place one or delete both.

---

## C. Proposal repo (`Zhihong0321/ee-proposal`, cloned at `/storage/workspaces/proposal`)

Make these as normal commits on `main` (Railway deploys). Line numbers are from `fb253a1`.

### C1. Single source for the defaults  — **priority 1 (biggest agent-time saver)**
- **Where:** `invoice-data.js` :4-8 and `pdf-generator.js` :145-149 define the same five defaults; `pdf-generator.js` also repeats the quotation warranty strings twice (:388-394 and :569-575); `proposal.html` `renderWarranty` :1114-1119 and `quotation.html` :606-624 / :693-696 hardcode the Installation and MSIG lines again.
- **How:** add `defaults.js` exporting `{ PANEL_MODEL, PANEL_WARRANTY, INVERTER_MODEL, INVERTER_WARRANTY, MOUNTING_WARRANTY, INSTALLATION_WARRANTY_LINES, INSURANCE_LINE, QUOTATION_VALID_DAYS }` in a form both the browser (`<script src="./defaults.js">` setting `window.EternalgyDefaults`) and Node (`module.exports`) can read (UMD-style guard). Replace every literal above with a reference. Keep `page-i18n.js` :192-202 as the EN→ZH map but generate the quotation labels from the same list.
- **Verify:** `grep -rn "Mounting Structure Warranty" --include=*.js --include=*.html . | grep -v node_modules` lists only `defaults.js`, `page-i18n.js`, and the PDF templates; render check in [agent/context/proposal/PLAYBOOKS.md](agent/context/proposal/PLAYBOOKS.md) § Verify shows the same lines in EN and ZH.

### C2. Delete the four dead PDF templates  — **priority 2**
- `html_to_pdf/proposal-pdf.html` (= `-en`), `marcap-pdf.html` (= `-en`), `tiger-neo3-pdf.html` (stale), `why-eternalgy-pdf.html` (ZH content with Latin fonts). `pdf-generator.js` :415-419 loads only `-en`/`-zh` and the two quotation files.
- **Verify:** `grep -rn "pdf\.html" *.js` shows no reference to the deleted names; `generateQuotationHtml` still works.

### C3. Remove tracked screenshots and dev leftovers  — **priority 2**
- 26 root-level PNGs (`marcap-*.png`, `quotation-mobile*.png`, `shipment-mobile-*.png`, `stock-mobile-canvas.png`; ~3.3 MB), `test-language-switch.html`, `eternalgy-design-2/` (documentation-only, references a missing `public/domestic-v4.html`). Keep `msig_logo.png`.
- Add `*.png` at root to `.gitignore` or move real assets under `image/`.

### C4. Fix or delete `tests/static-smoke.test.js`  — **priority 2**
- Fails at :118 (`index.html must include inline CSS`) because `index.html` is now a redirect stub; it describes the old landing page (black/blue theme, single inline script). Either rewrite it against `tiger-neo3.html` + the shell, or delete it. Add a `"test"` script to `package.json` only if it passes.

### C5. Marcap PDF numbers are hardcoded  — **priority 3**
- `pdf-generator.js` :406-412 (`~USD 2.8B`, `~$24.50`, `+2.3%`). Either fetch the same TradingView endpoint `marcap.html` :1284 uses (with the fallback quote at :1055) or label the PDF figures "snapshot".

### C6. Company identity in quotation templates  — **after B4**
- `html_to_pdf/quotation-pdf.html` :610, :615-619, :653-654, :847 and `quotation-standalone.html` :512-515, :550-551. Apply whatever B4 decides.

### C7. `/api/sql` accepts arbitrary SQL from the browser  — **priority 2 (security, maintainer)**
- `server.js` :213-237 passes any `sql` string through `pool.query` with the server's `DATABASE_URL`. The pages only need the three queries in `invoice-data.js` (:306 invoice+package+template join, :157 products, :175 customer, :195 agent).
- **How:** replace with named queries: `POST /api/query { name: "invoice"|"products"|"customer"|"agent", params }` and a server-side map; keep the response shape `{ rows }`. Update `invoice-data.js` `runSql` callers and `pdf-generator.js` (server side can call the map directly).
- **Verify:** `curl -X POST …/api/sql -d '{"sql":"select 1"}'` → 404; `shell.html?uid=<real invoice>` still renders live data and GEN HTML still downloads.

### C8. Unused assets  — **priority 3**
- `image/*.png` originals (webp versions in `image/processed/` are live), `image/Eternalgy-Cert-CIDB.png` (saved 2026-09-03, never referenced), `logo/Jinko_Solar_logo.svg`, `logo/SAJ-LOGO.jpg`. Delete or reference.

### C9. `native-nav.js` is legacy  — **priority 3**
- Not loaded by any shell page (nav lives inline in `shell.html`). Delete, or note it in CODEMAP as dead. Its page-label list duplicates `shell.html` :186.

---

## D. Package Updater — nothing to fix in code

- Only failure mode in the logs: `$PG_PROXY_TOKEN` unset (sessions `42941439`). Save it on Settings → Keys. After A2 make sure the token still reaches the `package` agent and only that agent.
- Optional: re-verify counts in [agent/context/package/PROJECT.md](agent/context/package/PROJECT.md) with one SELECT; they are from 2026-09-03.

## E. NEWPAGES — nothing to fix in code

- Chat logs contain the merchant password pasted by the operator during CLI development (sessions `0c8b5a97`, `230c1d4d`, `3db793e8`). Rotate that password once and consider deleting those four test sessions from `sessions`/`messages`.

---

## Order I would do it in

1. A2 (env allowlist) and B1 (fonts) — an hour, both visible.
2. A1 + A8 (wire packs, vision line), then A9 (trim roles). Deploy. Re-run the acceptance probes in AGENT_BLUEPRINT § 7 for Website and Proposal and record numbers.
3. A3 (auto-continue), A4/A5 (recovery + journal).
4. C1, C2, C3, C4, C7 in one proposal PR.
5. A6, A7, A10, and the priority-3 items.

Open operator decisions before touching them: B3 (phone), B4/C6 (company identity), B5 (public cert PDFs).
