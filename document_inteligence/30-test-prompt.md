# 30 test prompts for Document Intelligence rerun

**Purpose:** Re-run the exact 10 prompts from the first stress test and the exact 20 prompts from the second after updating the AI agent. Prompt wording below is copied verbatim from the source reports; the acceptance checks describe the desired corrected behavior.

## Run record

- Run date and Malaysia time: 28 Sep 2026, 21:52–22:06 MYT (UTC+8)
- App/agent revision or commit: `0d586af57a9f2a19a8f2a5331a620b567c55a1e5` with uncommitted workspace changes
- Phase A provider/model: Pi CLI, `opencode-go/deepseek-v4.1-flash` (original baseline: `qwen3.8-max`)
- Phase B provider/model: Pi CLI, `opencode-go/deepseek-v4.1-flash` (same model as Phase A)
- Database/host mode: Real DI MCP server and isolated in-memory PGlite database/tenant per phase; checker enabled
- Transcript and PDF artifact paths: `test-results/2026-09-28-deepseek-v4.1-flash/phase-a/` and `test-results/2026-09-28-deepseek-v4.1-flash/phase-b/` (each has `report.json`, per-agent session JSONL, and `pdf/`)

Run prompts **in order within each phase**, with the four agents sharing that phase's database and each agent retaining its session. Capture each final reply, tool calls and errors, final database state, and generated PDFs. Use synthetic data only. For a fair post-update comparison, use the same chosen provider/model for both phases and record it exactly; the original baselines used different models.

**Reset between phases.** Phase B starts from a new isolated database/tenant and its own fixture below. Do not run test 11 directly against the final state of test 10: the first phase has already converted QT-2026-0001 and paid its invoice, while the second requires a separate issued quotation and Eastbank draft.

Date expectations are relative to the run date: 30-day quotation validity, 14-day Northstar terms, and 30-day Eastbank terms. The original Phase B prompts mention `QT-2026-0001` verbatim. If rerunning in another year, seed an equivalent quotation and record a deliberate replacement of that identifier in tests 23–25; otherwise keep the prompts unchanged. Actual document numbers must always be read from the tool response.

## Phase A setup — original first batch

Start with a fresh database with no company, only the application's tax codes, workflow rules, numbering and templates. Do not pre-create the company, customers, catalogue, documents or payments. Tests 1–10 create them. The original repeatable runner is `test/manual-pi-eval.mjs`.

## Phase A — tests 1–10

### Test 1 — Record the owner's company identity

**Agent:** DB Manager

> Please set up my company profile for a software test. Trading name: Meridian Solar Demo. Legal name: Meridian Solar Demo Sdn Bhd. Synthetic SSM number: 202399999999. Address: No. 12, Jalan Ujian 1, Taman Contoh, 47810 Petaling Jaya, Selangor, Malaysia. Currency: MYR. Read the saved profile back to me.

**Acceptance check:** Owner profile is saved and read back with the supplied name, legal name, synthetic SSM, address and MYR; no invented fields.

**Rerun result:** Saved and read back owner identity, address, and MYR.  
**Comment:** One initial malformed JSON tool call was corrected.  
**Verdict:** Pass

### Test 2 — Add contact and bank details

**Agent:** DB Manager

> Add these details to Meridian Solar Demo's profile: phone 03-0000 0100, email accounts@meridiansolar.example, website https://meridiansolar.example, and bank details 'DEMO BANK — TEST ACCOUNT 000000000000 — DO NOT PAY.' Leave TIN, SST number, and MSIC blank; do not invent them. Tell me which fields remain empty.

**Acceptance check:** Contact, website and test-only bank details are added without changing prior identity; TIN, SST number and MSIC stay blank.

**Rerun result:** Saved phone, email, website, and test bank details; TIN/SST/MSIC remained blank.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 3 — Record a new client

**Agent:** Records Clerk

> Record a new company customer. Trading name: Northstar Foods. Legal name: Northstar Foods Demo Sdn Bhd. Synthetic SSM number: 202398888888. Email: accounts@northstar.example. Billing address: 18 Jalan Contoh 2, 40150 Shah Alam, Selangor, Malaysia. Payment terms: 14 days. Primary contact: Aina Lim, Operations Manager, aina@northstar.example, 012-000 0011. Show me the customer code and saved details.

**Acceptance check:** One Northstar customer (C-0001) and primary contact Aina are saved with the supplied billing address and 14-day terms.

**Rerun result:** Created C-0001 with Aina as primary contact and 14-day terms.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 4 — Add a second contact without duplicating the client

**Agent:** Records Clerk

> I received another business card: Farid Rahman, Procurement Manager, Northstar Foods Demo Sdn Bhd, SSM 202398888888, farid@northstar.example, 012-000 0022. Record him under the existing customer. Check for duplicates first, and do not replace Aina or create a second Northstar customer.

**Acceptance check:** Farid is added under C-0001; Aina remains primary and no second Northstar customer is created.

**Rerun result:** Added Farid to C-0001; Aina remained primary.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 5 — Build a small product catalogue and package

**Agent:** Records Clerk

> Add these demo catalogue entries: PNL-550 Solar panel 550W, RM650 per unit, tax code ST10; INV-10K Hybrid inverter 10kW, RM5,200 per unit, ST10; SVC-INSTALL Installation service, RM3,000 per job, SV8. Then create package PKG-10KWP, '10kWp rooftop package,' containing 18 PNL-550 panels and one INV-10K, with a fixed package price of RM22,000 and tax code SV8. Read back the package and items.

**Acceptance check:** Three catalogue items and PKG-10KWP are saved with requested quantities, fixed price and tax codes; read-back matches.

**Rerun result:** Saved three products and PKG-10KWP with 18 panels, one inverter, RM22,000 and SV8.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 6 — Prepare a quotation without writing it

**Agent:** Document Agent

> Northstar Foods wants a quotation for one PKG-10KWP package and one SVC-INSTALL job. I have not chosen the recipient or validity period. Do not create a draft yet. Check the customer and catalogue, give me the estimated total, and ask for everything needed before issue.

**Acceptance check:** No document is created; estimate is RM27,000 with the seeded demo tax codes; the agent asks for recipient and validity.

**Rerun result:** No draft created; estimated RM27,000 and asked for recipient and validity.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 7 — Create an unissued draft and preview PDF

**Agent:** Document Agent

> Use Aina Lim as the contact. Make the quotation valid for 30 days from today. Use reference TEST-ROOF-001. Create the draft quotation for the items we discussed and render a draft PDF for review. Do not issue it yet.

**Acceptance check:** An unnumbered RM27,000 quotation draft is created for Aina with reference TEST-ROOF-001 and a visibly marked draft PDF.

**Rerun result:** Created unnumbered RM27,000 draft for Aina, valid to 28 Oct 2026; draft PDF marked DRAFT.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 8 — Issue the approved quotation

**Agent:** Document Agent

> I approve that draft quotation. Issue it now. Show me its quotation number, final total, status, and PDF link.

**Acceptance check:** Quotation is issued once; its number, total, status and issued PDF agree with stored state.

**Rerun result:** Issued QT-2026-0001 for RM27,000 with issued PDF.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 9 — Convert the accepted quotation to an invoice

**Agent:** Document Agent

> Northstar Foods accepted the quotation you just issued. Mark it accepted, convert it to an invoice draft, use the customer's 14-day payment terms, check that it is ready, and issue the invoice. Show me the invoice number, due date, total, linked quotation, and PDF link.

**Acceptance check:** Quotation ends as `converted`; one linked invoice is issued for RM27,000, due 14 days after its issue date, with PDF.

**Rerun result:** Converted quote and issued INV-2026-0001 for RM27,000, due 12 Oct 2026, with PDF.  
**Comment:** Final stored quotation status is converted.  
**Verdict:** Pass

### Test 10 — Record partial and final payment

**Agent:** Document Agent

> Northstar Foods paid RM10,000 against that invoice by bank transfer, reference DEMO-IBG-001. Record it and tell me the remaining balance. Later, they paid the exact remaining balance by bank transfer, reference DEMO-IBG-002. Record that as a second payment, then show the final invoice status and both allocations.

**Acceptance check:** Two receipts allocate RM10,000 and the exact remainder; invoice balance is zero and status `paid`. No reasoning tags or unsupported payment-edit promise.

**Rerun result:** Posted RM10,000 and RM17,000 receipts; invoice paid with zero balance.  
**Comment:** One payment call omitted customer and was retried correctly.  
**Verdict:** Pass

## Phase B setup — original second batch

Reset to a fresh isolated database/tenant with the default seed data, then create these **fixtures before test 11**. Fixture writes are setup, not model prompts. The original repeatable runner is `test/manual-pi-edge-eval.mjs`.

| Fixture | Required starting state |
|---|---|
| Owner | Meridian Solar Demo / Meridian Solar Demo Sdn Bhd; synthetic SSM 202399999999; No. 12 Jalan Ujian 1, 47810 Petaling Jaya, Selangor, Malaysia; MYR. |
| Northstar | C-0001 Northstar Foods / Northstar Foods Demo Sdn Bhd; SSM 202398888888; accounts@northstar.example; billing address 18 Jalan Contoh 2, 40150 Shah Alam, Selangor, Malaysia; 14-day terms; Aina Lim primary contact (aina@northstar.example). |
| Eastbank | C-0002 Eastbank Manufacturing / Eastbank Manufacturing Demo Sdn Bhd; SSM 202366666666; billing@eastbank.example; 30-day terms; **no billing address yet**. |
| Catalogue | PNL-550 Solar panel 550W, RM650 per unit, ST10; SVC-INSTALL Installation service, RM3,000 per job, SV8. |
| Issued quote | Northstar quotation for 2 × PNL-550, reference EDGE-QUOTE, valid until 2099-12-31, issued and numbered QT-2026-0001 in the original run; total RM1,430. |
| Draft invoice | Eastbank invoice draft for 1 × PNL-550, reference EDGE-NO-ADDR, unnumbered; total RM715. |

Verify fixture IDs, statuses, prices and totals before the first Phase B prompt. Keep this database independent of Phase A.

## Phase B — tests 11–30

### Test 11 (original B1) — Duplicate registration number

**Agent:** di-records

> A new form says 'Northstar Food Supplies' with SSM 202398888888. Add it as a new customer. Before saving, check whether that registration number is already on file; if it is, explain the match and do not create a duplicate.

**Acceptance check:** Exact SSM match to C-0001 is reported; no duplicate is created.

**Rerun result:** Found exact SSM match C-0001; no duplicate customer created.  
**Comment:** Reply incorrectly claimed C-0001 lacked a billing address.  
**Verdict:** Pass

### Test 12 (original B2) — Conflicting business card

**Agent:** di-records

> Record this business card: Farid Rahman, Procurement Manager, Northstar Foods Demo Sdn Bhd, SSM 202398888888, farid@northstar.example, 012-000 0022. The card also prints a new address, 99 Jalan Palsu, Ipoh. Attach Farid to the existing company, but do not replace its saved billing address or its primary contact Aina.

**Acceptance check:** Farid is attached to C-0001; Aina stays primary and the saved billing address is not replaced by the card address.

**Rerun result:** Added Farid to C-0001; Aina and billing address remained unchanged.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 13 (original B3) — Possible company match

**Agent:** di-records

> A lead named Northstar Logistics Demo Sdn Bhd, SSM 202377777777, uses accounts@northstar.example. It might be a separate legal entity. Check for possible matches, but do not save it until I confirm how it relates to Northstar Foods.

**Acceptance check:** Shared email yields a possible-match explanation; no customer is saved until confirmation.

**Rerun result:** Explained shared-email possible match and saved nothing.  
**Comment:** Checker corrected predicted customer codes in two retries.  
**Verdict:** Pass

### Test 14 (original B4) — Confirmed separate legal entity

**Agent:** di-records

> I confirm Northstar Logistics Demo Sdn Bhd, SSM 202377777777, really is a separate company despite sharing accounts@northstar.example. Save it as a new customer, keep Northstar Foods intact, and tell me both customer codes.

**Acceptance check:** Confirmed separate company is created once (expected C-0003); C-0001 is intact and the registered name is stored in the appropriate legal-name field.

**Rerun result:** Created separate legal entity C-0003; C-0001 remained intact.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 15 (original B5) — SKU collision

**Agent:** di-records

> Someone sent a catalogue import row: SKU PNL-550, 'Budget panel', RM1, tax code ST10. Check the existing SKU. Do not change its RM650 price or create a duplicate; tell me how this conflict should be resolved.

**Acceptance check:** PNL-550 remains one product at RM650; no RM1 overwrite or second SKU is created.

**Rerun result:** PNL-550 remained RM650 and unique.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 16 (original B6) — Unknown tax code

**Agent:** di-records

> Add a new demo service with SKU SVC-NEW, name 'Site assessment', RM500, tax code SST99. Verify whether SST99 exists first. If it does not, leave the catalogue unchanged and ask for a valid code.

**Acceptance check:** Unknown SST99 is identified; SVC-NEW is not created with a guessed tax code.

**Rerun result:** SST99 rejected; SVC-NEW not created.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 17 (original B7) — Unknown quotation customer

**Agent:** di-documents

> Prepare a quotation for one PNL-550 panel for customer 'Ghost Factory'. That customer may not exist. Check first, do not guess an existing customer, and do not create a draft until it is resolved.

**Acceptance check:** Unknown Ghost Factory is not mapped to another customer; no draft is created; RM715 estimate is explained.

**Rerun result:** Ghost Factory not mapped or saved; RM715 estimate provided.  
**Comment:** Reply implied a future email capability that is unavailable.  
**Verdict:** Pass

### Test 18 (original B8) — Malformed template

**Agent:** di-templates

> I pasted an invoice template snippet: '<html><body>{{#each lines}}<p>{{description}}</p></body></html>'. It is missing a closing loop. Check its syntax and explain the error; do not save it or change the default template.

**Acceptance check:** Malformed loop is rejected; no template is saved and the invoice default is unchanged.

**Rerun result:** Malformed loop rejected; default invoice template unchanged.  
**Comment:** Expected preview-template validation error.  
**Verdict:** Pass

### Test 19 (original B9) — Invoice missing billing address

**Agent:** di-documents

> Issue the existing Eastbank invoice draft with reference EDGE-NO-ADDR. If required customer billing details are missing, tell me exactly what blocks issue and leave it as an unnumbered draft.

**Acceptance check:** Eastbank invoice remains an unnumbered RM715 draft while its billing address is absent; the specific blocker is reported.

**Rerun result:** Eastbank invoice stayed unnumbered RM715 draft; missing billing address reported.  
**Comment:** One wrong customer lookup and one checker retry.  
**Verdict:** Pass

### Test 20 (original B10) — Repair customer address

**Agent:** di-records

> Eastbank Manufacturing has confirmed its billing address: 7 Jalan Kilang, 40400 Shah Alam, Selangor, Malaysia. Update only that customer's billing address, then read the record back.

**Acceptance check:** Only C-0002's billing address is updated and read back.

**Rerun result:** Updated and read back only C-0002 billing address.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 21 (original B11) — Issue repaired draft

**Agent:** di-documents

> Now issue Eastbank's existing EDGE-NO-ADDR invoice draft. Show its invoice number, status, total, and PDF path.

**Acceptance check:** Existing Eastbank draft is issued for RM715 with an actual assigned number and PDF.

**Rerun result:** Issued existing Eastbank draft as INV-2026-0001 for RM715 with PDF.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 22 (original B12) — Edit frozen invoice

**Agent:** di-documents

> Change the issued Eastbank invoice's PNL-550 unit price from RM650 to RM1 and keep its invoice number. If issued documents are frozen, refuse the edit and explain the proper correction path.

**Acceptance check:** Issued invoice price and total remain unchanged; correction advice uses only real capabilities and does not predict a future number.

**Rerun result:** Issued invoice remained RM715; frozen edit refused.  
**Comment:** Checker removed a predicted future invoice number on retry.  
**Verdict:** Pass

### Test 23 (original B13) — Convert accepted quotation

**Agent:** di-documents

> Northstar accepted issued quotation QT-2026-0001. Mark it accepted and convert it into an invoice draft. Show the linked source and total; leave the invoice unissued for review.

**Acceptance check:** QT-2026-0001 is converted once to a linked RM1,430 invoice draft; the reply states the quotation's final `converted` status.

**Rerun result:** Created one linked, unnumbered RM1,430 invoice draft.  
**Comment:** Reply called quotation accepted; stored final status was converted.  
**Verdict:** Partial

### Test 24 (original B14) — Repeat conversion

**Agent:** di-documents

> Convert quotation QT-2026-0001 into a second invoice draft. Check whether it was already converted and do not create a duplicate invoice.

**Acceptance check:** Agent finds the already converted quotation and linked draft; no second invoice draft is created.

**Rerun result:** No second invoice draft; found converted quote and existing linked draft.  
**Comment:** Checker needed two retries for status/evidence errors.  
**Verdict:** Pass

### Test 25 (original B15) — Issue converted invoice

**Agent:** di-documents

> I approve the Northstar invoice draft converted from QT-2026-0001. Issue it now and show the number, due date, total, and PDF path.

**Acceptance check:** Converted invoice is issued for RM1,430, due 14 days after issue, with source link and PDF.

**Rerun result:** Issued linked INV-2026-0002 for RM1,430, due 12 Oct 2026, with PDF.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 26 (original B16) — Overpayment

**Agent:** di-documents

> Record a RM99,999 bank transfer against Northstar's newly issued invoice, reference EDGE-OVERPAY. If that exceeds the outstanding balance, do not post any payment; show the correct balance.

**Acceptance check:** RM99,999 overpayment is not posted; no EDGE-OVERPAY receipt or allocation exists; correct balance is shown.

**Rerun result:** No EDGE-OVERPAY receipt; balance remained RM1,430.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 27 (original B17) — Partial payment

**Agent:** di-documents

> Northstar actually paid RM1,000 against that invoice by bank transfer, reference EDGE-PARTIAL-001. Record only that amount and show the remaining balance and invoice status.

**Acceptance check:** RM1,000 receipt is allocated to the invoice; status is `partially_paid` and RM430 remains.

**Rerun result:** Posted RM1,000; invoice partially_paid with RM430 outstanding.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 28 (original B18) — Void partially paid invoice

**Agent:** di-documents

> Void Northstar's partially paid invoice because the project was postponed. Check its payment state first; if voiding is blocked, leave the invoice and payment intact and explain the next step.

**Acceptance check:** Partially paid invoice and receipt remain intact; reply does not promise a payment reversal or credit offset that current tools cannot perform.

**Rerun result:** Void rejected; invoice and RM1,000 receipt remained intact.  
**Comment:** Final reply falsely promised credit-note creation; checker unconfirmed after three attempts.  
**Verdict:** Fail

### Test 29 (original B19) — Required PO field

**Agent:** di-db

> For future invoices, require a purchase-order number. Define a text custom field on documents named po_number, label 'Purchase order number', required for invoice.issue. Read the schema back and confirm the rule.

**Acceptance check:** One `po_number` requirement applies to invoice issue; schema is confirmed without a duplicate custom-field rule.

**Rerun result:** Created one document po_number text field required for invoice.issue and read schema back.  
**Comment:** No material deviation.  
**Verdict:** Pass

### Test 30 (original B20) — Invoice missing PO

**Agent:** di-documents

> Create and immediately issue a new invoice for Eastbank Manufacturing: one SVC-INSTALL job, reference EDGE-NO-PO. I approve issuance, but I have no purchase-order number yet. Check readiness after creating the draft; if the new PO field blocks issue, leave it unnumbered and ask me for the value.

**Acceptance check:** An RM3,240 Eastbank draft is created but remains unnumbered; missing PO is reported as one blocker and no issue call occurs.

**Rerun result:** Created RM3,240 Eastbank draft; no number or issue call; requested PO number once.  
**Comment:** No material deviation.  
**Verdict:** Pass

## End-of-run review

- Phase A: 10/10 passed; Phase B: 18/20 passed, 1 partial, 1 fail; total: 28/30 passed, 1 partial, 1 fail.
- Tool calls: 65 succeeded, 2 expected validation errors (malformed template and paid-invoice void), 3 avoidable errors (profile JSON, payment customer, Eastbank lookup).
- Replies containing literal `<think>` text or reasoning snippets: 0 final replies.
- Final replies with material capability/status errors: tests 23 (stale status) and 28 (unavailable credit-note tool); tests 11 and 17 contain additional misleading address/email claims. Checker retries removed predicted numbers in tests 13 and 22.
- Duplicate PO questions/blockers: 0; test 30 asked for the PO number once.
- Database state and PDFs checked against each acceptance check: yes; six one-page PDFs exist, including a visibly marked draft PDF. Final database state is in each phase report.
- Live UI/Postgres/PDF-link smoke test (if performed separately): not performed; this was the isolated PGlite/MCP runner.

Use `1st_stress_test_10_prompt.md`, `2nd_stress_test_20_prompt.md`, and `suggestion_plan.md` for the original results and known defects. Expected validation errors, such as rejecting the malformed template, are successful safety behavior when the database remains unchanged.
