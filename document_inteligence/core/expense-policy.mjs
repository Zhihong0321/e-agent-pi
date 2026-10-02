// Tenant policy for expense claims, kept as data so a company can add rules without code or DDL:
//   extra categories      di.expense_setting.custom.categories  [{ key, label }]
//   extra claim fields    di.field_def                          entity 'expense_claim'
//   claim rules           di.workflow_def                       doc_type 'expense_claim', transition 'file'
// A claim also carries a free `custom` bag (field values) and each receipt a `kind` (receipt,
// route_map, ...). The rules are the closed vocabulary in workflows.mjs; nothing here runs tenant code.
import { DiError } from "./common.mjs";
import { evaluate, KIND_KEY } from "./workflows.mjs";

export const POLICY_DOC_TYPE = "expense_claim";
export const POLICY_TRANSITION = "file";
export const DEFAULT_KIND = "receipt";
/** Keys the system writes into a claim's custom bag; never shown as tenant fields. */
export const INTERNAL_CUSTOM_KEYS = ["withdrawn_reason", "withdrawn_by", "demo"];

export const visibleCustom = (custom) =>
  Object.fromEntries(Object.entries(custom ?? {}).filter(([key]) => !INTERNAL_CUSTOM_KEYS.includes(key)));

// ---------------------------------------------------------------- categories

/** Tenant categories from expense_setting.custom, dropping anything malformed. */
export function tenantCategories(settings) {
  const raw = settings?.custom?.categories;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && KIND_KEY.test(String(c.key)) && String(c.label ?? "").trim())
    .map((c) => ({ key: c.key, label: String(c.label).trim().slice(0, 60) }));
}

/** The built-in categories first, then the tenant's additions (a tenant can't override a built-in key). */
export function mergeCategories(defaults, settings) {
  const seen = new Set(defaults.map((c) => c.key));
  const out = [...defaults];
  for (const c of tenantCategories(settings)) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------- report definitions

/** Report specs stored on the company's expense settings (validated when they were saved). */
export const reportsOf = (settings) => (Array.isArray(settings?.custom?.reports) ? settings.custom.reports : []);

/** What `who` may run: admins every report, everyone else only the ones scoped to their own claims. */
export const availableReports = (settings, who) =>
  reportsOf(settings)
    .filter((r) => who?.role === "admin" || r.audience === "scoped")
    .map((r) => ({ slug: r.slug, title: r.title, audience: r.audience }));

// ---------------------------------------------------------------- policy

/**
 * @returns {Promise<{ rules: object[], fields: object[], kinds: string[] }>} what applies to a claim right now.
 * `kinds` is every attachment kind a claim may carry: the default plus any a rule asks for.
 */
export async function loadPolicy(tx) {
  const wf = (
    await tx.query("SELECT rules FROM di.workflow_def WHERE doc_type = $1 AND transition = $2 AND deleted_at IS NULL", [
      POLICY_DOC_TYPE,
      POLICY_TRANSITION,
    ])
  ).rows[0];
  const fields = (
    await tx.query("SELECT key, label, type, options, required_for, help FROM di.field_def WHERE entity = $1 AND deleted_at IS NULL ORDER BY key", [
      POLICY_DOC_TYPE,
    ])
  ).rows;
  const rules = Array.isArray(wf?.rules) ? wf.rules : [];
  const kinds = [DEFAULT_KIND];
  for (const rule of rules) if (rule.check === "attachment_kind" && !kinds.includes(rule.arg)) kinds.push(rule.arg);
  return { rules, fields, kinds };
}

const need = (rule) =>
  rule.check === "custom_field"
    ? `custom.${String(rule.arg).split(".")[1]}`
    : rule.check === "attachment_kind"
      ? `an attachment of kind "${rule.arg}" (receipt_kinds)`
      : `an amount of at most ${rule.arg}`;

/** What the Expenses Clerk is told about the policy: short, structured, no prompt growth. */
export function policySummary(policy) {
  return {
    requirements: policy.rules.map((rule) => ({
      ...(rule.id ? { id: rule.id } : {}),
      applies_to: rule.when?.category ?? "all categories",
      severity: rule.severity,
      needs: need(rule),
      message: rule.message,
    })),
    fields: policy.fields.map((f) => ({
      key: f.key, label: f.label, type: f.type,
      ...(f.type === "select" ? { options: f.options } : {}),
      ...(f.required_for === "save" ? { required: true } : {}),
      ...(f.help ? { help: f.help } : {}),
    })),
    attachment_kinds: policy.kinds,
  };
}

// ---------------------------------------------------------------- attachment kinds

export function kindOf(policy, value) {
  const kind = String(value ?? DEFAULT_KIND).trim().toLowerCase() || DEFAULT_KIND;
  if (!policy.kinds.includes(kind)) throw new DiError(`Attachment kind "${kind}" is not one this company uses. Use one of: ${policy.kinds.join(", ")}`);
  return kind;
}

/** Tags each loaded attachment with its kind; `kinds[i]` belongs to `receipts[i]`, missing ones are plain receipts. */
export function withKinds(policy, receipts, kinds, label = "receipt_kinds") {
  if ((kinds?.length ?? 0) > receipts.length) throw new DiError(`${label} has more entries than there are attachments`);
  return receipts.map((r, i) => ({ ...r, kind: kindOf(policy, kinds?.[i]) }));
}

// ---------------------------------------------------------------- evaluation

/** @param {{ category: string, amount: number, custom: object }} claim @param {{ kind?: string }[]} receipts */
export const checkClaim = (policy, claim, receipts) => evaluate(policy.rules, { claim, receipts });

export const blockedMessage = (verdict) =>
  `Company policy: ${verdict.blockers.map((b) => b.message).join(" ")} Get what is missing from the user, then try again.`;

export const issueMessages = (verdict) => [...verdict.blockers, ...verdict.warnings].map((i) => i.message);
