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

/**
 * check name -> (ctx, arg) => boolean.
 * Document ctx = { doc, lines, customer, contact, tenant, template }.
 * Expense-claim ctx = { claim: { category, amount, custom }, receipts: [{ kind }] }.
 */
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
    const source = entity === "document" ? c.doc : entity === "contact" ? c.contact : entity === "expense_claim" ? c.claim : c.customer;
    return present(source?.custom?.[key]);
  },
  // Expense claims only: an attachment of this kind (receipt, route_map, ...) is on the claim.
  attachment_kind: (c, kind) => (c.receipts ?? []).some((r) => (r.kind || "receipt") === kind),
  amount_at_most: (c, max) => Number(c.claim?.amount) <= Number(max),
};

/** Checks that only make sense on an expense claim; documents refuse them. custom_field works on both. */
export const CLAIM_ONLY_CHECKS = ["attachment_kind", "amount_at_most"];
export const CLAIM_CHECKS = ["custom_field", ...CLAIM_ONLY_CHECKS];
export const RULE_ID = /^[a-z][a-z0-9_-]{0,47}$/;
export const KIND_KEY = /^[a-z][a-z0-9_]{0,31}$/;

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

/**
 * @param {object[]} rules
 * @param {string | null} [subject] the doc type the rules belong to ("expense_claim" for claims).
 *   Without it nothing is subject-checked, so older callers behave as before.
 */
export function validateRules(rules, subject = null) {
  if (!Array.isArray(rules)) throw new Error("rules must be an array");
  const claim = subject === "expense_claim";
  const ids = new Set();
  for (const rule of rules) {
    if (!CHECKS[rule.check]) throw new Error(`Unknown check "${rule.check}". Known: ${Object.keys(CHECKS).join(", ")}`);
    if (subject && claim && !CLAIM_CHECKS.includes(rule.check)) {
      throw new Error(`Check "${rule.check}" does not apply to expense claims. Use: ${CLAIM_CHECKS.join(", ")}`);
    }
    if (subject && !claim && CLAIM_ONLY_CHECKS.includes(rule.check)) {
      throw new Error(`Check "${rule.check}" only applies to expense claims, not ${subject}`);
    }
    if (!["block", "warn"].includes(rule.severity)) throw new Error(`severity must be block or warn (rule ${rule.check})`);
    if (!rule.message) throw new Error(`rule ${rule.check} needs a message`);
    const noArg = rule.arg === undefined || rule.arg === null || rule.arg === "";
    if ((rule.check === "date_set" || rule.check === "custom_field" || CLAIM_ONLY_CHECKS.includes(rule.check)) && noArg) {
      throw new Error(`${rule.check} needs an arg`);
    }
    if (rule.id !== undefined) {
      if (!RULE_ID.test(String(rule.id))) throw new Error(`rule id "${rule.id}" must be lowercase letters, digits, - or _ (max 48 characters)`);
      if (ids.has(rule.id)) throw new Error(`duplicate rule id "${rule.id}"`);
      ids.add(rule.id);
    }
    if (rule.when !== undefined) {
      if (subject && !claim) throw new Error(`"when" only applies to expense claim rules (rule ${rule.check})`);
      const cats = rule.when?.category;
      const keys = Object.keys(rule.when ?? {});
      if (keys.some((k) => k !== "category") || !Array.isArray(cats) || !cats.length || cats.length > 10 || cats.some((c) => !KIND_KEY.test(String(c)))) {
        throw new Error(`rule ${rule.check}: when must be { category: [up to 10 category keys] }`);
      }
    }
    if (claim) {
      if (String(rule.message).length > 200) throw new Error(`rule ${rule.check}: message is too long (max 200 characters)`);
      if (rule.check === "custom_field" && !/^expense_claim\.[a-z][a-z0-9_]{0,47}$/.test(String(rule.arg))) {
        throw new Error(`custom_field arg must look like expense_claim.<field key>`);
      }
      if (rule.check === "attachment_kind" && !KIND_KEY.test(String(rule.arg))) {
        throw new Error(`attachment_kind arg must be a lowercase kind such as route_map`);
      }
      if (rule.check === "amount_at_most" && !(Number(rule.arg) > 0)) throw new Error(`amount_at_most arg must be a number above zero`);
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

/** A rule with `when.category` only applies to claims in one of those categories. */
const applies = (rule, ctx) => {
  const cats = rule.when?.category;
  return !cats?.length || cats.includes(ctx.claim?.category);
};

export function evaluate(rules, ctx) {
  const blockers = [];
  const warnings = [];
  for (const rule of rules) {
    if (!applies(rule, ctx)) continue;
    const ok = CHECKS[rule.check]?.(ctx, rule.arg);
    if (ok) continue;
    const item = { check: rule.check, ...(rule.id ? { id: rule.id } : {}), ...(rule.arg ? { field: rule.arg } : {}), message: rule.message };
    (rule.severity === "block" ? blockers : warnings).push(item);
  }
  return { ready: blockers.length === 0, blockers, warnings };
}
