# First stress test: 10 prompts

**Date:** 28 September 2026  
**Result:** All 10 scenario goals passed; 35 of 35 Document Intelligence tool calls succeeded.  
**Assessment:** Workflow quality was strong. Response quality needs work: two replies exposed literal `<think>` text, and one reply suggested a payment-date correction the Document Agent cannot perform directly.

## Test setup and scope

The prompts below were run in order through the Pi CLI, using the actual Document Intelligence role prompts and MCP server. The completed run used `qwen3.8-max`, an isolated PGlite database, and Chromium PDF rendering. The database started with no company, only the application's tax codes, workflows, numbering, and templates. No real customer or production tenant was changed.

This was an **agent and MCP workflow test**, not a live UIv2 deployment test. The local UIv2 host had no `DATABASE_URL`, so production Postgres startup, chat UI display, authentication, and `/api/files/raw` links were not exercised. A separate attempt with `deepseek-v4-flash` timed out after MCP tool discovery without making a business-tool call; the 10-prompt run below used `qwen3.8-max` and completed.

## Prompt 1 — Record the owner's company identity

**Agent:** DB Manager

**Prompt**

> Please set up my company profile for a software test. Trading name: Meridian Solar Demo. Legal name: Meridian Solar Demo Sdn Bhd. Synthetic SSM number: 202399999999. Address: No. 12, Jalan Ujian 1, Taman Contoh, 47810 Petaling Jaya, Selangor, Malaysia. Currency: MYR. Read the saved profile back to me.

**Result:** Pi called `get_company_profile`, `update_company_profile`, then `get_company_profile`. The stored name, legal name, synthetic registration number, structured address, and MYR currency matched the prompt.

**Comment:** **Pass.** It verified the saved state before replying and correctly identified the fields that were still empty. The saved name and address satisfied the default issuer-profile readiness check.

## Prompt 2 — Add contact and bank details

**Agent:** DB Manager

**Prompt**

> Add these details to Meridian Solar Demo's profile: phone 03-0000 0100, email accounts@meridiansolar.example, website https://meridiansolar.example, and bank details 'DEMO BANK — TEST ACCOUNT 000000000000 — DO NOT PAY.' Leave TIN, SST number, and MSIC blank; do not invent them. Tell me which fields remain empty.

**Result:** Pi updated the company profile and read it back. The previously saved identity and address remained intact. Phone, email, website, and bank details were stored; TIN, SST number, and MSIC remained empty.

**Comment:** **Pass.** The agent made a partial update without overwriting existing fields or inventing tax identifiers. The bank string is explicitly test-only.

## Prompt 3 — Record a new client

**Agent:** Records Clerk

**Prompt**

> Record a new company customer. Trading name: Northstar Foods. Legal name: Northstar Foods Demo Sdn Bhd. Synthetic SSM number: 202398888888. Email: accounts@northstar.example. Billing address: 18 Jalan Contoh 2, 40150 Shah Alam, Selangor, Malaysia. Payment terms: 14 days. Primary contact: Aina Lim, Operations Manager, aina@northstar.example, 012-000 0011. Show me the customer code and saved details.

**Result:** Pi called `match_customer` before creating the record, then `save_customer`, `save_contact`, and `get_customer`. It created customer **C-0001** with the requested billing address and 14-day terms, and saved Aina as the primary contact.

**Comment:** **Pass.** The duplicate check preceded creation. The billing address and payment terms later supported invoice readiness and the due-date calculation.

## Prompt 4 — Add a second contact without duplicating the client

**Agent:** Records Clerk

**Prompt**

> I received another business card: Farid Rahman, Procurement Manager, Northstar Foods Demo Sdn Bhd, SSM 202398888888, farid@northstar.example, 012-000 0022. Record him under the existing customer. Check for duplicates first, and do not replace Aina or create a second Northstar customer.

**Result:** `match_customer` returned an existing match with score 100 on the registration number. Pi added Farid to **C-0001**, read the customer back, and confirmed that Aina remained primary. Final database state contained one Northstar customer and two contacts.

**Comment:** **Pass.** The agent followed the intended matching workflow and did not overwrite Aina or create a duplicate customer.

## Prompt 5 — Build a small product catalogue and package

**Agent:** Records Clerk

**Prompt**

> Add these demo catalogue entries: PNL-550 Solar panel 550W, RM650 per unit, tax code ST10; INV-10K Hybrid inverter 10kW, RM5,200 per unit, ST10; SVC-INSTALL Installation service, RM3,000 per job, SV8. Then create package PKG-10KWP, '10kWp rooftop package,' containing 18 PNL-550 panels and one INV-10K, with a fixed package price of RM22,000 and tax code SV8. Read back the package and items.

**Result:** Pi checked the available tax codes and searched the catalogue before saving. It created the three products and package **PKG-10KWP**, then called `get_package` to confirm its 18 panels, one inverter, and fixed RM22,000 price.

**Comment:** **Pass.** No duplicate SKU was created. Tax amounts in later prompts were calculated from the application's seeded demo code `SV8`; this test does not assess whether that code is appropriate for a real sale.

## Prompt 6 — Prepare a quotation without writing it

**Agent:** Document Agent

**Prompt**

> Northstar Foods wants a quotation for one PKG-10KWP package and one SVC-INSTALL job. I have not chosen the recipient or validity period. Do not create a draft yet. Check the customer and catalogue, give me the estimated total, and ask for everything needed before issue.

**Result:** Pi called `prepare_document` only; no document was created. It resolved the customer and both catalogue entries, estimated **RM25,000 subtotal + RM2,000 tax = RM27,000**, and asked two questions together: whether to address Aina or Farid, and what validity date to use. It suggested 28 October 2026, 30 days from the test date.

**Comment:** **Pass on workflow; response defect.** Pi honored the read-only instruction and asked the right questions, but its reply began with a visible `<think>...</think>` block containing internal planning text.

## Prompt 7 — Create an unissued draft and preview PDF

**Agent:** Document Agent

**Prompt**

> Use Aina Lim as the contact. Make the quotation valid for 30 days from today. Use reference TEST-ROOF-001. Create the draft quotation for the items we discussed and render a draft PDF for review. Do not issue it yet.

**Result:** Pi called `create_draft` and `render_pdf`. It selected Aina, set validity to **28 October 2026**, and created a draft with no document number and a **RM27,000** total. Chromium produced a one-page A4 PDF clearly marked **“DRAFT — not issued.”**

**Comment:** **Pass.** The quote stayed editable and unnumbered. The PDF contained the company, customer, contact, line items, tax summary, and reference without visible clipping or overlap.

## Prompt 8 — Issue the approved quotation

**Agent:** Document Agent

**Prompt**

> I approve that draft quotation. Issue it now. Show me its quotation number, final total, status, and PDF link.

**Result:** Pi called `issue_document` once. The quotation became **QT-2026-0001**, status `issued`, total **RM27,000**, and received an issued PDF. The PDF was one A4 page with the draft banner removed.

**Comment:** **Pass.** Issuance happened only after explicit approval. The agent's reply matched the tool result and included the workspace-relative PDF link.

## Prompt 9 — Convert the accepted quotation to an invoice

**Agent:** Document Agent

**Prompt**

> Northstar Foods accepted the quotation you just issued. Mark it accepted, convert it to an invoice draft, use the customer's 14-day payment terms, check that it is ready, and issue the invoice. Show me the invoice number, due date, total, linked quotation, and PDF link.

**Result:** Pi called `set_quotation_status`, `get_customer`, `convert_to_invoice`, and `issue_document`. The quotation ended in status `converted`. The linked invoice became **INV-2026-0001**, status `issued`, total **RM27,000**, due **12 October 2026**, with a one-page A4 PDF. Pi relayed the tool's warning that the customer has no TIN for future MyInvois use.

**Comment:** **Pass.** It preserved the quotation's lines and prices, used the customer's 14-day terms, and distinguished the TIN warning from an issuance blocker.

## Prompt 10 — Record partial and final payment

**Agent:** Document Agent

**Prompt**

> Northstar Foods paid RM10,000 against that invoice by bank transfer, reference DEMO-IBG-001. Record it and tell me the remaining balance. Later, they paid the exact remaining balance by bank transfer, reference DEMO-IBG-002. Record that as a second payment, then show the final invoice status and both allocations.

**Result:** Pi called `record_payment` twice. Receipt **RCP-2026-0001** allocated RM10,000, leaving **RM17,000** and status `partially_paid`. Receipt **RCP-2026-0002** allocated RM17,000, leaving **RM0** and status `paid`. Both receipts and allocations were present in the final database state.

**Comment:** **Pass on accounting transition; response defects.** The final reply again exposed a literal `<think>...</think>` block. It also said it could correct the received dates if supplied later, although the Document Agent has no direct payment-edit tool. Both payments were booked on 28 September 2026 because the prompt gave no other dates; the agent did disclose that assumption.

## Overall assessment

| Area | Assessment |
|---|---|
| Data and workflow | **10/10 scenario goals passed.** Final state had one company, one client, two contacts, three products, one package, a converted quotation, a paid invoice, and two matching payment allocations. |
| Tool reliability | **35/35 business-tool calls succeeded; 0 tool errors.** |
| Document rendering | Draft, quotation, and invoice PDFs were each one legible A4 page. |
| Response quality | **Needs polish.** Internal `<think>` text appeared in prompts 6 and 10. The payment-date correction offer exceeded the Document Agent's direct tools. |
| Deployment confidence | **Not established by this run.** A live UIv2 host, Postgres role separation, chat rendering, and PDF-link serving still need a deployment smoke test. |

**Overall quality for this isolated run: 8/10.** The business path worked end to end. The main fixes are to prevent internal reasoning text from reaching user replies and to keep follow-up promises within the agent's actual tool capabilities.

## Evidence

- Full machine-readable Pi transcript, tool arguments/results, and final database state: `C:\Users\Eternalgy\AppData\Local\Temp\di-pi-eval\2026-09-28T10-22-54-312Z\report.json`
- Generated PDFs: `C:\Users\Eternalgy\AppData\Local\Temp\di-pi-eval\2026-09-28T10-22-54-312Z\workspace\di-documents\documents\`
- Repeatable isolated runner: `test/manual-pi-eval.mjs`
