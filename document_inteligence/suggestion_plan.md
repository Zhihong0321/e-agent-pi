# Suggestion plan after the first and second stress tests

**Date:** 28 September 2026  
**Status:** Recommendations for implementation; no product fixes are included in this plan.

## What the tests establish

The two isolated Pi/MCP runs achieved **30/30 intended scenario outcomes**. The first run made 35/35 successful business-tool calls. The second made 37/40; its three errors were an expected malformed-template rejection and two document lookups that the agent recovered from. Customer matching, draft/issue boundaries, conversion, payment allocation, and the refusal to edit or void ineligible documents worked in the tested database state.

The largest remaining risk is **what the agents tell the user after a correct tool action**. The first run exposed literal `<think>` text twice and offered a payment-date correction without a tool for it. The second run reported a quotation as `accepted` after conversion had changed it to `converted`, suggested a payment reversal through the DB Manager although that agent has no reversal tool, predicted a future invoice number, and overstated some missing data as universal issue blockers. Its DB Manager also enforced one PO field twice, producing duplicate readiness blockers.

The runs used different models, prompts, and starting data (`qwen3.8-max` for the first; `opencode-go/deepseek-v4.1-flash` for the second). Their scores are useful diagnostics, **not a controlled model comparison**. Both runs used isolated PGlite and MCP tools; neither proves the live UIv2/Postgres deployment or served PDF links.

## Prioritized work

| Priority | Change | Why now | Done when |
|---|---|---|---|
| P0 | Keep reasoning text out of user replies | Two first-run replies exposed `<think>` text; reply extraction can fall back to a thinking block. | No reasoning tags or thinking snippets reach streamed or saved replies, including when tags cross chunk boundaries. |
| P0 | Stop unsupported payment-correction advice | Both runs contained promises or handoffs for payment edits/reversals that the exposed tools cannot perform. | Agents state the actual available action and ask for an operator-led resolution when no correction tool exists. |
| P1 | Report final document state after multi-step actions | Conversion reply showed the intermediate `accepted` state instead of final `converted`. | Conversion replies use the final source status and linked invoice from tool output or a fresh read. |
| P1 | Make readiness rules single-source | `required_for=invoice.issue` plus an explicit custom-field workflow rule produced two PO blockers. | One missing field yields one question and one blocker. |
| P1 | Improve document discovery | The agent failed on a short customer name and a draft reference before finding the draft by listing. | Users can find drafts by customer name and reference without accepting an ambiguous match. |
| P1 | Preserve structured customer identity and distinguish warnings | A confirmed legal-looking company name was saved only in `name`; reply overstated TIN/payment-term requirements. | Legal name is saved when supplied, and replies distinguish blockers, warnings, and optional data. |
| P2 | Register the exact tested OpenCode model in the product catalog | The test used an isolated Pi model entry because the checked-in catalog lacks `deepseek-v4.1-flash`. | The product can select `opencode-go/deepseek-v4.1-flash` directly with its configured credential and no silent fallback. |
| P2 | Run a live deployment smoke test | Both stress tests bypassed the UI host and production Postgres. | One end-to-end scenario succeeds through login, chat, database roles, issue, and served PDF link. |

## Implementation notes and acceptance checks

### 1. User-facing reply boundary (P0)

`../server/pi-stream.mjs:127-155` appends Pi text deltas directly to the visible reply. `../server/pi-stream.mjs:29-38` can use the first thinking block as a fallback reply when no text exists. The universal style prompt in `../server/reply-style.mjs` already says to keep working notes out, so prompt wording alone has not been enough.

- Add a **chunk-safe assistant-output filter** at the Pi stream boundary for literal reasoning wrappers such as `<think>...</think>`. Apply the same rule when final `message_end` text replaces streamed text. Keep legitimate tool results and user input untouched.
- Remove the thinking-block fallback from `extractReply`; use a neutral “no final reply produced” state instead. Keep diagnostic thinking data separate from the user-facing answer.
- Add focused tests for complete tags, tags split over multiple deltas, missing closing tags, and an assistant turn with thinking but no final text. Re-run first-test prompts 6 and 10 on the same model before considering this fixed.

### 2. Payment corrections and agent capability claims (P0)

`core/tools.mjs` exposes `record_payment` to the Document Agent, but no payment edit, unallocation, refund, or reversal tool to the Document Agent or DB Manager. `core/documents.mjs:540-574` records receipts and allocations; it does not reverse them. The first run offered to correct receipt dates; the second told the user to ask DB Manager to reverse a receipt.

- Update `../agent/roles/di-documents.md` and `../agent/roles/di-db.md` to say explicitly that recorded payments cannot currently be edited or reversed through these agents. Do not promise that a credit note automatically offsets an invoice unless the backend establishes that link.
- For a recorded-payment mistake, give a truthful escalation: preserve the receipt and invoice state, report the exact receipt and balance, and say that an authorized accounting correction outside the current agent tools is needed.
- Treat a future reversal feature as a separate design decision. Specify who may initiate it, how refund or unallocation differs from reversal, audit history, idempotency, and how invoice `amount_paid` and status are recalculated atomically. Only then add a dedicated tool and tests. Avoid making the current DB Manager sound capable of the future workflow.
- Add agent evaluations for “change a receipt date,” “refund a partial payment,” “void a partially paid invoice,” and “apply an overpayment.” Passing means no unsupported tool promise and no unintended database write.

### 3. Final-state and numbering language (P1)

`core/documents.mjs:485-526` changes a converted quotation to `converted`, while `convert_to_invoice` returns the new invoice draft. The agent used the earlier `accepted` result in its reply. The same run predicted the next invoice number before another invoice was issued.

- Return the source quotation's **final status and number** alongside the converted invoice, or require a `get_document` read after conversion. Use that final state in the reply.
- Add a rule to `../agent/roles/di-documents.md`: show a document number only after `issue_document` returns it; say “next number on issue” while still in draft. Do not forecast a particular future number.
- Test the `issued → accepted → converted` sequence and concurrent issuance between draft and issue. The reply should match the final stored status and actual assigned number.

### 4. Single PO requirement (P1)

`core/workflows.mjs:86-95` derives a custom-field blocker from `required_for`. `core/documents.mjs:126-135` appends those blockers to explicit workflow rules. In second-test prompt 19 the agent set both, and prompt 20 received two PO questions and two PO blockers.

- Make `required_for` the default way to require a custom field. Update `../agent/roles/di-db.md` so `set_workflow_rules` is used for additional policy, not to repeat a field's `required_for` setting.
- Add a backend safeguard in `rulesFor` or `setWorkflowRules`: normalize `po_number` and `document.po_number` to the same field identity and reject or deduplicate equivalent `custom_field` rules. Preserve a deliberate custom message if one was explicitly configured.
- Test both entry orders (field first, rule first), then verify `prepare_document` and draft `readiness` each return **one** PO item. Existing configured tenants should be handled by the same deduplication logic.

### 5. Draft lookup by reference and customer (P1)

`core/documents.mjs:93-99` resolves a document only by UUID or issued number; an unnumbered draft's `reference` does not work there. `core/documents.mjs:188-201` omits `reference` from `list_documents`, while its customer filter reaches `core/records.mjs:327-332`, which accepts only customer UUID or code.

- Include `reference` in list results and add an explicit reference filter for drafts and issued documents. Allow a unique exact customer name in the list filter, while returning candidates for ambiguous names rather than choosing one silently.
- Keep UUID and issued number as definitive identifiers for writes. When a reference matches multiple documents, return an ambiguity error with their IDs, status, customer, and dates.
- Test the Eastbank `EDGE-NO-ADDR` case directly, duplicate references, similar customer names, and references shared across document types.

### 6. Customer identity and readiness wording (P1)

Second-test prompt 4 stored “Northstar Logistics Demo Sdn Bhd” in `name` but left `legal_name` empty. The Records Clerk role already describes both fields in `../agent/roles/di-records.md`; this needs a concrete save/read-back rule. The agent also described TIN and payment terms as mandatory for quotation and invoice issue even though the tested readiness rules did not make all of them blockers.

- When the user supplies a legal name, send `legal_name` separately. If the only supplied company name is clearly the registered name, using it in both `name` and `legal_name` is acceptable; do not invent a different trading name. Read the saved fields back before claiming completion.
- In role guidance, use `describe_schema` or document `readiness` to label each missing field as **blocking**, **warning**, or **optional** for the specific document type. Do not turn future MyInvois needs into a current issue blocker without a rule that says so.
- Test separate trading/legal names, one registered name, missing TIN, and an invoice with an explicit due date but no customer payment terms.

### 7. Product model registration (P2)

`../agent/model-catalog.json` and `../.pi/agent/models.json` list OpenCode Go models but not the exact `deepseek-v4.1-flash` used in the second test. The isolated runner `test/manual-pi-edge-eval.mjs` configured and selected it explicitly.

- Add the exact model ID under provider `opencode-go` in the product catalog, using the existing OpenCode Go credential mapping in `../server/models.mjs`. Align the checked-in Pi config with the credential variable that the product actually supplies. Mark only verified capabilities (the stress test exercised text and tools, not vision).
- Add a startup or selection smoke check that reports the chosen provider/model and fails visibly if unavailable; do not silently route to a different model.
- Keep the first and second reports labelled with their actual models. Re-run identical prompts and fixtures if a model-to-model quality comparison is wanted.

### 8. Regression suite and deployment gate (P2)

The repeatable isolated runners are `test/manual-pi-eval.mjs` and `test/manual-pi-edge-eval.mjs`. Keep deterministic backend tests in the normal test suite, and use the live model runs as a separate evaluation gate.

- Turn the most important scenarios into assertions on **database state and response claims**, not just successful tool calls: no duplicate customer/SKU, no issued edit, no duplicate conversion, no overpayment write, no paid-invoice void, no thinking leak, correct final status, and no unavailable correction promise.
- Label expected validation errors (malformed template) separately from avoidable lookup errors. Capture provider/model identity and the exact fixture in each evaluation artifact.
- Run one staging smoke test with Postgres `DATABASE_URL`, the intended database role separation, UI chat, document issuance, Chromium rendering, and fetching the issued PDF through the application's file route. Verify the link opens for the authorized user.
- Compare outcomes against the 30-prompt baseline after each change; treat any stored-state regression as a release blocker.

## Recommended sequence

1. Fix the reply boundary and payment-capability claims, then rerun the two prompts that exposed each issue.
2. Fix final-state reporting and PO-rule duplication, with deterministic backend tests.
3. Improve draft lookup and customer-field completeness, then rerun the affected second-batch prompts.
4. Register the exact OpenCode model in the product configuration and repeat a small model smoke test.
5. Run the full isolated evaluation and the staging Postgres/UI/PDF smoke test before calling the agent deployment-ready.

## Evidence

- `1st_stress_test_10_prompt.md`: prompts 6 and 10, and overall assessment.
- `2nd_stress_test_20_prompt.md`: prompts 4, 9, 12–13, and 18–20, and overall assessment.
- Raw transcripts and final database states are linked from both reports.
