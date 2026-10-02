// Expense claims and monthly submissions.
//
// A claim is one expense with its receipts. Claims are grouped into a monthly submission
// (di.expense_batch) by the day they were FILED: with a cut-off of 10, everything filed from
// the 11th of one month to the 10th of the next belongs to the later month's submission.
// A closed submission is frozen by trigger (sql/006); the checks here give readable errors.
//
// Every handler takes (tx, args, { who, receipts, now }). `who` is the signed-in host user
// ({ id, username, display_name, role, email? }); the host supplies it, never the model.
import { DiError, addDays, isUuid, isoDate, nextNumber, round2, todayMY, validateCustom } from "./common.mjs";
import {
  DEFAULT_KIND, availableReports, blockedMessage, checkClaim, issueMessages, loadPolicy, mergeCategories, policySummary, visibleCustom, withKinds,
} from "./expense-policy.mjs";

export const EXPENSE_CATEGORIES = [
  { key: "meals", label: "Meals" },
  { key: "transport", label: "Transport (taxi, parking, toll, fuel)" },
  { key: "travel", label: "Travel (flights, trains)" },
  { key: "accommodation", label: "Accommodation" },
  { key: "office", label: "Office supplies" },
  { key: "communication", label: "Phone & internet" },
  { key: "entertainment", label: "Client entertainment" },
  { key: "training", label: "Training & seminars" },
  { key: "medical", label: "Medical" },
  { key: "courier", label: "Postage & courier" },
  { key: "other", label: "Other" },
];
export const PAYMENT_METHODS = ["cash", "personal_card", "company_card", "bank_transfer", "e_wallet", "other"];
export const MAX_RECEIPTS = 5;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n) => String(n).padStart(2, "0");
const num = (v) => Number(v) || 0;
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(String(s));
export const isAdmin = (who) => who?.role === "admin";

// ---------------------------------------------------------------- cut-off arithmetic (pure)

export function addMonths(periodKey, n) {
  const [y, m] = periodKey.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** The submission whose cut-off month is `periodKey` ("2026-10" with cut-off 10 -> 11 Sep..10 Oct). */
export function cycleOf(periodKey, cutoffDay) {
  return {
    period_key: periodKey,
    period_start: addDays(`${addMonths(periodKey, -1)}-${pad(cutoffDay)}`, 1),
    cutoff_date: `${periodKey}-${pad(cutoffDay)}`,
  };
}

/** The submission a claim filed on `dateISO` belongs to. */
export function cycleFor(dateISO, cutoffDay) {
  const [y, m, d] = dateISO.split("-").map(Number);
  return cycleOf(d <= cutoffDay ? `${y}-${pad(m)}` : addMonths(`${y}-${pad(m)}`, 1), cutoffDay);
}

export function batchLabel(batchOrKey) {
  const key = typeof batchOrKey === "string" ? batchOrKey : batchOrKey.period_key;
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y} submission`;
}

const daysBetween = (fromISO, toISO) => Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------- who

export function requireWho(who) {
  if (!who?.id) {
    throw new DiError("Sign-in required: expense tools need an authenticated session owner. Please sign in before using Expenses Clerk.");
  }
  return who;
}

async function memberFor(tx, who) {
  const byUser = (await tx.query("SELECT id, name, email FROM di.company_member WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1", [who.id])).rows[0];
  if (byUser) return byUser;
  if (who.email) {
    return (await tx.query("SELECT id, name, email FROM di.company_member WHERE lower(email) = lower($1) AND deleted_at IS NULL LIMIT 1", [who.email])).rows[0] ?? null;
  }
  return null;
}

async function resolveClaimant(tx, who, claimant) {
  if (!claimant) {
    const member = await memberFor(tx, who);
    return { user_id: who.id, member_id: member?.id ?? null, name: member?.name || who.display_name || who.username, email: member?.email || who.email || null };
  }
  const q = String(claimant).trim();
  if (!isAdmin(who)) {
    const self = [who.username, who.display_name, who.email].filter(Boolean).map((v) => String(v).toLowerCase());
    if (self.includes(q.toLowerCase())) return resolveClaimant(tx, who, null);
    throw new DiError("Only an admin can file a claim for someone else. Leave claimant empty to file your own.");
  }
  let rows;
  if (isUuid(q)) rows = (await tx.query("SELECT id, name, email, user_id FROM di.company_member WHERE id = $1 AND deleted_at IS NULL", [q])).rows;
  else {
    rows = (await tx.query("SELECT id, name, email, user_id FROM di.company_member WHERE deleted_at IS NULL AND (lower(email) = lower($1) OR lower(name) = lower($1))", [q])).rows;
    if (!rows.length) {
      const like = `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
      rows = (await tx.query("SELECT id, name, email, user_id FROM di.company_member WHERE deleted_at IS NULL AND lower(name) LIKE $1 ORDER BY name LIMIT 6", [like])).rows;
    }
  }
  if (!rows.length) throw new DiError(`No company person matches "${q}". Check the name with list_company_members, or add the person first (Company Onboarding / DB Manager).`);
  if (rows.length > 1) throw new DiError(`"${q}" matches ${rows.length} people (${rows.map((r) => `${r.name} <${r.email || "no email"}>`).join("; ")}). Use the exact name, email or id.`);
  const m = rows[0];
  return { user_id: m.user_id ?? null, member_id: m.id, name: m.name, email: m.email };
}

/** SQL fragment limiting claims (alias c) to what `who` may see, plus an optional claimant filter. */
export function scopeClause(who, claimant, startAt) {
  const parts = [];
  const values = [];
  const next = (v) => { values.push(v); return `$${startAt + values.length - 1}`; };
  if (!isAdmin(who)) {
    if (claimant) throw new DiError("Regular users only see their own claims.");
    parts.push(`c.claimant_user_id = ${next(who.id)}`);
  } else if (claimant) {
    const q = String(claimant).trim();
    if (isUuid(q)) {
      const p = next(q);
      parts.push(`(c.claimant_member_id = ${p}::uuid OR c.claimant_user_id = ${p}::text)`);
    } else {
      const p = next(`%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
      parts.push(`(lower(c.claimant_name) LIKE ${p} OR lower(coalesce(c.claimant_email, '')) LIKE ${p})`);
    }
  }
  return { sql: parts.length ? ` AND ${parts.join(" AND ")}` : "", values };
}

// ---------------------------------------------------------------- settings and submissions

export async function getSettings(tx) {
  const read = async () => (await tx.query("SELECT * FROM di.expense_setting WHERE deleted_at IS NULL")).rows[0];
  let row = await read();
  if (!row) {
    await tx.query(
      `INSERT INTO di.expense_setting (currency)
       VALUES (coalesce((SELECT currency FROM di.company_profile WHERE tenant_id = di.current_tenant()), 'MYR'))
       ON CONFLICT (tenant_id) DO NOTHING`,
    );
    row = await read();
  }
  return { ...row, cutoff_day: Number(row.cutoff_day), max_claim_age_days: Number(row.max_claim_age_days) };
}

async function ensureBatch(tx, periodKey, cutoffDay) {
  const c = cycleOf(periodKey, cutoffDay);
  await tx.query(
    `INSERT INTO di.expense_batch (period_key, period_start, cutoff_date) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, period_key) WHERE deleted_at IS NULL DO NOTHING`,
    [c.period_key, c.period_start, c.cutoff_date],
  );
  return (await tx.query("SELECT * FROM di.expense_batch WHERE period_key = $1 AND deleted_at IS NULL", [periodKey])).rows[0];
}

/** The open submission a claim filed on `dateISO` goes to; a closed month rolls to the next. */
async function openBatchFor(tx, dateISO, settings) {
  let key = cycleFor(dateISO, settings.cutoff_day).period_key;
  for (let i = 0; i < 36; i++) {
    const batch = await ensureBatch(tx, key, settings.cutoff_day);
    if (batch.status === "open") return batch;
    key = addMonths(key, 1);
  }
  throw new DiError("No open monthly submission could be found");
}

const filedOn = (ts) => todayMY(ts instanceof Date ? ts : new Date(ts));
const CUSTOM_DEFINER = "an admin (the Forward Deploy Engineer agent adds claim fields)";

function shapeBatch(b) {
  return {
    id: b.id, period_key: b.period_key, label: batchLabel(b), status: b.status,
    period_start: isoDate(b.period_start), cutoff_date: isoDate(b.cutoff_date),
    closed_at: b.closed_at ? new Date(b.closed_at).toISOString() : null, closed_by: b.closed_by ?? null,
    report_path: b.report_path ?? null,
  };
}

async function batchByMonth(tx, month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) throw new DiError("month must look like 2026-10");
  return (await tx.query("SELECT * FROM di.expense_batch WHERE period_key = $1 AND deleted_at IS NULL", [month])).rows[0] ?? null;
}

export async function getExpenseSettings(tx, _args, { who, now = new Date() } = {}) {
  requireWho(who);
  const settings = await getSettings(tx);
  const today = todayMY(now);
  const cycle = cycleFor(today, settings.cutoff_day);
  const existing = (await tx.query("SELECT * FROM di.expense_batch WHERE period_key = $1 AND deleted_at IS NULL", [cycle.period_key])).rows[0];
  const member = await memberFor(tx, who);
  return {
    me: { username: who.username, name: member?.name || who.display_name || who.username, role: who.role, company_person: member ? { id: member.id, name: member.name } : null },
    settings: { cutoff_day: settings.cutoff_day, currency: settings.currency, receipt_required: settings.receipt_required, max_claim_age_days: settings.max_claim_age_days },
    categories: mergeCategories(EXPENSE_CATEGORIES, settings),
    policy: policySummary(await loadPolicy(tx)),
    reports: availableReports(settings, who),
    payment_methods: PAYMENT_METHODS,
    max_receipts_per_claim: MAX_RECEIPTS,
    current_submission: {
      ...cycle, label: batchLabel(cycle.period_key), status: existing?.status ?? "open",
      days_left: daysBetween(today, cycle.cutoff_date), exists: Boolean(existing),
    },
    today,
  };
}

export async function setExpenseSettings(tx, input = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  if (!isAdmin(who)) throw new DiError("Only an admin can change expense settings.");
  const current = await getSettings(tx);
  const patch = {};
  if (input.cutoff_day !== undefined) {
    if (!Number.isInteger(input.cutoff_day) || input.cutoff_day < 1 || input.cutoff_day > 28) throw new DiError("cutoff_day must be a whole day from 1 to 28");
    patch.cutoff_day = input.cutoff_day;
  }
  if (input.currency !== undefined) {
    if (!/^[A-Za-z]{3}$/.test(input.currency)) throw new DiError("currency must be a 3-letter code such as MYR");
    patch.currency = input.currency.toUpperCase();
  }
  if (input.receipt_required !== undefined) patch.receipt_required = Boolean(input.receipt_required);
  if (input.max_claim_age_days !== undefined) {
    if (!Number.isInteger(input.max_claim_age_days) || input.max_claim_age_days < 1 || input.max_claim_age_days > 3650) throw new DiError("max_claim_age_days must be 1-3650");
    patch.max_claim_age_days = input.max_claim_age_days;
  }
  if (!Object.keys(patch).length) throw new DiError("Give at least one setting to change");
  const cols = Object.keys(patch);
  await tx.query(`UPDATE di.expense_setting SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1}`, [...cols.map((c) => patch[c]), current.id]);
  const settings = await getSettings(tx);

  let moved = 0;
  if (patch.cutoff_day !== undefined && patch.cutoff_day !== current.cutoff_day) {
    const openBatches = (await tx.query("SELECT id, period_key FROM di.expense_batch WHERE status = 'open' AND deleted_at IS NULL")).rows;
    for (const b of openBatches) {
      const c = cycleOf(b.period_key, settings.cutoff_day);
      await tx.query("UPDATE di.expense_batch SET period_start = $1, cutoff_date = $2 WHERE id = $3", [c.period_start, c.cutoff_date, b.id]);
    }
    const claims = (await tx.query(
      `SELECT c.id, c.submitted_at, c.batch_id FROM di.expense_claim c
        WHERE c.deleted_at IS NULL AND c.batch_id IN (SELECT id FROM di.expense_batch WHERE status = 'open' AND deleted_at IS NULL)
        ORDER BY c.submitted_at`,
    )).rows;
    for (const claim of claims) {
      const target = await openBatchFor(tx, filedOn(claim.submitted_at), settings);
      if (target.id !== claim.batch_id) {
        await tx.query("UPDATE di.expense_claim SET batch_id = $1 WHERE id = $2", [target.id, claim.id]);
        moved++;
      }
    }
    await tx.query(
      `UPDATE di.expense_batch b SET deleted_at = now()
        WHERE b.status = 'open' AND b.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM di.expense_claim c WHERE c.batch_id = b.id AND c.deleted_at IS NULL)`,
    );
  }
  const today = todayMY(now);
  const cycle = cycleFor(today, settings.cutoff_day);
  return {
    settings: { cutoff_day: settings.cutoff_day, currency: settings.currency, receipt_required: settings.receipt_required, max_claim_age_days: settings.max_claim_age_days },
    claims_moved_between_open_submissions: moved,
    current_submission: { ...cycle, label: batchLabel(cycle.period_key), days_left: daysBetween(today, cycle.cutoff_date) },
  };
}

// ---------------------------------------------------------------- shaping

async function receiptsFor(tx, claimIds) {
  if (!claimIds.length) return new Map();
  const { rows } = await tx.query(
    "SELECT id, claim_id, name, mime, bytes, sha256, file_path, extracted FROM di.expense_receipt WHERE claim_id = ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY created_at, name",
    [claimIds],
  );
  const map = new Map();
  for (const r of rows) {
    const list = map.get(r.claim_id) ?? [];
    list.push({ id: r.id, name: r.name, mime: r.mime, bytes: Number(r.bytes), sha256: r.sha256, path: r.file_path, kind: r.extracted?.kind || DEFAULT_KIND });
    map.set(r.claim_id, list);
  }
  return map;
}

function shapeClaim(row, receipts = [], batch = null) {
  return {
    id: row.id, number: row.number, status: row.status,
    claimant: { name: row.claimant_name, email: row.claimant_email ?? null, user_id: row.claimant_user_id ?? null, member_id: row.claimant_member_id ?? null },
    expense_date: isoDate(row.expense_date), merchant: row.merchant, category: row.category,
    description: row.description ?? null, currency: row.currency, amount: num(row.amount),
    tax_amount: row.tax_amount == null ? null : num(row.tax_amount), payment_method: row.payment_method ?? null,
    no_receipt_reason: row.no_receipt_reason ?? null, custom: visibleCustom(row.custom),
    submitted_at: new Date(row.submitted_at).toISOString(),
    reviewed_by: row.reviewed_by ?? null, reviewed_at: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null, review_note: row.review_note ?? null,
    submission: batch ? { period_key: batch.period_key, label: batchLabel(batch), status: batch.status } : null,
    receipts,
  };
}

async function findClaim(tx, ref, who, { lock = false } = {}) {
  const q = String(ref ?? "").trim();
  if (!q) throw new DiError("Give the claim number (EXP-2026-0001) or id");
  const scope = scopeClause(who, null, 2);
  const where = isUuid(q) ? "c.id = $1::uuid" : "upper(c.number) = upper($1)";
  const row = (await tx.query(
    `SELECT c.* FROM di.expense_claim c WHERE ${where} AND c.deleted_at IS NULL${scope.sql}${lock ? " FOR UPDATE" : ""}`,
    [q, ...scope.values],
  )).rows[0];
  if (!row) throw new DiError(`Claim ${q} not found`); // same answer for "not yours": never reveal other people's claims
  const batch = row.batch_id ? (await tx.query("SELECT * FROM di.expense_batch WHERE id = $1", [row.batch_id])).rows[0] : null;
  return { row, batch };
}

// ---------------------------------------------------------------- field checks

function cleanText(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) throw new DiError(`${label} is required`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) throw new DiError(`${label} is too long (max ${max} characters)`);
  return s;
}

function normaliseCategory(value, categories = EXPENSE_CATEGORIES) {
  const q = String(value || "").trim().toLowerCase();
  const hit = categories.find((c) => c.key === q || c.label.toLowerCase() === q);
  if (!hit) throw new DiError(`category must be one of: ${categories.map((c) => c.key).join(", ")}`);
  return hit.key;
}

function cleanAmount(value, label = "amount") {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new DiError(`${label} must be a positive number (the total on the receipt)`);
  if (n > 1_000_000) throw new DiError(`${label} is too large for a single claim`);
  return round2(n);
}

function checkFields(input, settings, today, { partial = false } = {}) {
  const out = {};
  const has = (k) => input[k] !== undefined && input[k] !== null && input[k] !== "";
  if (!partial || has("expense_date")) {
    if (!has("expense_date") || !isDate(input.expense_date)) throw new DiError("expense_date must be the date on the receipt, as YYYY-MM-DD");
    if (input.expense_date > today) throw new DiError(`expense_date ${input.expense_date} is in the future (today is ${today})`);
    out.expense_date = input.expense_date;
  }
  if (!partial || has("merchant")) out.merchant = cleanText(input.merchant, "merchant", 120, { required: true });
  if (!partial || has("category")) out.category = normaliseCategory(input.category, mergeCategories(EXPENSE_CATEGORIES, settings));
  if (has("description")) out.description = cleanText(input.description, "description", 500);
  if (!partial || has("amount")) out.amount = cleanAmount(input.amount);
  if (has("tax_amount")) {
    const t = Number(input.tax_amount);
    if (!Number.isFinite(t) || t < 0) throw new DiError("tax_amount must be zero or more");
    out.tax_amount = round2(t);
    if (out.amount !== undefined && out.tax_amount > out.amount) throw new DiError("tax_amount cannot exceed the claim amount");
  }
  if (has("payment_method")) {
    if (!PAYMENT_METHODS.includes(input.payment_method)) throw new DiError(`payment_method must be one of: ${PAYMENT_METHODS.join(", ")}`);
    out.payment_method = input.payment_method;
  }
  if (has("currency") && String(input.currency).toUpperCase() !== settings.currency) {
    throw new DiError(`Claims are in ${settings.currency}. Convert ${String(input.currency).toUpperCase()} to ${settings.currency} and note the original amount in the description.`);
  }
  if (has("no_receipt_reason")) out.no_receipt_reason = cleanText(input.no_receipt_reason, "no_receipt_reason", 300);
  return out;
}

async function findDuplicates(tx, { receipts, claimant, fields, excludeClaimId = null }) {
  // Only real receipts count: a route screenshot or other supporting file may legitimately be reused.
  const sha = receipts.filter((r) => (r.kind || DEFAULT_KIND) === DEFAULT_KIND).map((r) => r.sha256);
  if (sha.length) {
    const hit = (await tx.query(
      `SELECT c.number, c.claimant_name FROM di.expense_receipt r JOIN di.expense_claim c ON c.id = r.claim_id
        WHERE r.sha256 = ANY($1::text[]) AND coalesce(r.extracted->>'kind', '${DEFAULT_KIND}') = '${DEFAULT_KIND}'
          AND r.deleted_at IS NULL AND c.deleted_at IS NULL AND c.status <> 'withdrawn'
          AND ($2::uuid IS NULL OR c.id <> $2::uuid) LIMIT 1`,
      [sha, excludeClaimId],
    )).rows[0];
    if (hit) return `This receipt file is already attached to ${hit.number} (${hit.claimant_name})`;
  }
  if (fields.expense_date && fields.amount !== undefined && fields.merchant) {
    const hit = (await tx.query(
      `SELECT number FROM di.expense_claim
        WHERE deleted_at IS NULL AND status <> 'withdrawn' AND expense_date = $1 AND amount = $2 AND lower(merchant) = lower($3)
          AND (claimant_user_id IS NOT DISTINCT FROM $4 AND ($4::text IS NOT NULL OR lower(claimant_name) = lower($5)))
          AND ($6::uuid IS NULL OR id <> $6::uuid) LIMIT 1`,
      [fields.expense_date, fields.amount, fields.merchant, claimant.user_id, claimant.name, excludeClaimId],
    )).rows[0];
    if (hit) return `${hit.number} has the same claimant, date, merchant and amount`;
  }
  return null;
}

async function insertReceipts(tx, claimId, receipts) {
  for (const r of receipts) {
    await tx.query(
      `INSERT INTO di.expense_receipt (claim_id, file_path, name, mime, bytes, sha256, extracted) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [claimId, r.path, r.name, r.mime, r.bytes, r.sha256, JSON.stringify({ ...(r.extracted ?? {}), ...(r.kind && r.kind !== DEFAULT_KIND ? { kind: r.kind } : {}) })],
    );
  }
}

/** One copy per file; when the same file is listed twice the first entry (and its kind) wins. */
const uniqueBySha = (receipts) => {
  const seen = new Map();
  for (const r of receipts) if (!seen.has(r.sha256)) seen.set(r.sha256, r);
  return [...seen.values()];
};

// ---------------------------------------------------------------- claims

export async function fileClaim(tx, input = {}, { who, receipts = [], now = new Date(), claimant: preset } = {}) {
  requireWho(who);
  const settings = await getSettings(tx);
  const today = todayMY(now);
  const fields = checkFields(input, settings, today);
  // `preset` is host-only (the /demo seed): tools never pass it, so a model can't name an arbitrary claimant.
  const claimant = preset ?? await resolveClaimant(tx, who, input.claimant);
  const policy = await loadPolicy(tx);
  const files = uniqueBySha(withKinds(policy, receipts, input.receipt_kinds));
  const warnings = [];
  if (!files.length) {
    if (settings.receipt_required && !fields.no_receipt_reason) {
      throw new DiError("Attach the receipt (receipts: [\"_inbox/...\"]), or give no_receipt_reason if there really is none.");
    }
    warnings.push("No receipt attached" + (fields.no_receipt_reason ? `: ${fields.no_receipt_reason}` : ""));
  }
  if (files.length < receipts.length) warnings.push("The same receipt file was attached more than once; kept one copy");
  if (daysBetween(fields.expense_date, today) > settings.max_claim_age_days) {
    warnings.push(`Expense is ${daysBetween(fields.expense_date, today)} days old; the policy window is ${settings.max_claim_age_days} days, so a reviewer may reject it`);
  }
  // The company's own rules (extra fields, required attachments, limits). `preset` is the host-only demo seed.
  const custom = preset ? (input.custom ?? {}) : await validateCustom(tx, "expense_claim", input.custom, { creating: true, definer: CUSTOM_DEFINER });
  if (!preset) {
    const verdict = checkClaim(policy, { category: fields.category, amount: fields.amount, custom }, files);
    if (verdict.blockers.length) throw new DiError(blockedMessage(verdict));
    warnings.push(...verdict.warnings.map((w) => w.message));
  }
  const duplicate = await findDuplicates(tx, { receipts: files, claimant, fields });
  if (duplicate && !input.allow_duplicate) {
    throw new DiError(`Possible duplicate: ${duplicate}. File it again with allow_duplicate=true only if the user confirms it is a separate expense.`);
  }
  if (duplicate) warnings.push(`Filed despite a possible duplicate: ${duplicate}`);

  const number = await nextNumber(tx, "expense_claim", today);
  const batch = await openBatchFor(tx, today, settings);
  const row = (await tx.query(
    `INSERT INTO di.expense_claim
       (number, batch_id, claimant_user_id, claimant_member_id, claimant_name, claimant_email, expense_date, merchant, category,
        description, currency, amount, tax_amount, payment_method, no_receipt_reason, submitted_at, custom)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [number, batch.id, claimant.user_id, claimant.member_id, claimant.name, claimant.email, fields.expense_date, fields.merchant, fields.category,
      fields.description ?? null, settings.currency, fields.amount, fields.tax_amount ?? null, fields.payment_method ?? null,
      fields.no_receipt_reason ?? null, now.toISOString(), JSON.stringify(custom)],
  )).rows[0];
  await insertReceipts(tx, row.id, files);
  const stored = (await receiptsFor(tx, [row.id])).get(row.id) ?? [];
  return {
    claim: shapeClaim(row, stored, batch),
    submission: { ...shapeBatch(batch), days_left: daysBetween(today, isoDate(batch.cutoff_date)) },
    warnings,
    ...(row.claimant_user_id !== who.id ? { filed_on_behalf_of: claimant.name } : {}),
  };
}

export async function updateClaim(tx, input = {}, { who, receipts = [], now = new Date() } = {}) {
  requireWho(who);
  const { row, batch } = await findClaim(tx, input.claim, who, { lock: true });
  if (batch?.status === "closed") throw new DiError(`${row.number} is in the closed ${batchLabel(batch)} and can't change.`);
  if (row.status !== "submitted") throw new DiError(`${row.number} is ${row.status}; only a pending (submitted) claim can be edited. A reviewer can reject it first, or withdraw it and file a new one.`);
  const settings = await getSettings(tx);
  const policy = await loadPolicy(tx);
  const fields = checkFields(input, settings, todayMY(now), { partial: true });
  const files = uniqueBySha(withKinds(policy, receipts, input.add_receipt_kinds, "add_receipt_kinds"));
  const effectiveTax = fields.tax_amount ?? (row.tax_amount == null ? null : num(row.tax_amount));
  if (effectiveTax != null && effectiveTax > (fields.amount ?? num(row.amount))) throw new DiError("tax_amount cannot exceed the claim amount");
  const merged = { expense_date: fields.expense_date ?? isoDate(row.expense_date), amount: fields.amount ?? num(row.amount), merchant: fields.merchant ?? row.merchant };
  const claimant = { user_id: row.claimant_user_id, name: row.claimant_name };
  const duplicate = await findDuplicates(tx, { receipts: files, claimant, fields: merged, excludeClaimId: row.id });
  if (duplicate && !input.allow_duplicate) throw new DiError(`Possible duplicate: ${duplicate}. Send allow_duplicate=true only if the user confirms.`);
  // Extra field values merge into what the claim already has; the company rules judge the claim as it will be.
  let custom = row.custom ?? {};
  if (input.custom !== undefined) {
    custom = { ...custom, ...(await validateCustom(tx, "expense_claim", input.custom, { definer: CUSTOM_DEFINER })) };
    fields.custom = JSON.stringify(custom);
  }
  const existing = (await receiptsFor(tx, [row.id])).get(row.id) ?? [];
  if (existing.length + files.length > MAX_RECEIPTS) throw new DiError(`A claim can hold at most ${MAX_RECEIPTS} receipts`);
  const verdict = checkClaim(policy, { category: fields.category ?? row.category, amount: fields.amount ?? num(row.amount), custom }, [...existing, ...files]);
  if (verdict.blockers.length) throw new DiError(blockedMessage(verdict));
  const cols = Object.keys(fields);
  if (!cols.length && !files.length) throw new DiError("Nothing to change: give the fields to correct, custom values or add_receipts");
  let updated = row;
  if (cols.length) {
    updated = (await tx.query(`UPDATE di.expense_claim SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1} RETURNING *`, [...cols.map((c) => fields[c]), row.id])).rows[0];
  }
  await insertReceipts(tx, row.id, files);
  const stored = (await receiptsFor(tx, [row.id])).get(row.id) ?? [];
  const warnings = [...verdict.warnings.map((w) => w.message), ...(duplicate ? [`Saved despite a possible duplicate: ${duplicate}`] : [])];
  return { claim: shapeClaim(updated, stored, batch), changed: cols, receipts_added: files.length, ...(warnings.length ? { warnings } : {}) };
}

export async function getClaim(tx, { claim } = {}, { who } = {}) {
  requireWho(who);
  const { row, batch } = await findClaim(tx, claim, who);
  const receipts = (await receiptsFor(tx, [row.id])).get(row.id) ?? [];
  const claimShape = shapeClaim(row, receipts, batch);
  // Read-time check against today's rules: claims filed before a rule existed are flagged, never blocked.
  const verdict = checkClaim(await loadPolicy(tx), { category: claimShape.category, amount: claimShape.amount, custom: claimShape.custom }, receipts);
  return { claim: { ...claimShape, policy_issues: issueMessages(verdict) } };
}

/** Totals for a list of shaped claims; withdrawn claims never count. */
export function totalsOf(claims) {
  const live = claims.filter((c) => c.status !== "withdrawn");
  const sum = (list) => round2(list.reduce((s, c) => s + c.amount, 0));
  return {
    count: live.length,
    claimed: sum(live),
    approved: sum(live.filter((c) => c.status === "approved")),
    pending: sum(live.filter((c) => c.status === "submitted")),
    rejected: sum(live.filter((c) => c.status === "rejected")),
  };
}

/** Where a receipt's stored file is, if `who` may see its claim (used by the /demo file route). */
export async function getReceiptFile(tx, id, { who } = {}) {
  requireWho(who);
  if (!isUuid(id)) throw new DiError("Receipt id is required");
  const scope = scopeClause(who, null, 2);
  const row = (await tx.query(
    `SELECT r.file_path, r.name, r.mime FROM di.expense_receipt r JOIN di.expense_claim c ON c.id = r.claim_id
      WHERE r.id = $1::uuid AND r.deleted_at IS NULL AND c.deleted_at IS NULL${scope.sql}`,
    [id, ...scope.values],
  )).rows[0];
  if (!row) throw new DiError("Receipt not found");
  return { path: row.file_path, name: row.name, mime: row.mime };
}

const SUM_SQL = `
  count(*) FILTER (WHERE c.status <> 'withdrawn')::int AS claims,
  coalesce(sum(c.amount) FILTER (WHERE c.status <> 'withdrawn'), 0) AS claimed,
  coalesce(sum(c.amount) FILTER (WHERE c.status = 'approved'), 0) AS approved,
  coalesce(sum(c.amount) FILTER (WHERE c.status = 'submitted'), 0) AS pending,
  coalesce(sum(c.amount) FILTER (WHERE c.status = 'rejected'), 0) AS rejected,
  count(*) FILTER (WHERE c.status = 'submitted')::int AS pending_count`;
const shapeTotals = (t) => ({
  claims: t.claims, pending_count: t.pending_count,
  claimed: round2(num(t.claimed)), approved: round2(num(t.approved)), pending: round2(num(t.pending)), rejected: round2(num(t.rejected)),
});

export async function listClaims(tx, input = {}, { who } = {}) {
  requireWho(who);
  const { month, status, claimant, category, query } = input;
  const limit = Math.min(Math.max(Number(input.limit) || 50, 1), 50);
  const scope = scopeClause(who, claimant, 1);
  const values = [...scope.values];
  const conds = ["c.deleted_at IS NULL"];
  const arg = (v) => { values.push(v); return `$${values.length}`; };
  if (month && month !== "all") {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new DiError("month must look like 2026-10, or all");
    conds.push(`b.period_key = ${arg(month)}`);
  } else if (!month) conds.push("b.status = 'open'");
  if (status) {
    if (!["submitted", "approved", "rejected", "withdrawn"].includes(status)) throw new DiError("status must be submitted, approved, rejected or withdrawn");
    conds.push(`c.status = ${arg(status)}`);
  }
  if (category) {
    let key;
    try {
      key = normaliseCategory(category, mergeCategories(EXPENSE_CATEGORIES, await getSettings(tx)));
    } catch (error) {
      // A category the company later removed can still be filtered on while claims use it.
      const used = String(category).trim().toLowerCase();
      if (!(await tx.query("SELECT 1 FROM di.expense_claim WHERE category = $1 AND deleted_at IS NULL LIMIT 1", [used])).rows[0]) throw error;
      key = used;
    }
    conds.push(`c.category = ${arg(key)}`);
  }
  if (query) {
    const p = arg(`%${String(query).toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    conds.push(`(lower(c.merchant) LIKE ${p} OR lower(coalesce(c.description, '')) LIKE ${p} OR lower(c.number) LIKE ${p})`);
  }
  const where = `${conds.join(" AND ")}${scope.sql}`;
  const rows = (await tx.query(
    `SELECT c.*, b.period_key, b.status AS batch_status, (SELECT count(*) FROM di.expense_receipt r WHERE r.claim_id = c.id AND r.deleted_at IS NULL)::int AS receipt_count
       FROM di.expense_claim c JOIN di.expense_batch b ON b.id = c.batch_id
      WHERE ${where} ORDER BY c.submitted_at DESC, c.number DESC LIMIT ${limit + 1}`,
    values,
  )).rows;
  const totals = (await tx.query(`SELECT ${SUM_SQL} FROM di.expense_claim c JOIN di.expense_batch b ON b.id = c.batch_id WHERE ${where}`, values)).rows[0];
  return {
    claims: rows.slice(0, limit).map((r) => ({
      id: r.id, number: r.number, status: r.status, claimant: r.claimant_name, expense_date: isoDate(r.expense_date), merchant: r.merchant,
      category: r.category, amount: num(r.amount), currency: r.currency, receipts: r.receipt_count, submission: r.period_key, submission_status: r.batch_status,
    })),
    has_more: rows.length > limit,
    totals: shapeTotals(totals),
    scope: isAdmin(who) ? "all claims" : "your claims only",
  };
}

export async function reviewClaim(tx, { claim, decision, note } = {}, { who } = {}) {
  requireWho(who);
  if (!isAdmin(who)) throw new DiError("Only an admin can approve or reject claims.");
  if (!["approve", "reject"].includes(decision)) throw new DiError("decision must be approve or reject");
  const cleanNote = cleanText(note, "note", 500);
  if (decision === "reject" && !cleanNote) throw new DiError("Give a reason (note) when rejecting a claim so the claimant knows why.");
  const { row, batch } = await findClaim(tx, claim, who, { lock: true });
  if (batch?.status === "closed") throw new DiError(`${row.number} is in the closed ${batchLabel(batch)} and can't change.`);
  if (row.status === "withdrawn") throw new DiError(`${row.number} was withdrawn by the claimant.`);
  const status = decision === "approve" ? "approved" : "rejected";
  const updated = (await tx.query(
    "UPDATE di.expense_claim SET status = $1, reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $4 RETURNING *",
    [status, who.username, cleanNote, row.id],
  )).rows[0];
  const receipts = (await receiptsFor(tx, [row.id])).get(row.id) ?? [];
  return {
    claim: shapeClaim(updated, receipts, batch), previous_status: row.status,
    ...(row.claimant_user_id === who.id ? { warnings: ["You reviewed your own claim."] } : {}),
  };
}

export async function withdrawClaim(tx, { claim, reason } = {}, { who } = {}) {
  requireWho(who);
  const { row, batch } = await findClaim(tx, claim, who, { lock: true });
  if (batch?.status === "closed") throw new DiError(`${row.number} is in the closed ${batchLabel(batch)} and can't change.`);
  if (row.status === "withdrawn") throw new DiError(`${row.number} is already withdrawn.`);
  if (row.status === "approved") throw new DiError(`${row.number} is already approved; ask an admin to reject it first.`);
  const updated = (await tx.query(
    "UPDATE di.expense_claim SET status = 'withdrawn', custom = custom || $1::jsonb WHERE id = $2 RETURNING *",
    [JSON.stringify({ withdrawn_reason: cleanText(reason, "reason", 300), withdrawn_by: who.username }), row.id],
  )).rows[0];
  return { claim: shapeClaim(updated, (await receiptsFor(tx, [row.id])).get(row.id) ?? [], batch), note: "Withdrawn claims keep their number and are left out of totals." };
}

// ---------------------------------------------------------------- monthly submissions

export async function listSubmissions(tx, { limit } = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  const settings = await getSettings(tx);
  const scope = scopeClause(who, null, 1);
  const rows = (await tx.query(
    `SELECT b.*, ${SUM_SQL}
       FROM di.expense_batch b LEFT JOIN di.expense_claim c ON c.batch_id = b.id AND c.deleted_at IS NULL${scope.sql}
      WHERE b.deleted_at IS NULL GROUP BY b.id ORDER BY b.cutoff_date DESC LIMIT ${Math.min(Math.max(Number(limit) || 12, 1), 36)}`,
    scope.values,
  )).rows;
  const today = todayMY(now);
  return {
    cutoff_day: settings.cutoff_day, currency: settings.currency,
    submissions: rows.map((r) => ({ ...shapeBatch(r), days_left: r.status === "open" ? daysBetween(today, isoDate(r.cutoff_date)) : null, totals: shapeTotals(r) })),
    scope: isAdmin(who) ? "all claims" : "your claims only",
  };
}

/** Admin only. Freezes the submission; returns a `report` request the host turns into the final PDF. */
export async function closeSubmission(tx, { month, carry_forward_pending = false } = {}, { who } = {}) {
  requireWho(who);
  if (!isAdmin(who)) throw new DiError("Only an admin can close a monthly submission.");
  const batch = await batchByMonth(tx, month);
  if (!batch) throw new DiError(`No claims have been filed for ${month} yet, so there is no submission to close.`);
  if (batch.status === "closed") throw new DiError(`${batchLabel(batch)} is already closed.`);
  await tx.query("SELECT id FROM di.expense_batch WHERE id = $1 FOR UPDATE", [batch.id]);
  const settings = await getSettings(tx);
  const pending = (await tx.query("SELECT id, number FROM di.expense_claim WHERE batch_id = $1 AND status = 'submitted' AND deleted_at IS NULL ORDER BY number", [batch.id])).rows;
  const carried = [];
  if (pending.length) {
    if (!carry_forward_pending) {
      throw new DiError(`${pending.length} claim(s) are still pending: ${pending.map((p) => p.number).join(", ")}. Approve or reject them first, or close with carry_forward_pending=true to move them to the next submission.`);
    }
    const next = await ensureBatch(tx, addMonths(batch.period_key, 1), settings.cutoff_day);
    for (const p of pending) {
      await tx.query("UPDATE di.expense_claim SET batch_id = $1 WHERE id = $2", [next.id, p.id]);
      carried.push(p.number);
    }
  }
  const t = (await tx.query(`SELECT ${SUM_SQL} FROM di.expense_claim c WHERE c.batch_id = $1 AND c.deleted_at IS NULL`, [batch.id])).rows[0];
  if (!t.claims) throw new DiError(`${batchLabel(batch)} has no claims to submit.`);
  const closed = (await tx.query(
    "UPDATE di.expense_batch SET status = 'closed', closed_at = now(), closed_by = $1, claim_count = $2, total_claimed = $3, total_approved = $4 WHERE id = $5 RETURNING *",
    [who.username, t.claims, round2(num(t.claimed)), round2(num(t.approved)), batch.id],
  )).rows[0];
  return {
    submission: { ...shapeBatch(closed), totals: shapeTotals(t) },
    carried_forward: carried,
    report: { batch_id: closed.id, final: true },
  };
}

// ---------------------------------------------------------------- data for reports and exports

/** Everything a report or CSV needs for one submission, limited to what `who` may see. */
export async function loadSubmissionData(tx, { batchId, month, claimant }, { who } = {}) {
  requireWho(who);
  const batch = batchId
    ? (await tx.query("SELECT * FROM di.expense_batch WHERE id = $1 AND deleted_at IS NULL", [batchId])).rows[0]
    : await batchByMonth(tx, month);
  if (!batch) throw new DiError(month ? `No claims have been filed for ${month} yet.` : "Submission not found");
  const scope = scopeClause(who, claimant, 2);
  const rows = (await tx.query(
    `SELECT c.* FROM di.expense_claim c WHERE c.batch_id = $1 AND c.deleted_at IS NULL${scope.sql} ORDER BY lower(c.claimant_name), c.expense_date, c.number`,
    [batch.id, ...scope.values],
  )).rows;
  const receipts = await receiptsFor(tx, rows.map((r) => r.id));
  const profile = (await tx.query("SELECT * FROM di.company_profile WHERE tenant_id = di.current_tenant()")).rows[0] ?? null;
  const settings = await getSettings(tx);
  return {
    batch: shapeBatch(batch),
    claims: rows.map((r) => shapeClaim(r, receipts.get(r.id) ?? [], batch)),
    company: profile, currency: settings.currency, cutoff_day: settings.cutoff_day,
    scope: isAdmin(who) ? "all" : "own", claimant_filter: claimant ? String(claimant) : null,
  };
}

export async function setBatchReportPath(tx, batchId, reportPath) {
  await tx.query("UPDATE di.expense_batch SET report_path = $1 WHERE id = $2", [reportPath, batchId]);
}

/** The oldest submission still open: what the company is collecting right now. */
export async function defaultMonth(tx) {
  const open = (await tx.query("SELECT period_key FROM di.expense_batch WHERE status = 'open' AND deleted_at IS NULL ORDER BY cutoff_date LIMIT 1")).rows[0];
  if (!open) throw new DiError("There is no open monthly submission yet (no claims filed); give month (YYYY-MM)");
  return open.period_key;
}

/** Validates the request and what `who` may see; the host turns `report` into the PDF. */
export async function claimReport(tx, { month, claimant } = {}, { who } = {}) {
  requireWho(who);
  const key = month && month !== "all" ? month : await defaultMonth(tx);
  const data = await loadSubmissionData(tx, { month: key, claimant }, { who });
  return {
    submission: data.batch, scope: data.scope === "all" ? "all claims" : "your claims only",
    totals: totalsOf(data.claims), report: { month: key, claimant: data.claimant_filter },
  };
}

/** Claims for the CSV export; the tool's saveFile hook turns `claims` into the file. */
export async function exportClaims(tx, input = {}, ctx = {}) {
  const month = input.month && input.month !== "all" ? input.month : await defaultMonth(tx);
  const data = await loadSubmissionData(tx, { month, claimant: input.claimant }, ctx);
  // Withdrawn claims are left out unless asked for by name, like spam in the form export.
  const claims = data.claims.filter((c) => (input.status ? c.status === input.status : c.status !== "withdrawn"));
  return {
    month: data.batch.period_key, submission_status: data.batch.status, count: claims.length,
    total: round2(claims.filter((c) => c.status !== "withdrawn").reduce((sum, c) => sum + c.amount, 0)),
    claims, name: `expense-claims-${data.batch.period_key}${data.claimant_filter || input.status ? "-filtered" : ""}.csv`,
  };
}
