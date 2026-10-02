// Company reports over expense claims, defined as data (expense_setting.custom.reports) and run here.
// A spec picks from a closed vocabulary: filters, up to two groupings, and measures (count, sum, avg,
// max of the amount, the tax or any number field). No SQL, HTML or code ever comes from the spec: the
// rows are loaded with the same scoping as every other claim read, then grouped in plain JS, so the
// Forward Deploy Engineer can add a report without a deploy and a report can never show more than the
// person running it may see.
import { DiError, round2, todayMY } from "./common.mjs";
import { EXPENSE_CATEGORIES, addMonths, defaultMonth, getSettings, isAdmin, scopeClause } from "./expenses.mjs";
import { mergeCategories, reportsOf, availableReports } from "./expense-policy.mjs";

export const REPORT_LIMITS = { group_by: 2, measures: 8, per_company: 10, rows: 5000 };
export const GROUPS = ["employee", "department", "category", "month"];
export const FNS = ["count", "sum", "avg", "max"];
const BASE_FIELDS = ["amount", "tax_amount"];
const STATUSES = ["submitted", "approved", "rejected"];
const SLUG = /^[a-z][a-z0-9-]{0,47}$/;
const KEY = /^[a-z][a-z0-9_]{0,31}$/;
const PERIOD = /^(current|previous|all|\d{4}-(0[1-9]|1[0-2]))$/;
const GROUP_LABEL = { employee: "Employee", department: "Department", category: "Category", month: "Month" };

const fail = (message) => { throw new DiError(`Report: ${message}`); };
const humanise = (key) => String(key).replace(/^custom\./, "").replace(/_/g, " ");

/**
 * Checks a report spec and returns a clean copy. With `refs` it also checks the names a spec uses exist:
 * refs = { categories: [keys], numberFields: [keys of number custom fields] }.
 */
export function normaliseReportSpec(input, refs = null) {
  const s = input && typeof input === "object" ? input : {};
  if (!SLUG.test(String(s.slug ?? ""))) fail("slug must be lowercase letters, digits and - (e.g. mileage-monthly)");
  const title = String(s.title ?? "").trim();
  if (!title || title.length > 80) fail("title is required (max 80 characters)");
  if ((s.dataset ?? "expense_claims") !== "expense_claims") fail('dataset must be "expense_claims"');

  const w = s.where ?? {};
  const unknown = Object.keys(w).filter((k) => !["category", "status", "department", "period"].includes(k));
  if (unknown.length) fail(`where does not know ${unknown.join(", ")}. Use category, status, department, period`);
  const where = {};
  if (w.category?.length) {
    if (w.category.length > 10 || w.category.some((c) => !KEY.test(String(c)))) fail("where.category is a list of up to 10 category keys");
    if (refs) for (const c of w.category) if (!refs.categories.includes(c)) fail(`category "${c}" does not exist`);
    where.category = [...w.category];
  }
  if (w.status?.length) {
    if (w.status.some((x) => !STATUSES.includes(x))) fail(`where.status can only be ${STATUSES.join(", ")}`);
    where.status = [...w.status];
  }
  if (w.department?.length) {
    if (w.department.length > 10 || w.department.some((d) => !String(d).trim() || String(d).length > 60)) fail("where.department is a list of up to 10 department names");
    where.department = w.department.map((d) => String(d).trim());
  }
  where.period = w.period ?? "current";
  if (!PERIOD.test(String(where.period))) fail("where.period must be current, previous, all or YYYY-MM");

  const period_basis = s.period_basis ?? "submission";
  if (!["submission", "expense_date"].includes(period_basis)) fail("period_basis must be submission (the monthly claim cycle) or expense_date (the calendar month of the expense)");

  const group_by = s.group_by ?? [];
  if (group_by.length > REPORT_LIMITS.group_by || new Set(group_by).size !== group_by.length || group_by.some((g) => !GROUPS.includes(g))) {
    fail(`group_by is up to ${REPORT_LIMITS.group_by} different values of ${GROUPS.join(", ")}`);
  }

  const measures = (s.measures?.length ? s.measures : [{ key: "claims", fn: "count" }]).map((m) => {
    if (!KEY.test(String(m?.key ?? ""))) fail("every measure needs a key (lowercase letters, digits, _)");
    if (!FNS.includes(m.fn)) fail(`measure ${m.key}: fn must be ${FNS.join(", ")}`);
    if (m.fn !== "count" && !m.field) fail(`measure ${m.key}: ${m.fn} needs a field (amount, tax_amount or custom.<number field>)`);
    if (m.field) {
      const custom = String(m.field).startsWith("custom.");
      if (!BASE_FIELDS.includes(m.field) && !(custom && KEY.test(String(m.field).slice(7)))) fail(`measure ${m.key}: field must be amount, tax_amount or custom.<field key>`);
      if (custom && refs && !refs.numberFields.includes(String(m.field).slice(7))) fail(`measure ${m.key}: ${m.field} is not a number field`);
    }
    return { key: m.key, ...(m.label ? { label: String(m.label).slice(0, 40) } : {}), fn: m.fn, ...(m.field ? { field: m.field } : {}) };
  });
  if (measures.length > REPORT_LIMITS.measures || new Set(measures.map((m) => m.key)).size !== measures.length) fail(`at most ${REPORT_LIMITS.measures} measures, each with its own key`);

  if (s.include_members && !(group_by.length === 1 && group_by[0] === "employee")) fail("include_members only works when grouped by employee alone (it adds people with no claims)");
  const audience = s.audience ?? "admin";
  if (!["admin", "scoped"].includes(audience)) fail("audience must be admin or scoped");

  const out = { slug: s.slug, title, dataset: "expense_claims", where, period_basis, group_by, measures, audience };
  if (s.include_members) out.include_members = true;
  if (s.detail) out.detail = true;
  if (s.sort) {
    const dir = s.sort.dir === "desc" ? "desc" : "asc";
    if (![...group_by, ...measures.map((m) => m.key)].includes(s.sort.by)) fail("sort.by must be one of the group_by values or a measure key");
    out.sort = { by: s.sort.by, dir };
  }
  return out;
}

// ---------------------------------------------------------------- aggregation (pure)

const dimOf = (row, group, spec, categoryLabel) => {
  if (group === "employee") return { key: row.claimant_key, label: row.claimant_name };
  if (group === "department") return { key: String(row.department ?? "").toLowerCase(), label: row.department || "Unassigned" };
  if (group === "category") return { key: row.category, label: categoryLabel(row.category) };
  const month = spec.period_basis === "expense_date" ? String(row.expense_date).slice(0, 7) : row.period_key;
  return { key: month, label: month };
};

const valueOf = (row, field) => Number(field.startsWith("custom.") ? row.custom?.[field.slice(7)] : row[field]);

function measure(rows, m) {
  if (m.fn === "count") return m.field ? rows.filter((r) => Number.isFinite(valueOf(r, m.field))).length : rows.length;
  const nums = rows.map((r) => valueOf(r, m.field)).filter((n) => Number.isFinite(n));
  if (!nums.length) return m.fn === "sum" ? 0 : null;
  if (m.fn === "sum") return round2(nums.reduce((a, b) => a + b, 0));
  if (m.fn === "avg") return round2(nums.reduce((a, b) => a + b, 0) / nums.length);
  return Math.max(...nums);
}

const measureLabel = (m) => m.label ?? (m.fn === "count" ? "Claims" : `${m.fn[0].toUpperCase()}${m.fn.slice(1)} ${humanise(m.field)}`);

/**
 * @param {object[]} rows claims: { claimant_key, claimant_name, department, category, period_key, expense_date, amount, tax_amount, custom }
 * @param {object} spec a normalised report spec
 * @param {{ categoryLabel?: (key: string) => string, members?: { key: string, name: string, department: string | null }[] }} [opts]
 */
export function aggregate(rows, spec, { categoryLabel = (k) => k, members = [] } = {}) {
  const columns = [
    ...spec.group_by.map((g) => ({ key: g, label: GROUP_LABEL[g], type: "text" })),
    ...spec.measures.map((m) => ({ key: m.key, label: measureLabel(m), type: "number" })),
  ];
  const buckets = new Map();
  for (const row of rows) {
    const dims = spec.group_by.map((g) => dimOf(row, g, spec, categoryLabel));
    const id = dims.map((d) => d.key).join("\u0000");
    if (!buckets.has(id)) buckets.set(id, { dims, rows: [] });
    buckets.get(id).rows.push(row);
  }
  if (spec.include_members) {
    for (const person of members) if (!buckets.has(person.key)) buckets.set(person.key, { dims: [{ key: person.key, label: person.name }], rows: [] });
  }
  const out = [...buckets.values()].map((b) => ({
    ...Object.fromEntries(spec.group_by.map((g, i) => [g, b.dims[i].label])),
    ...Object.fromEntries(spec.measures.map((m) => [m.key, measure(b.rows, m)])),
  }));
  const dir = spec.sort?.dir === "desc" ? -1 : 1;
  out.sort((a, b) => {
    if (spec.sort?.by) {
      const x = a[spec.sort.by];
      const y = b[spec.sort.by];
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
      if (cmp) return cmp * dir;
    }
    for (const g of spec.group_by) {
      const cmp = String(a[g] ?? "").localeCompare(String(b[g] ?? ""));
      if (cmp) return cmp;
    }
    return 0;
  });
  const totals = Object.fromEntries(spec.measures.map((m) => [m.key, measure(rows, m)]));
  return { columns, rows: out, totals };
}

const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const show = (v) => (typeof v === "number" ? String(v) : cell(v));

/** A GitHub-flavoured table the chat can show as is. */
export function toMarkdown({ columns, rows, totals }, spec) {
  const head = `| ${columns.map((c) => c.label).join(" | ")} |\n| ${columns.map((c) => (c.type === "number" ? "---:" : "---")).join(" | ")} |`;
  const body = rows.map((r) => `| ${columns.map((c) => show(r[c.key])).join(" | ")} |`);
  const total = spec.group_by.length ? [`| **Total** | ${columns.slice(1).map((c) => (c.key in totals ? `**${show(totals[c.key])}**` : "")).join(" | ")} |`] : [];
  return [head, ...body, ...total].join("\n");
}

// ---------------------------------------------------------------- running a report

async function resolveMonth(tx, spec, month, now) {
  const wanted = month ?? spec.where.period;
  if (wanted === "all") return null;
  if (/^\d{4}-\d{2}$/.test(wanted)) return wanted;
  const current = spec.period_basis === "expense_date" ? todayMY(now).slice(0, 7) : await defaultMonth(tx);
  return wanted === "previous" ? addMonths(current, -1) : current;
}

/** Loads the claims a report covers, limited to what `who` may see, and groups them. */
export async function executeReport(tx, spec, { month, who, now = new Date() }) {
  const settings = await getSettings(tx);
  const categories = mergeCategories(EXPENSE_CATEGORIES, settings);
  const label = (key) => (categories.find((c) => c.key === key)?.label ?? humanise(key)).replace(/ \(.*\)$/, "");
  const period = await resolveMonth(tx, spec, month, now);

  const values = [];
  const arg = (v) => { values.push(v); return `$${values.length}`; };
  const conds = ["c.deleted_at IS NULL", "c.status <> 'withdrawn'"];
  if (spec.where.status) conds.push(`c.status = ANY(${arg(spec.where.status)}::text[])`);
  if (spec.where.category) conds.push(`c.category = ANY(${arg(spec.where.category)}::text[])`);
  if (spec.where.department) conds.push(`lower(m.department) = ANY(${arg(spec.where.department.map((d) => d.toLowerCase()))}::text[])`);
  if (period && spec.period_basis === "submission") conds.push(`b.period_key = ${arg(period)}`);
  if (period && spec.period_basis === "expense_date") conds.push(`c.expense_date >= ${arg(`${period}-01`)}::date AND c.expense_date < ${arg(`${addMonths(period, 1)}-01`)}::date`);
  const scope = scopeClause(who, null, values.length + 1);
  values.push(...scope.values);
  const loaded = (await tx.query(
    `SELECT c.number, c.status, c.category, c.amount, c.tax_amount, c.expense_date, c.claimant_name, c.claimant_user_id, c.claimant_member_id, c.custom, b.period_key, m.department
       FROM di.expense_claim c JOIN di.expense_batch b ON b.id = c.batch_id
       LEFT JOIN di.company_member m ON m.id = c.claimant_member_id AND m.deleted_at IS NULL
      WHERE ${conds.join(" AND ")}${scope.sql} ORDER BY c.expense_date, c.number LIMIT ${REPORT_LIMITS.rows + 1}`,
    values,
  )).rows;
  const truncated = loaded.length > REPORT_LIMITS.rows;
  const rows = loaded.slice(0, REPORT_LIMITS.rows).map((r) => ({
    number: r.number, status: r.status, category: r.category, amount: Number(r.amount), tax_amount: r.tax_amount == null ? null : Number(r.tax_amount),
    expense_date: r.expense_date instanceof Date ? r.expense_date.toISOString().slice(0, 10) : String(r.expense_date).slice(0, 10),
    claimant_name: r.claimant_name, claimant_key: r.claimant_member_id || r.claimant_user_id || String(r.claimant_name).toLowerCase(),
    department: r.department ?? null, custom: r.custom ?? {}, period_key: r.period_key,
  }));

  let members = [];
  if (spec.include_members && isAdmin(who)) {
    const dept = spec.where.department?.map((d) => d.toLowerCase());
    members = (await tx.query("SELECT id, name, department FROM di.company_member WHERE deleted_at IS NULL ORDER BY name")).rows
      .filter((p) => !dept || dept.includes(String(p.department ?? "").toLowerCase()))
      .map((p) => ({ key: p.id, name: p.name, department: p.department }));
  }
  const grouped = aggregate(rows, spec, { categoryLabel: label, members });
  return {
    report: { slug: spec.slug, title: spec.title },
    period: { basis: spec.period_basis, month: period },
    scope: isAdmin(who) ? "all claims" : "your claims only",
    columns: grouped.columns, rows: grouped.rows, totals: grouped.totals,
    row_count: rows.length, truncated,
    markdown: toMarkdown(grouped, spec),
    ...(spec.detail ? { claims: rows.map(({ claimant_key, ...r }) => ({ ...r, category: label(r.category) })) } : {}),
  };
}

/** The run_report tool: without `report` it lists what the caller may run; with it, runs one. */
export async function runReport(tx, { report, month } = {}, { who, now = new Date() } = {}) {
  if (!who) throw new DiError("Sign-in required");
  if (month !== undefined && !/^\d{4}-\d{2}$|^all$/.test(String(month))) throw new DiError("month must look like 2026-10, or all");
  const settings = await getSettings(tx);
  if (!report) return { reports: availableReports(settings, who) };
  const spec = reportsOf(settings).find((r) => r.slug === report);
  if (!spec || (spec.audience === "admin" && !isAdmin(who))) {
    const names = availableReports(settings, who).map((r) => r.slug).join(", ") || "none";
    throw new DiError(`No report "${report}" is available to you. Available: ${names}`);
  }
  return executeReport(tx, spec, { month, who, now });
}
