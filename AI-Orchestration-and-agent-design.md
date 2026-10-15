# AI Orchestration and Agent Design

*Written 2026-10-11. Status: findings and proposed decisions only. Nothing in the product was changed to write this. Every decision below needs the owner's approval before any code is written.*

## 0. Warning: read this before you touch any agent, prompt or orchestration code

Between 09-30 and 10-07, seven commits changed `agent/roles/orchestrator.md`. Every fix round added code or prompt text. None took a decision away from the model. The behaviour is still random. More of the same will make it worse.

If you are an AI agent working in this repo:

1. **Do not add text to a prompt to fix agent behaviour.** That covers `agent/roles/*.md`, `agent/context/_shared/HOST-COMMON.md`, tool descriptions and SOPs. See section 9.
2. **Do not add a new model step** (a planner, checker, judge or retry loop) to fix randomness that comes from another model step.
3. **Every change must remove a model decision, or at least not add one.** Write it in the commit message: `Model decisions: removed <x>; added none`.
4. **Follow the SOP in section 10.** Trace first, classify second, then use the highest rung of the fix ladder that works.
5. **The owner decides.** Section 12 lists the open decisions. Do not make them yourself.
6. The repo rules still apply: work on `main` only, never create a branch, and never stash, reset or overwrite other people's changes (`AGENTS.md`).

## 1. Summary

- The remaining defects are orchestration defects: how the system decides which agent does what. The plumbing is mostly fine. One exception is attachments (F5 in the post-mortem).
- The root cause is not prompt length. **The model is making decisions that should be fixed in code or data**: which agent owns a request, how many tasks to run, what each task says, whether to check, and what to do when no agent fits.
- Each fix tried to steer those decisions with more words. Words do not bind a model. So the prompt grows and the behaviour stays random.
- Measured: given the same sentence, the orchestrator took the same path every time in only **49 of 109** cases. It sent a request to the right owner, and only that owner, in **78%** of runs.
- The fix is structural: **code decides, the model fills in.** Keep one owner per request type, as data. The model only picks a request type from a closed list and fills in tool arguments.

## 2. How it works today

```
User message
  └─ Orchestrator (model, 16.7 KB system prompt)
       ├─ list_specialists → 18 agent cards, each cut to 120 characters
       ├─ picks the agent(s) from the cards                              ← model decision
       ├─ or does the work itself (create_person, save_agent_sop, email) ← model decision
       ├─ designs a plan: how many tasks, which order, any checker       ← model decision
       ├─ writes each task in its own words                              ← model decision
       ├─ submit_plan → stored in Postgres, queued
       └─ replies "Queued" (the answer is not in this turn)
  └─ Runner (code) starts each task
       └─ Specialist (model, about 9–10 KB prompt) reads the orchestrator's words
            ├─ calls its tools                                           ← model decision (fine)
            └─ finish_run {done | blocked | failed} → checked by code
```

Four model decisions sit in the orchestrator, before any specialist runs. The code parts work and they are deterministic: permission gates, plan validation, and completion validation.

## 3. Findings

Evidence comes from the question-menu v2 traces, reps 2 to 17 (`tests/question-menu/v2/evidence/`), the code at the lines cited, and git history. The measuring method is in Appendix A, so anyone can rerun it.

### F-1. The same sentence takes different paths

The orchestrator's prompt last changed on 10-07, before all of these runs. Each case has the same wording and the same role in every run.

- **Path stability:** 109 single-message cases were seen 3 or more times. Only **49** took the same path every time. **60** varied, and **22** took 3 or more different paths.
- **Routing accuracy** covers 720 runs where the expected owner is on the company's roster:
  - right owner only: 78%
  - right owner plus extra agents: 2%
  - wrong agent: 3%
  - did the work itself: 6%. 15 of these runs are CMP-R0, where today's design lets the orchestrator add a staff login itself.
  - no dispatch at all: 11%. Some of these are fair clarifying questions.

Examples:

| Sentence | Paths seen |
|---|---|
| "From now on, every quotation must show a validity of 14 days." (RUL-6) | 6 paths in 14 runs. It wrote an SOP itself 9 times. The other runs went to DB Manager, Template Designer, FDE, or a mix. |
| "Change the company address to …" (CMP-N2) | Company Onboarding 9 times, DB Manager 6 times |
| "Add this name card." (REC-R3) | The orchestrator's own `create_person` 13 times, Records Clerk once |

Some variation is fair: when an earlier case failed, the company's data was different. So 60 is the most it could be. The routing examples above do not depend on data.

**A passing case can still be random.** RUL-6 passes 13 of 14 times because its oracle accepts any write, yet it took 6 paths. The pass rate hides this, so measure path stability as well.

### F-2. Routing means the model reads prose cards cut at 120 characters

`server/orchestrator.mjs:41-42` cuts each agent's headline and description to 120 characters. The cut removes the very words that routing needs:

| Agent | Text the orchestrator never sees |
|---|---|
| DB Manager | "…numbering, tax codes, archive/restore and the audit log" |
| Records Clerk | "…Keeps the product and package catalogue" |
| Document Agent | "…renders the PDF, converts quotes to invoices and records payments" |
| Form Designer | "…previews them, and publishes or closes their public links" |
| Procurement | "…checks every invoice against what was ordered and received", and who may issue POs |

"Show me the audit log for last Tuesday" (CMP-R3) failed in 12 of 14 runs. Each time, the orchestrator said that no specialist can read an audit log. The post-mortem calls this "ask variance". It is not variance: the capability is cut out of the text the model reads.

Even without the cut, routing from these cards is a guess. The cards were written to describe agents to people, not to decide who owns what.

### F-3. No request type has exactly one owner

Ownership overlaps, so the model has to choose, and it chooses differently from run to run.

| Request about | Claimed by |
|---|---|
| "company profile" | Company Onboarding (description) and DB Manager (headline) |
| "rules" | FDE ("your company's rules"), DB Manager ("rules and numbering"), and the orchestrator itself (`save_agent_sop`) |
| a staff person | the orchestrator (`create_person`), Company Onboarding (`create_person`), and Onboarding and DB Manager through the `save_company_member` alias (`document_inteligence/core/tools.mjs:191`) |
| a customer contact or name card | Records Clerk, but the word "people" points the model at the staff tools above |

### F-4. The router also does work itself

The orchestrator's own description says "It cannot do their jobs itself" (`server/catalog.mjs:1121`). Its tool list says otherwise: `create_person`, `update_person`, `list_people`, `count_user_accounts`, `get_agent_sop`, `save_agent_sop` and email (`server/execution/profiles.mjs:95-101`).

- Calling its own tool is one step. Delegating takes three: list the agents, write a plan, submit it. The model takes the short path.
- "Add this name card": in 13 of 14 runs, the orchestrator called its own `create_person`, which writes to the internal staff table. No customer or contact was ever created.
- The tool description already says "Create one internal company person" (`document_inteligence/core/user-tools.mjs:20`), and `list_people` says "Customer contacts are separate". That text did not help.
- The post-mortem blames Company Onboarding for this (its F6). The traces show the orchestrator did it.

### F-5. The prompt tells the model to design a workflow, and never to refuse

`agent/roles/orchestrator.md` says:

- line 14: "Write the complete plan … several tasks for a pipeline"
- line 16: "Add `checker` … when independent verification adds value"
- line 9: "Never refuse on your own judgment". `server/agent-prompts.test.mjs:56` makes this line mandatory.
- line 21: "Never answer that browsing is unavailable before checking the live roster and dispatching"

Together these lines say: always make something happen. So when the right agent does not exist, the model invents a substitute:

- There is no Prototyper. In all 13 runs of PRT-R1, the orchestrator sent the job to the Form Designer instead, often with an extra Form Clerk "checker". The post-mortem records this ending in a published live form.
- "Never refuse" was added to stop agents refusing the owner (commit ad6aca7). That problem was real. But a blanket line in a prompt fixes one behaviour by pushing the model into another.
- The right fix lives in code. When no agent owns a request, code returns a fixed reply that names the blocker. That is not the model refusing; it is the system stating a fact.

### F-6. The model rewrites the user's request, and the scope grows

The specialist receives the orchestrator's paraphrase, not the user's words.

- "Publish the order form" when no order form exists (FRM-R2): the orchestrator wrote into the task "if no order form exists, build one with customer details, items, quantity…". The Form Designer did that and published a new form. The post-mortem blames the Form Designer (its F3), but the scope came from the orchestrator.
- "Delete the customer ACME Sdn Bhd" (RUL-5): the orchestrator designed a "verify-then-delete" pipeline. When that plan failed to submit, it switched to "a single combined task".

### F-7. The prompt only grows

| Date | Commit | `orchestrator.md` size (characters) |
|---|---|---|
| 09-30 | 40f2126 | 6,737 |
| 09-30 | 96d0ffc | 7,449 |
| 09-30 | 36cb32c | 7,727 |
| 10-01 | 35093f5 | 8,199 |
| 10-02 | 774499d | 8,896 |
| 10-06 | ad6aca7 | 9,181 |
| 10-07 | de4aecf | 11,392 |

The file grew 69% in eight days and never got smaller. Most of the growth is special cases for one scenario each:

- the logo pipeline (lines 21-23)
- the scheduled-job status check (lines 37-45)
- the media kit (lines 68-70)
- email and SOPs

Every special case is read on every request, including requests that have nothing to do with it.

### F-8. Every agent gets 5.3 KB of text that does not apply to it

`buildRoleText` (`server/runtime.mjs:128-142`) and `loadContextPack` (`server/context-pack.mjs:90`) add the same blocks to every agent:

- **`HOST-COMMON.md` (3.8 KB):** node, git, scrapling, the `$CLOUD_PI_*` command-line tools and `_inbox/`. The orchestrator and the Document Intelligence agents run on the `assistant` profile, which has no shell, so they cannot use any of it.
- **The reply style:** "phone screen, non-technical reader, under 100 words". Specialists never talk to the user; they finish with `finish_run`.
- **File-sharing and image-generation text.**

| Agent | Role file | Full prompt | Text not about this agent |
|---|---|---|---|
| Orchestrator | 11.4 KB | 16.7 KB | 5.3 KB |
| Records Clerk | 3.8 KB | 9.2 KB | 5.3 KB |
| Company Onboarding | 5.1 KB | 10.4 KB | 5.3 KB |

For a specialist, more than half of the prompt is about something else.

### F-9. SOPs let the model grow prompts at run time

- `save_agent_sop` replaces another agent's SOP, and that SOP is added to the agent's prompt as "Mandatory agent SOP" (`server/runtime.mjs:137`).
- The size limit is 120,000 characters (`server/sops.mjs:16`). That is about ten times the orchestrator's whole role file.
- The orchestrator holds `save_agent_sop`. In RUL-6 it wrote an SOP itself in 9 of 14 runs.
- "Every quotation must show a validity of 14 days" is an owner rule. It should be data that code applies. Today the quotation validity is fixed at 30 days in code (`document_inteligence/core/documents.mjs:300`), and there is no company setting for it.
- So the rule becomes prompt text, and the Document Agent may or may not follow it.

### F-10. The roster is "every agent in the table"

`server/companies.mjs:45-47` gives a new company every agent that is not a platform agent. That includes a test agent called "Alphabetizer (MVP Test)". Any agent seeded for any reason shows up on every company's roster, and the orchestrator has one more card to choose from.

### F-11. A simple lookup goes through two models and a queue, and the reply does not contain the answer

"Do we already have a product with SKU X?" runs like this:

1. The orchestrator calls `list_specialists`, writes a plan and calls `submit_plan`.
2. The user's reply says "Queued". It does not say yes or no.
3. Later, the Records Clerk starts, calls `find_catalog`, and finishes.
4. The answer is stored. The post-mortem confirms that plan results are not pushed to the chat. In EXP-R1 and EXP-SEED, the chat said "Queued" while the clerk ended `blocked`.

Each model hop is another chance for variation. Queuing suits long jobs, not a lookup.

### F-12. The reply claims success before there is a result

In RUL-6, rep 17, the orchestrator replied: "Understood — quotations will now carry a 14-day validity." The DB Manager task ended `blocked`, and nothing changed. The user was told the change was made.

### F-13. Old and new mechanisms run side by side

- **Two plan runners.** The v1 runner in `server/orchestrator.mjs` still starts at boot (`server/index.mjs:2366`), but nothing calls the v1 `submitPlan` any more. The v2 runner is `server/execution/runner.mjs`.
- **Three ways to create a staff person.** See F-3.

Each new mechanism was added next to the old one instead of replacing it.

### F-14. The fix process blames the wrong part

The post-mortem's own defect list puts three findings on the wrong component:

| Post-mortem item | Blamed | Actual cause |
|---|---|---|
| F3 | Form Designer | The orchestrator added the extra scope |
| F6 | Company Onboarding | The orchestrator's own `create_person` |
| F8 | Model variance | The cut card text |

A fix list built from that report would have patched the specialists while the orchestrator went on making the bad decisions. That is how each round adds code and fixes nothing.

### Not orchestration (corrections)

- **Attachments (F5 in the post-mortem) are a real path bug.** The file is stored in the orchestrator's folder, and the specialist gets a path it cannot open (post-mortem, section 10).
- **Some "simple question" failures come from the test sentence.**
  - "Do we already have a product with SKU X?": in 7 of 22 runs the orchestrator asked whether "X" was a placeholder. That is a reasonable question.
  - EXP-N1 failed because its oracle forbids a read the clerk had good reason to make.

## 4. What is already right: keep it

These parts are deterministic and they work. Do not replace them with model judgement.

- **Typed completion.** Specialists finish with `finish_run`, and code checks the evidence (`server/execution/runner.mjs:456`):
  - cited tool calls must belong to this attempt
  - unknown write outcomes block `done`
  - `blocked` and `failed` need a reason code
- **Permission gates in code:**
  - `requireAdmin` on profile writes (the F1 fix)
  - `PERMISSION_DENIED` on the SOP tools
  - `userAssignedAgent` on dispatch
- **Plan validation** (`server/execution/runner.mjs:661`). `submitPlanHandler` checks that:
  - the agent exists
  - it is assigned to the user
  - it is not the orchestrator
  - the task dependency graph is valid
- **The company setup gate.** `companyDispatchGate` blocks operational Document Intelligence work until the minimum company profile exists (`server/orchestrator.mjs:594`).
- **The v2 test harness:** a fresh company per rep, a preflight check, one oracle per case written before the run, waiting for runs to settle before judging, and k of 3.
- **The prompt lint test** (`server/agent-prompts.test.mjs`). The idea is right; extend it (section 8).
- **The Pi gate and the LLM gate:** they make work wait in a queue instead of refusing it.

## 5. Root cause: who decides

| Decision | Today | Should be |
|---|---|---|
| Which agent owns the request | The model reads 18 cut prose cards | **Data**: an intent registry with one owner per request type |
| One task or several | The model | **Data**: one owner, or a fixed template |
| What the task says | The model's paraphrase | **The user's own words**, plus structured fields |
| Whether to add a checker | The model | **Data**, per request type; code checks first |
| No agent fits | The model invents a substitute | **Code**: a fixed reply naming the blocker |
| Confirm before delete or publish | Text in the specialist's prompt | **Code**: the tool requires a confirmation token |
| Who may do it | Code | Code (keep) |
| Company rules ("quotes valid 14 days") | The model writes SOP text | **Data**: a setting that code applies |
| Which agents a company has | Whatever is in the agents table | **Data**: an allowlist |
| When the user gets the answer | Always queued | Reads answered in the same turn; long jobs queued |

**Why the prompts keep growing:** each fix tries to steer a model decision with more words, but words do not bind a model. The next run differs, so the next fix adds more words. The only way out is to take the decision away from the model.

## 6. Architecture decisions (proposed; the owner must approve)

**AD-1. Code decides, the model fills in.**
The model does two narrow jobs only:
- it picks one request type from a closed list
- inside a specialist, it turns the request into tool arguments

Everything else is code or data.

**AD-2. One owner per request type, kept in an intent registry.**
One data file (or table) lists every request type the product supports, with its owner agent and its rules. It is the single source of truth. The router's list, the menu, the test cases and the roster check are all generated from it.

**AD-3. The orchestrator routes and relays. It does no work itself.**
- Its tools become `route_request` and `task_status`.
- People tools move to Company Onboarding, SOP tools to the FDE, and email becomes a request type with its own owner.
- Its role prompt shrinks to routing rules only.

**AD-4. A single-owner request becomes one task carrying the user's own words.**
Nothing is paraphrased and no scope is added. The task contains:
- the user's message
- the signed-in line
- the extracted fields
- references from the session

The specialist reads what the user actually wrote.

**AD-5. Multi-step work comes only from fixed templates.**
Example: "save the logo from our website" maps to the template `website.logo.save`: inspect the website, then save the logo, with fixed owners and a fixed order. The model never builds a task graph. If a request needs steps that no template covers, the reply lists what can be done, one step at a time.

**AD-6. When nobody owns a request, code gives a fixed reply. Never a substitute.**
"No agent on your account does <x>. An admin can add it." Do the same for "not assigned to you". The reply names the blocker, so it fits the owner-authority rule. It is not the model refusing.

**AD-7. Destructive and public actions are confirmed in code.**
For delete, archive, publish and send:
- The first call returns a preview and a token.
- The commit call requires that token.
- The token is bound to the user and the session, and it can only be used after the user answers.

A prompt cannot skip this step.

**AD-8. Read requests are answered in the same turn.**
For a read, the router waits for the owner's answer (with a limit, for example 60 seconds) and passes it on. Only long jobs are queued, and their results are pushed to the chat.

**AD-9. Prompts and SOPs have size budgets, enforced by tests.**
- Each role file and each assembled prompt has a size cap.
- Shared blocks are included only where they apply.
- SOPs stay small. Only the FDE writes them, with a preview, and they cannot change routing or permissions.
- An owner rule that can be a setting becomes a setting.

**AD-10. Determinism is measured, and it gates releases.**
Every harness run reports path stability and routing accuracy. A change that lowers either one is a regression, even if the pass rate goes up.

## 7. Target design

```
User message
  └─ Router (model, small prompt, one tool: route_request)
       picks ONE key from the intent list, or "unclear", or "none"   ← the only routing decision
  └─ Code
       ├─ key not in the list, or owner not on the roster → fixed reply (AD-6)
       ├─ "unclear" → one fixed question offering 2–3 candidate keys
       ├─ permission check (code, as today)
       ├─ single owner → one task: the user's words + fields (AD-4)
       ├─ template → fixed tasks, fixed order, fixed checker (AD-5)
       └─ read → wait for the answer and pass it on (AD-8)
  └─ Specialist (model, small prompt, only its own tools)
       fills in tool arguments; destructive tools need a token (AD-7)
       finish_run → checked by code (as today)
  └─ Code checker: the database row exists, the count changed, the right owner ran
  └─ Reply = the owner's summary, passed through unchanged
```

### Intent registry: example entries

```yaml
- key: records.customer.add
  owner: di-records
  kind: write
  fields: [company_name, person_name, email?, phone?]
  answer: same-turn
  check: a di.customer row exists for company_name
  examples: ["Add a new customer, Maya Tan from Greenleaf Sdn Bhd", "Add this name card"]

- key: records.archive
  owner: di-records
  kind: destructive
  confirm: token            # AD-7
  check: the record is archived only after confirmation

- key: company.audit_log.read
  owner: di-db
  kind: read
  answer: same-turn

- key: company.profile.update
  owner: di-onboarding      # owner decision: Onboarding or DB Manager, never both
  kind: write
  roles: [superadmin]       # enforced by the tool, as after the F1 fix

- key: website.logo.save
  template:
    - { step: find_logo, owner: <browsing agent> }
    - { step: save_logo, owner: di-onboarding, after: find_logo }
```

The router sees only each `key` and a single routing line per key. That line is written for routing ("Owns: … Not: … → other key") and is never cut.

### Follow-up messages

For "Issue that invoice", session state (code) keeps the last request type and the ids it produced. The router receives those ids, not a free-text summary of the conversation.

## 8. What to add (suggested order)

Each item names the model decision it removes. Size: S = small, M = medium.

| # | What to add | Removes | Size |
|---|---|---|---|
| 1 | Intent registry (a data file) with one owner per key, plus a test that fails when a key has no owner or two keys overlap | The model choosing the owner (F-2, F-3) | M |
| 2 | Owner decisions on the overlaps: customer and name card, company profile, rules, staff, email | Ownership overlap (F-3) | owner |
| 3 | A `route_request` tool with a fixed list of keys, checked by code. Keep `submit_plan` for templates only. | The model writing plans (F-5) | M |
| 4 | Fixed replies in code for "none", "not assigned" and "unclear" | Invented substitutes (F-5) | S |
| 5 | Verbatim hand-off: each task = the user's words + fields | Paraphrase and scope growth (F-6) | S |
| 6 | Remove worker tools from the orchestrator; move people, SOP and email to their owners | The router doing the work (F-4) | S |
| 7 | Confirmation tokens on delete, archive, publish and send | Confirmation that depends on prompt text | M |
| 8 | A company roster allowlist; remove test agents from companies | Roster drift (F-10) | S |
| 9 | A prompt budget test: caps per role file and per assembled prompt. Growing one needs owner approval and the removal of the same amount of text elsewhere. | Prompt growth (F-7) | S |
| 10 | Context packs per profile: no `HOST-COMMON.md` for agents without a shell, and the reply style only where the agent replies to the user | Irrelevant context (F-8) | S |
| 11 | SOP limits: a small cap (for example 1,500 characters), written only by the FDE, with a preview and a lint check on save | Prompt growth at run time (F-9) | S |
| 12 | Owner rules as settings, starting with the default quotation validity | Rules held as prompt text (F-9) | S each |
| 13 | Record `intent` and `owner` on every run event | Having to infer routing from traces | S |
| 14 | Path stability and routing accuracy in `report.mjs`; the golden gate requires the same path 3 of 3 times | Hidden randomness (F-1) | S |
| 15 | Same-turn answers for reads; push long-job results to the chat | The second hop and "Queued" replies (F-11) | M |
| 16 | Replies built only from recorded results: code rejects "done" wording when the task is not done | False confirmations (F-12) | S |
| 17 | Remove the v1 runner and the duplicate people paths | Two mechanisms side by side (F-13) | S |

Suggested order: 2 (the owner decides), then 1, then 4, 5 and 6, then 3, then 7, then the rest. Items 9, 13 and 14 only measure and guard, so they can come first.

## 9. Mistakes to avoid at all costs

Every one of these has already happened in this repo.

1. **Fixing behaviour with prompt text.** `orchestrator.md` grew 69% in eight days, and the same sentence still takes up to 6 paths (F-1, F-7).
2. **Adding a special-case section for one scenario,** such as the logo pipeline or the scheduled-job status check. Each one adds noise to every other request.
3. **Letting the model pick the owner from prose descriptions,** and then cutting that prose (F-2).
4. **Letting two agents own the same kind of request** (F-3).
5. **Giving the router worker tools** (F-4).
6. **Letting the model rewrite the user's request into a task** (F-6).
7. **Letting the model invent a plan when the right agent is missing** (F-5).
8. **Blanket instructions** such as "never refuse", "always dispatch" or "never say X before trying". They force the model to improvise. Put the rule in code.
9. **Fixing model randomness with more model steps,** such as a model deciding whether to check, or a model judging another model. Check in code first.
10. **Fixing from a symptom or from a report's "Fix:" line.** The post-mortem blamed the wrong component for three of its findings (F-14). Trace first.
11. **Judging from a single run, or from the reply's wording.** Use k of 3 and database oracles.
12. **Changing the test harness and the product in the same step.** Afterwards you cannot tell which one moved the score.
13. **Putting shared boilerplate in every prompt** (F-8).
14. **A roster that is whatever happens to be in the table** (F-10).
15. **Letting one agent write another agent's prompt without limit** (F-9).
16. **Saying "done" before there is a recorded result** (F-12).
17. **Adding a new mechanism next to the old one** instead of replacing it (F-13).
18. **Believing that more is better.** More agents, tasks, checkers and prompt text mean more places for behaviour to vary. Simple and fixed beats clever and flexible.

## 10. SOP for any change to agents or orchestration

1. **Read** this file and `report/post-mortem-question-menu-run.md`.
2. **Name the case.** Every change starts from a case ID in `tests/question-menu/v2/cases.mjs`, backed by k of 3 evidence. No case, no change. If no case exists, add one, run it 3 times, and show it failing.
3. **Find the deciding component in the trace.** Check, in this order, and name the first one that went wrong:
   1. the orchestrator's events before `run.finished` (the routing decision)
   2. the task text
   3. the specialist's tool calls
   4. the tool results
   5. the code
4. **Classify the finding** as one of:
   - test defect
   - spec gap (an owner decision)
   - model variance (fails 1 of 3)
   - product bug
   - design (a model decision that should be data or code)
5. **Pick the fix from the ladder.** Use the highest rung that works:
   1. Data: the intent registry, the roster, an owner, a setting
   2. Code guard: tool validation, a permission, a confirmation token, a fixed reply
   3. Code checker: a database row, a count, the right owner ran
   4. Remove the prompt text that causes the behaviour
   5. A model-based checker
   6. Add prompt text. This is the last resort: at most one sentence, with owner approval, and remove at least as much text elsewhere.
6. **Write the decision line** in the commit message: `Model decisions: removed <x>; added <none>`. If anything is added, explain why no higher rung works.
7. **Test:**
   - the unit tests pass
   - the regression case turns green 3 of 3 times
   - the golden set stays green 3 of 3 times
   - path stability and routing accuracy do not drop
8. **Get the owner's approval.** Commit on `main` only.
9. **Update this file:** mark the finding as fixed and name the commit.

## 11. Tips

- **A tool error beats a prompt rule.** A model can ignore text, but it cannot get past a refused call.
- **Write routing lines for routing, not for selling.** For example: "Owns: customers, contacts, products. Not: staff (→ people.add)."
- **Fewer tools mean fewer wrong choices.** Give each agent only its own tools, and never mention a tool the agent does not have.
- **Name tools so they cannot be confused.** A tool called `create_person`, meant for staff, invites the model to use it for "add a customer". If two similar tools must exist, the names should state the difference, for example `add_staff_member` and `add_customer`.
- **Keep the user's words.** Pass them through, and put structured fields next to them, not in their place.
- **Let the model fill in arguments, not decide the flow.**
- **Fixed messages live in code:** refusals, "not assigned", "queued", "needs confirmation".
- **Owner rules are data.** If a rule can be a setting, make it a setting before anyone writes an SOP.
- **Measure path stability, not only the pass rate.** A case can pass while taking six different paths.
- **A low temperature helps the router a little.** It does not replace structure.
- **Make one change at a time,** and rerun the golden set 3 times after each one.
- **A small decision space allows a small model.** Once routing is a choice from a closed list, a cheaper and faster model can do it.

## 12. Owner decisions needed

1. Approve, change or reject AD-1 to AD-10.
2. Choose one owner for each overlap:
   - customers, contacts and name cards: Records Clerk (recommended)
   - company profile: Company Onboarding or DB Manager, only one of them
   - "rules": settings first; FDE for expense rules and SOPs; DB Manager for document rules and numbering
   - staff and logins: Company Onboarding (recommended)
   - email: which agent owns it, or whether code sends it directly
3. Should reads be answered in the same turn? Yes or no.
4. The 31 GAP areas in the menu are platform agents that a company can never have. Remove them from the client menu, or make them assignable.
5. Prototyper: build it, or remove it from the menu.
6. Decide what counts as confirmation for delete, archive, publish and send.
7. Set the company roster allowlist.
8. Set the size caps for prompts and SOPs.

## 13. Status: the core rework (built 2026-10-11, not yet on prod)

**Owner decisions taken on 2026-10-11:** do the core first; Company Onboarding owns the company profile; reads are answered in the same turn; ask before every push.

**What was built.** Section 2 described the old flow. The flow now is:

```
User message
  └─ Orchestrator (model): one tool, route_request; picks ONE key   ← the only model decision
  └─ server/routing.mjs (code):
       ├─ none / help / unclear / not assigned / profile incomplete → fixed reply
       ├─ request_status → the last request's status, from the database
       └─ owner key → one task: the user's message exactly as typed, plus the previous exchange as context
  └─ Owner agent runs it → finish_run (checked by code, as before)
  └─ The chat waits up to 60 s (ROUTE_WAIT_MS) after the orchestrator's turn has freed its Pi slot
       ├─ finished → the owner's own summary is this turn's reply
       └─ still running → "<owner> is still working on it"; the answer posts to the chat when ready
```

| Item (section 8) | Done | Where |
|---|---|---|
| 1. Intent registry, one owner per key, validated by a test | yes | `agent/intents.json`, `server/routing.test.mjs` |
| 3. `route_request` with a fixed list of keys, checked by code | yes | `server/routing.mjs`, `server/execution/registry.mjs` |
| 4. Fixed replies in code | yes | `server/routing.mjs` |
| 5. The user's words, unchanged | yes | `ctx.input` from the run binding (`runner.mjs`, `dispatch.mjs`) |
| 6. No worker tools on the orchestrator | yes | `manifestForAgent` gives it `route_request` only, no MCP |
| 9. Prompt budget test | yes | `agent/prompt-budgets.json`, `server/prompt-budget.test.mjs` |
| 13. `intent` and `owner` on run events | yes | `route.decided` events |
| 14. Routing numbers in the report | yes | `tests/question-menu/v2/report.mjs`, "Routing" section |
| 15. Same-turn answers | yes | `finishRoutedTurn` in the chat handler (`server/index.mjs`) |
| 2, 7, 8, 10, 11, 12, 16, 17 | not yet | |

**Size.** The orchestrator's whole prompt is now about 1 KB of role text plus a 3.7 KB key list, generated from `agent/intents.json`. Before, it was 16.7 KB of prompt plus 12 tool schemas.

**Two defects found and fixed along the way:**
- On the v2 runner, Company Onboarding's people tools (`list_people`, `create_person`, `update_person`) were Document Intelligence copies that always threw "User administration must run through the authenticated host". Only the orchestrator's native copies worked. Onboarding now gets the native tools.
- The minimum company profile gate existed only in the old v1 runner and in prompt text. `route_request` now enforces it in code.

**Behaviour that changed on purpose:**
- **Saving a logo from a website no longer runs as two steps.** That needs a fixed template (AD-5, next). Today the request goes to Company Onboarding alone, which cannot browse.
- **Email is owned by the Document Agent,** the only company agent that has the EE-Mail tool. You can change this with one line in `agent/intents.json`.
- **SOP changes go to the FDE** (`company_rules`). The orchestrator can no longer write SOPs.
- **A scheduled run that targets the orchestrator does not wait.** Its routed answer posts as a chat message.

**Known gaps:**
- If the model skips `route_request`, its own text stands. The report counts this as `no-route`.
- The orchestrator's own Pi memory keeps "Asking …", not the answer. The owner still gets the last exchange from the stored chat.
- Specialists still get the shared boilerplate (item 10).

**Verification so far.** Local only:
- `npm test` passes, including a new end-to-end routing test on the embedded database.
- The new `npm run test:orchestration` passes.
- The scheduler tests pass.
- The Document Intelligence tests pass, except "prompt size caps" (`di-documents.md` is 4,293 characters against 4,000), which was already failing before this work.

**Still to do on prod:** push, then run the golden set 3 times, the regression set, and compare routing with Appendix A.

## Appendix A. How to measure determinism

Both numbers come from the orchestrator's first decision, meaning its events before `run.finished`.

- **Path stability:** the share of cases where every run took the same path. A path is the set of agents in the plan, plus any action the orchestrator did itself, or "reply only" when it did neither.
- **Routing accuracy:** the share of runs where the plan went to the expected owner (`needs` in `cases.mjs`) and only to that owner. It counts only runs where that owner is on the company's roster.

**Baseline** (reps 2 to 17, run on 2026-10-10 and 2026-10-11): path stability 49 of 109; routing accuracy 78% over 720 runs.

The script only reads traces. Save it as a file, then run it from the repo root with `node <file>`.

```js
// Reads traces only. Prints path stability and routing accuracy for the orchestrator's first decision.
// Usage (from the repo root): node measure-routing.mjs [evidenceDir]
import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url";
const V2 = path.resolve("tests/question-menu/v2");
const EV = process.argv[2] || path.join(V2, "evidence");
const mod = await import(pathToFileURL(path.join(V2, "cases.mjs")));
const scripts = Object.values(mod).find((v) => Array.isArray(v) && v[0]?.turns);
const chained = new Set(scripts.flatMap((s) => (s.chain && s.turns.length > 1 ? s.turns.map((t) => t.id) : [])));
const OWN = new Set(["create_person", "update_person", "save_agent_sop", "ee-mail__send_email"]); // the orchestrator's own action tools
const COMPANY = (a) => a.startsWith("di-") || ["scheduler", "company-deep-research", "ads-research", "media-ai"].includes(a);
const per = {}; const acc = { runs: 0, exact: 0, extra: 0, wrong: 0, self: 0, none: 0 };
for (const run of fs.readdirSync(EV).filter((d) => /^(B0|B1|B2|REG)/.test(d))) {
  for (const f of fs.readdirSync(path.join(EV, run)).filter((x) => x.startsWith("trace-"))) {
    let t; try { t = JSON.parse(fs.readFileSync(path.join(EV, run, f), "utf8")); } catch { continue; }
    if (!t.events || !t.dbState || chained.has(t.case.id)) continue;
    const end = t.events.findIndex((e) => e.kind === "run.finished"); // the orchestrator's events stop here
    const ops = t.events.slice(0, end < 0 ? undefined : end).filter((e) => e.kind === "tool.started").map((e) => e.op);
    const agents = [...new Set(t.dbState.tasks.map((x) => x.agent_id))].sort();
    const self = [...new Set(ops.filter((o) => OWN.has(o)))].sort();
    const planned = ops.includes("submit_plan");
    const sig = [planned ? `plan[${agents.join("+")}]` : "", self.length ? `self[${self.join("+")}]` : ""].filter(Boolean).join(" ") || "reply-only";
    const c = (per[t.case.id] ||= { n: 0, sigs: {} }); c.n++; c.sigs[sig] = (c.sigs[sig] || 0) + 1;
    const need = t.case.needs || [];
    if (need.length === 1 && COMPANY(need[0]) && ["read", "write"].includes(t.case.cls)) {
      acc.runs++;
      if (planned) acc[agents.length === 1 && agents[0] === need[0] ? "exact" : agents.includes(need[0]) ? "extra" : "wrong"]++;
      else acc[self.length ? "self" : "none"]++;
    }
  }
}
const seen = Object.entries(per).filter(([, c]) => c.n >= 3);
const stable = seen.filter(([, c]) => Object.keys(c.sigs).length === 1).length;
console.log(`PATH STABILITY: ${stable} of ${seen.length} cases took one path every time (cases seen >= 3 times, chains excluded)`);
const pct = (k) => `${acc[k]} (${Math.round((100 * acc[k]) / acc.runs)}%)`;
console.log(`ROUTING (${acc.runs} runs, owner on roster): exact owner ${pct("exact")}, owner + extra ${pct("extra")}, wrong agent ${pct("wrong")}, did it itself ${pct("self")}, no dispatch ${pct("none")}`);
for (const [id, c] of seen.filter(([, c]) => Object.keys(c.sigs).length >= 3).sort((a, b) => Object.keys(b[1].sigs).length - Object.keys(a[1].sigs).length))
  console.log(`  ${id.padEnd(8)} ${Object.keys(c.sigs).length} paths: ${Object.entries(c.sigs).map(([s, n]) => `${n}x ${s}`).join(" | ")}`);
```

Limits of the method:
- Cases in multi-turn chains are left out, because one session's tasks mix several turns.
- Some path variation is fair, because company data differs when an earlier case fails.
- "No dispatch" includes fair clarifying questions.

## Appendix B. Evidence index

| Finding | Cases | Where |
|---|---|---|
| F-1 | RUL-6, CMP-N2, REC-R3, FRM-R4, CMP-R2 | `tests/question-menu/v2/evidence/` (run Appendix A) |
| F-2 | CMP-R3 | `server/orchestrator.mjs:41-42`, `document_inteligence/host.mjs:35-108` |
| F-3 | CMP-N2, CMP-R1, RUL-6, REC-R1, REC-R3 | `document_inteligence/host.mjs:35-108`, `document_inteligence/core/tools.mjs:191` |
| F-4 | REC-R3, REC-R1, REC-R5, CMP-R0 | `server/execution/profiles.mjs:95-101`, `server/catalog.mjs:1121`, `document_inteligence/core/user-tools.mjs:20` |
| F-5 | PRT-R1, ADS-R2 | `agent/roles/orchestrator.md` lines 9, 14, 16, 21; `server/agent-prompts.test.mjs:56` |
| F-6 | FRM-R2 (B2-r6), RUL-5 (B2-r7) | the trace replies |
| F-7 | — | `git log -- agent/roles/orchestrator.md` |
| F-8 | — | `server/runtime.mjs:128-142`, `server/context-pack.mjs:90` |
| F-9 | RUL-6 | `server/sops.mjs:16`, `server/runtime.mjs:137`, `document_inteligence/core/documents.mjs:300` |
| F-10 | — | `server/companies.mjs:45-47` |
| F-11 | REC-Q1 (B0-r16), EXP-R1 | the trace events |
| F-12 | RUL-6 (B0-r17) | the trace reply and task status |
| F-13 | — | `server/index.mjs:2366`, `server/orchestrator.mjs:289` |
| F-14 | F3, F6, F8 | `report/post-mortem-question-menu-run.md`, section 10 |
