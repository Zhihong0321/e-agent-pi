# e (by eternalgy)

**e is the name of this AI Agent System.**

e brings named AI agents, business records, research, files, and automation into one application. Users work through chat and dedicated business screens; the host manages capabilities, authentication, persistent data, execution, and integrations.

The project began as Website Studio and has grown into a broader agent system. Website development and publishing remain capabilities within e.

## Current repository status

**Updated: 5 October 2026 (Asia/Kuala_Lumpur).** This overview describes the current local working tree on `main`, including uncommitted changes. It is not a live production-health snapshot.

| Area | Current state |
| --- | --- |
| Identity | Official name: **e (by eternalgy)**. Some package, UI, PWA, and internal identifiers still use Website Studio, UIv2, or e-agent. |
| Stack | React 19 / TypeScript frontend built with Vite 8; Node.js HTTP backend; PostgreSQL persistence. |
| Main experience | `/` redirects to `/demo`, with separate research, calendar, Media Kit, web, sign-in, and settings screens. |
| Agent platform | Named profiles, assigned skills and MCP servers, per-agent workspaces and context packs, model selection, streaming chats, and a managed Pi process pool. |
| Business features | Document intelligence, records, forms, expenses, procurement, company setup, people/accounts, and supporting integrations. |
| Execution migration | A shared runner, native host tools, durable operation records, and host-owned external MCP connections exist for migrated Pi flows. Release verification remains incomplete. |
| Release readiness | The execution evidence records a candidate that is **not deployed**, with Gate A blocked by lint and outstanding integration/release checks. This refers to that candidate, not every existing production feature. |

See [execution release evidence](docs/execution-release-evidence.md) for recorded results and remaining gates. Historical documents can describe earlier implementations; use current source and Graft spans to resolve differences.

## Capabilities

| Capability | Scope |
| --- | --- |
| Chat and orchestration | Chat with a selected agent; submit durable jobs with specialist tasks, dependencies, recorded outcomes, and shared artifacts. |
| Document intelligence | Customer/contact records, products, packages, quotations, invoices, credit notes, payments, templates, and PDFs. |
| Forms and intake | Design and publish forms, review submissions, connect intake to records, and export results. |
| Expenses and procurement | Receipt-based claims, monthly submissions and approval workflows; suppliers, purchase orders, receiving, and invoice checks. |
| Company deep research | Establish company identity, collect evidence, validate findings, and produce dossiers and reports with citations. Search integrations support Brave, Exa, and Tavily. |
| Advertising research | Research jobs with reports, screenshots, and structured artifacts. |
| Media Kit | Company assets, file uploads, manifests, and share-link creation/revocation. |
| Website and repository work | Dedicated editing workspaces, host-managed website publishing, and configured repository workflows. |
| Business integrations | Sales/stock, package data, NEWPAGES merchant automation, Google Ads, electricity/solar tools, email, Composio, and a Go WhatsApp sidecar. |

Availability depends on the agent, attached capabilities, credentials, signed-in identity, company setup, and external-service readiness. A catalog entry alone does not establish that an integration is operational.

## Architecture

An agent is a **named role + assigned skills + assigned tools**, with its own workspace and runtime context. Installing a capability in the library and granting it to an agent are separate operations. Bootstrap rules can grant defaults, such as Scrapling.

- **Frontend:** streaming chat, transcripts, business panels, settings, and artifact links.
- **Host:** authenticates requests, selects trusted user/company context, resolves profiles/models, owns execution, and invokes business handlers.
- **Pi runtime:** executes turns using materialized roles, context packs, selected skills, and permitted tools. The host manages pooled processes rather than one global process.
- **Persistence:** PostgreSQL stores settings, catalog attachments, chats, business records, and execution state. Persistent storage holds workspaces, runtime files, browser profiles, and generated artifacts.
- **Integrations:** browser automation, external APIs, MCP services, and the WhatsApp sidecar extend the configured system.

Context packs under `agent/context/<slug>/` supply host, project, code-map, playbook, and state information. Runtime journals support continuity, and child-process environment filtering limits which host variables reach agents.

### Execution migration

For migrated Pi runs, `server/execution/` provides the shared runner and canonical operation dispatcher. Workers use native host tools through a run-bound bridge. The host checks permissions/inputs, records calls and effects, and persists execution events and outcomes. Completion uses explicit `finish_run` rather than final-answer prose.

The candidate includes stable chat submission keys, call replay/conflict handling, attempt ownership, cancellation, deadlines, and dependency execution. Its host adapter owns external MCP connections. Document-intelligence operations reach existing business handlers through the native registry; the older same-host forwarding proxy is retired for those flows.

**AGY remains a compatibility path outside the migrated execution contract.** Real PostgreSQL concurrency, actual worker/model execution, HTTP MCP, release-image behavior, and browser recovery still require the checks in the release evidence. A frontend build and deterministic tests do not establish production readiness.

The [execution architecture](docs/agent-execution-architecture.md) describes the target contract; its full acceptance list is not a list of completed features.

### Files and publishing

Agents create files; the host publishes them and returns references for chat to display. Shared files use persistent company-scoped storage and `/files/<file-id>/<filename>` links. Workspaces are working directories, not permanent download addresses.

Website publishing packages the workspace for the configured HTML host. Proposal publishing uses its configured repository workflow. Credentials and publication operations belong to the host. See [shared-file rules](document_inteligence/about-file-system.md).

## Application routes

| Route | Purpose |
| --- | --- |
| `/`, `/demo` | Main application; root redirects to `/demo`. |
| `/web` | Web workspace interface. |
| `/research` | Research interface. |
| `/calendar` | Calendar interface. |
| `/media-kit` | Media assets and sharing. |
| `/signin` | User sign-in. |
| `/settings` | Administrative configuration: models/keys, agents, skills, MCP, and jobs. |
| `/api/health` | Host health and boot diagnostics. |
| `/api/debug` | Debug diagnostics, subject to host access checks. |
| `/test-agy` | Redirects to the backend AGY test interface. |

## Local development

Use **Node.js >= 22.22.3**, npm, and PostgreSQL for persistent functionality. The Docker image supplies additional integration dependencies: Python/Scrapling, browser tooling, Poppler, AGY, and the compiled Go WhatsApp sidecar. A Node-only local installation does not supply all of these.

Install dependencies:

```powershell
npm ci
```

Set variables and start the backend in PowerShell:

```powershell
$env:DATABASE_URL = "postgresql://user:password@localhost:5432/e"
$env:DATA_DIR = Join-Path $PWD "agent-storage"
$env:PORT = "47831"
npm run dev
```

In a second terminal:

```powershell
npm run dev:ui
```

Open `http://127.0.0.1:47821`. Vite proxies `/api`, `/files`, `/reports`, `/db-viewer`, and `/company-profile` to the backend on `47831`.

To serve the production frontend locally, run `npm run build`, then `npm start` with host variables set. The backend serves `dist/`; deployment uses port `8080`.

### Configuration and storage

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection. |
| `PORT` | HTTP port; use `47831` with the current Vite development proxy. |
| `RAILWAY_VOLUME_MOUNT_PATH` | Preferred persistent data root when set. |
| `DATA_DIR` | Data-root override if the Railway variable is absent; default `/storage`. |

Provider keys and much runtime configuration are managed through `/settings` and stored in PostgreSQL. Integrations support selected environment fallbacks. [`.env.example`](.env.example) documents base variables; the commands above set them explicitly.

With a Railway volume mounted at `/storage`:

| Path | Purpose |
| --- | --- |
| `/storage/workspace` | Website agent workspace. |
| `/storage/workspaces/<slug>` | Other agent workspaces; ops maps to `settings`. |
| `/storage/storage` | Pi session storage. |
| `/storage/pi` | Shared Pi model configuration. |
| `/storage/library/skills` | Host skill library. |
| `/storage/runtime/<agent-id>` | Materialized agent runtime configuration. |
| `/storage/browser/profiles` | Persistent browser sessions. |
| `/storage/files/<company-id>/<file-id>/` | Published shared files. |

## Build and verification

```powershell
npm run build
npm test
npm run test:company-research
npm run test:ads-research
npm run lint
git diff --check
```

`npm test` runs the execution suite, not every repository test. It runs isolated Node processes and supplies `--experimental-test-module-mocks` where needed. Additional domain/integration tests live alongside their modules.

The [release evidence](docs/execution-release-evidence.md) records a passing production build, 21 execution tests, and 29 runtime/context/browser tests. It also records a repository-wide lint failure and outstanding release checks. These are results recorded in that document, not tests rerun for this README update.

## Deployment

The checked-in target is Railway using `Dockerfile` and `railway.toml`. The image builds the frontend and WhatsApp sidecar, installs integration dependencies, and starts `node server/index.mjs`. Railway checks `/api/health` and allows a 330-second drain period.

Provision PostgreSQL and persistent storage. The existing volume-based deployment uses a single replica. Credentials, company configuration, and integration setup must be completed for the relevant agents.

This README does not certify the active deployment, its revision, models, credentials, or deployment branch. Check the actual deployment and release gates when preparing a release.

## Repository guide

| Path | Responsibility |
| --- | --- |
| `src/main.tsx` | Frontend routing and boot. |
| `app/` | Chat, settings, business screens, research, calendar, and Media Kit. |
| `server/index.mjs` | HTTP entry, boot, route integration, and process lifecycle. |
| `server/execution/` | Runner, contracts, registry, dispatch, durable store, Pi adapter, and host MCP adapter. |
| `server/orchestrator.mjs` | Durable plans, specialist tasks, and orchestration integration. |
| `server/catalog.mjs`, `server/runtime.mjs` | Capability catalog and runtime materialization. |
| `server/context-pack.mjs`, `server/agent-env.mjs` | Context construction and environment filtering. |
| `server/company-research/`, `server/ads-research/` | Research pipelines, persistence, and reports. |
| `server/media-ai/` | Media assets and sharing backend. |
| `document_inteligence/` | Business handlers, migrations, rendering, and domain tests. Links retain the existing directory spelling. |
| `agent/roles/`, `agent/skills/`, `agent/context/` | Roles, bundled skills, and context packs. |
| `agent/extensions/host-tools.ts` | Native host-tool bridge for migrated workers. |
| `sidecar/` | Go WhatsApp service. |
| `docs/` | Architecture, research, jobs, and release evidence. |
| `graft/` | Repository graph with exact source spans. |

Further reading: [agent blueprint](agent/AGENT_BLUEPRINT.md), [document intelligence](document_inteligence/README.md), [company research](docs/company-deep-research.md), [research pipeline review](docs/company-research-pipeline-review.md), and [orchestrator jobs](docs/orchestrator-jobs.md). Domain documents may retain earlier transport descriptions; the execution migration notes above describe the current boundary.

## Working in this repository

Follow [`AGENTS.md`](AGENTS.md): **commit only on `main`; never create or switch branches; preserve unrelated user changes.** If the current branch is not `main`, stop and report the mismatch before committing.

Consult Graft before searching or opening source:

```text
graft map
graft ask "your question or literal identifier" --source
graft skeleton server/execution/runner.mjs
graft callers dispatchTool
graft grep "literal identifier"
```

Use returned `covers:` spans to inspect precise ranges. Ranked `ask` results are not exhaustive; use `graft grep` for every occurrence. Run `graft build` after substantial code changes.

This rewrite used Graft's map, runtime/catalog/persistence concepts, and source spans, including `server/execution/dispatch.mjs:69–183`, `document_inteligence/host.mjs:385–416`, and `server/media-ai/host.mjs:414–473`, then checked current routing, configuration, and release documentation. The working tree is authoritative when a graph summary is stale.
