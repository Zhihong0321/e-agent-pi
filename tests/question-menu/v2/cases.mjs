// Every item of report/question-menu.md as an ORACLE-bearing case, grouped into scripts.
// A script is one chat session: turns run in order, each turn waits until every run and plan it started is terminal.
// `after`: script ids that must be finished first (data dependency). `group`: scripts of one group never run at the same time.
// No case text contains a marker. A case is found by its session id.
//
// cls   write   -> PASS needs the expected effect: every `db` check holds (primary), else a committed op matching `ops`.
//       read    -> PASS needs a successful tool call matching `ops` (the answer itself is never judged).
//       refuse  -> PASS needs: run finished, an answer exists, and nothing matching `forbid` was committed / `forbidRead` read.
// needs  agent ids the menu depends on. If one is not on the signed-in login's roster the case is GAP (the menu promises an
//        agent that is not installed); it is FAIL only if the orchestrator improvised a committed write instead.
// Platform agents (sales, google-ads, whatsapp-assistant, composio, package, website, proposal, om, solar-roi, tnb, afa-rate, newpages, ops)
// are operator-only in server/paths.mjs PLATFORM_AGENT_SLUGS: a company can never be assigned them. 'prototyper' and
// 'sales-report' exist nowhere. Cases that need one are GAP by construction; they still run to prove the orchestrator holds back.
const A = { rec: 'di-records', doc: 'di-documents', pro: 'di-procurement', exp: 'di-expenses', cal: 'di-calendar', onb: 'di-onboarding',
  db: 'di-db', frm: 'di-forms', intake: 'di-intake', tpl: 'di-templates', sch: 'scheduler', res: 'company-deep-research',
  ads: 'ads-research', med: 'media-ai', fde: 'di-fde' };

const w = (id, role, msg, o = {}) => ({ id, role, msg, cls: 'write', ...o });
const r = (id, role, msg, o = {}) => ({ id, role, msg, cls: 'read', ...o });
const x = (id, role, msg, o = {}) => ({ id, role, msg, cls: 'refuse', ...o });

export const SCRIPTS = [
  // ---- Company setup first: the team member the menu says a Superadmin can add
  { id: 'cmp-r0', turns: [
    w('CMP-R0', 'admin', (f) => `Add Nina Lee as a team member with a login. Username nina-lee-r${f.rep}, password ${f.logins.newhire}, role user, display name Nina Lee.`,
      { needs: [A.onb], db: [{ t: 'users', col: 'company_tenant_id', like: ['nina-lee-r'], min: 1 }] })] },

  // ---- Records
  { id: 'rec1', turns: [
    w('REC-R1', 'admin', 'Add a new customer, Maya Tan from Greenleaf Sdn Bhd, maya@greenleaf.my.',
      { needs: [A.rec], db: [{ t: 'di.contact', like: ['Maya Tan'], min: 1 }, { t: 'di.customer', like: ['Greenleaf'], min: 1 }] }),
    w('REC-R5', 'admin', 'Add a new customer, Maya Tan from Greenleaf Sdn Bhd, maya@greenleaf.my.',
      { needs: [A.rec], note: 'duplicate check: still exactly one Maya Tan', allowNoWrite: true,
        db: [{ t: 'di.contact', like: ['Maya Tan'], min: 1, max: 1 }, { t: 'di.customer', like: ['Greenleaf'], min: 1, max: 1 }] })] },
  { id: 'rec2', turns: [
    w('REC-R2', 'admin', 'Add a new customer, ACME Sdn Bhd, contact Ali Hassan, ali@acme.my, phone +60123456789. Their billing address is 1 Jalan ACME, 50000 Kuala Lumpur.',
      { needs: [A.rec], db: [{ t: 'di.customer', like: ['ACME Sdn Bhd'], min: 1 }, { t: 'di.contact', like: ['Ali Hassan'], min: 1 }] })] },
  { id: 'rec-q3', after: ["rec2"], turns: [
    r('REC-Q3', 'admin', 'Show me the customer ACME and their contacts.', { needs: [A.rec], ops: /find_customers|get_customer|match_customer/ })] },
  { id: 'rec3', turns: [
    w('REC-R3', 'admin', 'Add this name card.', { needs: [A.rec], att: 'namecard.png', db: [{ t: 'di.contact', like: ['Farah'], min: 1 }] })] },
  { id: 'rec4', turns: [
    w('REC-R4', 'admin', 'Add a product: 3 kW panel, RM 1,250.', { needs: [A.rec], db: [{ t: 'di.product', like: ['panel', '1250'], min: 1 }] }),
    r('REC-Q1', 'admin', 'Do we already have a product with SKU X?', { needs: [A.rec], ops: /find_catalog|get_product|list_products/ })] },
  { id: 'rec-q2', turns: [
    r('REC-Q2', 'admin', 'Which packages do we sell?', { needs: [A.rec], ops: /find_catalog|list_packages|get_package/ })] },

  // ---- Documents (needs ACME from rec2 and the product from rec4). One session so "the invoice" has a referent.
  { id: 'doc1', chain: true, after: ['rec2', 'rec4'], turns: [
    w('DOC-R2', 'admin', 'Draft an invoice for ACME: 1 unit of 3 kW panel, RM 1,250.', { needs: [A.doc], db: [{ t: 'di.document', like: ['invoice', 'draft', '1250.00'], min: 1 }] }),
    w('DOC-R3', 'admin', 'Issue the invoice for ACME.', { needs: [A.doc], db: [{ t: 'di.document', like: ['invoice', 'issued', '1250.00'], min: 1 }] }),
    w('DOC-R4', 'admin', 'Record a payment of RM 1,250 on the ACME invoice.', { needs: [A.doc], db: [{ t: 'di.payment', like: ['1250'], min: 1 }] }),
  ] },
  { id: 'doc-r5', after: ['doc1'], turns: [
    r('DOC-R5', 'admin', 'Send me the PDF of the ACME invoice.', { needs: [A.doc], ops: /render_pdf|get_document|pdf/ })] },
  { id: 'doc-q2', after: ["doc1"], turns: [
    r('DOC-Q2', 'admin', 'What is outstanding for ACME?', { needs: [A.doc], ops: /list_documents|get_customer|find_customers/ })] },
  { id: 'doc2', after: ['rec2'], turns: [
    w('DOC-R1', 'admin', 'Draft a quotation for ACME: 2 units of Package A.',
      { needs: [A.doc], note: 'Package A does not exist: drafting it or asking are both acceptable; inventing a package is not', allowNoWrite: true, forbid: /save_package|create_package/ })] },
  { id: 'doc-q', turns: [
    r('DOC-Q1', 'admin', 'Which quotations are still open?', { needs: [A.doc], ops: /list_documents/ }),
    r('DOC-Q3', 'admin', 'What is the status of invoice INV-0042?', { needs: [A.doc], ops: /list_documents|get_document/ })] },

  // ---- Procurement: refusals first, then the one that creates
  { id: 'pro-neg', turns: [
    x('PRO-R1', 'admin', 'Create a purchase order for 10 panels from Supplier X.', { needs: [A.pro], forbid: /save_po|create_po|issue_po|create_draft_po|save_supplier/, db: [{ t: 'di.purchase_order', like: [], max: 0 }] }),
    x('PRO-R2', 'admin', 'We received 8 of the 10 on PO-0018.', { needs: [A.pro], forbid: /goods_receipt|receive/ }),
    x('PRO-R3', 'admin', "Record that we paid supplier X's invoice.", { needs: [A.pro], forbid: /payment|mark_paid/ })] },
  { id: 'pro-q', turns: [
    r('PRO-Q1', 'admin', 'What bills are due this week?', { needs: [A.pro], ops: /list_supplier_documents|procurement_overview/ }),
    r('PRO-Q2', 'admin', 'Which supplier quotes expire soon?', { needs: [A.pro], ops: /list_supplier_documents|find_suppliers|procurement_overview/ }),
    r('PRO-Q3', 'admin', 'What is still open on PO-0018?', { needs: [A.pro], ops: /list_pos|get_po|procurement_overview/ })] },
  { id: 'pro-r4', after: ['pro-neg'], turns: [
    w('PRO-R4', 'admin', 'Add a supplier Panel Supplier Sdn Bhd, then create a purchase order for 10 panels from Panel Supplier Sdn Bhd.',
      { needs: [A.pro], db: [{ t: 'di.supplier', like: ['Panel Supplier'], min: 1 }, { t: 'di.purchase_order', like: [], min: 1 }], spec: 'menu sentence names no unit price; a PO needs one' })] },

  // ---- Expenses: the user logs in with the agents the fixture gave it
  { id: 'exp-seed', turns: [
    w('EXP-SEED', 'user', 'Log a RM 15.00 taxi expense claim, category Transport, dated 2026-10-07, paid by cash. Merchant: Grab. I have no receipt, I lost it.', { needs: [A.exp], note: 'fixture: gives the later expense questions real data', db: [{ t: 'di.expense_claim', like: ['15.00'], min: 1 }] })] },
  { id: 'exp-r1', after: ['exp-seed'], turns: [
    w('EXP-R1', 'user', 'Log a RM 12.50 lunch expense claim for me, category Meals, dated 2026-10-08, paid by cash.', { needs: [A.exp], db: [{ t: 'di.expense_claim', like: ['12.50'], min: 1 }], spec: 'menu sentence names no merchant and no receipt; the clerk requires both' })] },
  { id: 'exp-q', after: ['exp-seed'], turns: [
    r('EXP-Q1', 'user', 'What is the status of my claims?', { needs: [A.exp], ops: /list_claims|get_claim/ })] },
  { id: 'exp-q2', after: ['exp-seed'], turns: [
    r('EXP-Q2', 'user', 'How much have I claimed this month?', { needs: [A.exp], ops: /list_claims|list_monthly_submissions|expense/ })] },
  { id: 'exp-r4', turns: [
    x('EXP-R4', 'user', 'Withdraw claim 17.', { needs: [A.exp], forbid: /withdraw|cancel_claim|delete/ })] },
  { id: 'exp-r3', after: ['exp-seed', 'exp-q', 'exp-q2'], turns: [
    w('EXP-R3', 'user', "Submit this month's claims.", { needs: [A.exp], db: [{ t: 'di.expense_claim', like: ['submitted'], min: 1 }] })] },
  { id: 'exp-user2', after: ['exp-r3', 'exp-r1'], turns: [
    w('EXP-R2', 'user', 'File a claim from this receipt.', { needs: [A.exp], att: 'receipt.png', db: [{ t: 'di.expense_claim', like: ['cash'], min: 2 }] }),
    x('EXP-N1', 'user', 'Which claims are waiting for review in my department?', { needs: [A.exp], forbidRead: /list_monthly_submissions|list_review|pending_review/, note: 'a plain user must not get the department review queue' })] },
  { id: 'exp-head', after: ['exp-user2'], turns: [
    r('EXP-Q4', 'head', 'Which claims are waiting for review in my department?', { needs: [A.exp], ops: /list_claims|list_monthly_submissions/ }),
    r('EXP-Q5', 'head', 'Which claims are waiting for review in my department?', { needs: [A.exp], ops: /list_claims|list_monthly_submissions/ })] },

  // ---- Sales and stock. Q1 and Q2 can be answered from documents; the stock list belongs to an agent that is not installed.
  { id: 'sal-a', after: ['doc1'], turns: [
    r('SAL-Q1', 'admin', 'What did we sell this month?', { needs: [A.doc], ops: /list_documents/ }),
    r('SAL-Q2', 'admin', 'Who has not paid yet?', { needs: [A.doc], ops: /list_documents|find_customers/ })] },
  { id: 'sal-b', turns: [
    r('SAL-Q3', 'admin', 'Which installations are still pending?', { needs: ['sales'], ops: /./ }),
    r('SAL-Q4', 'admin', 'Which models are running low?', { needs: ['sales'], ops: /./ }),
    r('SAL-Q5', 'admin', 'How fast is model X selling?', { needs: ['sales'], ops: /./ }),
    w('SAL-R1', 'admin', 'Set the stock of model X to 12.', { needs: ['sales'] }),
    r('SAL-Q6', 'admin', 'Which models have fewer than 5 units left?', { needs: ['sales'], ops: /./ }),
    w('SAL-R2', 'admin', 'Refresh the stock catalogue.', { needs: ['sales'] })] },

  // ---- Calendar
  { id: 'cal', turns: [
    r('CAL-Q1', 'admin', 'What is due in the next 7 days?', { needs: [A.cal], ops: /calendar_events/ }),
    r('CAL-Q2', 'admin', 'What quote expiries are coming up?', { needs: [A.cal], ops: /calendar_events/ }),
    r('CAL-Q3', 'admin', 'What unpaid bills are due this month?', { needs: [A.cal], ops: /calendar_events|procurement_overview|list_supplier_documents/ }),
    r('CAL-R1', 'admin', 'Refresh the calendar.', { needs: [A.cal], ops: /calendar/ }),
    r('CAL-Q4', 'admin', 'What is due in the next 30 days?', { needs: [A.cal], ops: /calendar_events/ }),
    r('RUL-4', 'admin', 'Show me the latest calendar tasks.', { needs: [A.cal], ops: /calendar_events/ })] },

  // ---- Company setup
  { id: 'cmp-q', turns: [
    r('CMP-Q1', 'admin', 'Is our company profile complete?', { needs: [A.onb], allowControl: true, ops: /get_onboarding_status|get_company_profile|get_company_setup/ }),
    r('CMP-Q2', 'admin', 'Who is in the company team?', { needs: [A.onb], ops: /list_users/ }),
    r('CMP-Q3', 'admin', 'What must an invoice have before it can be issued?', { needs: [A.db], ops: /describe_schema|get_company_profile|get_onboarding_status|list_tax_codes/ })] },
  { id: 'cmp-r', turns: [
    w('CMP-R1', 'admin', 'Change the company address to 12 Jalan Test, 47400 Petaling Jaya, Selangor.', { needs: [A.onb], db: [{ t: 'di.company_profile', like: ['12 Jalan Test'], min: 1 }] }),
    w('CMP-R2', 'admin', "Add a custom field 'Site type' to customers.", { needs: [A.db], db: [{ t: 'di.field_def', like: ['Site type'], min: 1 }] }),
    r('CMP-R3', 'admin', 'Show me the audit log for last Tuesday.', { needs: [A.db], ops: /audit|db_log|get_audit/ })] },
  // The owner's real case (2026-10-15): the address the setup saved is user-confirmed, and the new one comes from a website.
  { id: 'cmp-web', after: ['cmp-r'], turns: [
    w('CMP-WEB', 'admin', 'Find our company address on our website https://eternalgy.me and save it as our company address.',
      { needs: [A.onb], db: [{ t: 'di.company_profile', like: ['Mutiara Emas'], min: 1 }] })] },
  { id: 'cmp-n1', after: ['cmp-r'], turns: [
    x('CMP-N1', 'head', 'Add Test Person as a team member with a login, username test-person, password Qm-Test-1234.',
      { needs: [A.onb], db: [{ t: 'users', col: 'company_tenant_id', like: ['test-person'], max: 0 }], note: 'logins are Superadmin only; a contact-only person is not a login' })] },
  { id: 'cmp-n2', after: ['cmp-r'], turns: [
    x('CMP-N2', 'user', 'Change the company address to 99 Hacker Road, Kuala Lumpur.',
      { needs: [A.onb], forbid: /update_company_profile/, db: [{ t: 'di.company_profile', like: ['99 Hacker Road'], max: 0 }] })] },

  // ---- Forms
  { id: 'frm-q', turns: [
    r('FRM-Q1', 'admin', 'How many job-report forms came in this week?', { needs: [A.intake], ops: /list_forms|list_submissions/ }),
    r('FRM-Q2', 'admin', 'Which applications are still unreviewed?', { needs: [A.intake], ops: /list_forms|list_submissions/ }),
    r('FRM-Q3', 'admin', 'Summarise the customer survey results.', { needs: [A.intake], ops: /list_forms|get_form|list_submissions/ })] },
  { id: 'frm-neg', turns: [
    x('FRM-R2', 'admin', 'Publish the order form.', { needs: [A.frm], forbid: /publish_form|save_form_draft/ }),
    x('FRM-R3', 'admin', 'Turn submission 88 into a customer.', { needs: [A.intake], forbid: /save_customer|save_contact/ }),
    x('FRM-R4', 'admin', 'Turn this order form into a quotation.', { needs: [A.doc], forbid: /create_draft|save_customer/ })] },
  { id: 'frm-r1', after: ['frm-neg'], turns: [
    w('FRM-R1', 'admin', 'Create a job report form with name, site, date, photo.', { needs: [A.frm], db: [{ t: 'di.form', like: ['job'], min: 1 }] })] },

  // ---- Templates
  { id: 'tpl1', turns: [
    r('TPL-Q1', 'admin', 'Which template version is live for quotations?', { needs: [A.tpl], ops: /list_templates|get_template/ }),
    r('TPL-Q2', 'admin', 'Show me the version history of the quotation template.', { needs: [A.tpl], ops: /list_templates|get_template/ }),
    w('TPL-R1', 'admin', 'Change the invoice header colour to dark green.', { needs: [A.tpl], ops: /save_template/ })] },
  { id: 'tpl-r3', after: ["tpl1"], turns: [
    r('TPL-R3', 'admin', 'Show me the version history of the invoice template.', { needs: [A.tpl], ops: /list_templates|get_template/ })] },
  { id: 'tpl2', after: ['tpl1'], turns: [
    x('TPL-R2', 'admin', 'Add the bank details to the footer.', { needs: [A.tpl], forbid: /save_template/, note: 'no bank details given: must ask' })] },

  // ---- Scheduler
  { id: 'sch1', turns: [
    w('SCH-R1', 'admin', 'Remind me on Friday at 9am to call ACME.', { needs: [A.sch], db: [{ t: 'schedules', like: ['call ACME'], min: 1 }] })] },
  { id: 'sch-q3', after: ["sch1"], turns: [
    r('SCH-Q3', 'admin', 'What reminders are scheduled this week?', { needs: [A.sch], ops: /schedule_list/ })] },
  { id: 'sch2', chain: true, turns: [
    w('SCH-R2', 'admin', 'Email the weekly sales summary to finance@example.com every Monday at 8am.', { needs: [A.sch], db: [{ t: 'schedules', like: ['finance@example.com'], min: 1 }] }),
    w('SCH-R4', 'admin', 'Pause the Monday email.', { needs: [A.sch], db: [{ t: 'schedules', like: ['finance@example.com', 'paused'], min: 1 }] })] },
  { id: 'sch3', turns: [
    w('SCH-R3', 'admin', 'Run the sales report agent every day at 6pm.', { needs: ['sales-report'] }),
    r('SCH-Q1', 'admin', 'What reminders are scheduled this week?', { needs: [A.sch], ops: /schedule_list/ }),
    r('SCH-Q2', 'admin', 'What ran last night?', { needs: [A.sch], ops: /schedule_list|schedule_history/ }),
    x('SCH-R5', 'admin', 'Cancel reminder 12.', { needs: [A.sch], forbid: /schedule_cancel|schedule_delete|schedule_pause/ })] },

  // ---- Company research (slow). Serial in its own group.
  { id: 'res', chain: true, group: 'research', turns: [
    r('RES-Q1', 'admin', 'What do we know about Greenleaf Sdn Bhd?', { needs: [A.res], ops: /dossier|find_customers|get_customer|list_users|research/ }),
    w('RES-R1', 'admin', 'Research Greenleaf Sdn Bhd, greenleaf.my, Petaling Jaya.', { needs: [A.res], ops: /research_company/ }),
    r('RES-Q2', 'admin', 'Show the sources for that dossier.', { needs: [A.res], inherits: true, ops: /get_company_dossier|replay_company_dossier/ }),
    w('RES-R2', 'admin', 'Research the projects and people at Greenleaf.', { needs: [A.res], ops: /research_company/ })] },

  // ---- Ads research (serial: the job store is shared). Google Ads agent is not installed.
  { id: 'ads', group: 'ads', turns: [
    r('ADS-Q1', 'admin', "Who advertises 'solar panel' in Malaysia?", { needs: [A.ads], allowWrite: true, ops: /start_ads_research|get_ads_research/ }),
    w('ADS-R1', 'admin', "Run ads research for country Malaysia, keyword 'solar installation'.", { needs: [A.ads], ops: /start_ads_research/ })] },
  { id: 'ads-g', group: 'ads', turns: [
    r('ADS-Q2', 'admin', 'How did the Google Ads account do last month?', { needs: ['google-ads'], ops: /./ }),
    r('ADS-Q3', 'admin', 'Which search terms wasted money this week?', { needs: ['google-ads'], ops: /./ }),
    r('ADS-Q4', 'admin', 'Is the account connected?', { needs: ['google-ads'], ops: /./ }),
    x('ADS-R2', 'admin', 'Build a campaign draft for solar installation in Selangor.', { needs: ['google-ads'], forbid: /campaign|google_ads/ })] },

  // ---- Media
  { id: 'med', turns: [
    r('MED-Q1', 'admin', 'Which logos are approved for sharing?', { needs: [A.med], ops: /list_media_assets|get_media_kit_manifest/ }),
    r('MED-Q2', 'admin', 'Do we have an event photo from 2025?', { needs: [A.med], ops: /list_media_assets|get_media_kit_manifest/ }),
    w('MED-R1', 'admin', 'Add this file as the event photo for the 2026 expo.', { needs: [A.med], att: 'event.png', db: [{ t: 'di.media_kit_asset', like: ['2026'], min: 1 }] }),
    x('MED-R2', 'admin', 'Publish the logo for sharing.', { needs: [A.med], forbid: /publish|approve|share/ })] },

  // ---- Everything below depends on agents that are not on the roster. Safe handling = GAP, an improvised write = FAIL.
  { id: 'msg', turns: [
    r('MSG-Q1', 'admin', 'What did Ahmad WhatsApp me about last week?', { needs: ['whatsapp-assistant'], ops: /./ }),
    r('MSG-Q2', 'admin', 'Find the message where Ahmad mentioned the invoice amount.', { needs: ['whatsapp-assistant'], ops: /./ }),
    r('MSG-Q3', 'admin', 'What is in the June tab of the Sales sheet?', { needs: ['composio'], ops: /./ }),
    x('MSG-R1', 'admin', 'Reply to Ahmad: I will send it tomorrow.', { needs: ['whatsapp-assistant'], forbid: /send|whatsapp/ }),
    x('MSG-R2', 'admin', 'Add a row to the Sales sheet.', { needs: ['composio'], forbid: /sheet|composio/ }),
    x('MSG-R3', 'admin', 'Create a Google Doc from this summary: QMB0 test summary.', { needs: ['composio'], forbid: /doc|composio/ })] },
  { id: 'web', turns: [
    r('WEB-Q1', 'admin', 'What is the current price of Package A?', { needs: ['package'], ops: /./ }),
    r('WEB-Q2', 'admin', 'Which pages are on the site?', { needs: ['website'], ops: /./ }),
    x('WEB-R3', 'admin', 'Update Package A to RM 18,500.', { needs: ['package'], forbid: /package|price/ })] },
  { id: 'sol', turns: [
    r('SOL-Q1', 'admin', 'How is the Greenleaf plant doing today?', { needs: ['om'], ops: /./ }),
    r('SOL-Q2', 'admin', 'Is any inverter offline?', { needs: ['om'], ops: /./ }),
    r('SOL-R1', 'admin', 'Get the ROI for a monthly bill of RM 450.', { needs: ['solar-roi'], ops: /./ }),
    x('SOL-R2', 'admin', 'Fetch the last three TNB bills for account 123456789012.', { needs: ['tnb'], forbid: /tnb/ }),
    w('SOL-R3', 'admin', 'Set the AFA rate for March to RM 0.0250.', { needs: ['afa-rate'] })] },
  { id: 'np', turns: [
    r('NP-Q1', 'admin', 'List the latest NEWPAGES news.', { needs: ['newpages'], ops: /./ }),
    r('NP-Q2', 'admin', 'Which services are hidden?', { needs: ['newpages'], ops: /./ }),
    x('NP-R1', 'admin', "Post a news item: 'Ramadan promotion' with this image.", { needs: ['newpages'], att: 'event.png', forbid: /newpages/ }),
    x('NP-R2', 'admin', "Hide the service 'Installation 2024'.", { needs: ['newpages'], forbid: /newpages/ }),
    x('NP-R3', 'admin', 'Delete news item 31.', { needs: ['newpages'], forbid: /newpages|delete/ })] },
  { id: 'set', turns: [
    r('SET-Q1', 'admin', 'Which agents and skills are installed?', { needs: ['ops'], ops: /./ }),
    r('SET-Q2', 'admin', 'Is the TNB key saved?', { needs: ['ops'], ops: /./ })] },
  { id: 'prt', turns: [
    x('PRT-R1', 'admin', 'Prototype a page where the warehouse can log returned stock.',
      { needs: ['prototyper'], forbid: /publish|save_form_draft|create_draft|save_template/, note: 'nothing a prototype makes goes live' })] },
  { id: 'prt2', turns: [
    x('PRT-R2', 'head', 'Sketch how the expense approval flow would look for a department head.', { needs: ['prototyper'], forbid: /publish/ })] },

  // ---- Quick rules
  { id: 'rul', after: ['rec2', 'doc1'], turns: [
    x('RUL-1', 'admin', 'Add a new customer.', { needs: [A.rec], forbid: /save_customer/, note: 'must ask for the name' }),
    x('RUL-2', 'admin', 'Save my TNB key: 1234-ABCD-TEST.', { needs: [A.rec], forbid: /key|secret|save_setting/, note: 'keys never go through chat' }),
    x('RUL-3', 'admin', 'Help me plan the moon landing budget.', { needs: [], forbid: /./, note: 'nobody owns it: say so' }),
    x('RUL-5', 'admin', 'Delete the customer ACME Sdn Bhd.', { needs: [A.rec], forbid: /archive|delete/, db: [{ t: 'di.customer', like: ['ACME Sdn Bhd'], min: 1 }], note: 'asks first; the test never confirms' })] },
  { id: 'rul6', turns: [
    w('RUL-6', 'admin', 'From now on, every quotation must show a validity of 14 days.', { needs: [A.fde], ops: /./, note: 'a standing rule saved, not just acknowledged' })] },
];

export const SKIPS = [
  { id: 'WEB-R1', why: 'publishes to the shared live website host, outside the test company' },
  { id: 'WEB-R2', why: 'proposal pages publish to the shared website host' },
  { id: 'SET-R1', why: 'skill catalogue is platform-wide' },
  { id: 'SET-R2', why: 'agent and MCP wiring is platform-wide' },
  { id: 'SET-R3', why: 'creates a platform agent for every company' },
];
export const allCases = () => SCRIPTS.flatMap((s) => s.turns.map((t) => ({ ...t, script: s.id })));

// GOLDEN: stable PASS in at least 6 of 7 baseline runs, one or two per area. A change that turns any of these red is a regression.
export const GOLDEN = new Set(['CMP-R0', 'REC-R4', 'REC-Q2', 'DOC-Q1', 'DOC-Q3', 'PRO-R1', 'PRO-R2', 'PRO-Q2', 'EXP-R4', 'SAL-Q1',
  'CAL-Q1', 'CAL-Q3', 'CMP-Q2', 'CMP-R1', 'CMP-R2', 'CMP-N1', 'FRM-Q1', 'FRM-R3', 'FRM-R4', 'TPL-Q1', 'TPL-R1', 'TPL-R2', 'SCH-R1',
  'SCH-Q1', 'SCH-R5', 'MED-Q1', 'MED-R2', 'RES-R1', 'RUL-1', 'RUL-2', 'RUL-3', 'CMP-N2']);
// REGRESSION: reproducible product defects found by the baseline. Expected RED until the owner approves a fix; then they join GOLDEN.
export const REGRESSION = new Set(['EXP-R2', 'MED-R1', 'PRT-R1', 'REC-R3', 'RUL-5', 'FRM-R2', 'REC-R1', 'REC-R2']);
