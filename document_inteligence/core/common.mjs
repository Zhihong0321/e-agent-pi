// Shared helpers for the domain modules. Every query here runs inside withContext(),
// so row-level security already scopes it to one tenant: no tenant_id filters needed.

export class DiError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "DiError";
    this.details = details;
  }
}

/** Today's date in Malaysia as YYYY-MM-DD. */
export function todayMY(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(now);
}

export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
}

/** Date columns come back as Date (pg) or string (PGlite); normalise to YYYY-MM-DD. */
export function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Malaysian-aware phone normalisation to digits with country code: 012-345 6789 -> 60123456789. */
export function normPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0")) d = `6${d}`;
  else if (/^1\d{8,9}$/.test(d)) d = `60${d}`;
  return d;
}

/**
 * SSM numbers are often written "202301012345 (1500000-A)": the 12-digit new format
 * plus the old one. Match on the 12-digit number when present.
 */
export function normRegNo(raw) {
  const text = String(raw || "").toUpperCase();
  const modern = text.match(/(?:19|20)\d{10}/);
  return modern ? modern[0] : text.replace(/[^0-9A-Z]/g, "");
}
export const normEmail = (raw) => String(raw || "").trim().toLowerCase();

const NAME_NOISE = new Set([
  "sdn", "bhd", "berhad", "sendirian", "plt", "enterprise", "ent", "co", "company", "the", "m",
  "llp", "ltd", "limited", "inc", "corp", "corporation", "trading", "resources", "holdings", "group", "and",
]);

export function nameTokens(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !NAME_NOISE.has(t));
}

export function nameSimilarity(a, b) {
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const jaccard = inter / (ta.size + tb.size - inter);
  const contained = inter === Math.min(ta.size, tb.size) ? 0.85 : 0;
  return Math.max(jaccard, contained && inter >= 1 ? contained : 0);
}

/** Drops undefined keys so partial updates only touch what the agent sent. */
export function defined(obj) {
  return Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined));
}

/** Builds "col = $n" SET clauses from a whitelist; returns { sql, values }. */
export function setClause(patch, allowed, startAt = 1) {
  const cols = Object.keys(patch).filter((k) => allowed.includes(k));
  const values = cols.map((k) => (patch[k] !== null && typeof patch[k] === "object" ? JSON.stringify(patch[k]) : patch[k]));
  const sql = cols.map((c, i) => `${c} = $${startAt + i}`).join(", ");
  return { sql, values, cols };
}

/** Takes the next gap-free number for a sequence key. Must run in the issuing transaction. */
export async function nextNumber(tx, key, today = todayMY()) {
  const { rows } = await tx.query(
    "SELECT * FROM di.document_sequence WHERE key = $1 AND deleted_at IS NULL FOR UPDATE",
    [key],
  );
  const seq = rows[0];
  if (!seq) throw new DiError(`No numbering sequence for "${key}". The DB Manager agent can create it.`);
  const year = Number(today.slice(0, 4));
  let n = Number(seq.next_number);
  let currentYear = seq.current_year == null ? null : Number(seq.current_year);
  if (seq.yearly_reset && currentYear !== year) {
    n = currentYear == null ? n : 1;
    currentYear = year;
  }
  const number = `${seq.prefix}${seq.yearly_reset ? `${year}-` : ""}${String(n).padStart(Number(seq.padding), "0")}`;
  await tx.query("UPDATE di.document_sequence SET next_number = $1, current_year = $2 WHERE id = $3", [
    n + 1,
    currentYear,
    seq.id,
  ]);
  return number;
}

/**
 * Validates custom field values against di.field_def. Unknown keys are refused so
 * agents can't invent columns; the DB Manager agent defines new fields first.
 */
export async function validateCustom(tx, entity, custom, { creating = false } = {}) {
  const defs = (
    await tx.query("SELECT * FROM di.field_def WHERE entity = $1 AND deleted_at IS NULL", [entity])
  ).rows;
  const out = {};
  const byKey = new Map(defs.map((d) => [d.key, d]));
  for (const [key, value] of Object.entries(custom || {})) {
    const def = byKey.get(key);
    if (!def) {
      const known = defs.map((d) => d.key).join(", ") || "none";
      throw new DiError(
        `Unknown custom field ${entity}.${key} (defined: ${known}). Ask the DB Manager agent to define it first.`,
      );
    }
    if (value === null || value === "") {
      out[key] = null;
      continue;
    }
    if (def.type === "number") {
      if (!Number.isFinite(Number(value))) throw new DiError(`${def.label} must be a number`);
      out[key] = Number(value);
    } else if (def.type === "boolean") {
      out[key] = value === true || value === "true" || value === "yes";
    } else if (def.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new DiError(`${def.label} must be a YYYY-MM-DD date`);
      out[key] = String(value);
    } else if (def.type === "select") {
      const options = Array.isArray(def.options) ? def.options : [];
      if (!options.includes(value)) throw new DiError(`${def.label} must be one of: ${options.join(", ")}`);
      out[key] = value;
    } else {
      out[key] = String(value);
    }
  }
  if (creating) {
    const missing = defs.filter((d) => d.required_for === "save" && (out[d.key] == null || out[d.key] === ""));
    if (missing.length) {
      throw new DiError(`Required before saving a ${entity}: ${missing.map((d) => d.label).join(", ")}`);
    }
  }
  return out;
}

export async function requireRow(tx, table, id, label = table) {
  if (!id) throw new DiError(`${label} id is required`);
  const { rows } = await tx.query(`SELECT * FROM di.${table} WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!rows[0]) throw new DiError(`${label} ${id} not found (or archived)`);
  return rows[0];
}

export const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ""));
