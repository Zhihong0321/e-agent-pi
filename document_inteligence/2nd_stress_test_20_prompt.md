# Second stress test: 20 edge-case prompts

**Date:** 28 September 2026  
**Model used:** `opencode-go/deepseek-v4.1-flash` for every prompt, with no fallback  
**Outcome:** 20/20 intended data and workflow outcomes; 37/40 business-tool calls succeeded, with three handled validation/lookup errors. Response accuracy needs work.

## Model check and test setup

Before designing these prompts, I checked the Pi configuration and made a live one-turn Pi request to the exact `opencode-go/deepseek-v4.1-flash` model. It returned the requested sentinel text. The checked-in Pi catalog does **not** list this exact model; the user-level `local/deepseek-v4.1-flash` entry points to an inactive localhost proxy. This runner supplies an isolated Pi model entry for the OpenCode Go endpoint using the existing `OPENCODE_GO_TOKEN_PLAN` environment secret. Every scenario explicitly selects provider `opencode-go` and model `deepseek-v4.1-flash`; the runner has no alternative model path.

The 20 prompts ran in order through the Pi CLI, actual agent role prompts, Pi MCP adapter, real Document Intelligence MCP server and tools, an isolated PGlite database, and Chromium PDF rendering. Synthetic fixtures were seeded directly before prompt 1: Meridian Solar Demo as owner; Northstar C-0001 with Aina, billing address and 14-day terms; Eastbank C-0002 without a billing address and with 30-day terms; PNL-550 and SVC-INSTALL; issued quotation QT-2026-0001; and an unnumbered Eastbank invoice draft with reference EDGE-NO-ADDR. Fixture writes are recorded separately from the 20 model prompts. No production tenant was changed.

## Prompt 1 — Duplicate registration number

**Agent:** di-records

**Prompt**

> A new form says 'Northstar Food Supplies' with SSM 202398888888. Add it as a new customer. Before saving, check whether that registration number is already on file; if it is, explain the match and do not create a duplicate.

**Result:** Matched the exact SSM number to C-0001 (score 100); no duplicate was created.

**Comment:** Pass. It checked the strongest identifier before writing.

## Prompt 2 — Conflicting business card

**Agent:** di-records

**Prompt**

> Record this business card: Farid Rahman, Procurement Manager, Northstar Foods Demo Sdn Bhd, SSM 202398888888, farid@northstar.example, 012-000 0022. The card also prints a new address, 99 Jalan Palsu, Ipoh. Attach Farid to the existing company, but do not replace its saved billing address or its primary contact Aina.

**Result:** Added Farid as a non-primary contact under C-0001. Aina stayed primary and the saved billing address stayed unchanged.

**Comment:** Pass. The name-card path filled only blanks on an existing customer.

## Prompt 3 — Possible company match

**Agent:** di-records

**Prompt**

> A lead named Northstar Logistics Demo Sdn Bhd, SSM 202377777777, uses accounts@northstar.example. It might be a separate legal entity. Check for possible matches, but do not save it until I confirm how it relates to Northstar Foods.

**Result:** Found a possible match from the shared email (score 90), recognized the different SSM number, and stopped without saving.

**Comment:** Pass. It requested confirmation for an ambiguous relationship.

## Prompt 4 — Confirmed separate legal entity

**Agent:** di-records

**Prompt**

> I confirm Northstar Logistics Demo Sdn Bhd, SSM 202377777777, really is a separate company despite sharing accounts@northstar.example. Save it as a new customer, keep Northstar Foods intact, and tell me both customer codes.

**Result:** Created separate customer C-0003 using `allow_duplicate=true`; C-0001 stayed intact. The new row has the requested SSM and email.

**Comment:** Pass on duplicate handling; response/data quality issue. It put the full legal-looking name in `name` but left `legal_name` null. It also overstated that missing TIN and payment terms block quotation and invoice issue; the actual rules do not make all of these universal blockers.

## Prompt 5 — SKU collision

**Agent:** di-records

**Prompt**

> Someone sent a catalogue import row: SKU PNL-550, 'Budget panel', RM1, tax code ST10. Check the existing SKU. Do not change its RM650 price or create a duplicate; tell me how this conflict should be resolved.

**Result:** Read PNL-550 at RM650 and left it unchanged; no second PNL-550 row was created.

**Comment:** Pass. It treated the RM1 import row as a conflict requiring a decision.

## Prompt 6 — Unknown tax code

**Agent:** di-records

**Prompt**

> Add a new demo service with SKU SVC-NEW, name 'Site assessment', RM500, tax code SST99. Verify whether SST99 exists first. If it does not, leave the catalogue unchanged and ask for a valid code.

**Result:** Checked tax codes, found no SST99, and did not create SVC-NEW.

**Comment:** Pass. It did not silently use a different tax code.

## Prompt 7 — Unknown quotation customer

**Agent:** di-documents

**Prompt**

> Prepare a quotation for one PNL-550 panel for customer 'Ghost Factory'. That customer may not exist. Check first, do not guess an existing customer, and do not create a draft until it is resolved.

**Result:** `prepare_document` found no Ghost Factory customer and returned `ready_to_create=false`. No draft was made; the estimated panel total was RM715 including ST10.

**Comment:** Pass. It did not guess a customer or write a document.

## Prompt 8 — Malformed template

**Agent:** di-templates

**Prompt**

> I pasted an invoice template snippet: '<html><body>{{#each lines}}<p>{{description}}</p></body></html>'. It is missing a closing loop. Check its syntax and explain the error; do not save it or change the default template.

**Result:** `preview_template` rejected the snippet with `Unclosed {{#each lines}}`. No template was saved or made default.

**Comment:** Pass. The rejected preview call is an expected validation error, not an outage.

## Prompt 9 — Invoice missing billing address

**Agent:** di-documents

**Prompt**

> Issue the existing Eastbank invoice draft with reference EDGE-NO-ADDR. If required customer billing details are missing, tell me exactly what blocks issue and leave it as an unnumbered draft.

**Result:** Found the Eastbank draft and its readiness blocker: missing customer billing address. It remained unnumbered at RM715.

**Comment:** Pass after recovery. Two initial lookups failed because a short customer name and the free-text reference were not accepted as document identifiers; the agent then listed drafts and used the draft ID.

## Prompt 10 — Repair customer address

**Agent:** di-records

**Prompt**

> Eastbank Manufacturing has confirmed its billing address: 7 Jalan Kilang, 40400 Shah Alam, Selangor, Malaysia. Update only that customer's billing address, then read the record back.

**Result:** Updated C-0002's billing address and read it back; other customer fields remained intact.

**Comment:** Pass. The record change addressed the issue blocker.

## Prompt 11 — Issue repaired draft

**Agent:** di-documents

**Prompt**

> Now issue Eastbank's existing EDGE-NO-ADDR invoice draft. Show its invoice number, status, total, and PDF path.

**Result:** Issued the existing Eastbank draft as INV-2026-0001, total RM715, and rendered its PDF.

**Comment:** Pass. The document became numbered only after the billing address existed.

## Prompt 12 — Edit frozen invoice

**Agent:** di-documents

**Prompt**

> Change the issued Eastbank invoice's PNL-550 unit price from RM650 to RM1 and keep its invoice number. If issued documents are frozen, refuse the edit and explain the proper correction path.

**Result:** Refused to edit the issued invoice. The stored RM650 line price and RM715 total were unchanged.

**Comment:** Pass on document integrity; answer was too certain that a replacement would get INV-2026-0002. Another invoice could be issued first, as happened later in this run.

## Prompt 13 — Convert accepted quotation

**Agent:** di-documents

**Prompt**

> Northstar accepted issued quotation QT-2026-0001. Mark it accepted and convert it into an invoice draft. Show the linked source and total; leave the invoice unissued for review.

**Result:** Marked QT-2026-0001 accepted, then converted it into one unissued RM1,430 invoice draft linked to the quotation.

**Comment:** Pass on stored workflow; response defect. Conversion changed the quotation's final status to `converted`, but the reply's table still reported `accepted`.

## Prompt 14 — Repeat conversion

**Agent:** di-documents

**Prompt**

> Convert quotation QT-2026-0001 into a second invoice draft. Check whether it was already converted and do not create a duplicate invoice.

**Result:** Read the now-converted quotation and existing linked draft; created no second invoice.

**Comment:** Pass. The agent prevented duplicate conversion without needing a failing write.

## Prompt 15 — Issue converted invoice

**Agent:** di-documents

**Prompt**

> I approve the Northstar invoice draft converted from QT-2026-0001. Issue it now and show the number, due date, total, and PDF path.

**Result:** Issued the converted draft as INV-2026-0002, total RM1,430, due 12 October 2026, with a PDF.

**Comment:** Pass. Source linkage and prices were preserved.

## Prompt 16 — Overpayment

**Agent:** di-documents

**Prompt**

> Record a RM99,999 bank transfer against Northstar's newly issued invoice, reference EDGE-OVERPAY. If that exceeds the outstanding balance, do not post any payment; show the correct balance.

**Result:** Read the RM1,430 outstanding balance and posted no RM99,999 payment.

**Comment:** Pass. No receipt or allocation with reference EDGE-OVERPAY exists.

## Prompt 17 — Partial payment

**Agent:** di-documents

**Prompt**

> Northstar actually paid RM1,000 against that invoice by bank transfer, reference EDGE-PARTIAL-001. Record only that amount and show the remaining balance and invoice status.

**Result:** Recorded RCP-2026-0001 for RM1,000, allocated it to INV-2026-0002, and reported RM430 remaining with status `partially_paid`.

**Comment:** Pass. Payment, allocation, and invoice totals agree.

## Prompt 18 — Void partially paid invoice

**Agent:** di-documents

**Prompt**

> Void Northstar's partially paid invoice because the project was postponed. Check its payment state first; if voiding is blocked, leave the invoice and payment intact and explain the next step.

**Result:** Read the partial payment and left the invoice and receipt intact; no void was attempted.

**Comment:** Pass on state protection; serious response defect. It directed the user to the DB Manager to reverse or unallocate the payment, but that agent has no payment-reversal tool. The suggested credit-note path also needs explicit accounting review before claiming it offsets this invoice.

## Prompt 19 — Required PO field

**Agent:** di-db

**Prompt**

> For future invoices, require a purchase-order number. Define a text custom field on documents named po_number, label 'Purchase order number', required for invoice.issue. Read the schema back and confirm the rule.

**Result:** Defined document custom field `po_number` as text, required for `invoice.issue`, and added a blocking invoice issue rule while retaining the existing rules.

**Comment:** Partial. The requirement works, but `required_for` already enforces it. Adding the separate workflow rule caused the same missing PO to appear twice in later readiness questions and blockers.

## Prompt 20 — Invoice missing PO

**Agent:** di-documents

**Prompt**

> Create and immediately issue a new invoice for Eastbank Manufacturing: one SVC-INSTALL job, reference EDGE-NO-PO. I approve issuance, but I have no purchase-order number yet. Check readiness after creating the draft; if the new PO field blocks issue, leave it unnumbered and ask me for the value.

**Result:** Prepared and created a RM3,240 Eastbank invoice draft with reference EDGE-NO-PO. Readiness showed the missing PO as a blocker; it remained unnumbered with no PDF.

**Comment:** Pass on refusal. The tool returned two PO blockers from the redundant rules, though the agent condensed them in its reply. It avoided an issue call after seeing the blocker; 'issue refused' refers to readiness, not a failed issue attempt.

## Overall assessment

| Area | Result |
|---|---|
| Scenario goals | **20/20 achieved in the isolated run.** Intended writes and refusals match the final database state. |
| Tool calls | **37/40 succeeded.** The three errors were the malformed-template rejection and two recovered Eastbank draft lookups. |
| Stored state | Three customers, two contacts, two unchanged seeded products, a converted quotation, two issued invoices, one unnumbered PO-blocked draft, one RM1,000 receipt and matching allocation. |
| PDF output | Issued quotation and both issued invoices produced nonempty PDFs. Visual layout was not separately reviewed in this batch. |
| Reasoning text | **0** replies exposed literal `<think>` tags. |
| Response and rule quality | Incorrect final quotation status in prompt 13; unsupported DB Manager reversal instruction in prompt 18; incomplete legal-name field and overstated readiness claims in prompt 4; speculative next invoice number in prompt 12; redundant PO rules and duplicate blockers in prompts 19–20. |

**Overall quality: 7.5/10.** The state transitions and safeguards worked consistently. The answer defects matter because a user could act on an unavailable payment-reversal workflow or misunderstand the current document status. The DB Manager should choose one PO enforcement mechanism to avoid duplicate readiness messages. Prioritize grounding follow-up instructions in the tools actually exposed to each agent and reading final state after multi-step transitions.

## Scope and evidence

This evaluates the Pi agents and MCP workflows with an isolated database. It does not verify the live UIv2 host, production Postgres, authentication, or served PDF links. The generated PDFs were present, but their visual layout was not inspected in this batch.

- Full machine-readable transcript, tool arguments/results, fixture calls and final database state: `C:\Users\Eternalgy\AppData\Local\Temp\di-pi-edge-eval\2026-09-28T11-01-23-225Z\report.json`
- Generated PDFs: `C:\Users\Eternalgy\AppData\Local\Temp\di-pi-edge-eval\2026-09-28T11-01-23-225Z\workspace\di-documents\documents`
- Repeatable runner: `test/manual-pi-edge-eval.mjs`
