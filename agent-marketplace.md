# Agent Marketplace: plan

Status: draft for discussion · 2026-10-08 · not built yet.
Scope: E Agent (UIv2): platform, companies (tenants), user slots, orchestrator, specialist catalog,
SOPs, `/demo` UI. This plan comes before full multi-tenancy, and multi-tenancy builds on it.

---

## 1. Goal (the owner's request)

1. **Agent Marketplace.** The Specialist Agents become a marketplace. Only the **company admin**
   chooses which specialists join the **company roster**.
2. **Per-user roster.** Each user in a company can have a different roster of specialists.
   This is access control, and some specialists can edit config, so access to them has to be
   tighter.
3. **Most important: plug and play.** When a specialist is added or removed, the roster updates
   and the **orchestrator adapts to the new roster automatically**.
4. **Each agent has its own SOP document, customizable per company.**

## 2. The picture: three levels

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ TIER 0 · PLATFORM  (infrastructure: us)                                      │
│   one codebase, one deploy → updates the entire app for every company        │
│   ships the specialist catalog (agent packages) and their default SOPs       │
│   decides what each company may choose, and how many user slots it has       │
├──────────────────────────────────────────────────────────────────────────────┤
│ COMPANY · tenant account  (company admin)                                    │
│   picks specialists from the catalog → company roster                        │
│   owns the SOP of each specialist (customize / restore default)              │
│   assigns people to user slots and decides which tier gets which specialist  │
├──────────────────────────────────────────────────────────────────────────────┤
│ USER SLOT · per company, tier 1 / 2 / 3                                      │
│   a signed-in person in one slot; the slot's tier decides their roster       │
│   uses the specialists, does not manage them                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

**The rule that falls out of the picture:**

> **Platform = code. Company = data. User = access.**
> Everything a company can change (roster, SOP, agent settings, who has which tier) is data, so
> one platform deploy updates every company without touching any company's choices. A company
> never needs code, a fork or a deploy to differ from another company.

### Who owns what

| Thing | Platform (Tier 0) | Company | User slot |
|---|---|---|---|
| App code, orchestrator, runtime | **owns, updates** | — | — |
| Specialist catalog (agent packages) | **publishes, updates** | chooses from it | — |
| Which catalog agents a company may choose (plan) | **sets** | sees its available list | — |
| Company roster (installed specialists) | — | **owns** (admin) | — |
| Agent role prompt (`ROLE.md`) | **owns** | — | — |
| Agent SOP | ships the default | **owns the customized SOP** (admin) | reads it |
| Agent settings (`config_schema` values) | defines the fields | **sets the values** (admin) | — |
| User slots per tier (count) | **sets** (limit / plan) | fills them with people | occupies one |
| Tier → specialist access | — | **owns** (admin) | gets the result |
| Model keys, infrastructure settings | **owns** | — | — |

## 3. Why

- **No more forks.** The 2026-10-07 fork (`e-agent-signals`, `ENABLED_AGENTS` env switch) exists
  only because the roster is code and env, not company data. With three levels, a new company is
  one tenant row plus choices, not a repository.
- **One update for everyone.** The platform improves an agent or its default SOP once, and every
  company gets it. Companies that customized their SOP keep their text and are told a new
  default exists.
- **Least privilege by tier.** Some specialists change company rules or config (DB Manager,
  Templates, Onboarding reset). A tier-3 slot should not reach them just because the orchestrator
  can.
- **Small context.** The orchestrator prompt names specific specialists today. With the roster
  as data shown per turn, the orchestrator prompt stays generic and does not grow as the catalog
  grows. This follows the small-prompt + micro-agent + checker strategy.
- **Same agent, different company procedure.** Two companies run the same Expenses Clerk with
  different approval steps. The code is shared and the SOP carries the difference.

## 4. Where we are today (facts)

| Area | Today | File |
|---|---|---|
| Platform vs company | Not separated. One host = one company. Platform settings (model keys) and company data live in the same database with no platform operator role. | `server/settings*`, `di.tenant` |
| Company | `di.tenant` exists, and the DI tables use row-level security per tenant. The host picks a single "default company". `users.company_tenant_id` exists. | `document_inteligence/sql/001_core.sql:45`, `server/people-service.mjs` |
| User tier | `users.tier TEXT DEFAULT 'standard'`, described to agents as "metadata only". No slots and no limits. | `server/users.mjs:29`, `server/people-service.mjs` |
| Roles | `admin` (labelled Superadmin, "owns this system"), `department_head`, `user`. A host-verified `signedInLine` is appended to every run. | `server/roles.mjs` |
| Catalog | One global `agents` table, seeded from code on every boot. It has no company or user column. | `server/catalog.mjs:90`, `:838` |
| Orchestrator roster | `listSpecialists()` returns **every** agent except the orchestrator. | `server/orchestrator.mjs:197` |
| Dispatch check | `resolveSpecialist()` only checks that the agent exists. | `server/orchestrator.mjs:204` |
| Orchestrator prompt | It already says to use the live cards (line 13), but it hard-codes *Scheduler AI*, *Media AI*, *Company Onboarding* and `di-onboarding` routing (lines 21, 39, 70, 76, 82). | `agent/roles/orchestrator.md` |
| Tools per agent | Chosen by id or prefix (`orchestrator`, `di-*`, `scheduler`). | `server/execution/profiles.mjs:88` |
| Readiness gate | Hard-coded `di-` prefix and a list of setup agents. | `server/orchestrator.mjs:591` |
| Protected agents | Hard-coded list of slugs that cannot be deleted. | `server/catalog.mjs:519` |
| Agent list API | `GET /api/agents` returns all agents to every caller. | `server/index.mjs:2997` |
| Scheduler targets | Kept in a separate list. | `server/scheduler/actions.mjs:3` |
| UI | `/demo` sections and mobile links are hard-wired to agents. | `app/demo/*` |
| SOPs | One global `agent_sops` row per agent. It is injected into the agent's prompt every run (`runtime.mjs:134`), and a save restarts the runtime (`sopFingerprint`). Superadmin-only tools exist only on the orchestrator and di-fde. The FDE owns a `<!-- fde:start -->` block inside it. No agent ships a default SOP. | `server/sops.mjs`, `server/execution/registry.mjs:207` |

Hard-coded agent slugs appear in 2–8 non-test files each, for example `di-expenses` in 8 and
`media-ai` in 7. Every one of these references stands in the way of plug and play.

## 5. Tier 0: Platform

**What the platform does:**
- **Publishes the catalog.** Each specialist is an **agent package** in this repo (§8). A deploy
  makes new packages and new versions available to every company at once.
- **Ships default SOPs** in each package. Defaults reach every company that has not customized.
- **Sets each company's entitlement:** which catalog agents the company may choose from (its
  plan), and how many user slots it has per tier.
- **Owns infrastructure:** model keys, providers, storage, processes and the runtime. Companies
  never see or change these.
- **Platform-only agents.** Agents that operate the platform (Settings / host settings, Website
  Dev, Package Updater, and the Eternalgy-internal Proposal, NEWPAGES, AFA and Sales agents) are
  **not in the company catalog**. They stay `visibility: platform` (or `private:<company>` for
  Eternalgy's own tenant).

**New role: platform operator.** Today's `admin` key is labelled "Superadmin: owns this system".
In the three-level picture that sentence is wrong for every company except ours. Split it:

| Role | Level | Can |
|---|---|---|
| `platform_operator` (new) | Tier 0 | manage companies, entitlements and slot counts, publish packages (by deploy), view platform health. Not a member of any company's data by default. |
| `admin`, shown as **Company admin** | Company | the company roster, SOPs, agent settings, people, slot and tier assignment |
| `department_head`, `user` | Company | unchanged; their authority inside company data stays as it is |

`signedInLine` changes from "owns this system" to "**Company admin of <Company>**: their
instructions set this company's rules". The owner-authority rule still holds, scoped to the
company.

## 6. Company: tenant account

The company admin manages four things.

### 6.1 Company roster (the marketplace)

- The **Marketplace page** shows the catalog agents in the company's entitlement. Each card shows
  headline, `use_when`, a risk badge, requirements and a default SOP preview, plus a status of
  *Installed* / *Not installed* / *Needs setup*.
- **Install** adds the agent to the company roster. **Uninstall** is soft: it keeps the SOP,
  settings and business data, so a reinstall restores everything (§9).
- Core agents (the orchestrator) are always installed.

### 6.2 SOP per specialist

Split by who owns the text:

| Document | Owner | Contains |
|---|---|---|
| `ROLE.md` | Platform | identity, tools, safety mechanics, output contract. Same for every company. |
| `SOP.md` (default) | Platform | a sensible default procedure, shipped in the package |
| Company SOP | Company | that company's procedure: approval steps, numbering, wording, who to copy, what to check |

Resolution is **override-only**, the same pattern as the per-tenant "Customize page / Restore
default":

```
effectiveSop(company, agent) = company SOP row, if one exists
                               otherwise the package's SOP.md
```

- **No row means the default.** Platform improvements to the default reach that company
  automatically.
- **Customize** starts from the current default. Saving creates the company row.
- **Restore default** deletes the row. History is kept, so it can be undone.
- **Default updated since you customized.** The row stores the `base_version` it started from.
  When the package ships a newer default, the editor shows a diff and the company chooses to
  merge, keep or restore. The platform never auto-merges into a company's text.
- **History and audit.** Every save writes a history row (content, who, when, base_version) and
  an audit-log row.
- **The FDE block** (`<!-- fde:start -->…<!-- fde:end -->`) keeps working, scoped to the company
  row.
- **The orchestrator's company SOP** is where company-specific routing preferences go, for
  example "always use a checker for invoices above RM 10k". `orchestrator.md` stays generic.
- **Context budget.** A SOP is prompt context on every run. The editor warns above about 4,000
  characters, and a hard limit stays as a safety net. A rule that keeps failing becomes a
  checker check, not a longer SOP.
- **Injection** works as today (`runtime.mjs:134`), but looks up by (company, agent). The runtime
  bundle key includes the company SOP revision, so a save takes effect on the agent's next run.

### 6.3 Agent settings

Each package can declare a `config_schema`, for example an approval limit or a default currency
for the document. The company admin sets the values. The agent reads them through its tools,
not from the prompt.

### 6.4 People, slots and tiers

- The company has **N slots per tier**, set by the platform. Assigning a person to a tier
  consumes a slot. The host refuses when a tier is full, and the admin sees "Tier 2: 4 / 5 used".
- Every login-enabled person sits in exactly one slot with tier **1, 2 or 3**. Contact-only
  people (no login) use no slot.
- **Tier is not role.** Role is authority inside company data (company admin, department head,
  user). Tier is which specialists the person gets. A department head can be tier 2, and a
  company admin always has full access regardless of tier.
- `users.tier` (today free text, "metadata only") becomes `1 | 2 | 3` and is enforced.

## 7. User slot: the per-user roster

**The company admin maps tiers to specialists.** On the Roster page, each installed specialist
has three tier checkboxes:

```
                       Tier 1   Tier 2   Tier 3
Expenses Clerk           ☑        ☑        ☑
Procurement              ☑        ☑        ☐
Scheduler AI             ☑        ☐        ☐
DB Manager (config)      admin only
```

```
userRoster(user) = company roster
                   ∩ specialists allowed for the user's tier
                   ∪ everything, if the user is a company admin
```

- Tiers are **sets, not a ladder**. Tier numbers do not imply "1 ⊃ 2 ⊃ 3"; the admin ticks
  whatever they want. A company that wants a ladder just ticks it that way.
- **Risk-based defaults.** At install, `risk: config` agents (DB Manager, Templates, Onboarding
  reset) default to **admin only**. `external_send` agents (email, WhatsApp) default to no tiers.
  Others default to all three tiers. The admin can widen any of these, and sees a warning first.
- **"Some specialists can edit config"** is covered twice. Agents that change company rules are
  admin-only by default. Editing any agent's SOP or settings is a company-admin action, not a
  tier right.
- **The agent's own data rules still apply.** Roster access lets a person reach the agent, and
  the agent's row rules still decide what they see. Example: department heads see only their
  department's claims (`sql/010_department_scope.sql`).

## 8. Plug and play: the contract

### 8.1 Agent package: an agent describes itself (Platform)

```
agent/packages/<slug>/
  agent.json      # manifest
  ROLE.md         # role prompt (moved from agent/roles/<slug>.md)
  SOP.md          # default SOP
```

```jsonc
{
  "slug": "di-expenses",
  "version": 3,
  "name": "Expenses Clerk",
  "short": "EX",
  "card": {
    "headline": "Expense claims, receipts and reimbursement",
    "use_when": "staff submit, check or approve expense claims or receipts",   // ≤120 chars
    "not_for": "supplier invoices or purchase orders",                         // ≤120 chars
    "routing_notes": ""                                                        // ≤300 chars, optional
  },
  "toolsets": ["di:expenses"],          // replaces the id/prefix logic in manifestForAgent
  "skills": [], "mcp": [],
  "requires": { "company_setup": "minimum", "settings": [] },  // replaces companyDispatchGate prefix logic
  "risk": "write",                      // read | write | config | external_send → default tier access
  "core": false,                        // always installed (orchestrator)
  "visibility": "catalog",              // catalog | platform | private:<company>
  "schedulable": true,
  "ui": { "pages": ["expenses"], "mobile_links": ["expenses"] },
  "config_schema": { "approval_limit": { "type": "number" } }
}
```

At boot, the catalog seed scans `agent/packages/*`, as `seedAgentCatalog` does now from code.
**Code (Platform) is the source of truth for what an agent is. Data (Company) is the source of
truth for who has it and how it works there.**

Publishing a new specialist means adding a folder (plus a native toolset if the agent needs one)
and deploying. It appears in the marketplace of every entitled company, **not installed**. There
is no orchestrator prompt edit, no `manifestForAgent` branch and no UI branch.

### 8.2 Remove every hard-coded agent reference

| Hard-coded today | Becomes |
|---|---|
| `manifestForAgent` id/prefix branches | `manifest.toolsets` → registry looks up toolsets by name |
| `companyDispatchGate` `di-` prefix and setup list | `manifest.requires.company_setup` |
| `deleteAgent` protected list | `manifest.core` / `visibility: platform` |
| Specialist names in `orchestrator.md` | `card.use_when` / `card.routing_notes` on each agent |
| `/demo` section ↔ agent map | `manifest.ui.pages`, filtered by the user roster |
| `schedulableAgents` | `manifest.schedulable` ∩ user roster |
| SOP tools only on orchestrator and di-fde | company-admin check plus company scope, on any agent that needs them |

**Regression guard (a checker, not a prompt rule):**
- `server/agent-prompts.test.mjs`: `orchestrator.md` contains no catalog slug or agent name.
- A second test fails if any file under `server/` or `app/` compares against a literal agent slug
  outside `agent/packages/`. Known exceptions go on an allowlist that should shrink over time.

Two-agent recipes (logo: browse, then Onboarding saves) move into the receiving agent's
`routing_notes`. When that agent is not installed, its note disappears with it.

### 8.3 How the orchestrator adapts automatically

1. **One resolver.** `server/roster.mjs` → `userRoster(user)`. Every gate calls it, and nobody
   filters agents on their own.
2. **Per-turn roster line, supplied by the host.** This uses the same mechanism as
   `signedInLine`. It is appended to the run, not to the system prompt, so the prompt cache
   survives:
   ```
   [Your specialists (rev 7c1e, 9): Scheduler AI (scheduler): run or check jobs on a timetable ·
    Expenses Clerk (di-expenses): staff expense claims and receipts · … Full cards: list_specialists.]
   ```
   The line is capped at about 1,200 characters, with names and slugs only when the roster is
   large. It is cheaper than the `list_specialists` round trip the orchestrator makes on almost
   every turn today.
3. **The roster belongs to the person the work is for.** In chat, that is the signed-in user. In
   a plan task, it is the plan owner. In a scheduled run, it is the schedule owner.
4. **The host checks three times.** At `submit_plan` (agent and checker agent; the error returns
   the current roster so the model can re-plan in the same turn), at `dispatchTask` / the job
   runner tick, and at `runSpecialist`.
5. **Stale history is harmless.** The rev tells the model the list changed, and the gates reject
   a removed agent anyway.
6. **A missing specialist is named, never silently refused:**
   - user: "That needs **Expenses Clerk**, which isn't available on your tier. Ask your company
     admin."
   - company admin: "Expenses Clerk isn't installed. Install it?" (phase 3 tool)
   - not in the company's entitlement: "Expenses Clerk isn't in your plan. Contact the platform."

## 9. Lifecycle

| Event | Effect |
|---|---|
| **Platform deploys a new package** | It appears in entitled companies' marketplaces as *Not installed*. |
| **Platform deploys a package update** | Every company that installed it runs the new version. Non-customized SOPs get the new default. Customized SOPs keep their text and show "default updated". A breaking `config_schema` change needs a migration in the package. |
| **Platform removes an agent from a company's entitlement** | It is treated like an uninstall for that company. |
| **Company installs** | A `company_agents` row is written, risk-based tier defaults are applied and `roster_rev` is bumped. The next orchestrator turn sees the agent and its UI pages appear. If `requires` is not met, it shows **Needs setup** and stays out of user rosters until it is ready. |
| **Company uninstalls** (soft) | `enabled=false`. SOP, settings, tier mapping and business data are kept. New dispatch is blocked. **Pending** tasks become `blocked: removed from roster`. **Running** tasks finish (or the admin chooses "stop now"). Schedules that target it are **paused** with a reason. Direct-chat sessions become read-only. The process is evicted. |
| **Admin changes tier mapping / moves a person to another tier** | Only the affected users get a new rev. Their pending tasks and schedules for agents they lost are handled as above, for them only. |
| **Slot removed / person disabled** | Their sessions end (as today when a user is disabled), and their schedules pause. |

## 10. Data model

```sql
-- PLATFORM ---------------------------------------------------------------
-- global catalog: existing agents table + manifest from agent.json
ALTER TABLE agents ADD COLUMN IF NOT EXISTS manifest JSONB NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS package_version INT NOT NULL DEFAULT 1;

-- what each company may choose, and its slot counts
CREATE TABLE company_entitlements (
  company_id    UUID PRIMARY KEY,                 -- di.tenant.id
  agent_ids     TEXT[],                           -- NULL = every catalog agent
  slots_tier1   INT NOT NULL DEFAULT 0,
  slots_tier2   INT NOT NULL DEFAULT 0,
  slots_tier3   INT NOT NULL DEFAULT 0,
  updated_by    TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- COMPANY ----------------------------------------------------------------
CREATE TABLE company_agents (
  company_id   UUID NOT NULL,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  tiers        SMALLINT[] NOT NULL DEFAULT '{1,2,3}',  -- empty = company admin only
  config       JSONB NOT NULL DEFAULT '{}',              -- config_schema values
  installed_by TEXT REFERENCES users(id),
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, agent_id)
);

CREATE TABLE company_agent_sops (                 -- no row = package default SOP.md
  company_id    UUID NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  content       TEXT NOT NULL,
  base_version  INT  NOT NULL,
  revision      INT  NOT NULL DEFAULT 1,
  updated_by    TEXT REFERENCES users(id),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (company_id, agent_id)
);
CREATE TABLE company_agent_sop_history (
  id UUID PRIMARY KEY, company_id UUID NOT NULL, agent_id TEXT NOT NULL,
  revision INT NOT NULL, content TEXT,            -- NULL = "restored default"
  base_version INT, changed_by TEXT, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE di.tenant ADD COLUMN IF NOT EXISTS roster_rev BIGINT NOT NULL DEFAULT 0;

-- USER SLOT --------------------------------------------------------------
-- users.tier: 'standard' text → 1|2|3; slot limits are checked against company_entitlements
ALTER TABLE users ADD COLUMN IF NOT EXISTS slot_tier SMALLINT CHECK (slot_tier IN (1,2,3));
-- users.role gains 'platform_operator' (no company_tenant_id)
```

Every roster, tier, SOP and entitlement change writes an audit row.

**Migration (no visible change on day 1):**
- The existing company gets an entitlement for all catalog agents, and slot counts equal to
  today's login count per tier.
- Every login user gets `slot_tier = 1`.
- Every current catalog agent is installed with tiers `{1,2,3}`, except config-risk agents, which
  are admin only.
- Platform-only agents are marked `visibility: platform`.
- The global `agent_sops` rows become this company's SOP rows with `base_version = 0`.
- The current `admin` account stays Company admin of this company. A separate platform operator
  account is created deliberately, never seeded with a default password.

## 11. Screens by level

| Level | Screen | What it does |
|---|---|---|
| Platform | **Companies** | Create a company, set entitlement (agents) and slot counts per tier, see usage |
| Company admin | **Marketplace** | Browse entitled agents and install or uninstall. The uninstall confirm lists the pending tasks, schedules and people affected. |
| Company admin | **Roster** | Installed agents × tier checkboxes, agent settings, and an SOP button per agent |
| Company admin | **SOP editor** | Default / Customized status, Customize, Restore default, history, "default updated" diff, length warning |
| Company admin | **People** | Assign people to slots and tiers, with "Tier 2: 4 / 5 used" |
| User | **My specialists** | Their roster, and the read-only SOP for each agent. `/demo` sections and mobile links render from this, never from a hard-coded list. |
| Any | **Chat** | The orchestrator works within the person's roster. The company admin can also manage the roster by chat (phase 3). |

API: `GET /api/roster` (me), `GET /api/marketplace`, `POST /api/marketplace/:agent/install|uninstall`,
`PUT /api/roster/:agent` (tiers, config), `GET|PUT|DELETE /api/roster/:agent/sop`,
`GET /api/roster/:agent/sop/history`, `GET|PUT /api/platform/companies/:id` (platform operator).

## 12. Enforcement points (all call `userRoster`)

1. `listSpecialists(ctx)`: filtered roster cards.
2. `submit_plan` / `updatePlan`: each task's agent and checker agent.
3. `dispatchTask` and the job runner tick.
4. `runSpecialist`: last check before the turn.
5. Chat start / `manifestForAgent`: direct chat with a specialist.
6. `GET /api/agents` → per-user list, plus `GET /api/roster`.
7. Scheduler: `schedulableAgents`, `schedule_create`, and the check when a schedule fires.
8. SOP, settings and roster tools and APIs: company admin only, always scoped to the caller's
   company. People with roster access can read SOPs.
9. Slot limits: creating or retiering a login person checks `company_entitlements`.
10. Platform APIs: platform operator only. A company admin never reaches them.

One table-driven test calls each entry point with a disallowed agent, tier or company and
expects a refusal. A new entry point added without the resolver should fail the test.

## 13. Phases

**P0: decouple (no behavior change).** Agent packages and manifests. Make `manifestForAgent`,
`companyDispatchGate`, `deleteAgent`, `schedulableAgents` and the UI read the manifest. Make
`orchestrator.md` generic and add the lint tests.
*Proof:* drop in a test agent folder and the orchestrator routes to it with zero other edits.

**P1: Company roster + SOPs.** Add `roster.mjs`, `company_agents`, the company SOP tables, the
per-turn roster line, enforcement points 1–8, the lifecycle effects, and the Marketplace, Roster
and SOP editor screens. Run the migration for the existing company.

**P2: User slots and tiers.** Add `slot_tier`, the tier mapping per agent, slot limits and the
People screen changes. Retire the "tier is metadata only" text.

**P3: Platform level.** Add the `platform_operator` role, `company_entitlements`, the Companies
screen, and the `signedInLine` wording change. A platform deploy updates everyone, with
SOP-default notices.

**P4: Orchestrator as roster assistant.** Company-admin chat tools (`roster_install`,
`roster_set_tiers`, SOP edit), the "ask your company admin" path for users, and optional email
to the admin.

**P5: full multi-tenant isolation (separate plan).** These items are keyed by agent only today
and must become (company, agent): Pi process pool keys, agent workspaces (`agentWorkspace`),
per-agent `STATE.md` and the SOP fingerprint. Also needed: settings split into platform vs
company, and the host's single "default company" replaced by the signed-in user's company.

## 14. Acceptance tests

- **Plug and play:** a new package folder appears as *Not installed* in an entitled company.
  After install and tier ticks, the next orchestrator turn routes a matching request to it, with
  no code, prompt or UI edit.
- **Uninstall** with a pending task: the task becomes `blocked: removed from roster`, the
  orchestrator tells the user, and its schedule pauses.
- **Tier:** a tier-3 user asks for something only tier 1 has. The orchestrator names the agent
  and the company admin. If the model tries anyway, the host rejects the dispatch.
- **Slots:** adding a 6th tier-2 login when the limit is 5 is refused with "Tier 2: 5 / 5 used".
- **SOP isolation:** company A customizes the Expenses SOP, and company B still gets the default.
  Restore default works, and the history shows both changes.
- **Platform update:** a new default SOP reaches non-customized companies on their next run.
  Customized companies keep their text and see the notice.
- **Level isolation:** a company admin cannot call platform APIs or read another company's
  roster or SOP.
- **Context:** the `orchestrator.md` lint passes, and the orchestrator system prompt does not
  grow as agents are added.

## 15. Open questions for discussion

1. **Tier meaning.** This plan treats tier 1/2/3 as "which specialists", chosen per agent by the
   company admin, and kept separate from role (authority). Is tier also a **price** (the platform
   charges per slot by tier), or should tier replace the department-head / user roles?
2. **Is tier a ladder?** This plan uses sets (the admin ticks any tiers). Should tier 1 always
   include everything tier 2 has?
3. **Per-person exceptions:** should one person get a specialist that their tier doesn't have, or
   is tier the only control? (This plan says tier only, for simplicity.)
4. **SOP editing delegation:** company admin only, or can the admin delegate one agent's SOP to a
   named person (for example, finance head edits the Expenses SOP)?
5. **Entitlement:** does the platform restrict which catalog agents a company may choose (plans),
   or can every company choose every catalog agent?
6. **Direct chat** with specialists (as `/demo` Expenses does today), or only through the
   orchestrator?
7. **Checkers and helper agents:** do they count against the roster, or are they `internal` and
   always available?
8. **SOP shape:** whole-document override (this plan) vs default + company additions vs
   per-department SOPs. Is about 4,000 characters the right soft limit?
9. **The FDE (Forward Deploy Engineer):** is it a platform agent that works on a company's
   behalf, or a catalog agent the company installs?

## 16. Non-goals

- Third parties publishing agents (packages ship in this repo only).
- Billing and payments (entitlements and slot counts are where they would attach later).
- Full process and workspace isolation per company (P5, separate plan).
