import { USER_TOOLS } from './user-tools.mjs';
// The single registry of Document Intelligence tools: input shapes, which micro-agent
// may call each one, and the domain function behind it. The MCP server reads it to
// advertise tools; the host reads it to authorise and run them. One source of truth,
// so an agent can never be offered a tool the host would refuse, or vice versa.
import { z } from "zod";
import * as records from "./records.mjs";
import * as catalog from "./catalog.mjs";
import * as documents from "./documents.mjs";
import * as admin from "./admin.mjs";
import * as company from './company.mjs';
import * as members from './members.mjs';
import * as forms from "./forms.mjs";
import { renderFormPage } from "./formpage.mjs";
import { crmDashboard } from "./dashboard.mjs";
import { readCalendar } from "./calendar.mjs";
import * as expenses from "./expenses.mjs";
import * as fde from "./fde.mjs";
import * as reports from "./reports.mjs";
import { claimsToCsv } from "./expense-report.mjs";
import * as procurement from "./procurement.mjs";
import { publishPoPdf } from "./procurement-report.mjs";

export const AGENTS = {
  "di-onboarding": { name: "Company Onboarding", short: "CO" },
  "di-records": { name: "Records Clerk", short: "RC" },
  "di-documents": { name: "Document Agent", short: "DA" },
  "di-templates": { name: "Template Designer", short: "TD" },
  "di-db": { name: "DB Manager", short: "DB" },
  "di-forms": { name: "Form Designer", short: "FD" },
  "di-intake": { name: "Form Clerk", short: "FC" },
  "di-calendar": { name: "Calendar AI", short: "CA" },
  "di-expenses": { name: "Expenses Clerk", short: "EC" },
  "di-procurement": { name: "Procurement Clerk", short: "PC" },
  "di-fde": { name: "Forward Deploy Engineer", short: "FD" },
};

// The read-only company tools every agent gets. The calendar and the expense clerk need none of the CRM ones.
const ALL = Object.keys(AGENTS).filter((id) => !["di-calendar", "di-expenses", "di-procurement", "di-fde"].includes(id));
const RECORDS = "di-records";
const DOCS = "di-documents";
const TPL = "di-templates";
const DB = "di-db";
const ONBOARD = "di-onboarding";
const FORMS = "di-forms";
const INTAKE = "di-intake";
const CALENDAR = "di-calendar";
const EXPENSES = "di-expenses";
const PROC = "di-procurement";
const FDE = "di-fde";

const fdeIdentity = z.string().optional().describe("Identity code from the newest [Deploy identity] line. Pass it on every call; never show it to the user.");
const fdeRule = z.object({
  id: z.string().describe("Short slug such as mileage-map. The same id replaces that rule."),
  when: z.object({ category: z.array(z.string()).max(10) }).optional().describe("Only claims in these category keys; omit to cover every category"),
  check: z.enum(["custom_field", "attachment_kind", "amount_at_most"]),
  arg: z.union([z.string(), z.number()]).describe("custom_field: expense_claim.<field key>; attachment_kind: the kind key; amount_at_most: a number"),
  severity: z.enum(["block", "warn"]),
  message: z.string().describe("Max 200 characters, shown to the claimant: say exactly what to provide"),
});
const fdeReport = z.object({
  slug: z.string().describe("e.g. mileage-monthly"), title: z.string(),
  where: z.object({
    category: z.array(z.string()).optional(), status: z.array(z.enum(["submitted", "approved", "rejected"])).optional(),
    department: z.array(z.string()).optional(), period: z.string().optional().describe("current | previous | YYYY-MM | all"),
  }).optional(),
  period_basis: z.enum(["submission", "expense_date"]).optional().describe("submission = the monthly claim cycle (default); expense_date = calendar month of the expense"),
  group_by: z.array(z.enum(["employee", "department", "category", "month"])).max(2).optional(),
  measures: z.array(z.object({
    key: z.string(), label: z.string().optional(), fn: z.enum(["count", "sum", "avg", "max"]),
    field: z.string().optional().describe("amount | tax_amount | custom.<number field key>; not needed for count"),
  })).max(8).optional(),
  include_members: z.boolean().optional().describe("With group_by [employee] only: list people with no claims too"),
  detail: z.boolean().optional(), sort: z.object({ by: z.string(), dir: z.enum(["asc", "desc"]).optional() }).optional(),
  audience: z.enum(["admin", "scoped"]).optional().describe("admin (default) = admins only; scoped = anyone sees only their own claims"),
});
const fdeChangeset = z.object({
  target_agent: z.enum(["di-expenses"]),
  summary: z.string().describe("One line for the change history"),
  categories: z.array(z.object({ key: z.string(), label: z.string() })).max(10).optional().describe("Extra expense categories, e.g. {key: mileage, label: Mileage}"),
  custom_fields: z.array(z.object({
    key: z.string(), label: z.string(), type: z.enum(["text", "number", "date", "boolean", "select"]),
    options: z.array(z.string()).optional().describe("select only"), help: z.string().optional(),
  })).max(10).optional().describe("Extra values a claim can carry, e.g. {key: distance_km, label: Distance (km), type: number}"),
  rules: z.array(fdeRule).max(20).optional(),
  reports: z.array(fdeReport).max(10).optional().describe("Saved reports the Expenses Clerk can run, e.g. monthly mileage by employee"),
  sop: z.object({ markdown: z.string().describe("Max 1200 characters: how the agent should handle these rules in conversation") }).optional(),
  examples: z.array(z.object({
    claim: z.object({
      category: z.string(), amount: z.number(), custom: z.record(z.string(), z.any()).optional(),
      attachment_kinds: z.array(z.string()).optional().describe("Kinds of the attachments on the example, e.g. [route_map]"),
    }),
    expect: z.enum(["ok", "blocked"]),
  })).max(12).optional().describe("Example claims and whether the rules must accept or refuse them. Needed when you add rules."),
  notes_for_engineering: z.array(z.string()).max(5).optional().describe("Anything asked for that cannot be done with this vocabulary"),
});

const identity =z.string().optional().describe("Identity code from the newest [Expense identity] line. Pass it on every call; never show it to the user.");
const procIdentity = z.string().optional().describe("Identity code from the newest [Procurement identity] line. Pass it on every call; never show it to the user.");
const poLine = z.object({
  description: z.string(), quantity: z.number(), unit_price: z.number(),
  unit: z.string().optional().describe("e.g. pcs, box, kg"), tax_rate: z.number().optional().describe("Percent, e.g. 8 for SST 8%"), sku: z.string().optional(),
});

const formField = z
  .object({
    key: z.string().optional().describe("snake_case, unique in the form (sections may omit it)"),
    type: z.string().describe("text | textarea | email | phone | number | date | select | multiselect | checkbox | rating | file | section"),
    label: z.string(),
    help: z.string().optional(),
    required: z.boolean().optional(),
    options: z.array(z.string()).optional().describe("select / multiselect"),
    min: z.number().optional(),
    max: z.number().optional(),
    scale: z.number().optional().describe("rating: 3-10, default 5"),
    max_length: z.number().optional(),
    accept: z.array(z.string()).optional().describe('file: ["image"], ["pdf"] or both'),
    max_mb: z.number().optional(),
    max_files: z.number().optional(),
    text: z.string().optional().describe("section: text shown under the heading"),
    binds_to: z.string().optional().describe("What the answer means, e.g. customer.email, contact.name, line.PNL-550.quantity, survey.satisfaction"),
  })
  .passthrough();
const formSettings = z
  .object({
    consent_text: z.string().optional().describe("PDPA consent the visitor must tick; required when personal data is collected"),
    intro: z.string().optional(),
    success_message: z.string().optional(),
    closes_at: z.string().optional().describe("YYYY-MM-DD"),
    max_submissions: z.number().int().optional(),
  })
  .optional();
const formRef = z.string().describe("Form slug or id");

const address = z
  .union([
    z.string(),
    z.object({
      line1: z.string().optional(),
      line2: z.string().optional(),
      line3: z.string().optional(),
      postcode: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
    }),
  ])
  .describe("Address: {line1, line2, postcode, city, state, country} (preferred) or a multi-line string");
const custom = z.record(z.string(), z.any()).optional().describe("Custom field values (keys must be defined by the DB Manager)");
const lineInput = z.object({
  product: z.string().optional().describe("Product SKU or id"),
  package: z.string().optional().describe("Package code or id"),
  description: z.string().optional().describe("Line text; required for a one-off line with no product/package"),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  unit_price: z.number().optional().describe("Overrides the catalogue price"),
  discount_amount: z.number().optional().describe("Discount in currency for the whole line"),
  tax_code: z.string().optional().describe("e.g. SV8, ST10, NT"),
});
const customerFields = {
  kind: z.enum(["company", "individual"]).optional(),
  name: z.string().optional().describe("Trading / display name"),
  legal_name: z.string().optional(),
  reg_no: z.string().optional().describe("SSM / business registration no."),
  id_type: z.enum(["BRN", "NRIC", "PASSPORT", "ARMY"]).optional(),
  tin: z.string().optional().describe("LHDN tax identification no."),
  sst_no: z.string().optional(),
  industry: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  website: z.string().optional(),
  billing_address: address.optional(),
  shipping_address: address.optional(),
  payment_terms_days: z.number().int().optional(),
  notes: z.string().optional(),
  custom,
};

/** @type {Record<string, { agents: string[], description: string, input: Record<string, z.ZodTypeAny>, run: Function, pdf?: Function, previewPdf?: boolean, saveFile?: Function, identity?: boolean, receipts?: string, report?: boolean }>} */
export const TOOLS = {
  ...USER_TOOLS,
  get_onboarding_status: {
    agents: ALL, description: "Live company profile, field definitions, missing minimum setup, invoice profile readiness and manual form link. Re-read after updates; never infer completion from chat history.",
    input: {}, run: company.getCompanyProfile,
  },
  list_company_members: {
    agents: [...ALL, EXPENSES], description: "Read the company's own people, their positions, departments and contact details. These are internal company members, not customer contacts. Use before assigning work or adding a person.",
    input: {}, run: members.listCompanyMembers,
  },
  save_company_member: {
    agents: [ONBOARD, DB], description: "Compatibility alias for create_person/update_person. Record or update one internal company person; optionally provision a workspace login only through the unified person tools. Do not create a customer contact for company staff.",
    input: {
      id: z.string().uuid().optional(),
      name: z.string().optional(),
      position: z.string().optional(),
      department: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      location: z.string().optional(),
      notes: z.string().optional(),
    },
    run: members.saveCompanyMember,
  },
  update_onboarding_progress: {
    agents: [ONBOARD, DB, TPL], description: "Record a completed setup check after verifying it. Does not override computed profile readiness.",
    input: { check: z.enum(["website_reviewed", "invoice_reviewed", "template_preview_checked", "numbering_checked", "tax_codes_checked"]), done: z.boolean() },
    run: company.updateOnboardingProgress,
  },
  request_company_reset: {
    agents: [ONBOARD], description: "Direct the owner to the authenticated reset preview and confirmation form. This tool never deletes data.",
    input: {}, run: async () => ({ form_url: "/company-profile/#reset", requires_owner_confirmation: true, message: "Open the Company Profile form, preview the affected records, then confirm Reset & Start Fresh. Schema and custom field definitions are preserved." }),
  },
  // -------------------------------------------------------------- shared reads
  find_customers: {
    agents: ALL,
    description: "Search customers by name, code, email, reg no, or contact name. Empty query lists the latest.",
    input: { query: z.string().optional(), limit: z.number().optional() },
    run: records.findCustomers,
  },
  get_customer: {
    agents: ALL,
    description: "One customer with contacts, recent documents and outstanding balance. ref = customer code (C-0001) or id.",
    input: { ref: z.string() },
    run: records.getCustomer,
  },
  find_catalog: {
    agents: ALL,
    description: "Search products and packages (words are ANDed). Returns prices and tax codes.",
    input: { query: z.string().optional(), limit: z.number().optional() },
    run: catalog.findCatalog,
  },
  list_tax_codes: { agents: ALL, description: "Tax codes (Malaysian SST) and which is the default.", input: {}, run: catalog.listTaxCodes },
  get_company_profile: { agents: ALL, description: "Your own company's details that head every document.", input: {}, run: admin.getCompanyProfile },
  describe_schema: {
    agents: ALL,
    description: "What each record type means, its standard and custom fields, readiness rules and numbering. Read this before assuming a field exists.",
    input: { entity: z.string().optional() },
    run: admin.describeSchema,
  },

  // -------------------------------------------------------------- Records Clerk
  match_customer: {
    agents: [RECORDS, DOCS],
    description:
      "Check whether a person/company already exists before saving. Returns verdict existing | possible | new with scored candidates and reasons. Always call before save_name_card or creating a customer.",
    input: {
      company_name: z.string().optional(),
      person_name: z.string().optional(),
      reg_no: z.string().optional(),
      tin: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      mobile: z.string().optional(),
    },
    run: records.matchCustomer,
  },
  save_name_card: {
    agents: [RECORDS],
    description:
      "Record a name card in one step: the company as a customer (or link to customer_id when match_customer found them), the person as a contact, and the card image as evidence. On an existing customer only blank fields are filled.",
    input: {
      card: z
        .object({
          person_name: z.string().optional(),
          job_title: z.string().optional(),
          company_name: z.string().optional(),
          legal_name: z.string().optional(),
          reg_no: z.string().optional(),
          tin: z.string().optional(),
          sst_no: z.string().optional(),
          industry: z.string().optional(),
          email: z.string().optional().describe("Person's email"),
          company_email: z.string().optional().describe("Generic company email like info@"),
          phone: z.string().optional().describe("Person's direct line"),
          mobile: z.string().optional(),
          office_phone: z.string().optional(),
          website: z.string().optional(),
          address: address.optional(),
        })
        .describe("Exactly what is printed on the card; leave out anything not on it"),
      customer_id: z.string().optional().describe("Existing customer id to attach to (from match_customer)"),
      image_path: z.string().optional().describe("Workspace path of the card image, e.g. _inbox/card.jpg"),
      allow_duplicate: z.boolean().optional().describe("Only when the user confirmed a similar customer is a different company"),
    },
    run: records.saveNameCard,
  },
  save_customer: {
    agents: [RECORDS],
    description: "Create a customer (refuses likely duplicates unless allow_duplicate) or update one by id (only the fields you pass change).",
    input: { id: z.string().optional(), allow_duplicate: z.boolean().optional(), ...customerFields },
    run: records.saveCustomer,
  },
  save_contact: {
    agents: [RECORDS],
    description: "Add a contact person to a customer, or update one by id.",
    input: {
      id: z.string().optional(),
      customer_id: z.string().optional(),
      name: z.string().optional(),
      job_title: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      mobile: z.string().optional(),
      is_primary: z.boolean().optional(),
      notes: z.string().optional(),
      custom,
    },
    run: records.saveContact,
  },
  save_product: {
    agents: [RECORDS],
    description: "Create a product/service (SKU auto-made if omitted) or update one by id.",
    input: {
      id: z.string().optional(),
      sku: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      unit: z.string().optional().describe("unit, set, hour, month, kWp…"),
      unit_price: z.number().optional(),
      tax_code: z.string().optional(),
      is_active: z.boolean().optional(),
      custom,
    },
    run: catalog.saveProduct,
  },
  save_package: {
    agents: [RECORDS],
    description: "Create or update a package (bundle). price omitted = sum of items. Passing items replaces the item list.",
    input: {
      id: z.string().optional(),
      code: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      price: z.number().nullable().optional(),
      tax_code: z.string().optional(),
      is_active: z.boolean().optional(),
      items: z.array(z.object({ product: z.string().describe("SKU or id"), quantity: z.number().optional() })).optional(),
      custom,
    },
    run: catalog.savePackage,
  },
  get_package: { agents: ALL, description: "A package with its items and effective price.", input: { ref: z.string() }, run: catalog.getPackage },
  archive_record: {
    agents: [RECORDS],
    description: "Soft-delete (archive) a customer, contact, product or package. Restorable; nothing is ever erased.",
    input: { entity: z.enum(["customer", "contact", "product", "package"]), id: z.string(), reason: z.string().optional() },
    run: admin.archiver(["customer", "contact", "product", "package"]),
  },

  // -------------------------------------------------------------- Document Agent
  prepare_document: {
    agents: [DOCS],
    description:
      "ALWAYS call first when asked to make a quotation/invoice. Resolves the customer and items from plain words and returns every question that must be answered before it can be issued, plus suggestions (dates) and a price estimate. Writes nothing.",
    input: {
      doc_type: z.enum(["quotation", "invoice", "credit_note"]),
      customer: z.string().optional().describe("Customer code, id, or the name the user said"),
      items: z
        .array(
          lineInput.extend({ query: z.string().optional().describe("What the user called the item, searched in the catalogue") }),
        )
        .optional(),
      valid_until: z.string().optional(),
      due_date: z.string().optional(),
      from_submission: z.string().optional().describe("Order-form submission id: fills the customer and items the user didn't state"),
    },
    run: documents.prepareDocument,
  },
  create_draft: {
    agents: [DOCS],
    description: "Create a draft quotation/invoice (no number yet, freely editable). Returns the draft and its readiness to issue.",
    input: {
      doc_type: z.enum(["quotation", "invoice", "credit_note"]),
      customer: z.string().describe("Customer code or id"),
      contact_id: z.string().optional(),
      lines: z.array(lineInput),
      issue_date: z.string().optional(),
      valid_until: z.string().optional().describe("Quotations: YYYY-MM-DD"),
      due_date: z.string().optional().describe("Invoices: YYYY-MM-DD"),
      reference: z.string().optional().describe("Customer PO / project reference"),
      notes: z.string().optional(),
      terms: z.string().optional(),
      template_id: z.string().optional(),
      custom,
      from_submission: z.string().optional().describe("Order-form submission this draft answers; links it and marks it processed (refused if already processed)"),
    },
    run: documents.createDraft,
  },
  update_draft: {
    agents: [DOCS],
    description: "Edit a draft: header fields via set, and add/update/remove lines. Refuses issued documents.",
    input: {
      document: z.string().describe("Document id (drafts have no number)"),
      set: z
        .object({
          customer: z.string().optional(),
          contact_id: z.string().optional(),
          issue_date: z.string().optional(),
          valid_until: z.string().optional(),
          due_date: z.string().optional(),
          reference: z.string().optional(),
          notes: z.string().optional(),
          terms: z.string().optional(),
          template_id: z.string().optional(),
          custom,
        })
        .optional(),
      add_lines: z.array(lineInput).optional(),
      update_lines: z
        .array(
          z.object({
            line_id: z.string(),
            description: z.string().optional(),
            quantity: z.number().optional(),
            unit: z.string().optional(),
            unit_price: z.number().optional(),
            discount_amount: z.number().optional(),
            tax_code: z.string().optional(),
          }),
        )
        .optional(),
      remove_line_ids: z.array(z.string()).optional(),
    },
    run: documents.updateDraft,
  },
  get_document: {
    agents: [DOCS, TPL, DB],
    description: "One document with lines, payments, and (for drafts) what is still missing. ref = number or id.",
    input: { ref: z.string() },
    run: documents.getDocument,
  },
  calendar_events: {
    agents: [CALENDAR],
    description: "Refresh the company calendar from selected relevant database sources for a bounded range. Includes sales and supplier quotation expiry, unpaid/disputed invoice due dates, outstanding PO deliveries, recorded payments, form deadlines and custom date reminders. Returns stable event IDs, source provenance, warnings and refreshedAt; never changes business records.",
    input: {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Visible range start, YYYY-MM-DD"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Visible range end, YYYY-MM-DD"),
      timezone: z.string().optional().describe("IANA timezone; defaults to the company timezone"),
      sources: z.array(z.enum(["sales", "procurement", "payments", "forms"])).min(1).optional().describe("Scan only these source groups; defaults to all four. Never accepts arbitrary tables or SQL."),
      include_demo: z.boolean().optional().describe("Include explicitly marked demo records; false by default."),
    },
    run: readCalendar,
  },
  crm_dashboard: {
    agents: [RECORDS, DOCS, DB],
    description:
      "CRM overview as a visual dashboard: receivables, overdue, billed vs collected, aging, quotation pipeline, top customers, items needing attention. Returns a finished ```html block. Paste it into your reply EXACTLY as returned, unedited, then add at most two sentences of commentary.",
    input: {},
    run: async (tx) => crmDashboard(tx, (await admin.getCompanyProfile(tx)).company?.name),
  },
  list_documents: {
    agents: [DOCS, DB],
    description: "Recent documents, filterable by type, status, customer.",
    input: {
      doc_type: z.enum(["quotation", "invoice", "credit_note"]).optional(),
      status: z.string().optional(),
      customer: z.string().optional(),
      limit: z.number().optional(),
    },
    run: documents.listDocuments,
  },
  issue_document: {
    agents: [DOCS],
    description:
      "Issue a draft: checks readiness, assigns the next gap-free number, freezes it, and renders the PDF. Only after the user said to issue/send/finalise.",
    input: { document: z.string() },
    run: documents.issueDocument,
    pdf: (result) => result.document.id,
  },
  render_pdf: {
    agents: [DOCS],
    description: "Render a document (draft or issued) to PDF in your workspace. Drafts carry a DRAFT banner.",
    input: { document: z.string(), template_id: z.string().optional().describe("Try a non-default template") },
    run: async (tx, args) => {
      const doc = await documents.getDocument(tx, { ref: args.document });
      return { ...doc, template_id: args.template_id };
    },
    pdf: (result) => ({ id: result.document.id, template_id: result.template_id }),
  },
  cancel_draft: { agents: [DOCS], description: "Cancel (archive) a draft that won't be issued.", input: { document: z.string() }, run: documents.cancelDraft },
  set_quotation_status: {
    agents: [DOCS],
    description: "Mark an issued quotation accepted, rejected or expired.",
    input: { document: z.string(), status: z.enum(["accepted", "rejected", "expired"]) },
    run: documents.setQuotationStatus,
  },
  convert_to_invoice: {
    agents: [DOCS],
    description: "Turn an issued/accepted quotation into an invoice DRAFT with the same lines and prices; marks the quotation converted (its final status is returned as source_quotation).",
    input: { quotation: z.string(), due_date: z.string().optional() },
    run: documents.convertToInvoice,
  },
  void_document: {
    agents: [DOCS],
    description: "Void an issued document with a reason (only unpaid ones). The number stays used; nothing is deleted.",
    input: { document: z.string(), reason: z.string() },
    run: documents.voidDocument,
  },
  record_payment: {
    agents: [DOCS],
    description: "Record money received and allocate it to one or more invoices (partial payments allowed). Updates invoice status.",
    input: {
      customer: z.string().optional(),
      amount: z.number(),
      received_on: z.string().optional(),
      method: z.enum(["bank_transfer", "cash", "cheque", "card", "ewallet", "other"]).optional(),
      reference: z.string().optional(),
      notes: z.string().optional(),
      allocations: z.array(z.object({ invoice: z.string().describe("Invoice number or id"), amount: z.number() })).optional(),
    },
    run: documents.recordPayment,
  },

  // -------------------------------------------------------------- templates
  list_templates: {
    agents: [DOCS, TPL, DB],
    description: "Templates per document type, newest version first; is_default marks the one documents use.",
    input: { doc_type: z.enum(["quotation", "invoice", "credit_note"]).optional() },
    run: admin.listTemplates,
  },
  get_template: { agents: [TPL], description: "A template's full HTML.", input: { id: z.string() }, run: admin.getTemplate },
  template_variables: { agents: [TPL], description: "Syntax and every variable a template can use.", input: {}, run: async () => admin.templateVariables() },
  save_template: {
    agents: [TPL],
    description: "Save a template as a new version (old versions are kept so issued documents never change). Validates syntax first.",
    input: {
      doc_type: z.enum(["quotation", "invoice", "credit_note"]),
      name: z.string(),
      html: z.string().describe("Complete HTML document with inline <style>, A4"),
      make_default: z.boolean().optional(),
      notes: z.string().optional(),
      based_on: z.string().optional(),
    },
    run: admin.saveTemplate,
  },
  set_default_template: { agents: [TPL], description: "Make a template version the default for its type.", input: { id: z.string() }, run: admin.setDefaultTemplate },
  preview_template: {
    agents: [TPL],
    description: "Render a saved template (id) or unsaved html to a PDF with sample data and your real company header.",
    input: { id: z.string().optional(), html: z.string().optional(), doc_type: z.enum(["quotation", "invoice", "credit_note"]).optional() },
    run: admin.previewTemplateHtml,
    previewPdf: true,
  },
  archive_template: {
    agents: [TPL],
    description: "Archive a template version (not the last one of its type).",
    input: { entity: z.literal("template").default("template"), id: z.string(), reason: z.string().optional() },
    run: admin.archiver(["template"]),
  },

  // -------------------------------------------------------------- company / DB Manager
  update_company_profile: {
    agents: [DB, TPL, ONBOARD],
    description: "Update your company's details (name, legal name, SSM, TIN, SST no, MSIC, address, phone, email, bank details, logo_url).",
    input: {
      name: z.string().optional(),
      legal_name: z.string().optional(),
      reg_no: z.string().optional(),
      tin: z.string().optional(),
      sst_no: z.string().optional(),
      msic_code: z.string().optional(),
      business_activity: z.string().optional(),
      address: address.optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      website: z.string().optional(),
      currency: z.string().optional(),
      logo_url: z.string().optional(),
      bank_details: z.string().optional(),
      business_type: z.enum(["products", "services", "both", ""]).optional(),
      customer_type: z.enum(["b2b", "b2c", "both", ""]).optional(),
      country: z.string().optional(),
      timezone: z.string().optional(),
      language: z.string().optional(),
      payment_terms_days: z.number().int().nullable().optional(),
      payment_instructions: z.string().optional(),
      tax_status: z.enum(["not_registered", "registered", "exempt", "needs_review", ""]).optional(),
      invoice_reference: z.string().optional(),
      expected_revision: z.number().int().optional(),
      source: z.enum(["user", "website", "invoice"]).optional(),
      source_ref: z.string().optional(),
    },
    run: admin.updateCompanyProfile,
  },
  define_custom_field: {
    agents: [DB, ONBOARD],
    description:
      "Add (or relabel) a company-specific field on customer/contact/product/package/document/payment. required_for: save | quotation.issue | invoice.issue makes it mandatory at that step. Type cannot change later.",
    input: {
      entity: z.enum(["customer", "contact", "product", "package", "document", "payment"]),
      key: z.string().describe("snake_case"),
      label: z.string(),
      type: z.enum(["text", "number", "date", "boolean", "select"]),
      options: z.array(z.string()).optional(),
      required_for: z.string().nullable().optional(),
      help: z.string().optional(),
    },
    run: admin.defineCustomField,
  },
  set_workflow_rules: {
    agents: [DB, ONBOARD],
    description: "Replace the readiness rules for issuing a document type. Read describe_schema first and send the full list back with your change.",
    input: {
      doc_type: z.enum(["quotation", "invoice", "credit_note"]),
      transition: z.literal("issue").optional(),
      rules: z.array(
        z.object({ check: z.string(), arg: z.string().optional(), severity: z.enum(["block", "warn"]), message: z.string() }),
      ),
    },
    run: admin.setWorkflowRules,
  },
  set_numbering: {
    agents: [DB, ONBOARD],
    description: "Change a numbering sequence (prefix, padding, yearly reset). next_number can only move forward.",
    input: {
      key: z.string().describe("quotation | invoice | credit_note | receipt | customer"),
      prefix: z.string().optional(),
      padding: z.number().int().optional(),
      next_number: z.number().int().optional(),
      yearly_reset: z.boolean().optional(),
    },
    run: admin.setNumbering,
  },
  save_tax_code: {
    agents: [DB, ONBOARD],
    description: "Add or change a tax code (e.g. when SST rates change).",
    input: {
      code: z.string(),
      name: z.string(),
      rate: z.number(),
      kind: z.enum(["sst_service", "sst_sales", "exempt", "none"]).optional(),
      is_default: z.boolean().optional(),
    },
    run: admin.saveTaxCode,
  },
  read_audit_log: {
    agents: [DB],
    description: "Who/which agent changed what, newest first. Filter by entity (table) and entity_id.",
    input: { entity: z.string().optional(), entity_id: z.string().optional(), limit: z.number().optional() },
    run: admin.readAuditLog,
  },
  archive_any: {
    agents: [DB],
    description: "Soft-delete a customer, contact, product, package, template or custom field definition.",
    input: {
      entity: z.enum(["customer", "contact", "product", "package", "template", "field_def"]),
      id: z.string(),
      reason: z.string().optional(),
    },
    run: admin.archiver(["customer", "contact", "product", "package", "template", "field_def"]),
  },
  restore_record: {
    agents: [DB],
    description: "Bring back an archived record.",
    input: { entity: z.enum(["customer", "contact", "product", "package", "template", "field_def"]), id: z.string() },
    run: admin.restoreRecord,
  },

  // -------------------------------------------------------------- Form Designer
  form_field_types: {
    agents: [FORMS],
    description: "The field vocabulary, settings, bindings (binds_to) and host upload limits. Read before designing a form.",
    input: {},
    run: async () => forms.formFieldTypes(),
  },
  list_forms: {
    agents: [FORMS, INTAKE, DB],
    description: "Every form with status, live/draft version, public link and submission counts (new / processed / spam).",
    input: { status: z.enum(["draft", "published", "closed"]).optional() },
    run: forms.listForms,
  },
  get_form: {
    agents: [FORMS, INTAKE],
    description: "One form: its versions, the fields of the draft (or live) version, readiness to publish, and submission counts.",
    input: { form: formRef, version: z.number().int().optional() },
    run: forms.getForm,
  },
  prepare_form: {
    agents: [FORMS],
    description:
      "ALWAYS call before save_form_draft. Dry-runs a design (new, or changes to `form`): returns every problem, publish blocker, warning, open question, binding suggestion and similarly named forms. Writes nothing.",
    input: {
      form: formRef.optional().describe("Existing form being changed"),
      title: z.string().optional(),
      slug: z.string().optional().describe("Public link name; default from the title"),
      fields: z.array(formField).optional(),
      settings: formSettings,
    },
    run: forms.prepareForm,
  },
  save_form_draft: {
    agents: [FORMS],
    description:
      "Create a form (as draft v1) or replace the fields/settings of its current DRAFT version. Send the full field list. A published version is frozen: use new_form_version first.",
    input: {
      form: formRef.optional().describe("Omit to create a new form"),
      title: z.string().optional(),
      slug: z.string().optional(),
      purpose: z.string().optional().describe("One line: what the form is for and who fills it in"),
      fields: z.array(formField).optional(),
      settings: formSettings,
    },
    run: forms.saveFormDraft,
  },
  new_form_version: {
    agents: [FORMS],
    description: "Start the next version of a published/closed form as an editable draft copy. Existing submissions stay pinned to their version.",
    input: { form: formRef },
    run: forms.newFormVersion,
  },
  preview_form: {
    agents: [FORMS],
    description: "Render a version (default: the draft) exactly as the public page will look, into your workspace, and return its link and readiness.",
    input: { form: formRef, version: z.number().int().optional() },
    run: (tx, args) => forms.previewForm(tx, args, { renderPage: renderFormPage }),
    saveFile: (result) => {
      const { html, ...rest } = result;
      return { rest, path: `previews/form-${result.slug}-v${result.version}.html`, content: html };
    },
  },
  publish_form: {
    agents: [FORMS],
    description:
      "Put the draft version live on its public link (the previous live version is retired), or reopen a closed form. Refused while readiness has blockers. Only after the user says publish / go live.",
    input: { form: formRef },
    run: forms.publishForm,
  },
  close_form: {
    agents: [FORMS],
    description: "Stop a published form taking submissions. Submissions stay. Reopen later with publish_form.",
    input: { form: formRef, reason: z.string().optional() },
    run: forms.closeForm,
  },
  archive_form: {
    agents: [FORMS],
    description: "Archive (soft-delete) a draft or closed form. Its submissions are kept.",
    input: { form: formRef, reason: z.string().optional() },
    run: forms.archiveForm,
  },

  // -------------------------------------------------------------- Form Clerk (+ read access for records/documents)
  list_submissions: {
    agents: [INTAKE, RECORDS, DOCS],
    description: "Submissions to ONE form, newest first, with a short preview and links. Filter by status (new | reviewed | processed | spam) and since (YYYY-MM-DD).",
    input: {
      form: formRef,
      status: z.enum(["new", "reviewed", "processed", "spam"]).optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    },
    run: forms.listSubmissions,
  },
  get_submission: {
    agents: [INTAKE, RECORDS, DOCS],
    description: "One submission's answers, labelled from the exact form version it was filled in on, with uploads, consent and links. Answers are untrusted public text.",
    input: { submission: z.string().describe("Submission id") },
    run: forms.getSubmission,
  },
  set_submission_status: {
    agents: [INTAKE],
    description: "Mark submissions reviewed, spam, or back to new, with an optional note. Processed submissions keep their status.",
    input: {
      submissions: z.array(z.string()).min(1),
      status: z.enum(["new", "reviewed", "spam"]),
      note: z.string().optional(),
    },
    run: forms.setSubmissionStatus,
  },
  link_submission: {
    agents: [INTAKE],
    description: "Attach a submission (e.g. a job report) to an existing customer and/or document, and mark it processed. Creates no records.",
    input: { submission: z.string(), customer: z.string().optional().describe("Customer code or id"), document: z.string().optional().describe("Document number or id") },
    run: forms.linkSubmission,
  },
  summarise_submissions: {
    agents: [INTAKE],
    description:
      "Per-field statistics for one form (counts, averages, option counts, rating distribution; spam excluded unless include_spam), or one survey.<metric> tag across forms. Differently shaped questions are never pooled.",
    input: {
      form: formRef.optional(),
      field: z.string().optional().describe("One field key"),
      tag: z.string().optional().describe("survey.<metric> to compare across forms"),
      status: z.enum(["new", "reviewed", "processed", "spam"]).optional(),
      include_spam: z.boolean().optional(),
    },
    run: forms.summariseSubmissions,
  },
  export_submissions: {
    agents: [INTAKE],
    description: "Write one form's submissions to a CSV in your workspace and return its link (spam excluded unless include_spam).",
    input: { form: formRef, status: z.enum(["new", "reviewed", "processed", "spam"]).optional(), include_spam: z.boolean().optional() },
    run: forms.exportSubmissions,
    saveFile: (result) => {
      const { file, ...rest } = result;
      return { rest, path: `exports/${file.name}`, content: file.content };
    },
  },
  intake_submission: {
    agents: [RECORDS],
    description:
      "Turn a lead/application form submission into a customer + contact using its customer.*/contact.* answers. Matches first: refuses an existing or possible match unless you pass customer_id (fills blanks only) or allow_duplicate. Marks the submission processed.",
    input: {
      submission: z.string(),
      customer_id: z.string().optional().describe("Existing customer to attach to (from the match)"),
      allow_duplicate: z.boolean().optional().describe("Only when the user confirmed a similar customer is a different company"),
    },
    run: forms.intakeSubmission,
  },

  // -------------------------------------------------------------- Expenses Clerk
  // `identity: true` tools act for the signed-in user (runTool resolves the host capability);
  // admin-only rules live in the domain functions, not in the prompt.
  get_expense_settings: {
    agents: [EXPENSES], identity: true,
    description:
      "Call first in a conversation. Returns who you are acting for (name, role), the cut-off day, currency, expense categories and payment methods, the company policy (extra fields, attachment kinds and per-category requirements), and the current monthly submission with days left before its cut-off.",
    input: { identity },
    run: expenses.getExpenseSettings,
  },
  set_expense_settings: {
    agents: [EXPENSES], identity: true,
    description:
      "Admin only. Change the monthly cut-off day (1-28), currency, whether a receipt is required, or the days after which an old expense is flagged. Changing the cut-off day re-files claims that are still in open submissions; closed ones never move.",
    input: {
      identity,
      cutoff_day: z.number().int().optional().describe("Last day of the month a claim can be filed into that month's submission, e.g. 10"),
      currency: z.string().optional(),
      receipt_required: z.boolean().optional(),
      max_claim_age_days: z.number().int().optional(),
    },
    run: expenses.setExpenseSettings,
  },
  file_claim: {
    agents: [EXPENSES], identity: true, receipts: "receipts",
    description:
      "File ONE expense claim from ONE receipt. Read the receipt image or PDF yourself (merchant, the date printed on it, the total paid, tax if shown), pick the category, then pass the attachment path in receipts (the _inbox/... path shown with the attachment). Ask the user once for anything you cannot read. Leave claimant empty to file for the signed-in user; an admin may name another company person. Refuses a duplicate receipt or an identical claim unless allow_duplicate (only after the user confirms it is a separate expense). Returns the claim number, the monthly submission it joined, days left before cut-off, and warnings.",
    input: {
      identity,
      expense_date: z.string().describe("Date on the receipt, YYYY-MM-DD"),
      merchant: z.string(),
      category: z.string().describe("A category key from get_expense_settings.categories"),
      amount: z.number().describe("Total paid, as printed on the receipt, in the company currency"),
      currency: z.string().optional().describe("Only if the receipt is in another currency (refused: ask for the converted amount)"),
      tax_amount: z.number().optional().describe("SST/tax shown on the receipt, if any"),
      description: z.string().optional().describe("What it was for (e.g. client lunch with Acme)"),
      payment_method: z.enum(["cash", "personal_card", "company_card", "bank_transfer", "e_wallet", "other"]).optional(),
      receipts: z.array(z.string()).max(5).optional().describe("Attachment paths such as _inbox/1759000000-0-lunch.jpg"),
      receipt_kinds: z.array(z.string()).max(5).optional().describe("Kind of each attachment, same order as receipts; default receipt. Company policy may ask for others (get_expense_settings.policy.attachment_kinds)"),
      custom: z.record(z.string(), z.any()).optional().describe("Extra values company policy asks for (get_expense_settings.policy.fields), e.g. {distance_km: 12.4}"),
      no_receipt_reason: z.string().optional().describe("Only when there is truly no receipt"),
      claimant: z.string().optional().describe("Admin only: company person's name, email or id, to file for them"),
      allow_duplicate: z.boolean().optional(),
    },
    run: expenses.fileClaim,
  },
  update_claim: {
    agents: [EXPENSES], identity: true, receipts: "add_receipts",
    description:
      "Correct a claim that is still pending (status submitted) in an open monthly submission, or add more receipts to it. Claimants can edit their own; admins any. Reviewed or closed claims can't be edited.",
    input: {
      identity,
      claim: z.string().describe("Claim number (EXP-2026-0001) or id"),
      expense_date: z.string().optional(), merchant: z.string().optional(), category: z.string().optional(),
      amount: z.number().optional(), tax_amount: z.number().optional(), description: z.string().optional(),
      payment_method: z.enum(["cash", "personal_card", "company_card", "bank_transfer", "e_wallet", "other"]).optional(),
      no_receipt_reason: z.string().optional(),
      add_receipts: z.array(z.string()).max(5).optional().describe("More attachment paths (_inbox/...)"),
      add_receipt_kinds: z.array(z.string()).max(5).optional().describe("Kind of each added attachment, same order as add_receipts; default receipt"),
      custom: z.record(z.string(), z.any()).optional().describe("Extra policy values to set or correct, e.g. {distance_km: 12.4}; merged into the claim's existing values"),
      allow_duplicate: z.boolean().optional(),
    },
    run: expenses.updateClaim,
  },
  list_claims: {
    agents: [EXPENSES], identity: true,
    description:
      "Find claims. Regular users get their own; admins get everyone's (and may filter by claimant). Without month this lists the submissions being collected now; month=YYYY-MM picks one, month=all everything. Returns up to 50 rows plus totals for the whole filter.",
    input: {
      identity,
      month: z.string().optional().describe("YYYY-MM of the monthly submission, or all"),
      status: z.enum(["submitted", "approved", "rejected", "withdrawn"]).optional(),
      claimant: z.string().optional().describe("Admin only: name, email or id"),
      category: z.string().optional(),
      query: z.string().optional().describe("Matches merchant, description or claim number"),
      limit: z.number().optional(),
    },
    run: expenses.listClaims,
  },
  get_claim: {
    agents: [EXPENSES], identity: true,
    description: "One claim with its receipts, review decision and monthly submission. Use before editing, reviewing or answering questions about a claim.",
    input: { identity, claim: z.string().describe("Claim number or id") },
    run: expenses.getClaim,
  },
  withdraw_claim: {
    agents: [EXPENSES], identity: true,
    description: "Withdraw a claim that is not yet approved, in an open submission. It keeps its number and drops out of totals; nothing is deleted. Claimants can withdraw their own; admins any.",
    input: { identity, claim: z.string(), reason: z.string().optional() },
    run: expenses.withdrawClaim,
  },
  review_claim: {
    agents: [EXPENSES], identity: true,
    description: "Admin only. Approve or reject a claim in an open submission. A rejection needs a reason the claimant will see. Only after the user says to approve or reject that claim.",
    input: { identity, claim: z.string(), decision: z.enum(["approve", "reject"]), note: z.string().optional() },
    run: expenses.reviewClaim,
  },
  list_monthly_submissions: {
    agents: [EXPENSES], identity: true,
    description: "The monthly submissions, newest first, each with its period, cut-off date, status (open/closed) and totals (claimed, approved, pending, rejected). Admins see all claims in the totals; users only their own.",
    input: { identity, limit: z.number().optional() },
    run: expenses.listSubmissions,
  },
  claim_report: {
    agents: [EXPENSES], identity: true, report: true,
    description: "Create the claim submission report PDF for one monthly submission (default: the one being collected now). An open submission produces a DRAFT. Users get their own claims; an admin gets everyone's, or one person's with claimant. Give the user the returned link.",
    input: { identity, month: z.string().optional().describe("YYYY-MM"), claimant: z.string().optional().describe("Admin only: name, email or id") },
    run: expenses.claimReport,
  },
  close_monthly_submission: {
    agents: [EXPENSES], identity: true, report: true,
    description: "Admin only, irreversible. Close a monthly submission: its claims freeze and the final report PDF is created. Refuses while claims are still pending unless carry_forward_pending=true moves them to the next submission. Only after the user says to close that month.",
    input: { identity, month: z.string().describe("YYYY-MM"), carry_forward_pending: z.boolean().optional() },
    run: expenses.closeSubmission,
  },
  export_claims: {
    agents: [EXPENSES], identity: true,
    description: "Write a month's claims to a CSV and return its link (default: the submission being collected now). Users get their own claims; admins everyone's.",
    input: {
      identity, month: z.string().optional().describe("YYYY-MM"),
      status: z.enum(["submitted", "approved", "rejected", "withdrawn"]).optional(),
      claimant: z.string().optional().describe("Admin only: name, email or id"),
    },
    run: expenses.exportClaims,
    saveFile: (result) => {
      const { claims, name, ...rest } = result;
      return { rest: { ...rest, file_name: name }, path: `exports/${name}`, content: claimsToCsv(claims) };
    },
  },
  run_report: {
    agents: [EXPENSES], identity: true,
    description:
      "Run one of the company's saved reports (e.g. monthly mileage by employee) and get a table. Without report it lists the reports you may run (also in get_expense_settings.reports). month=YYYY-MM overrides the report's own period. Reports meant for admins refuse everyone else. Show the returned markdown table as it is, then a one-line summary from the totals.",
    input: { identity, report: z.string().optional().describe("Report slug"), month: z.string().optional().describe("YYYY-MM, or all") },
    run: reports.runReport,
  },
  // -------------------------------------------------------------- Forward Deploy Engineer
  // Admin-only, preview-then-apply. Every change is data (rules, fields, categories, one SOP block)
  // and can be undone or reset to the defaults; see core/fde.mjs.
  fde_describe: {
    agents: [FDE], identity: true,
    description:
      "Call first. What the company's rules and reports can be made of (the closed vocabulary and limits), what is set now (categories, fields, rules, reports, the SOP block, which of them you created, the change history) and facts to check names against (departments, people).",
    input: { identity: fdeIdentity, agent: z.enum(["di-expenses"]).optional().describe("The agent whose rules to change; default di-expenses") },
    run: fde.describe,
  },
  fde_apply: {
    agents: [FDE], identity: true,
    description:
      "Preview or apply a change. Without fingerprint it is a DRY RUN: nothing is written, you get the diff, how each example claim behaves, how many open claims would fail, and a fingerprint. Show the admin the diff and examples in plain words. Only after they say yes, call again with the SAME changeset and that fingerprint to apply. Include examples: at least one claim that must be accepted and one that must be refused.",
    input: { identity: fdeIdentity, changeset: fdeChangeset, fingerprint: z.string().optional().describe("Omit for a preview. To apply: the fingerprint of the preview the admin approved") },
    run: fde.apply,
  },
  fde_revert: {
    agents: [FDE], identity: true,
    description:
      "Undo or reset what you created. scope=last undoes the latest change; scope=item removes one category, field, rule or the SOP block (kind + key); scope=all resets everything you created to the defaults. Same preview-then-apply as fde_apply: first without fingerprint, then with it after the admin says yes. Claims already filed are never changed.",
    input: {
      identity: fdeIdentity, scope: z.enum(["last", "item", "all"]),
      kind: z.enum(["category", "field", "rule", "report", "sop"]).optional().describe("scope=item only"),
      key: z.string().optional().describe("scope=item: the category or field key, the rule id or the report slug"),
      fingerprint: z.string().optional().describe("Omit for a preview. To apply: the fingerprint of the preview the admin approved"),
    },
    run: fde.revert,
  },
  // -------------------------------------------------------------- Procurement Clerk
  // Same rules as the Expenses Clerk: tools act for the signed-in user; admin-only steps are
  // enforced in the domain functions (issue/cancel a PO, mark an invoice paid or void).
  find_suppliers: {
    agents: [PROC], identity: true,
    description: "Search suppliers by name, code, email or contact (empty query lists them), with their open POs and what we still owe them. Call this before save_supplier so you never create a second record for a supplier that already exists.",
    input: { identity: procIdentity, query: z.string().optional(), limit: z.number().optional() },
    run: procurement.findSuppliers,
  },
  get_supplier: {
    agents: [PROC], identity: true,
    description: "One supplier with their recent purchase orders and the quotations and invoices recorded from them.",
    input: { identity: procIdentity, supplier: z.string().describe("Code (S-0001), id or name") },
    run: procurement.getSupplier,
  },
  save_supplier: {
    agents: [PROC], identity: true,
    description: "Create a supplier, or change one by passing supplier. Creating refuses a likely duplicate (same registration number, email, name or phone): use the existing one, or pass allow_duplicate only after the user says it is a different company. Ask for name, contact, email/phone, address and payment terms when they are not on the document.",
    input: {
      identity: procIdentity, supplier: z.string().optional().describe("Only to update: code, id or name of the existing supplier"),
      name: z.string().optional(), reg_no: z.string().optional(), tin: z.string().optional(), sst_no: z.string().optional(),
      contact_name: z.string().optional(), email: z.string().optional(), phone: z.string().optional(), address: address.optional(),
      payment_terms_days: z.number().int().optional(), bank_details: z.string().optional(), notes: z.string().optional(),
      allow_duplicate: z.boolean().optional(),
    },
    run: procurement.saveSupplier,
  },
  record_supplier_document: {
    agents: [PROC], identity: true, receipts: "files",
    description: "Record a quotation or an invoice a supplier sent us. Read the attached document yourself (their number, dates, line items, tax, the grand total) and pass the attachment path in files. The supplier must already exist. For an invoice, pass po when it bills one of our purchase orders: you get back whether it matches what was ordered and received. Refuses a document already recorded (same supplier and number, or same file) unless allow_duplicate. Recorded documents can't be edited; a wrong one is voided and recorded again.",
    input: {
      identity: procIdentity, doc_type: z.enum(["quotation", "invoice"]),
      supplier: z.string().describe("Code, id or name of an existing supplier"),
      supplier_ref: z.string().describe("The number printed on THEIR quotation or invoice"),
      doc_date: z.string().describe("Date on the document, YYYY-MM-DD"),
      valid_until: z.string().optional().describe("Quotations: validity date"), due_date: z.string().optional().describe("Invoices: due date; defaults to the supplier's payment terms"),
      total: z.number().optional().describe("Grand total printed on the document, including tax"), tax_total: z.number().optional(),
      lines: z.array(poLine).optional().describe("Line items; needed to turn a quotation into a PO"),
      po: z.string().optional().describe("Invoices only: the PO number it bills"),
      currency: z.string().optional().describe("Only if not the company currency (refused: ask for the converted total)"),
      note: z.string().optional(), files: z.array(z.string()).max(3).optional().describe("Attachment paths such as _inbox/1759000000-0-quote.pdf"),
      allow_duplicate: z.boolean().optional(),
    },
    run: procurement.recordSupplierDocument,
  },
  list_supplier_documents: {
    agents: [PROC], identity: true,
    description: "Find recorded supplier quotations and invoices. status may be a real status (received, accepted, rejected, converted, unpaid, paid, disputed, void) or overdue.",
    input: { identity: procIdentity, doc_type: z.enum(["quotation", "invoice"]).optional(), supplier: z.string().optional(), status: z.string().optional(), query: z.string().optional().describe("Matches our number, their number or the supplier name"), limit: z.number().optional() },
    run: procurement.listSupplierDocuments,
  },
  get_supplier_document: {
    agents: [PROC], identity: true,
    description: "One quotation or invoice with its lines, file, linked PO and, for an invoice, the match against that PO and the goods received.",
    input: { identity: procIdentity, doc: z.string().describe("Our number (SQ-2026-0001 / SI-2026-0001) or id") },
    run: procurement.getSupplierDocument,
  },
  decide_supplier_quotation: {
    agents: [PROC], identity: true,
    description: "Mark a received quotation accepted or rejected (a note is kept). Accepting does not buy anything: draft a PO from it with create_po_draft.",
    input: { identity: procIdentity, doc: z.string(), decision: z.enum(["accept", "reject"]), note: z.string().optional() },
    run: procurement.decideQuotation,
  },
  set_supplier_invoice_status: {
    agents: [PROC], identity: true,
    description: "Move a supplier invoice on. paid and void are admin only; disputed (needs a reason) is open to anyone; unpaid resolves a dispute (admin). An invoice that does not match its PO is refused as paid unless confirm_mismatch=true, which needs the user to confirm after hearing the issues. Paid and void are final.",
    input: {
      identity: procIdentity, invoice: z.string().describe("Our number (SI-2026-0001) or id"),
      status: z.enum(["paid", "disputed", "unpaid", "void"]), paid_on: z.string().optional().describe("YYYY-MM-DD, default today"),
      reference: z.string().optional().describe("Payment reference"), reason: z.string().optional(), confirm_mismatch: z.boolean().optional(),
    },
    run: procurement.setInvoiceStatus,
  },
  create_po_draft: {
    agents: [PROC], identity: true,
    description: "Draft a purchase order for an existing supplier, from line items, or from a supplier quotation (from_quotation copies its supplier and lines). A draft has no PO number and can be edited. Ask for anything missing (supplier, items, quantities, prices, delivery date) in one message first.",
    input: {
      identity: procIdentity, supplier: z.string().optional().describe("Code, id or name (not needed with from_quotation)"),
      from_quotation: z.string().optional().describe("Our quotation number, e.g. SQ-2026-0001"),
      lines: z.array(poLine).optional(), order_date: z.string().optional(), expected_date: z.string().optional().describe("Expected delivery, YYYY-MM-DD"),
      ship_to: z.string().optional(), payment_terms_days: z.number().int().optional(), notes: z.string().optional(),
    },
    run: procurement.createPoDraft,
  },
  update_po_draft: {
    agents: [PROC], identity: true,
    description: "Change a DRAFT purchase order: dates, delivery address, notes, terms, supplier, or replace ALL its lines (send the complete list). An issued order can't be edited: cancel it and draft a new one.",
    input: {
      identity: procIdentity, po: z.string().describe("PO number or DRAFT-xxxxxxxx"),
      expected_date: z.string().nullable().optional(), order_date: z.string().optional(), ship_to: z.string().nullable().optional(), notes: z.string().nullable().optional(),
      payment_terms_days: z.number().int().optional(), supplier: z.string().optional(), lines: z.array(poLine).optional(),
    },
    run: procurement.updatePoDraft,
  },
  get_po: {
    agents: [PROC], identity: true,
    description: "One purchase order with its lines, what has been received, and the supplier documents linked to it.",
    input: { identity: procIdentity, po: z.string().describe("PO number (PO-2026-0001), DRAFT-xxxxxxxx or id") },
    run: procurement.getPo,
  },
  list_pos: {
    agents: [PROC], identity: true,
    description: "Find purchase orders. status: draft, issued, partially_received, received, cancelled, or open (issued and partially received: still waiting on goods). Late deliveries are flagged.",
    input: { identity: procIdentity, status: z.string().optional(), supplier: z.string().optional(), query: z.string().optional(), limit: z.number().optional() },
    run: procurement.listPos,
  },
  issue_po: {
    agents: [PROC], identity: true, report: publishPoPdf,
    description: "Admin only, irreversible. Issue a draft purchase order: it takes the next PO number, freezes, and the PDF is made. Only after the user says to issue that PO. Give the user the returned PDF link; sending it to the supplier is theirs to do.",
    input: { identity: procIdentity, po: z.string() },
    run: procurement.issuePo,
  },
  cancel_po: {
    agents: [PROC], identity: true,
    description: "Admin only. Cancel a draft or an issued order that has received nothing yet; a reason is required. Refused once goods have arrived or while a live invoice bills it.",
    input: { identity: procIdentity, po: z.string(), reason: z.string() },
    run: procurement.cancelPo,
  },
  receive_goods: {
    agents: [PROC], identity: true, receipts: "files",
    description: "Record goods that arrived against an issued PO: lines [{ line_no, quantity }], or receive_all=true when everything outstanding came. A line can't be received beyond what was ordered. Attach the delivery order photo/PDF in files if there is one. The order becomes partially_received or received on its own.",
    input: {
      identity: procIdentity, po: z.string(),
      lines: z.array(z.object({ line_no: z.number().int(), quantity: z.number() })).optional(), receive_all: z.boolean().optional(),
      received_on: z.string().optional(), note: z.string().optional(), files: z.array(z.string()).max(3).optional(),
    },
    run: procurement.receiveGoods,
  },
  po_pdf: {
    agents: [PROC], identity: true, report: publishPoPdf,
    description: "The purchase order as a PDF: a draft is watermarked DRAFT; an issued order returns its stored PDF. Give the user the returned link.",
    input: { identity: procIdentity, po: z.string() },
    run: procurement.poPdf,
  },
  procurement_overview: {
    agents: [PROC], identity: true,
    description: "Where procurement stands: purchase orders by status and late deliveries, invoices unpaid / overdue / due within 7 days / disputed, invoices that don't match their PO, and quotations waiting for a decision. Call it for 'what needs attention'.",
    input: { identity: procIdentity },
    run: procurement.procurementOverview,
  },
};

export function toolsFor(agentId) {
  return Object.entries(TOOLS)
    .filter(([, t]) => t.agents.includes(agentId))
    .map(([name, t]) => ({ name, ...t }));
}

export function allowed(agentId, toolName) {
  return Boolean(AGENTS[agentId] && TOOLS[toolName]?.agents.includes(agentId));
}
