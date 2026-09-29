// Idempotent tenant bootstrap: tax codes, numbering, entity descriptions,
// readiness rules and default templates. Safe to run on every boot.
import { withContext } from "./db.mjs";
import { DEFAULT_WORKFLOWS } from "./workflows.mjs";
import { defaultTemplateHtml } from "./templates.mjs";

export const DEFAULT_TAX_CODES = [
  { code: "NT", name: "No tax", rate: 0, kind: "none", is_default: true },
  { code: "SV8", name: "Service tax 8%", rate: 8, kind: "sst_service" },
  { code: "SV6", name: "Service tax 6% (F&B, telco, parking, logistics)", rate: 6, kind: "sst_service" },
  { code: "ST10", name: "Sales tax 10%", rate: 10, kind: "sst_sales" },
  { code: "ST5", name: "Sales tax 5%", rate: 5, kind: "sst_sales" },
  { code: "EX", name: "Exempt", rate: 0, kind: "exempt" },
];

export const DEFAULT_SEQUENCES = [
  { key: "quotation", prefix: "QT-", padding: 4, yearly_reset: true },
  { key: "invoice", prefix: "INV-", padding: 4, yearly_reset: true },
  { key: "credit_note", prefix: "CN-", padding: 4, yearly_reset: true },
  { key: "receipt", prefix: "RCP-", padding: 4, yearly_reset: true },
  { key: "customer", prefix: "C-", padding: 4, yearly_reset: false },
];

export const ENTITY_DEFS = [
  {
    entity: "customer",
    label: "Customer",
    description:
      "A company or individual you sell to. Company = the organisation (name, SSM reg no, TIN, billing address); the people you talk to are contacts under it. Never create a second customer for the same company: match first.",
    match_keys: ["reg_no", "tin", "email", "phone", "name"],
  },
  {
    entity: "contact",
    label: "Contact",
    description: "A person at a customer (from a name card, email signature, etc.). One customer can have many; one is primary.",
    match_keys: ["email", "mobile", "phone", "name"],
  },
  {
    entity: "product",
    label: "Product / service",
    description: "A sellable item with a SKU, unit, default price and tax code. Prices on documents are copied at the time, so changing a product never changes old documents.",
    match_keys: ["sku", "name"],
  },
  {
    entity: "package",
    label: "Package",
    description: "A bundle of products sold together at one price (or the sum of its items). On a document it is one line that lists its components.",
    match_keys: ["code", "name"],
  },
  {
    entity: "document",
    label: "Quotation / invoice / credit note",
    description:
      "draft (editable, no number) -> issued (numbered, frozen). Quotation: issued -> accepted | rejected | expired; accepted -> converted into an invoice draft. Invoice: issued -> partially_paid -> paid, or void. Issued documents are never edited or deleted: void and reissue instead.",
    match_keys: ["number"],
  },
  {
    entity: "payment",
    label: "Payment",
    description: "Money received. Allocated to one or more invoices; an invoice can be paid in parts.",
    match_keys: ["number", "reference"],
  },
  {
    entity: "form",
    label: "Form",
    description:
      "A company form (application, job report, survey, order form) with a public link. Its fields live in versions: draft (editable) -> published (frozen, live) -> retired. Editing a live form means a new version.",
    match_keys: ["slug", "title"],
  },
  {
    entity: "form_submission",
    label: "Form submission",
    description:
      "One set of answers to a form, pinned to the version it was filled in on. Answers never change; status moves new -> reviewed -> processed (turned into a customer/document or linked to one), or spam.",
    match_keys: ["id"],
  },
];

/** Returns the default tenant id, creating "My Company" on first boot. Runs as owner. */
export async function ensureDefaultTenant(db, name = "My Company") {
  const existing = await db.query(
    "SELECT id FROM di.tenant WHERE is_default AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await db.query(
    "INSERT INTO di.tenant (name, is_default) VALUES ($1, true) RETURNING id",
    [name],
  );
  return rows[0].id;
}

export async function seedTenant(db, tenantId) {
  return withContext(db, { tenantId, actor: "system", agent: "seed", asRole: false }, async (tx) => {
    for (const t of DEFAULT_TAX_CODES) {
      await tx.query(
        `INSERT INTO di.tax_code (tenant_id, code, name, rate, kind, is_default)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (tenant_id, code) DO NOTHING`,
        [tenantId, t.code, t.name, t.rate, t.kind, Boolean(t.is_default)],
      );
    }
    for (const s of DEFAULT_SEQUENCES) {
      await tx.query(
        `INSERT INTO di.document_sequence (tenant_id, key, prefix, padding, yearly_reset)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenantId, s.key, s.prefix, s.padding, s.yearly_reset],
      );
    }
    for (const e of ENTITY_DEFS) {
      await tx.query(
        `INSERT INTO di.entity_def (tenant_id, entity, label, description, match_keys)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, entity) DO NOTHING`,
        [tenantId, e.entity, e.label, e.description, JSON.stringify(e.match_keys)],
      );
    }
    for (const [docType, transitions] of Object.entries(DEFAULT_WORKFLOWS)) {
      for (const [transition, rules] of Object.entries(transitions)) {
        await tx.query(
          `INSERT INTO di.workflow_def (tenant_id, doc_type, transition, rules)
           VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, doc_type, transition) DO NOTHING`,
          [tenantId, docType, transition, JSON.stringify(rules)],
        );
      }
    }
    for (const docType of ["quotation", "invoice"]) {
      const have = await tx.query(
        "SELECT 1 FROM di.template WHERE tenant_id = $1 AND doc_type = $2 AND deleted_at IS NULL LIMIT 1",
        [tenantId, docType],
      );
      if (have.rows.length) continue;
      await tx.query(
        `INSERT INTO di.template (tenant_id, doc_type, name, version, html, is_default, notes)
         VALUES ($1, $2, $3, 1, $4, true, 'Seeded default A4 template')`,
        [tenantId, docType, `Standard ${docType}`, defaultTemplateHtml(docType)],
      );
    }
    return tenantId;
  });
}
