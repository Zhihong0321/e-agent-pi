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

export const AGENTS = {
  "di-onboarding": { name: "Company Onboarding", short: "CO" },
  "di-records": { name: "Records Clerk", short: "RC" },
  "di-documents": { name: "Document Agent", short: "DA" },
  "di-templates": { name: "Template Designer", short: "TD" },
  "di-db": { name: "DB Manager", short: "DB" },
  "di-forms": { name: "Form Designer", short: "FD" },
  "di-intake": { name: "Form Clerk", short: "FC" },
  "di-calendar": { name: "Calendar AI", short: "CA" },
};

const ALL = Object.keys(AGENTS).filter((id) => id !== "di-calendar");
const RECORDS = "di-records";
const DOCS = "di-documents";
const TPL = "di-templates";
const DB = "di-db";
const ONBOARD = "di-onboarding";
const FORMS = "di-forms";
const INTAKE = "di-intake";
const CALENDAR = "di-calendar";

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

/** @type {Record<string, { agents: string[], description: string, input: Record<string, z.ZodTypeAny>, run: Function, pdf?: Function, previewPdf?: boolean, saveFile?: Function }>} */
export const TOOLS = {
  ...USER_TOOLS,
  get_onboarding_status: {
    agents: ALL, description: "Live company profile, field definitions, missing minimum setup, invoice profile readiness and manual form link. Re-read after updates; never infer completion from chat history.",
    input: {}, run: company.getCompanyProfile,
  },
  list_company_members: {
    agents: ALL, description: "Read the company's own people, their positions, departments and contact details. These are internal company members, not customer contacts. Use before assigning work or adding a person.",
    input: {}, run: members.listCompanyMembers,
  },
  save_company_member: {
    agents: [ONBOARD, DB], description: "Record or update one person who works for this company. Ask for name, position, department and a work email or phone when available; use id to update an existing member. Do not create a customer contact for company staff.",
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
    description: "Read-only company calendar events for a bounded date range. Includes quotation expiry, unpaid invoice due dates, recorded payments, form deadlines, and date-typed custom-field reminders. Returns source provenance and review warnings; never changes records.",
    input: {
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Visible range start, YYYY-MM-DD"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Visible range end, YYYY-MM-DD"),
      timezone: z.string().optional().describe("IANA timezone; defaults to the company timezone"),
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
};

export function toolsFor(agentId) {
  return Object.entries(TOOLS)
    .filter(([, t]) => t.agents.includes(agentId))
    .map(([name, t]) => ({ name, ...t }));
}

export function allowed(agentId, toolName) {
  return Boolean(AGENTS[agentId] && TOOLS[toolName]?.agents.includes(agentId));
}
