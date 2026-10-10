# Agent Marketplace: MVP

Status: the only plan to build from · 2026-10-08
`agent-marketplace.md` is a map of the future. **Do not build anything from it.**

## How to read this plan

- **Incomplete is fine.** Anything missing gets added by the owner in the next round.
- **Extra is never fine.** Doing more than a box says is a failure, not a bonus. It burns time
  and tokens now, and it is hard to remove later.
- **Unsure whether something is needed? It is not.** Leave it out and name it in the report.

The only goal: the boxes below, proven running on the live server.

---

## Decision (no code)

One Railway service, one Postgres, many companies.

- **Separate per company:** business data (`di.*`, already separated by tenant id), logins
  (`users.company_tenant_id`, already exists), chats, SOPs.
- **Shared by all companies:** everything else.
- One email belongs to one company.

---

## Checklist

Work top to bottom. A step starts only after the step before it is proven on the live server.

### Step 1: An agent is a plugin folder (budget: 40 added lines)

- [x] `agent/packages/<slug>/` holds `agent.json` and `ROLE.md`. The folder name is the slug.
      `agent.json` has exactly 2 fields: `name`, `description` (what it does, when to use it).
- [x] `seedAgentCatalog` (`server/catalog.mjs:838`) also loads every folder in
      `agent/packages/` into the `agents` table.

Proof on live:
- [x] Add one test agent folder, and nothing else. Deploy. Ask for something that matches it.
      The orchestrator routes to it.

### Step 2: The admin picks each user's agents (budget: 120 added lines)

- [x] Table `user_agents (user_id, agent_id)`. On first deploy, every existing user gets every
      existing agent.
- [x] `listSpecialists` (`server/orchestrator.mjs:197`) returns only the signed-in user's agents.
      Scheduled runs are unchanged.
- [x] Company people page (`app/demo/users.tsx`): agent checkboxes per user.

Proof on live:
- [x] Untick agent X for a test user. The orchestrator no longer uses X for them. Tick it
      again. It does.

### Step 3: The menu shows only the user's agents (budget: 40 added lines)

- [x] `GET /api/agents` (`server/index.mjs:2997`) returns only the signed-in user's agents.
- [x] The `/demo` menu (`app/demo/page.tsx:14`) hides items whose agent the user does not have.

Proof on live:
- [x] The test user's menu shows only their ticked agents.

### Step 4: A second test company — profile, people, expenses (budget: 150 added lines)

One session, 60 minutes maximum.

- [x] For these features, use the signed-in user's `company_tenant_id`. Scheduled calls use
      the schedule's tenant. Missing company means an error.
- [x] Pass the company through existing request/session/run parameters. Never change shared
      the company per request. No new context framework or helper module.
- [x] Apply it to company profile, people and expenses, including their agent tool calls.
- [x] Add one small script that creates the tenant, calls `seedTenant`, and creates its first
      admin. Run it on the live server.

Proof on live:
- [x] Company 2's admin signs in. Profile, people and expenses show none of company 1's data.
- [x] Company 2 changes a profile value and creates an expense through its agent. Company 1's
      profile and expenses remain unchanged.
- [x] Company 1's existing flow and a scheduled run still work.

Left out:
- Chat separation.
- SOP separation.
- Other screens.
- File and running-process separation.

Company 2 is an internal test company until the deferred separation work is complete.

If the required changes exceed either budget, stop and report. Do not expand the step.

**Done = every proof box ticked on the live server.**

Owner note, not part of this plan: files and running agent processes are still shared between
companies. Separate them before a real second company goes live.

---

## Forbidden rules for AI agents

1. Do only the current step's boxes, exactly as written. Nothing from a later step, nothing
   from `agent-marketplace.md`.
2. Anything not written in a box is forbidden. If it seems needed, leave it out and name it in
   the report.
3. Never edit this plan. Ticking a box is allowed.
4. Edit the named code in place. No new abstraction, layer, helper module, class or framework.
5. No config options, env vars, feature flags, fallbacks, retries or compatibility code.
6. No refactoring, renaming, cleanup or "while I'm here" fixes.
7. No polish: no styling, empty or loading states, wording changes, docs or comments.
8. No new tests. If an existing test breaks, make the smallest change to that test.
9. Stay within the step's line budget (`git diff --stat`, added lines). Over budget means stop,
   report, and do not commit.
10. One step per session, 60 minutes at most. If it is not proven by then, stop and report the
    blocker.
11. Proof means the live server, a real sign-in and a real request. Local runs and tests are
    not proof.
12. If a proof fails, fix only that cause, with the smallest change. If the second fix fails,
    `git revert` the step and report.
13. Report only three things: the diff stat, the proof result on live, and what you left out.
    No suggestions.
