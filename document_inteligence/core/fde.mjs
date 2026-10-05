// Forward Deploy Engineer: lets a company admin teach the system a new business rule in chat.
//
// Nothing here changes a table or runs company code. A change is DATA in places the system already
// reads: extra expense categories (expense_setting.custom), extra claim fields (di.field_def), claim
// rules (di.workflow_def, the closed vocabulary in workflows.mjs) and one managed block in the target
// agent's SOP. Whatever the FDE creates is listed in a registry (expense_setting.custom.fde), and every
// operation (apply, remove an item, reset) records what each touched item looked like before, so any of
// them can be undone and "reset to default" means "registry empty". Claims already filed are never touched.
//
// Both tools preview first: no `fingerprint` = dry run (writes nothing); the fingerprint of that preview
// (changeset + the state it was computed against) applies it, and is refused if anything changed since.
import { createHash } from "node:crypto";
import { DiError } from "./common.mjs";
import { defineCustomField, removeCustomField, setWorkflowRules } from "./admin.mjs";
import { CLAIM_CHECKS, KIND_KEY, RULE_ID, evaluate, validateRules } from "./workflows.mjs";
import { DEFAULT_KIND, POLICY_DOC_TYPE, POLICY_TRANSITION, loadPolicy, mergeCategories, tenantCategories } from "./expense-policy.mjs";
import { EXPENSE_CATEGORIES, getSettings, isAdmin } from "./expenses.mjs";
import { FNS, GROUPS, REPORT_LIMITS, executeReport, normaliseReportSpec } from "./reports.mjs";

/** Agents an FDE change may target, and what it may change on each. */
export const TARGETS = { "di-expenses": { entity: "expense_claim" } };
export const LIMITS = { categories: 20, fields_per_change: 10, rules: 30, sop_chars: 1200, history: 20, examples: 12 };
export const FIELD_TYPES = ["text", "number", "date", "boolean", "select"];

const FIELD_KEY = /^[a-z][a-z0-9_]{0,47}$/;
const START = "<!-- fde:start -->";
const END = "<!-- fde:end -->";
const AREAS = ["categories", "fields", "rules", "reports"];
const SINGULAR = { categories: "category", fields: "field", rules: "rule", reports: "report" };

// ---------------------------------------------------------------- pure helpers

/** JSON with sorted keys, so equal data always hashes the same. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
const sha = (value) => createHash("sha256").update(canonical(value)).digest("hex");

/** The FDE's block inside an SOP, or null. */
export function extractBlock(content) {
  const text = String(content ?? "");
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  return a >= 0 && b > a ? text.slice(a + START.length, b).trim() : null;
}

/** SOP text with the managed block set (markdown) or removed (null). Everything outside the block is kept. */
export function mergeManagedBlock(existing, markdown) {
  const text = String(existing ?? "");
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  const rest = (a >= 0 && b > a ? text.slice(0, a) + text.slice(b + END.length) : text).trim();
  if (markdown == null) return rest ? `${rest}\n` : "";
  return `${rest ? `${rest}\n\n` : ""}${START}\n${String(markdown).trim()}\n${END}\n`;
}

function requireAdmin(who) {
  if (!who) throw new DiError("Sign-in required");
  if (!isAdmin(who)) throw new DiError("Only a Superadmin can change the company's rules.");
}

const text = (value, label, max, { required = true } = {}) => {
  const s = String(value ?? "").trim();
  if (!s) {
    if (required) throw new DiError(`${label} is required`);
    return null;
  }
  if (s.length > max) throw new DiError(`${label} is too long (max ${max} characters)`);
  return s;
};

/** Checks the shape of a changeset and returns a clean copy. Cross-references are checked against live state later. */
export function normaliseChangeset(input) {
  const cs = input && typeof input === "object" ? input : {};
  if (!TARGETS[cs.target_agent]) throw new DiError(`target_agent must be one of: ${Object.keys(TARGETS).join(", ")}`);
  const out = { target_agent: cs.target_agent, summary: text(cs.summary, "summary", 200) };

  if (cs.categories?.length) {
    const seen = new Set();
    out.categories = cs.categories.map((c) => {
      const key = String(c?.key ?? "").trim();
      if (!KIND_KEY.test(key)) throw new DiError(`category key "${key}" must be lowercase letters, digits or _ (e.g. mileage)`);
      if (EXPENSE_CATEGORIES.some((b) => b.key === key)) throw new DiError(`"${key}" is a built-in category and cannot be changed`);
      if (seen.has(key)) throw new DiError(`category "${key}" is listed twice`);
      seen.add(key);
      return { key, label: text(c.label, `label of category ${key}`, 60) };
    });
  }
  if (cs.custom_fields?.length) {
    if (cs.custom_fields.length > LIMITS.fields_per_change) throw new DiError(`At most ${LIMITS.fields_per_change} fields per change`);
    const seen = new Set();
    out.custom_fields = cs.custom_fields.map((f) => {
      const key = String(f?.key ?? "").trim();
      if (!FIELD_KEY.test(key)) throw new DiError(`field key "${key}" must be snake_case, start with a letter, max 48 characters`);
      if (seen.has(key)) throw new DiError(`field "${key}" is listed twice`);
      seen.add(key);
      if (!FIELD_TYPES.includes(f.type)) throw new DiError(`field ${key}: type must be one of ${FIELD_TYPES.join(", ")}`);
      const options = f.type === "select" ? (f.options ?? []).map((o) => text(o, `option of ${key}`, 60)) : [];
      if (f.type === "select" && !options.length) throw new DiError(`field ${key}: a select needs options`);
      return { key, label: text(f.label, `label of field ${key}`, 60), type: f.type, options, help: text(f.help, `help of field ${key}`, 200, { required: false }) };
    });
  }
  if (cs.rules?.length) {
    try {
      validateRules(cs.rules, POLICY_DOC_TYPE);
    } catch (error) {
      throw new DiError(error.message);
    }
    out.rules = cs.rules.map((r) => {
      if (!r.id) throw new DiError(`every rule needs an id (e.g. mileage-map); rule "${r.message ?? r.check}" has none`);
      return { id: r.id, ...(r.when ? { when: { category: [...r.when.category] } } : {}), check: r.check, arg: r.arg, severity: r.severity, message: r.message };
    });
  }
  if (cs.reports?.length) {
    if (cs.reports.length > REPORT_LIMITS.per_company) throw new DiError(`At most ${REPORT_LIMITS.per_company} reports per company`);
    out.reports = cs.reports.map((r) => normaliseReportSpec(r));
    if (new Set(out.reports.map((r) => r.slug)).size !== out.reports.length) throw new DiError("two reports share a slug");
  }
  if (cs.sop?.markdown !== undefined) {
    const md = text(cs.sop.markdown, "sop.markdown", LIMITS.sop_chars);
    if (md.includes(START) || md.includes(END)) throw new DiError("sop.markdown cannot contain the managed-block markers");
    out.sop = { markdown: md };
  }
  if (!out.categories && !out.custom_fields && !out.rules && !out.reports && !out.sop) throw new DiError("The change is empty: give categories, custom_fields, rules, reports or sop");
  out.examples = (cs.examples ?? []).slice(0, LIMITS.examples).map((e) => ({
    claim: { category: String(e?.claim?.category ?? ""), amount: Number(e?.claim?.amount) || 0, custom: e?.claim?.custom ?? {}, attachment_kinds: e?.claim?.attachment_kinds ?? [] },
    expect: e?.expect === "blocked" ? "blocked" : "ok",
  }));
  if (out.rules) {
    const want = new Set(out.examples.map((e) => e.expect));
    if (!want.has("ok") || !want.has("blocked")) throw new DiError("Add examples: at least one claim that must be accepted (expect ok) and one that must be refused (expect blocked), so the rules are tested before they go live");
  }
  if (cs.notes_for_engineering?.length) out.notes_for_engineering = cs.notes_for_engineering.slice(0, 5).map((n) => text(n, "note", 300));
  return out;
}

/** What each example claim does under a rule set. Pure. */
export function runExamples(examples, { rules, fieldKeys, categoryKeys }) {
  return examples.map((e) => {
    const problems = [];
    if (!categoryKeys.includes(e.claim.category)) problems.push(`category "${e.claim.category}" does not exist`);
    for (const key of Object.keys(e.claim.custom)) if (!fieldKeys.includes(key)) problems.push(`field "${key}" does not exist`);
    const verdict = evaluate(rules, { claim: e.claim, receipts: e.claim.attachment_kinds.map((kind) => ({ kind })) });
    const got = verdict.blockers.length ? "blocked" : "ok";
    return { claim: e.claim, expect: e.expect, got, pass: !problems.length && got === e.expect, ...(problems.length ? { problems } : {}), ...(verdict.blockers.length ? { because: verdict.blockers.map((b) => b.message) } : {}) };
  });
}

// ---------------------------------------------------------------- state

const emptyItems = () => ({ categories: [], fields: [], rules: [], reports: [], sop: false });

function readRegistry(custom) {
  const fde = custom?.fde && typeof custom.fde === "object" ? custom.fde : {};
  const items = { ...emptyItems(), ...(fde.items ?? {}) };
  return { items, history: Array.isArray(fde.history) ? fde.history : [], seq: Number(fde.seq) || 0 };
}

const lockTenant = (tx) => tx.query("SELECT pg_advisory_xact_lock(hashtext('di.fde:' || di.current_tenant()::text))");

async function readState(tx, sop, target) {
  const settings = await getSettings(tx);
  const custom = settings.custom ?? {};
  const policy = await loadPolicy(tx);
  const sopRow = sop ? await sop.get(target) : null;
  const registry = readRegistry(custom);
  const state = {
    custom, registry,
    categories: tenantCategories(settings),
    fields: policy.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options ?? [], help: f.help ?? null })),
    rules: policy.rules,
    reports: Array.isArray(custom.reports) ? custom.reports : [],
    sopContent: sopRow?.content ?? "",
  };
  state.block = extractBlock(state.sopContent);
  state.digest = sha({ categories: state.categories, fields: state.fields, rules: state.rules, reports: state.reports, items: registry.items, block: state.block });
  return state;
}

/** The current value of one item, or null when it does not exist. */
function valueOf(state, area, key) {
  if (area === "sop") return state.block;
  const list = state[area] ?? [];
  return list.find((x) => (area === "rules" ? x.id : area === "reports" ? x.slug : x.key) === key) ?? null;
}

// ---------------------------------------------------------------- the one mutation primitive

/**
 * Sets each touched item to the value in `desired` (null = remove) and records how it was.
 * `desired` = { categories?: {key: value|null}, fields?: {...}, rules?: {...}, reports?: {...}, sop?: string|null }.
 * @returns the history entry's `before`.
 */
async function applyDesired(tx, state, desired, { target, who, sop }) {
  const before = {};
  for (const area of AREAS) {
    if (!desired[area]) continue;
    before[area] = Object.fromEntries(Object.keys(desired[area]).map((key) => [key, valueOf(state, area, key)]));
  }
  if ("sop" in desired) before.sop = state.block;

  // Fields first: a rule may name a field this same change adds.
  for (const [key, value] of Object.entries(desired.fields ?? {})) {
    if (value === null) await removeCustomField(tx, { entity: TARGETS[target].entity, key });
    else await defineCustomField(tx, { entity: TARGETS[target].entity, key, label: value.label, type: value.type, options: value.options ?? [], help: value.help ?? null });
  }
  if (desired.rules) {
    const next = [...state.rules];
    for (const [id, value] of Object.entries(desired.rules)) {
      const at = next.findIndex((r) => r.id === id);
      if (value === null) {
        if (at >= 0) next.splice(at, 1);
      } else if (at >= 0) next[at] = value;
      else next.push(value);
    }
    if (next.length > LIMITS.rules) throw new DiError(`A company can have at most ${LIMITS.rules} claim rules`);
    await setWorkflowRules(tx, { doc_type: POLICY_DOC_TYPE, transition: POLICY_TRANSITION, rules: next });
  }
  if ("sop" in desired) {
    if (!sop) throw new DiError("SOP storage is not available on this host");
    const content = mergeManagedBlock(state.sopContent, desired.sop);
    if (content) await sop.save(target, content, who.username);
    else await sop.clear(target);
  }
  return before;
}

/** Writes categories, reports, the registry and history back into expense_setting.custom in one statement. */
async function writeCustom(tx, state, { categories, reports, items, history, seq }) {
  const custom = { ...state.custom };
  if (categories) {
    if (categories.length) custom.categories = categories;
    else delete custom.categories;
  }
  if (reports) {
    if (reports.length) custom.reports = reports;
    else delete custom.reports;
  }
  custom.fde = { items, history: history.slice(-LIMITS.history), seq };
  await tx.query("UPDATE di.expense_setting SET custom = $1 WHERE deleted_at IS NULL", [JSON.stringify(custom)]);
}

function nextCategories(state, desired) {
  if (!desired.categories) return null;
  const next = [...state.categories];
  for (const [key, value] of Object.entries(desired.categories)) {
    const at = next.findIndex((c) => c.key === key);
    if (value === null) {
      if (at >= 0) next.splice(at, 1);
    } else if (at >= 0) next[at] = value;
    else next.push(value);
  }
  if (mergeCategories(EXPENSE_CATEGORIES, { custom: { categories: next } }).length - EXPENSE_CATEGORIES.length > LIMITS.categories) {
    throw new DiError(`A company can have at most ${LIMITS.categories} extra categories`);
  }
  return next;
}

function nextReports(state, desired) {
  if (!desired.reports) return null;
  const next = [...state.reports];
  for (const [slug, value] of Object.entries(desired.reports)) {
    const at = next.findIndex((r) => r.slug === slug);
    if (value === null) {
      if (at >= 0) next.splice(at, 1);
    } else if (at >= 0) next[at] = value;
    else next.push(value);
  }
  if (next.length > REPORT_LIMITS.per_company) throw new DiError(`A company can have at most ${REPORT_LIMITS.per_company} reports`);
  return next;
}

/** Items the registry lists, after adding `add` ({area: [keys]}) and removing `remove`. */
function nextItems(items, { add = {}, remove = {}, sop } = {}) {
  const out = { ...items };
  for (const area of AREAS) {
    const keep = (items[area] ?? []).filter((key) => !(remove[area] ?? []).includes(key));
    out[area] = [...new Set([...keep, ...(add[area] ?? [])])];
  }
  out.sop = sop === undefined ? items.sop : sop;
  return out;
}

const touchedOf = (desired) => ({
  ...Object.fromEntries(AREAS.filter((a) => desired[a]).map((a) => [a, Object.keys(desired[a])])),
  ...("sop" in desired ? { sop: true } : {}),
});

async function record(tx, state, { kind, summary, desired, before, items, who, now }) {
  const seq = state.registry.seq + 1;
  const entry = { n: seq, at: now.toISOString(), by: who.username, kind, summary, touched: touchedOf(desired), before, registry_before: state.registry.items };
  await writeCustom(tx, state, { categories: nextCategories(state, desired), reports: nextReports(state, desired), items, history: [...state.registry.history, entry], seq });
  return entry;
}

// ---------------------------------------------------------------- describe

export async function describe(tx, { agent = "di-expenses" } = {}, { who, sop } = {}) {
  requireAdmin(who);
  if (!TARGETS[agent]) throw new DiError(`agent must be one of: ${Object.keys(TARGETS).join(", ")}`);
  const state = await readState(tx, sop, agent);
  const items = state.registry.items;
  const departments = (await tx.query("SELECT department, count(*)::int AS people FROM di.company_member WHERE deleted_at IS NULL GROUP BY department ORDER BY department")).rows;
  const unlinked = (await tx.query("SELECT count(DISTINCT lower(claimant_name))::int AS n FROM di.expense_claim WHERE claimant_member_id IS NULL AND deleted_at IS NULL")).rows[0].n;
  return {
    target_agent: agent,
    vocabulary: {
      rule_checks: [
        { check: "custom_field", arg: "expense_claim.<field key>", meaning: "the claim must carry a value for that field" },
        { check: "attachment_kind", arg: "<kind key>", meaning: "at least one attachment of that kind (e.g. route_map)" },
        { check: "amount_at_most", arg: "<number>", meaning: "the claim amount must not exceed this" },
      ],
      rule_shape: "{ id, when?: { category: [category keys] }, check, arg, severity: block|warn, message (max 200 chars, say what to provide) }",
      field_types: FIELD_TYPES,
      limits: { ...LIMITS, reports: REPORT_LIMITS.per_company },
      built_in_categories: EXPENSE_CATEGORIES.map((c) => c.key),
      report: {
        shape: "{ slug, title, where?: { category, status, department, period }, period_basis, group_by, measures, include_members?, detail?, sort?, audience }",
        group_by: `up to ${REPORT_LIMITS.group_by} of ${GROUPS.join(", ")}`,
        measures: `up to ${REPORT_LIMITS.measures}, each { key, label?, fn: ${FNS.join("|")}, field: amount | tax_amount | custom.<number field key> }; count needs no field`,
        period: "where.period is current | previous | YYYY-MM | all. period_basis submission = the monthly claim cycle (default), expense_date = the calendar month of the expense. Ask which the company means.",
        audience: "admin = admins only (default); scoped = anyone, but each person sees only their own claims",
        include_members: "with group_by [employee] only: also lists people who have no claims",
        departments: "where.department matches a company person's department exactly (see facts.departments)",
      },
      cannot_do: [
        "new tables or columns, roles, permissions or tools",
        "change a built-in category",
        "read what is inside an image: the Expenses Clerk reads it and records the value (for example distance_km)",
        "a report on anything but expense claims, or a custom page layout",
      ],
    },
    current: {
      categories: state.categories.map((c) => ({ ...c, managed: items.categories.includes(c.key) })),
      custom_fields: state.fields.map((f) => ({ ...f, managed: items.fields.includes(f.key) })),
      rules: state.rules.map((r) => ({ ...r, managed: items.rules.includes(r.id) })),
      reports: state.reports.map((r) => ({ ...r, managed: items.reports.includes(r.slug) })),
      sop_block: state.block,
      managed: items,
      history: state.registry.history.map((h) => ({ n: h.n, at: h.at, by: h.by, kind: h.kind, summary: h.summary, undone: Boolean(h.undone) })),
    },
    facts: { departments, claimants_not_linked_to_a_company_person: unlinked },
  };
}

// ---------------------------------------------------------------- apply

/** Open claims that would fail the proposed rules, so the admin sees the effect before saying yes. */
async function impactOnOpenClaims(tx, rules) {
  const claims = (await tx.query(
    `SELECT c.id, c.number, c.category, c.amount, c.custom FROM di.expense_claim c JOIN di.expense_batch b ON b.id = c.batch_id
      WHERE c.deleted_at IS NULL AND c.status = 'submitted' AND b.status = 'open' ORDER BY c.number LIMIT 500`,
  )).rows;
  if (!claims.length) return { checked: 0, failing: 0, numbers: [] };
  const kinds = (await tx.query(
    "SELECT claim_id, coalesce(extracted->>'kind', $2) AS kind FROM di.expense_receipt WHERE claim_id = ANY($1::uuid[]) AND deleted_at IS NULL",
    [claims.map((c) => c.id), DEFAULT_KIND],
  )).rows;
  const failing = claims.filter((c) =>
    evaluate(rules, { claim: { category: c.category, amount: Number(c.amount), custom: c.custom ?? {} }, receipts: kinds.filter((k) => k.claim_id === c.id) }).blockers.length);
  return { checked: claims.length, failing: failing.length, numbers: failing.slice(0, 10).map((c) => c.number) };
}

const describeRule = (r) => `${r.id} (${r.severity}${r.when?.category ? `, ${r.when.category.join("/")} only` : ""}): ${r.check} ${r.arg} — "${r.message}"`;

/** Dry run without `fingerprint`; applies with the fingerprint the dry run returned. */
export async function apply(tx, { changeset, fingerprint } = {}, { who, sop, now = new Date() } = {}) {
  requireAdmin(who);
  const cs = normaliseChangeset(changeset);
  await lockTenant(tx);
  const state = await readState(tx, sop, cs.target_agent);
  const items = state.registry.items;

  // What the policy would look like afterwards, to cross-check references and run the examples.
  const desired = {};
  const diff = [];
  const add = { categories: [], fields: [], rules: [], reports: [] };
  if (cs.categories) {
    desired.categories = {};
    for (const c of cs.categories) {
      const old = valueOf(state, "categories", c.key);
      if (old && !items.categories.includes(c.key)) throw new DiError(`Category "${c.key}" exists but was not created by the Forward Deploy Engineer`);
      if (old && old.label === c.label) continue;
      desired.categories[c.key] = c;
      add.categories.push(c.key);
      diff.push(`${old ? "~" : "+"} category ${c.key}: "${c.label}"`);
    }
    if (!Object.keys(desired.categories).length) delete desired.categories;
  }
  if (cs.custom_fields) {
    desired.fields = {};
    for (const f of cs.custom_fields) {
      const old = valueOf(state, "fields", f.key);
      if (old && !items.fields.includes(f.key)) throw new DiError(`Field "${f.key}" exists but was not created by the Forward Deploy Engineer`);
      if (old && old.type !== f.type) throw new DiError(`Field ${f.key} already exists as ${old.type}; changing its type would break stored values. Pick a new key.`);
      const same = old && old.label === f.label && (old.help ?? null) === (f.help ?? null) && canonical(old.options ?? []) === canonical(f.options);
      if (same) continue;
      desired.fields[f.key] = f;
      add.fields.push(f.key);
      diff.push(`${old ? "~" : "+"} field ${f.key} (${f.type}): "${f.label}"`);
    }
    if (!Object.keys(desired.fields).length) delete desired.fields;
  }
  if (cs.rules) {
    desired.rules = {};
    for (const r of cs.rules) {
      const old = valueOf(state, "rules", r.id);
      if (old && !items.rules.includes(r.id)) throw new DiError(`Rule "${r.id}" exists but was not created by the Forward Deploy Engineer`);
      if (old && canonical(old) === canonical(r)) continue;
      desired.rules[r.id] = r;
      add.rules.push(r.id);
      diff.push(`${old ? "~" : "+"} rule ${describeRule(r)}`);
    }
    if (!Object.keys(desired.rules).length) delete desired.rules;
  }
  if (cs.reports) {
    desired.reports = {};
    for (const r of cs.reports) {
      const old = valueOf(state, "reports", r.slug);
      if (old && !items.reports.includes(r.slug)) throw new DiError(`Report "${r.slug}" exists but was not created by the Forward Deploy Engineer`);
      if (old && canonical(old) === canonical(r)) continue;
      desired.reports[r.slug] = r;
      add.reports.push(r.slug);
      diff.push(`${old ? "~" : "+"} report ${r.slug}: "${r.title}" (${r.audience === "admin" ? "admins only" : "everyone sees their own claims"}${r.group_by.length ? `, by ${r.group_by.join(" and ")}` : ""})`);
    }
    if (!Object.keys(desired.reports).length) delete desired.reports;
  }
  if (cs.sop && cs.sop.markdown !== state.block) {
    desired.sop = cs.sop.markdown;
    diff.push(`${state.block ? "~" : "+"} SOP block for ${cs.target_agent} (${cs.sop.markdown.length} characters)`);
  }
  if (!diff.length) return { dry_run: !fingerprint, no_change: true, message: "Everything in this change is already in place." };

  const afterCategories = mergeCategories(EXPENSE_CATEGORIES, { custom: { categories: nextCategories(state, desired) ?? state.categories } });
  const afterFieldKeys = [...new Set([...state.fields.map((f) => f.key), ...Object.keys(desired.fields ?? {})])];
  const afterRules = [...state.rules];
  for (const [id, value] of Object.entries(desired.rules ?? {})) {
    const at = afterRules.findIndex((r) => r.id === id);
    if (at >= 0) afterRules[at] = value;
    else afterRules.push(value);
  }
  for (const r of afterRules) {
    for (const key of r.when?.category ?? []) if (!afterCategories.some((c) => c.key === key)) throw new DiError(`Rule ${r.id} names category "${key}", which does not exist`);
    if (r.check === "custom_field" && !afterFieldKeys.includes(String(r.arg).split(".")[1])) throw new DiError(`Rule ${r.id} needs field ${r.arg}, which is not defined; add it to custom_fields`);
  }
  const examples = runExamples(cs.examples, { rules: afterRules, fieldKeys: afterFieldKeys, categoryKeys: afterCategories.map((c) => c.key) });
  const impact = { examples, open_claims: await impactOnOpenClaims(tx, afterRules) };

  // Reports may only name categories and number fields that will exist; each is tried on today's data.
  if (desired.reports) {
    const numberFields = [...state.fields.filter((f) => f.type === "number").map((f) => f.key), ...Object.values(desired.fields ?? {}).filter((f) => f.type === "number").map((f) => f.key)];
    const refs = { categories: afterCategories.map((c) => c.key), numberFields };
    nextReports(state, desired);
    impact.reports = [];
    for (const spec of Object.values(desired.reports)) {
      normaliseReportSpec(spec, refs);
      try {
        const run = await executeReport(tx, spec, { who, now });
        impact.reports.push({ slug: spec.slug, claims_covered: run.row_count, rows: run.rows.slice(0, 5), totals: run.totals });
      } catch (error) {
        if (!(error instanceof DiError)) throw error;
        impact.reports.push({ slug: spec.slug, note: error.message });
      }
    }
  }
  const fp = sha({ op: "apply", cs, digest: state.digest });

  if (!fingerprint) {
    return {
      dry_run: true, valid: examples.every((e) => e.pass), diff, impact, fingerprint: fp,
      ...(cs.notes_for_engineering ? { needs_engineering: cs.notes_for_engineering } : {}),
      next: "Show the admin this diff and the examples in plain words. Apply only after they say yes: call fde_apply again with the same changeset and this fingerprint.",
    };
  }
  if (fingerprint !== fp) throw new DiError("The company's rules changed since the preview, or the change is different. Preview it again.", { code: "conflict" });
  if (!examples.every((e) => e.pass)) throw new DiError("The examples do not behave as expected, so this change is not applied. Fix the rules or the examples and preview again.");

  const before = await applyDesired(tx, state, desired, { target: cs.target_agent, who, sop });
  const entry = await record(tx, state, {
    kind: "apply", summary: cs.summary, desired, before, who, now,
    items: nextItems(items, { add, sop: "sop" in desired ? true : undefined }),
  });
  return { applied: true, change: entry.n, summary: cs.summary, changed: diff, ...(desired.sop !== undefined ? { sop: "saved" } : {}), undo: "fde_revert with scope last undoes this change." };
}

// ---------------------------------------------------------------- revert

/** Items the registry lists, as { area, key } pairs. */
const listed = (items) => [
  ...AREAS.flatMap((area) => (items[area] ?? []).map((key) => ({ area, key }))),
  ...(items.sop ? [{ area: "sop", key: "" }] : []),
];

const AREA_OF = { category: "categories", field: "fields", rule: "rules", report: "reports", sop: "sop" };

/**
 * Undo the last change, remove one item the FDE created, or reset everything it created to the defaults.
 * Dry run without `fingerprint`, like apply. Claims already filed are never changed.
 */
export async function revert(tx, { scope, kind, key, fingerprint, agent = "di-expenses" } = {}, { who, sop, now = new Date() } = {}) {
  requireAdmin(who);
  if (!["last", "item", "all"].includes(scope)) throw new DiError("scope must be last, item or all");
  if (!TARGETS[agent]) throw new DiError(`agent must be one of: ${Object.keys(TARGETS).join(", ")}`);
  await lockTenant(tx);
  const state = await readState(tx, sop, agent);
  const items = state.registry.items;
  const desired = {};
  const diff = [];
  let nextRegistry;
  let label;
  let entryKind;
  let restoreEntry = null;

  const remove = (pairs) => {
    for (const { area, key: k } of pairs) {
      if (area === "sop") {
        desired.sop = null;
        diff.push("- SOP block (your own SOP text is kept)");
      } else {
        (desired[area] ??= {})[k] = null;
        diff.push(`- ${SINGULAR[area]} ${k}`);
      }
    }
    const rm = Object.fromEntries(AREAS.map((a) => [a, pairs.filter((p) => p.area === a).map((p) => p.key)]));
    nextRegistry = nextItems(items, { remove: rm, sop: pairs.some((p) => p.area === "sop") ? false : undefined });
  };

  if (scope === "last") {
    restoreEntry = [...state.registry.history].reverse().find((h) => !h.undone);
    if (!restoreEntry) throw new DiError("There is no change to undo.");
    for (const area of AREAS) {
      for (const k of restoreEntry.touched?.[area] ?? []) {
        (desired[area] ??= {})[k] = restoreEntry.before?.[area]?.[k] ?? null;
        diff.push(`${restoreEntry.before?.[area]?.[k] ? "~ restore" : "- remove"} ${SINGULAR[area]} ${k}`);
      }
    }
    if (restoreEntry.touched?.sop) {
      desired.sop = restoreEntry.before?.sop ?? null;
      diff.push(restoreEntry.before?.sop ? "~ restore the earlier SOP block" : "- remove the SOP block");
    }
    nextRegistry = restoreEntry.registry_before ?? items;
    label = `Undo change ${restoreEntry.n}: ${restoreEntry.summary}`;
  } else if (scope === "item") {
    const area = AREA_OF[kind];
    if (!area) throw new DiError("kind must be category, field, rule, report or sop");
    const k = area === "sop" ? "" : String(key ?? "").trim();
    if (!listed(items).some((p) => p.area === area && p.key === k)) throw new DiError(`${kind}${k ? ` "${k}"` : ""} was not created by the Forward Deploy Engineer, so it cannot be removed here`);
    remove([{ area, key: k }]);
    label = `Remove ${kind}${k ? ` ${k}` : ""}`;
    entryKind = "remove";
  } else {
    const pairs = listed(items);
    if (!pairs.length) return { dry_run: !fingerprint, no_change: true, message: "Nothing to reset: the company is already on the default rules." };
    remove(pairs);
    label = "Reset to default";
    entryKind = "reset";
  }

  const fp = sha({ op: "revert", scope, kind: kind ?? null, key: key ?? null, digest: state.digest });
  if (!fingerprint) {
    return { dry_run: true, valid: true, diff, fingerprint: fp, note: "Claims already filed are not changed; values stored on them stay.", next: "Show the admin what will be removed. Apply only after they say yes: call fde_revert again with the same arguments and this fingerprint." };
  }
  if (fingerprint !== fp) throw new DiError("The company's rules changed since the preview. Preview it again.", { code: "conflict" });

  const before = await applyDesired(tx, state, desired, { target: agent, who, sop });
  if (scope === "last") {
    // The undone change stays in the list, marked, so the next undo goes one step further back.
    const history = state.registry.history.map((h) => (h.n === restoreEntry.n ? { ...h, undone: true } : h));
    await writeCustom(tx, state, { categories: nextCategories(state, desired), reports: nextReports(state, desired), items: nextRegistry, history, seq: state.registry.seq });
  } else {
    await record(tx, state, { kind: entryKind, summary: label, desired, before, who, now, items: nextRegistry });
  }
  return { reverted: true, summary: label, changed: diff };
}
