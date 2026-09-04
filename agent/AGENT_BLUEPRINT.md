# AGENT_BLUEPRINT.md — how to set up an agent on this host

This is the SOP for adding a new agent to the studio. Follow it in order. An agent
that skips a step is the agent that spends 200 tool calls finding its own workspace.

Agents here are **not** general coding assistants. Each one is hired for **one
project or one job**, forever. The whole point of setup is to hand it everything a
new employee would get on day one, so it never has to discover the project from
zero.

---

## 0. Principles

1. **One agent, one job, one workspace.** If a request needs two workspaces, that is
   two agents.
2. **Knowledge beats rules.** "Never run git" is a rule. "Warranty text lives in these
   8 files" is knowledge. The Package Updater works because its prompt is 90%
   knowledge. Write knowledge first, rules last.
3. **Nothing is discovered per chat that can be prepared once.** File maps, company
   facts, tool quirks, host behaviour: all prepared, all versioned in this repo.
4. **The prompt is a stable prefix.** Budget 4k to 6k tokens for the whole context
   pack. Stable text is cached; a fresh crawl of the repo every chat is not.
5. **Instrument, don't guess.** Every agent ships with an acceptance test and its
   transcripts get reviewed. If it wandered, the pack was missing something. Fix the
   pack, not the chat.

---

## 1. Definition of done

An agent is set up when all of these are true:

- [ ] Charter written (section 2) and stored at `agent/roles/<slug>.md` (top section)
- [ ] Has its **own** workspace folder on the volume; nothing shared with another agent
- [ ] Publish path decided and wired (or explicitly "no publish")
- [ ] Only the skills/MCP it needs are attached; nothing else is visible to it
- [ ] Only the env vars and credentials it needs are passed to its process
- [ ] Context pack complete: ROLE, HOST, PROJECT, CODEMAP, PLAYBOOKS, STATE (section 5)
- [ ] Registered (section 6) and visible in the studio
- [ ] Acceptance test passed with numbers recorded (section 7)
- [ ] README code map and this repo's role/seed code updated

---

## 2. Step 1 — Charter (fill this before touching code)

Copy this block into the top of `agent/roles/<slug>.md` and fill every line. Empty
lines are not allowed; write "none" if that is the answer.

```text
Name:            (human label shown in the studio)         e.g. Proposal Agent
Slug / id:       (lowercase, stable, used in paths)        e.g. proposal
One job:         (one sentence, one verb)                  e.g. Keep the Eternalgy proposal site correct and current.
Not its job:     (3 bullets naming the neighbour agents)   e.g. website HTML -> Website Dev Agent
Project:         (repo or system it owns)                  e.g. github.com/Zhihong0321/ee-proposal, branch main
Workspace:       (volume path)                             e.g. /storage/workspaces/proposal
How work goes live: (mechanism + who triggers it)          e.g. host commits + pushes main after each turn; Railway deploys
Live URL:        (what the operator opens to verify)
Inputs it gets:  (text / images / PDFs / URLs / none)
Vision needed:   (yes / no)  -> constrains model choice
Engine + model:  (pi + model id, or agy + model id)
Credentials:     (name each secret + where it is stored: Settings -> Keys / Sites)
External systems: (APIs, proxies, CLIs it must call)
Recurring tasks: (list 5 to 10; these become playbooks)
Danger zone:     (what it must never touch; what needs operator confirmation)
Owner:           (who reviews its transcripts)
```

Stop here if "One job" needs the word "and". Split the agent.

---

## 3. Step 2 — Workspace and host wiring

### 3.1 Workspace

Every agent gets its own folder under `/storage/workspaces/<slug>`. Decide which kind:

| Kind | Example | Setup |
|------|---------|-------|
| Git clone | Proposal (`ee-proposal`) | host clones on boot, host pushes after turns; set `workspace_repo` + `workspace_branch` |
| Static bundle | Website Dev | host zips + POSTs to ee-html after turns |
| Scratch only | Package Updater, NEWPAGES | folder for uploads and drafts; no publish |

Rules:
- Never reuse `/storage/workspace` (Website Dev) for a new agent.
  `agentWorkspace()` in [server/paths.mjs](../server/paths.mjs) defaults to
  `/storage/workspaces/<slug>` for anyone who is not `website`. Settings Agent
  uses `/storage/workspaces/settings`.
- `_inbox/` inside the workspace is where the host drops attachments. PDFs get a
  sibling `.txt` extract. Keep it out of git (`.git/info/exclude` or `.gitignore`).
- `AGENTS.md`, `.agents/` and any runtime files the host writes must also be
  excluded from git (the AGY path already does this).

### 3.2 Publish path

Pick exactly one and say it in HOST.md in the agent's own words:

- **ee-html zip** (`publishToHost()` in [server/index.mjs](../server/index.mjs)): only fires for Website Dev today. A second static-site agent needs its own slug and its own branch in the after-turn block.
- **git push** (`publishProposal()`): host pushes `workspace_branch`. On a failed push the host **restores the workspace from GitHub**. The agent must be told this or it will think its edits vanished (it happened).
- **none**: agent writes to an external system through a CLI or proxy (Package Updater, NEWPAGES).

### 3.3 Code touch points for a new agent

These places are per-agent by name today. Check each one when adding an agent:

| File | What to add |
|------|-------------|
| [server/paths.mjs](../server/paths.mjs) | `<SLUG>_AGENT_ID`, `<SLUG>_ROLE_FILE`, `agentWorkspace()` entry, `is<Slug>Agent()` |
| [server/catalog.mjs](../server/catalog.mjs) `seedAgentCatalog()` | `seedSystemAgent({...})` + default skill attachments; delete-guard list |
| [server/index.mjs](../server/index.mjs) | `mkdir` of the workspace on boot; `attachFallback()` text; after-turn publish branch if it publishes |
| [server/runtime.mjs](../server/runtime.mjs) + [server/agy-stream.mjs](../server/agy-stream.mjs) | extra prompt fragment if the agent needs a host-generated section (live URL, token state) |
| `README.md` | product rules, volume layout, code map rows |

Long-term fix (recommended, not done yet): make all of the above data-driven from the
`agents` row (`workspace_kind`, `publish`, `context_dir`) so a new agent is a row plus
a folder, not five code edits.

---

## 4. Step 3 — Capabilities

### 4.1 Skills and MCP

- Skills live in the host library (`/storage/library/skills/<slug>`); bundled ones
  come from `agent/skills/<slug>/SKILL.md` and are copied on boot.
- Attaching is explicit (`agent_skills`, `agent_mcp`). Unattached = invisible. Keep it
  that way. Do not attach "just in case"; every skill is prompt weight and a
  distraction path.
- Write a **new skill** only when a recipe is longer than one screen **or** shared by
  two agents. Otherwise the recipe belongs in PLAYBOOKS.md (section 5.5).
- Heavy interactive skills (Impeccable's init/comp/roll flow) burn turns on small
  models. Attach them only for the explicit task that needs them, and say in
  PLAYBOOKS which sub-commands are allowed.

### 4.2 Host CLIs available to every agent

| Env var | Purpose |
|---------|---------|
| `$CLOUD_PI_ROOT` | host repo root (`/app`) |
| `$CLOUD_PI_CATALOG` | catalog CLI (Settings Agent only should use it) |
| `$CLOUD_PI_IMAGEN` | image generation into the workspace |
| `$CLOUD_PI_SITES` | persistent headless browser + site logins |
| `$CLOUD_PI_PDF` | PDF text extract |
| `$PG_PROXY_TOKEN` | Postgres proxy token (only if saved on Settings) |

### 4.3 Environment allowlist

`server/agent-env.mjs` `agentEnv(agent)` is the allowlist: `PATH`, `HOME`, `USER`,
`LANG`, `TMPDIR`, `NODE_PATH`, `PI_*`, `CLOUD_PI_*`, `SCRAPLING_BIN`. `PG_PROXY_TOKEN`
is granted only to Package Updater. Model API keys go into the per-agent `models.json`,
not env. List any extra vars in the charter.

### 4.4 Model choice

- Needs to read screenshots → model must have vision. Kimi K3 does **not**. The prompt
  must not promise image reading the model cannot do; HOST.md gets a model-aware line.
- Small/fast models follow playbooks well and explore badly. The more you rely on a
  small model, the more complete the CODEMAP and PLAYBOOKS must be.

---

## 5. Step 4 — Context pack (the actual work)

The context pack is what the agent receives every turn. Today it is one text blob:
`role_prompt` in the DB, seeded from `agent/roles/<slug>.md`, plus host fragments
(imagen, ee-html, GitHub) appended by `materializeAgentRuntime()` / `materializeAgyWorkspace()`.

**Standard:** rules live in `agent/roles/<slug>.md` (~300 tokens). Knowledge lives in
`agent/context/<slug>/` (HOST, PROJECT, CODEMAP, PLAYBOOKS, STATE) plus
`agent/context/_shared/HOST-COMMON.md`. The host concatenates them in
`server/context-pack.mjs`. STATE.md on the volume (`/storage/runtime/<id>/STATE.md`)
is the journal; the repo file is the seed.

Budget per section (tokens, approximate):

| Section | Budget | Owner |
|---------|--------|-------|
| 5.1 ROLE | 300 | human |
| 5.2 HOST | 500 | human + host-generated lines |
| 5.3 PROJECT | 800 | human, refreshed on demand |
| 5.4 CODEMAP | 1500 | generated table + human concept index |
| 5.5 PLAYBOOKS | 1500 | human |
| 5.6 STATE | 400 | host-generated journal |

### 5.1 ROLE — identity and hard rules

- Name, the one job, the three "not your job, send to X" lines.
- Hard rules only (git policy, confirmation before writes, never print secrets).
- Reply format the studio can render (GitHub Markdown; tables for lists; no raw HTML).
- Turn discipline: **every turn ends with a result or one question. Never end on
  "Let me…".** (A third of user messages in the logs were "continue".)

### 5.2 HOST — how this host treats you

Mandatory lines, copy and adapt:

```text
- Your current directory IS the project. Do not list /, /root, /app or /storage. /app is the host app, not yours.
- After each turn the host <zips and publishes to URL | commits and pushes BRANCH | does nothing>. You never publish.
- If a push fails the host restores this folder from GitHub. Re-apply from STATE, do not panic.
- Attachments arrive in _inbox/. PDFs have a .txt extract next to them.
- Tools present: node 22 (global fetch works), git, python3 + scrapling. Absent: curl, wget, ps, ss.
- Node modules: use NODE_PATH=/app/node_modules for pg and playwright.
- This model <can | cannot> see images.   <- host injects from the selected model
- Env vars that are yours: <list>. Anything else in env is not yours; do not use it.
```

### 5.3 PROJECT — durable facts about the project

What a new hire would be told on day one and never again:

- What the product/site/system is, who it is for, the live URL(s) and slugs.
- Company facts the agent keeps re-scraping (registration number, contacts, certs with
  numbers and scopes, verified metrics with dates, palette, logo/asset paths).
- Default values (default package, panel, inverter, warranty lines).
- Conventions (EN/中文 kept in sync; relative asset paths; naming patterns).

Refresh trigger: a Settings Agent command or a button, not a per-chat fetch.

### 5.4 CODEMAP — where things are

Two parts:

**a) File table (generated).** Path, size, line count, top-level ids / functions /
headings. Regenerate whenever the host syncs or publishes so it never drifts.

**b) Concept index (hand-written, the valuable part).** One line per thing the
operator asks about, listing **every** location:

```text
Warranty lines   -> proposal.html renderWarranty(); invoice-data.js DEFAULT_*; pdf-generator.js DEFAULT_*;
                    quotation.html; html_to_pdf/proposal-pdf{,-en,-zh}.html; html_to_pdf/quotation-{pdf,standalone}.html
Certification    -> proposal.html cert-grid; html_to_pdf/proposal-pdf{,-en,-zh}.html; page-i18n.js zh h3 list (positional!)
Chinese strings  -> page-i18n.js: EN returns early except why-eternalgy; zh uses setAll positional lists
Mirror rule      -> every visible string exists in 3 to 4 html_to_pdf templates. Change all or none.
```

Rule of thumb: if an agent had to grep for it twice in the transcripts, it goes in the
concept index.

### 5.5 PLAYBOOKS — the recurring jobs, step by step

One entry per recurring task from the charter. Format:

```text
### <Task name>
When:      <what the operator says>
Read:      <exact files, in order>
Edit:      <exact files, what changes, mirrors to keep in sync>
Verify:    <one command or check; expected output>
Done when: <observable condition + what to tell the operator (live URL)>
Never:     <the one thing that goes wrong on this task>
```

Playbooks are why the Package Updater answers in one tool call. Write them from real
transcripts, not from imagination. Include the verification scripts an agent already
wrote once (save them under `tools/` in the workspace and reference them).

### 5.6 STATE — what happened recently (host-generated)

Appended by the host after each turn: date, files touched (from the diff), one-line
summary, pending items, gotchas discovered ("static-smoke test fails on a pre-existing
assertion; ignore"). Keep the last 10 entries. This is what a restarted turn reads
instead of its own transcript.

---

## 6. Step 5 — Register and attach

Three ways; **system agents use the first**:

1. **Repo seed (source of truth).** Role file at `agent/roles/<slug>.md`, entry in
   `seedAgentCatalog()`, boot reloads it. Deploy with `git push origin main:railway`.
2. **Settings page** `/settings#agents` (password) for quick experiments. The role
   prompt then lives only in Postgres and will not survive a reseed of that id.
3. **Settings Agent / CLI / manage API** for remote setup:

```bash
node "$CLOUD_PI_CATALOG" agents create --name "Name" --role-file agent/roles/<slug>.md --repo owner/name --branch main --live-url https://...
node "$CLOUD_PI_CATALOG" agents attach <id> --skill <slug> --mcp <slug>
```

Then attach skills/MCP, set `engine` and `model_id`, and start a **new chat** (the
bundle is rebuilt on the next chat, not mid-session).

---

## 7. Step 6 — Acceptance test (record the numbers)

Run these in a fresh chat and log the results in the agent's role file under
`## Acceptance`:

| Probe | Pass condition |
|-------|----------------|
| "Where is the live site / what do you own?" | Answered from the pack, 0 tool calls |
| "Where does <concept from CODEMAP> live?" | Lists every location, 0 or 1 tool calls |
| One small edit (change a string) | First edit within 5 tool calls; live URL in reply |
| One playbook task end to end | Follows the playbook files in order; verify step run; 0 "continue" needed |
| One out-of-scope request | Redirects to the named neighbour agent, no exploration |
| Restart mid-task, then "continue" | Recovers from STATE + diff, does not read transcripts |

Targets: calls-before-first-edit ≤ 5 for edits, ≤ 15 for playbook tasks, zero nudges.
If a probe fails, the fix is a line in the pack. Re-run.

---

## 8. Step 7 — Maintain

- **Weekly:** read the agent's transcripts (`/api/sessions?agentId=<id>` then
  `/api/messages?sessionId=`). Every grep-twice becomes a CODEMAP line; every
  "how do I…" becomes a PLAYBOOK; every wrong assumption becomes a HOST line.
- **On repo change:** regenerate the CODEMAP file table; re-check the concept index.
- **On model change:** re-check vision, tool-calling quality, and the size budget.
- **On prompt change:** edit the repo file, redeploy. Do not hot-patch the DB and forget.
- **Retire:** detach skills, keep the workspace, mark the role file `RETIRED` with the
  date. Do not delete transcripts.

---

## Appendix A — Minimal role file skeleton

```markdown
# <Name>

<!-- CHARTER (section 2) -->

## Role
## Host
## Project
## Codemap
### Files
### Concepts
## Playbooks
## State
## Acceptance
```

## Appendix B — Worked example (Proposal Agent, abridged)

```text
Name: Proposal Agent            Slug: proposal
One job: Keep the Eternalgy solar proposal site correct and current.
Not its job: website HTML -> Website Dev; package prices -> Package Updater; host settings -> Settings Agent
Project: github.com/Zhihong0321/ee-proposal main   Workspace: /storage/workspaces/proposal
Live: host pushes main after each turn; Railway deploys https://ee-proposal-production.up.railway.app/shell.html#proposal
Inputs: text, screenshots, PDF invoices     Vision: yes -> needs a vision model
Recurring: change client details; add/change warranty line; change certification; swap package/panel/inverter; add image
Danger: never create branches; never edit server.js /api/sql unless asked
```

CODEMAP concept index: warranty (8 files), certification (5), client fields
(`proposal.html` data-* attributes + `invoice-data.js`), i18n rule, mirror rule.

PLAYBOOK "Add or change a warranty line": read `proposal.html renderWarranty`, edit
the 8 locations + `page-i18n.js` zh; verify with `tools/verify-warranty.mjs`
(playwright render of shell EN/ZH + quotation); done when all three renders list the
line and the push SHA is reported.

Observed before the pack: 291 tool calls, first edit at call 184, 3 nudges.
Target after: ≤ 15 calls, 0 nudges.
