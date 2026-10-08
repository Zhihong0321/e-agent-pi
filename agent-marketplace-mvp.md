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

- [ ] `agent/packages/<slug>/` holds `agent.json` and `ROLE.md`. The folder name is the slug.
      `agent.json` has exactly 2 fields: `name`, `description` (what it does, when to use it).
- [ ] `seedAgentCatalog` (`server/catalog.mjs:838`) also loads every folder in
      `agent/packages/` into the `agents` table.

Proof on live:
- [ ] Add one test agent folder, and nothing else. Deploy. Ask for something that matches it.
      The orchestrator routes to it.

### Step 2: The admin picks each user's agents (budget: 120 added lines)

- [ ] Table `user_agents (user_id, agent_id)`. On first deploy, every existing user gets every
      existing agent.
- [ ] `listSpecialists` (`server/orchestrator.mjs:197`) returns only the signed-in user's agents.
      Scheduled runs are unchanged.
- [ ] Company people page (`app/demo/users.tsx`): agent checkboxes per user.

Proof on live:
- [ ] Untick agent X for a test user. The orchestrator no longer uses X for them. Tick it
      again. It does.

### Step 3: The menu shows only the user's agents (budget: 40 added lines)

- [ ] `GET /api/agents` (`server/index.mjs:2997`) returns only the signed-in user's agents.
- [ ] The `/demo` menu (`app/demo/page.tsx:14`) hides items whose agent the user does not have.

Proof on live:
- [ ] The test user's menu shows only their ticked agents.

### Step 4: A second company (budget: 150 added lines)

- [ ] The current company is the signed-in user's `company_tenant_id`. For a scheduled run, it
      is the schedule's tenant. No company means an error, never a default.
- [ ] `document_inteligence/host.mjs` uses the current company instead of `state.tenantId`
      (set once at line 390).
- [ ] Chat history lists only sessions whose user belongs to the current company.
- [ ] `agent_sops` gets `company_id`, and existing rows get the original company. SOPs are read
      and saved by (company, agent).
- [ ] A script creates a company: the tenant row, `seedTenant`, and its first admin. Run it on
      the live server.

Proof on live:
- [ ] Company 2's admin signs in. Company profile, people, expenses and chat history show none
      of company 1's data.
- [ ] Company 2 edits an agent's SOP. Company 1's SOP is unchanged.
- [ ] Company 1 works as before.

If another screen shows company 1's data, do not fix it. Name it in the report.

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
