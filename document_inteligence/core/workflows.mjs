// Readiness rules: what must be true before a document can move to its next state.
// Rules are data (di.workflow_def.rules, editable per tenant by the DB Manager);
// the checks they name are this fixed vocabulary, so a tenant can tighten or relax
// requirements without anyone writing code or SQL.

const hasAddress = (addr) => {
  if (!addr) return false;
  if (typeof addr === "string") return addr.trim().length > 0;
  return Boolean(addr.line1 || addr.city || addr.postcode);
};

const present = (v) => v !== undefined && v !== null && String(v).trim() !== "";

/** check name -> (ctx, arg) => boolean. ctx = { doc, lines, customer, contact, tenant, template } */
export const CHECKS = {
  customer_selected: (c) => Boolean(c.customer),
  customer_has_billing_address: (c) => hasAddress(c.customer?.billing_address),
  customer_has_email: (c) => present(c.contact?.email) || present(c.customer?.email),
  customer_has_phone: (c) => present(c.contact?.phone) || present(c.contact?.mobile) || present(c.customer?.phone),
  customer_has_reg_no: (c) => present(c.customer?.reg_no),
  customer_has_tin: (c) => present(c.customer?.tin),
  has_lines: (c) => (c.lines?.length ?? 0) > 0,
  lines_priced: (c) => (c.lines ?? []).every((l) => Number(l.unit_price) > 0),
  lines_have_tax_code: (c) => (c.lines ?? []).every((l) => present(l.tax_code)),
  date_set: (c, field) => present(c.doc?.[field]),
  template_available: (c) => Boolean(c.template),
  issuer_profile_complete: (c) => present(c.tenant?.name) && hasAddress(c.tenant?.address),
  issuer_has_tin: (c) => present(c.tenant?.tin),
  custom_field: (c, ref) => {
    const [entity, key] = String(ref || "").split(".");
    const source = entity === "document" ? c.doc : entity === "contact" ? c.contact : c.customer;
    return present(source?.custom?.[key]);
  },
};

export const DEFAULT_WORKFLOWS = {
  quotation: {
    issue: [
      { check: "customer_selected", severity: "block", message: "Which customer is this quotation for?" },
      { check: "has_lines", severity: "block", message: "What products, packages or services go on it, and how many?" },
      { check: "lines_priced", severity: "block", message: "Every line needs a price above zero." },
      { check: "date_set", arg: "valid_until", severity: "block", message: "How long is the quotation valid? (usually 30 days)" },
      { check: "issuer_profile_complete", severity: "block", message: "Your company name and address are not set; the DB Manager agent fills the company profile." },
      { check: "template_available", severity: "block", message: "No quotation template exists; the Template Designer agent creates one." },
      { check: "customer_has_email", severity: "warn", message: "The customer has no email, so the quotation cannot be emailed later." },
      { check: "customer_has_billing_address", severity: "warn", message: "The customer has no address; it will print without one." },
    ],
  },
  invoice: {
    issue: [
      { check: "customer_selected", severity: "block", message: "Which customer is this invoice for?" },
      { check: "customer_has_billing_address", severity: "block", message: "An invoice needs the customer's billing address." },
      { check: "has_lines", severity: "block", message: "What was sold, and how many?" },
      { check: "lines_priced", severity: "block", message: "Every line needs a price above zero." },
      { check: "lines_have_tax_code", severity: "block", message: "Every line needs a tax code (e.g. SV8, ST10 or NT for no tax)." },
      { check: "date_set", arg: "due_date", severity: "block", message: "When is payment due? (the customer's payment terms decide this)" },
      { check: "issuer_profile_complete", severity: "block", message: "Your company name and address are not set; the DB Manager agent fills the company profile." },
      { check: "template_available", severity: "block", message: "No invoice template exists; the Template Designer agent creates one." },
      { check: "customer_has_reg_no", severity: "warn", message: "No company registration no. for the customer; MyInvois e-invoicing will need it." },
      { check: "customer_has_tin", severity: "warn", message: "No TIN for the customer; MyInvois e-invoicing will need it." },
    ],
  },
  credit_note: {
    issue: [
      { check: "customer_selected", severity: "block", message: "Which customer is this credit note for?" },
      { check: "has_lines", severity: "block", message: "What is being credited?" },
      { check: "template_available", severity: "block", message: "No credit note template exists." },
    ],
  },
};

export function validateRules(rules) {
  if (!Array.isArray(rules)) throw new Error("rules must be an array");
  for (const rule of rules) {
    if (!CHECKS[rule.check]) throw new Error(`Unknown check "${rule.check}". Known: ${Object.keys(CHECKS).join(", ")}`);
    if (!["block", "warn"].includes(rule.severity)) throw new Error(`severity must be block or warn (rule ${rule.check})`);
    if (!rule.message) throw new Error(`rule ${rule.check} needs a message`);
    if ((rule.check === "date_set" || rule.check === "custom_field") && !rule.arg) {
      throw new Error(`${rule.check} needs an arg`);
    }
  }
  return rules;
}

/** Custom fields marked required_for "<doc_type>.issue" become blocking rules automatically. */
export function rulesFromFieldDefs(fieldDefs, docType, transition = "issue") {
  return fieldDefs
    .filter((f) => f.required_for === `${docType}.${transition}` && !f.deleted_at)
    .map((f) => ({
      check: "custom_field",
      arg: `${f.entity}.${f.key}`,
      severity: "block",
      message: `${f.label} (${f.entity}) is required before issuing${f.help ? ` — ${f.help}` : ""}.`,
    }));
}

export function evaluate(rules, ctx) {
  const blockers = [];
  const warnings = [];
  for (const rule of rules) {
    const ok = CHECKS[rule.check]?.(ctx, rule.arg);
    if (ok) continue;
    const item = { check: rule.check, ...(rule.arg ? { field: rule.arg } : {}), message: rule.message };
    (rule.severity === "block" ? blockers : warnings).push(item);
  }
  return { ready: blockers.length === 0, blockers, warnings };
}
