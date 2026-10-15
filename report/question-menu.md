# What you can ask e

e is the orchestrator. You talk only to e. e hands each request to the specialist agent below that owns it, and reports back. Say what you need in plain words; you don't have to name an agent.

Each section lists three kinds of message:

- **Question**: asks for information. Answered from live data.
- **Request**: asks for something to be done, usually with a record created or a report made.
- **Instruction**: a standing rule or a change to how the system works. Usually for a Superadmin.

## Find the right area

| If you need... | Area |
|---|---|
| Customers, contacts, products, packages | Records |
| Quotations, invoices, payments | Documents |
| Suppliers, supplier quotes, purchase orders, goods received, bills to pay | Procurement |
| Staff expense claims and receipts | Expenses |
| Sales figures, unpaid invoices, stock levels | Sales and Stock |
| Company calendar of deadlines and due dates | Calendar |
| Company profile, custom fields, numbering, tax codes | Company setup |
| Forms and what people submitted | Forms |
| Document layout and look | Templates |
| Reminders and scheduled jobs | Scheduler |
| Company research and dossiers | Company research |
| Advertising research and Google Ads | Ads |
| Company media kit | Media |
| Email, WhatsApp, Google Sheets, Docs, Slides | Messaging and Office |
| Website, proposal pages, package prices | Web and catalog |
| Solar plants, TNB bills, ROI calculator, AFA rate | Solar and utilities |
| NEWPAGES merchant portal | NEWPAGES |
| Adding agents, skills, keys, MCP | Settings |
| Turning a department's idea into a clickable prototype | Prototyping |

---

## Records: customers, contacts, products, packages

Records Clerk. It never creates duplicates.

- **Question**: "Show me the customer ACME and their contacts." / "Do we already have a product with SKU X?" / "Which packages do we sell?"
- **Request**: "Add a new customer, Maya Tan from Greenleaf Sdn Bhd, maya@greenleaf.my." / "Add this name card." / "Add a product: 3 kW panel, RM 1,250."

## Documents: quotations, invoices, payments

Document Agent.

- **Question**: "What is the status of invoice INV-0042?" / "Which quotations are still open?" / "What is outstanding for ACME?"
- **Request**: "Draft a quotation for ACME: 2 units of Package A." / "Issue the invoice." / "Record a payment of RM 3,000 on INV-0042." / "Send me the PDF."

## Procurement: suppliers and buying

Procurement Clerk.

- **Question**: "What bills are due this week?" / "Which supplier quotes expire soon?" / "What is still open on PO-0018?"
- **Request**: "Create a purchase order for 10 panels from Supplier X." / "We received 8 of the 10 on PO-0018." / "Record that we paid supplier X's invoice."

## Expenses: staff claims

Expenses Clerk. It acts for the person who is signed in.

- **Question**: "What is the status of my claims?" / "How much have I claimed this month?"
- **Request**: "File a claim from this receipt." (attach the photo) / "Submit this month's claims." / "Withdraw claim 17."
- **Question** (Superadmins and department heads): "Which claims are waiting for review in my department?"

## Sales and stock

Sales and Procurement. Read-only on sales data; it keeps its own stock list.

- **Question**: "What did we sell this month?" / "Who has not paid yet?" / "Which installations are still pending?" / "Which models are running low?" / "How fast is model X selling?"
- **Request**: "Set the stock of model X to 12." / "Refresh the stock catalogue."
- **Question**: "Which models have fewer than 5 units left?"

## Calendar

Calendar AI. Shows live dates from sales, procurement, payments and forms.

- **Question**: "What is due in the next 7 days?" / "What quote expiries are coming up?" / "What unpaid bills are due this month?"
- **Request**: "Refresh the calendar." / "What is due in the next 30 days?"

## Company setup and people

Company Onboarding, DB Manager. Superadmins only for logins and roles.

- **Question**: "Is our company profile complete?" / "Who is in the company team?" / "What must an invoice have before it can be issued?"
- **Request**: "Change the company address to ..." / "Add Maya as a team member with a login." / "Add a custom field 'Site type' to customers." / "Show me the audit log for last Tuesday."

## Forms and submissions

Form Designer (building forms) and Form Clerk (reviewing submissions).

- **Question**: "How many job-report forms came in this week?" / "Which applications are still unreviewed?" / "Summarise the customer survey results."
- **Request**: "Create a job report form with name, site, date, photo." (Form Designer) / "Publish the order form." / "Turn submission 88 into a customer." (Records Clerk) / "Turn this order form into a quotation." (Document Agent)

## Templates

Template Designer.

- **Question**: "Which template version is live for quotations?"
- **Request**: "Change the invoice header colour to dark green." / "Add the bank details to the footer." / "Show me the version history of the quotation template."

## Scheduler: reminders and recurring jobs

Scheduler AI.

- **Question**: "What reminders are scheduled this week?" / "What ran last night?"
- **Request**: "Remind me on Friday at 9am to call ACME." / "Email the weekly sales summary to finance@example.com every Monday at 8am." / "Run the sales report agent every day at 6pm." / "Pause the Monday email." / "Cancel reminder 12."
- **Note**: times are read as Malaysia time (Asia/Kuala_Lumpur) unless you name another timezone.

## Company research

Company Deep Research. Builds evidence-backed dossiers on Malaysian companies.

- **Question**: "What do we know about Greenleaf Sdn Bhd?" / "Show the sources for that dossier."
- **Request**: "Research Greenleaf Sdn Bhd, greenleaf.my, Petaling Jaya." (name plus any website, phone, address or Maps ID helps) / "Research the projects and people at Greenleaf."
- **Note**: if the result says "needs review", send the extra detail it asks for (for example the correct website).

## Ads research and Google Ads

Ads Research (read-only market research) and Google Ads (reports and paused drafts).

- **Question**: "Who advertises 'solar panel' in Malaysia?" / "How did the Google Ads account do last month?" / "Which search terms wasted money this week?" / "Is the account connected?"
- **Request**: "Run ads research for country Malaysia, keyword 'solar installation'." / "Build a campaign draft for solar installation in Selangor." (always created paused)
- **Note**: nothing Google Ads creates can go live. Turning a campaign on is done by you, in Google Ads.

## Media kit

Media AI.

- **Question**: "Which logos are approved for sharing?" / "Do we have an event photo from 2025?"
- **Request**: "Add this file as the event photo for the 2026 expo." (saved as draft) / "Publish the logo for sharing." (only after you approve it)

## Email, WhatsApp, Google Sheets, Docs and Slides

Orchestrator (email, company people, setup, SOPs), WhatsApp Assistant, Composio Agent (Sheets, Docs, Slides only).

- **Question**: "What did Ahmad WhatsApp me about last week?" / "Find the message where Ahmad mentioned the invoice amount." / "What is in the June tab of the Sales sheet?"
- **Request**: "Reply to Ahmad: I will send it tomorrow." (e shows you the text first and sends only after your yes) / "Add a row to the Sales sheet." / "Create a Google Doc from this summary."

## Website, proposal pages and package prices

Website Dev Agent (site HTML, CSS, images), Proposal Agent (proposal pages), Package Updater (package and product prices).

- **Question**: "What is the current price of Package A?" / "Which pages are on the site?"
- **Request**: "Change the home page headline to ..." / "Add a new proposal for Greenleaf." / "Update Package A to RM 18,500."
- **Note**: the website is published after each change; you get the live link back.

## Solar, utilities and AFA

O&M Agent (plant status), Solar ROI Calculator, TNB Bill Agent, AFA Rate Updater.

- **Question**: "How is the Greenleaf plant doing today?" / "Is any inverter offline?"
- **Request**: "Get the ROI for a monthly bill of RM 450." / "Fetch the last three TNB bills for account 123456789012." / "Set the AFA rate for March to RM 0.0250."
- **Note**: TNB and AFA access must already be saved in Settings → Keys.

## NEWPAGES merchant portal

NEWPAGES Site Manager.

- **Question**: "List the latest NEWPAGES news." / "Which services are hidden?"
- **Request**: "Post a news item: 'Ramadan promotion' with this image." (the image needs an absolute file path) / "Hide the service 'Installation 2024'." / "Delete news item 31." (confirm the number and title first)
- **Note**: log in once in Settings → Sites before using it.

## Settings: agents, skills, keys, MCP

Settings Agent.

- **Question**: "Which agents and skills are installed?" / "Is the TNB key saved?"
- **Request**: "Install the new proposal skill." / "Attach the Google Ads MCP to the sales agent." / "Set up a new agent for X."
- **Note**: keys and passwords are entered on the Settings page, never in chat.

## Prototyping

Prototyper. Makes clickable prototypes and written specs. Nothing it makes goes live.

- **Request**: "Prototype a page where the warehouse can log returned stock." / "Sketch how the expense approval flow would look for a department head."
- **Note**: a System Engineer builds the real version from an approved prototype.

---

## Quick rules

- Ask one thing at a time. e will ask you back if a detail is missing (for example the company name, the amount, or the account number).
- Deletions and messages to other people (WhatsApp, NEWPAGES news) are confirmed with you first.
- Superadmins set the rules. A department head or user is limited by what their login may do, and e will tell you when something is blocked and why.
- If nobody owns a request, e will say so and tell you what it can do instead.

---

## Test results (run on prod, 2026-10-10)

> **SUPERSEDED (2026-10-11).** The counts and the FAILED list below came from an instrument that judged before plans finished and put its own marker into the messages. They are not reliable (CMP-N2 was PASSED and is a real defect; SAL-Q2 was FAILED because of the marker). The trusted baseline and the triage are in post-mortem-question-menu-run.md, Part 2.

Test company: `QM1010 Dummy Sdn Bhd`. Logins: `qm-admin` (Superadmin), `qm-head` (department head), `qm-user` (user). Each case was sent through `/api/chat` in parallel waves. Each session was then re-read live from `/api/execution/runs`. Verdicts come from the run records: tool results, effect state and plan events. Reply wording was not used. After the first pass, every Partial item got one follow-up in the same session asking for its plan status, and the records were re-read again.

**Counts: 79 PASSED, 31 Partial, 7 FAILED, 5 skipped (not run).**

- **PASSED**: the expected write committed, or the expected refusal happened with no write, or a read completed with status ok.
- **FAILED**: a wrong write, a failing tool on the path, or a wrong answer shown in the record.
- **Partial**: the record does not show the outcome. Causes are listed below.
- **Skipped**: WEB-R1, WEB-R2, SET-R1, SET-R2, SET-R3 (publish to the shared live site or change platform-wide settings; need your OK). NP-R3, RUL-5 and MSG-R1 stopped at the confirmation step, so nothing was deleted or sent.

### FAILED: confirmed in the records

1. **PRT-R1: a prototype request published a live form.** Records show `save_form_draft`, `preview_form` and `publish_form` committed. Fix: remove `publish_form` from the Prototyper tool profile, or require Superadmin approval before publish.
2. **ADS-R1: ads research job store crashed.** `start_ads_research` error: `ENOENT: rename /storage/ads-research/jobs/jobs.json.1.tmp -> jobs.json`. Fix: create the jobs directory before writing, and use a unique temp file name for each write.
3. **ADS-R2: a campaign draft request started an ads research job.** Google Ads is not connected for QM1010, so the request should have been blocked. The record shows `start_ads_research` committed. Fix: block campaign drafts when the account is not connected, before any tool runs.
4. **RES-R1: research call sent the wrong arguments.** `research_company` returned validation errors (`seed.name` missing, `company_name` and `country` keys rejected), and the record still shows a research job committed. Fix: align the company-research prompt with the tool schema, and add a test that calls the tool with schema-valid arguments.
5. **SAL-Q2: the stock lookup retried one document id 5 times** after `get_document` returned not found. Fix: stop retrying a not-found result, and cap retries per tool.
6. **EXP-R1: expense request refused because the user has no specialists.** The run summary says the account has no specialists assigned. The qm-user account was created through chat and got none. Fix: assign the default agents when a Superadmin creates a user, or name the missing agent in the refusal. EXP-R2 and EXP-R3 are Partial for the same reason.
7. **DOC-R3: "issue the invoice" did not look up the draft.** DOC-R2 committed `create_draft` and `render_pdf`. DOC-R3's record has no document lookup, and the reply asked for the customer and items again. Fix: the Document Agent must look up existing drafts before asking.

### Findings that are not failures

- **Read-only tools are recorded as `effectState: committed`.** Examples: `media-ai__list_media_assets`, `media-ai__get_media_kit_manifest`, `media-ai__get_media_ai_status`, `company-research__get_company_dossier`. This does not change the verdicts here, because the report excludes read-type operations from the write count. Fix at source: read tools must report `effectState: none`.
- **Plan results are not pushed to the chat.** A queued read returns "Queued, plan X" and nothing else. The result appears only when the user asks again in the same session. The follow-up run confirmed this (for example SAL-Q1 answered "no invoices exist" and CAL-Q1 answered "nothing due in 7 days"). Fix: post the plan result to the session when it finishes.
- **`completion.rejected` on the orchestrator's final answer** appears on CMP-Q3, FRM-R4, TPL-R1, RES-R1, MED-Q1, MED-Q2, PRT-R1, REC-R5 and DOC-R1. The records show the rejection but not the reason. Fix: log the rejection reason in the run event.
- **Profile gate:** document and PO drafts are blocked until business type, business activity and tax status are set. The gate worked, but the company setup does not say so. Fix: list these fields in the onboarding checklist.

### Partial: why the record does not show the outcome

- **Attachments not sent (test gap, 3 items):** REC-R3, EXP-R2, MED-R1. The runner did not attach files, so the attachment path was never tested.
- **Write requested, no commit in the record (14 items):** SAL-R1, SAL-R2, CAL-R1, CMP-R2, SCH-R3, SCH-R4, SOL-R1, SOL-R3, DOC-R4, DOC-R5, RES-R2, RUL-6, TPL-R3, EXP-R3. Some may still be running. A later re-check of the records is needed before these are judged.
- **Lookups with a failing or missing read (9 items):** ADS-Q1, ADS-Q2, ADS-Q3 (ads research tool errors), MED-Q1, MED-Q2 (media tool error), MSG-Q3, WEB-Q2, RES-Q2 (dossier tool errors), PRT-R2 (`get_agent_sop` error).
- **Writes that hit a missing record or were not verified (5 items):** DOC-R1 and WEB-R3 (`get_package` error), REC-R5 (duplicate check, no commit recorded), FRM-R1 (`prepare_form` error, then `publish_form` committed outside the request), CMP-R3 (audit log, no read recorded).

### Per-item results

| ID | Role | HTTP | Writes committed | Tool errors | Reads ok | Verdict |
|---|---|---|---|---|---|---|
| CMP-R0 | admin | 200 | create_person | - | list_people | PASSED |
| REC-R1 | admin | 200 | save_customer, save_contact | - | find_customers, match_customer, get_customer | PASSED |
| REC-R2 | admin | 200 | save_customer, save_contact | - | match_customer, find_customers | PASSED |
| REC-R3 | admin | 200 | - | - | - | Partial |
| REC-R4 | admin | 200 | save_product | - | find_catalog, list_tax_codes, describe_schema | PASSED |
| REC-Q1 | admin | 200 | - | - | find_catalog, get_company_profile | PASSED |
| REC-Q2 | admin | 200 | - | - | find_catalog | PASSED |
| DOC-Q1 | admin | 200 | - | - | list_documents | PASSED |
| DOC-Q3 | admin | 200 | - | get_document | list_documents | PASSED |
| PRO-Q1 | admin | 200 | - | - | list_supplier_documents, procurement_overview | PASSED |
| PRO-Q2 | admin | 200 | - | - | list_supplier_documents, find_suppliers | PASSED |
| PRO-R1 | admin | 200 | - | - | - | PASSED |
| PRO-Q3 | admin | 200 | - | get_po | list_pos | PASSED |
| PRO-R2 | admin | 200 | - | get_po | list_pos | PASSED |
| PRO-R3 | admin | 200 | - | - | - | PASSED |
| EXP-R1 | user | 200 | - | - | - | FAILED |
| EXP-R2 | user | 200 | - | - | - | Partial |
| EXP-R4 | user | 200 | - | - | - | PASSED |
| EXP-Q4 | head | 200 | - | - | get_expense_settings, list_claims, list_monthly_submissions | PASSED |
| EXP-N1 | user | 200 | - | - | - | PASSED |
| SAL-Q1 | admin | 200 | - | - | list_documents, find_customers | PASSED |
| SAL-Q2 | admin | 200 | - | get_document | list_documents, find_customers, get_company_profile | FAILED |
| SAL-Q3 | admin | 200 | - | - | - | PASSED |
| SAL-Q4 | admin | 200 | - | - | find_catalog, describe_schema | PASSED |
| SAL-Q5 | admin | 200 | - | - | - | PASSED |
| SAL-R1 | admin | 200 | - | - | - | Partial |
| SAL-R2 | admin | 200 | - | - | - | Partial |
| CAL-Q1 | admin | 200 | - | - | calendar_events | PASSED |
| CAL-Q2 | admin | 200 | - | - | calendar_events | PASSED |
| CAL-Q3 | admin | 200 | - | - | procurement_overview, list_supplier_documents | PASSED |
| CAL-R1 | admin | 200 | - | - | - | Partial |
| CAL-Q4 | admin | 200 | - | - | list_people | PASSED |
| CMP-Q1 | admin | 200 | - | - | - | PASSED |
| CMP-Q2 | admin | 200 | - | - | list_people, count_user_accounts | PASSED |
| CMP-Q3 | admin | 200 | - | - | list_tax_codes, get_onboarding_status, get_company_profile, describe_schema, list_templates, list_documents | PASSED |
| CMP-R1 | admin | 200 | update_company_profile | - | get_company_profile | PASSED |
| CMP-R2 | admin | 200 | - | - | describe_schema, define_custom_field | Partial |
| CMP-R3 | admin | 200 | - | - | - | Partial |
| CMP-N1 | head | 200 | - | create_person | list_people | PASSED |
| CMP-N2 | user | 200 | - | - | - | PASSED |
| FRM-Q1 | admin | 200 | - | get_form | list_forms | PASSED |
| FRM-Q2 | admin | 200 | - | get_form | list_forms | PASSED |
| FRM-Q3 | admin | 200 | - | - | list_forms, get_form | PASSED |
| FRM-R1 | admin | 200 | save_form_draft, publish_form | prepare_form | form_field_types, list_forms, prepare_form | Partial |
| FRM-R2 | admin | 200 | - | - | list_forms, get_onboarding_status | PASSED |
| FRM-R3 | admin | 200 | - | get_form, get_submission | list_forms, list_submissions | PASSED |
| FRM-R4 | admin | 200 | - | get_submission | list_forms, list_submissions | PASSED |
| TPL-Q1 | admin | 200 | - | - | list_templates, get_template | PASSED |
| TPL-R1 | admin | 200 | save_template | - | list_templates, get_template, preview_template | PASSED |
| TPL-Q2 | admin | 200 | - | - | list_templates | PASSED |
| SCH-Q1 | admin | 200 | - | - | schedule_list | PASSED |
| SCH-Q2 | admin | 200 | - | - | schedule_list | PASSED |
| SCH-R1 | admin | 200 | schedule_create | - | schedule_preview | PASSED |
| SCH-R2 | admin | 200 | schedule_create | - | schedule_preview, schedule_agents | PASSED |
| SCH-R3 | admin | 200 | - | - | - | Partial |
| RES-Q1 | admin | 200 | company-research__research_company | company-research__research_company | find_customers, find_catalog, get_customer | PASSED |
| RES-R1 | admin | 200 | company-research__research_company | company-research__research_company | - | FAILED |
| ADS-Q1 | admin | 200 | - | ads-research__start_ads_research, ads-research__get_ads_research | - | Partial |
| ADS-Q2 | admin | 200 | - | ads-research__get_ads_research | - | Partial |
| ADS-Q3 | admin | 200 | - | ads-research__start_ads_research | - | Partial |
| ADS-Q4 | admin | 200 | - | - | count_user_accounts, list_people | PASSED |
| ADS-R1 | admin | 200 | ads-research__start_ads_research | ads-research__start_ads_research | - | FAILED |
| ADS-R2 | admin | 200 | ads-research__start_ads_research | ads-research__start_ads_research, ads-research__get_ads_research | - | FAILED |
| MED-Q1 | admin | 200 | - | - | - | Partial |
| MED-Q2 | admin | 200 | - | media-ai__list_media_assets | - | Partial |
| MED-R1 | admin | 200 | - | - | - | Partial |
| MED-R2 | admin | 200 | - | - | - | PASSED |
| MSG-Q1 | admin | 200 | - | - | list_people | PASSED |
| MSG-Q2 | admin | 200 | - | - | - | PASSED |
| MSG-Q3 | admin | 200 | - | - | - | Partial |
| MSG-R1 | admin | 200 | - | - | list_people | PASSED |
| MSG-R2 | admin | 200 | - | - | - | PASSED |
| MSG-R3 | admin | 200 | - | - | - | PASSED |
| WEB-Q2 | admin | 200 | - | - | - | Partial |
| SOL-Q1 | admin | 200 | - | - | - | PASSED |
| SOL-Q2 | admin | 200 | - | - | - | PASSED |
| SOL-R1 | admin | 200 | - | - | - | Partial |
| SOL-R2 | admin | 200 | - | - | - | PASSED |
| SOL-R3 | admin | 200 | - | - | - | Partial |
| NP-Q1 | admin | 200 | - | - | - | PASSED |
| NP-Q2 | admin | 200 | - | - | - | PASSED |
| NP-R1 | admin | 200 | - | - | - | PASSED |
| NP-R2 | admin | 200 | - | - | find_catalog, describe_schema | PASSED |
| NP-R3 | admin | 200 | - | - | - | PASSED |
| SET-Q1 | admin | 200 | - | - | - | PASSED |
| SET-Q2 | admin | 200 | - | - | - | PASSED |
| PRT-R1 | admin | 200 | save_form_draft, publish_form | - | form_field_types, prepare_form | FAILED |
| PRT-R2 | head | 200 | - | get_agent_sop | - | Partial |
| RUL-1 | admin | 200 | - | - | - | PASSED |
| RUL-2 | admin | 200 | - | - | - | PASSED |
| RUL-3 | admin | 200 | - | - | - | PASSED |
| RUL-4 | admin | 200 | - | - | calendar_events | PASSED |
| REC-Q3 | admin | 200 | - | - | count_user_accounts, list_people, find_customers, get_customer | PASSED |
| REC-R5 | admin | 200 | - | - | match_customer, get_customer | Partial |
| DOC-Q2 | admin | 200 | - | get_document | find_customers, list_documents, get_customer, get_document, get_onboarding_status | PASSED |
| DOC-R1 | admin | 200 | - | get_package | find_customers, find_catalog, get_customer | Partial |
| DOC-R2 | admin | 200 | create_draft | - | find_customers, get_company_profile, prepare_document | PASSED |
| PRO-R4 | admin | 200 | save_supplier | - | find_suppliers, list_supplier_documents, get_supplier | PASSED |
| EXP-Q1 | user | 200 | - | - | - | PASSED |
| EXP-Q2 | user | 200 | - | - | - | PASSED |
| SAL-Q6 | admin | 200 | - | - | find_catalog, describe_schema | PASSED |
| SCH-R4 | admin | 200 | - | - | schedule_list | Partial |
| SCH-R5 | admin | 200 | - | - | schedule_list | PASSED |
| RES-Q2 | admin | 200 | - | company-research__get_company_dossier, company-research__replay_company_dossier | - | Partial |
| RES-R2 | admin | 200 | - | - | list_people | Partial |
| TPL-R2 | admin | 200 | - | - | list_templates, get_company_profile | PASSED |
| WEB-Q1 | admin | 200 | - | - | find_catalog | PASSED |
| WEB-R3 | admin | 200 | - | get_package | find_catalog | Partial |
| RUL-5 | admin | 200 | - | archive_record | find_customers, get_customer | PASSED |
| RUL-6 | admin | 200 | - | - | get_agent_sop, fde_describe, get_company_profile, describe_schema, get_onboarding_status | Partial |
| EXP-R3 | user | 200 | - | - | - | Partial |
| DOC-R3 | admin | 200 | - | - | - | FAILED |
| DOC-R4 | admin | 200 | - | - | find_customers, list_documents, get_customer | Partial |
| DOC-R5 | admin | 200 | - | - | list_documents, find_customers, get_document | Partial |
| TPL-R3 | admin | 200 | - | get_template | list_templates | Partial |
| SCH-Q3 | admin | 200 | - | - | schedule_list, schedule_history | PASSED |
| EXP-Q5 | head | 200 | - | - | list_claims, get_expense_settings | PASSED |
