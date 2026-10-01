import { DiError } from "./common.mjs";

export const CALENDAR_SCHEMA_VERSION = "1.0";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 370;

function asDate(value) {
  if (value == null || value === "") return null;
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (!ISO_DATE.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : text;
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

export function validateCalendarRange({ from, to, timezone = "Asia/Kuala_Lumpur" } = {}) {
  const start = asDate(from);
  const end = asDate(to);
  if (!start || !end || start > end) throw new DiError("Calendar range must use YYYY-MM-DD and from must not be after to");
  if (daysBetween(start, end) > MAX_RANGE_DAYS) throw new DiError(`Calendar range cannot exceed ${MAX_RANGE_DAYS} days`);
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); }
  catch { throw new DiError("Calendar timezone must be a valid IANA timezone"); }
  return { from: start, to: end, timezone };
}

function inRange(value, range) {
  return Boolean(value && value >= range.from && value <= range.to);
}

function event({ id, kind, title, date, displayDate = date, range, timezone, status = "active", severity = "info", source, detail, warnings = [], confidence = 1 }) {
  if (!inRange(displayDate, range)) return null;
  return {
    id, kind, title, start: displayDate, end: displayDate, allDay: true, timezone,
    status, severity, source, detail: { ...(detail || {}), sourceDate: date }, warnings, confidence,
    needsReview: warnings.length > 0 || confidence < 0.8,
  };
}

function customDateEvents(row, defs, range, timezone, sourceTable, label) {
  const custom = row.custom && typeof row.custom === "object" ? row.custom : {};
  return defs.filter((def) => def.entity === sourceTable && def.type === "date" && custom[def.key])
    .map((def) => {
      const date = asDate(custom[def.key]);
      const warnings = date ? [] : ["Custom field contains an invalid date"];
      return event({
        id: `custom:${sourceTable}:${row.id}:${def.key}`,
        kind: "reminder", title: def.label || label, date: date || String(custom[def.key]), displayDate: date || range.from, range, timezone,
        severity: "info", source: { table: `di.${sourceTable}`, recordId: row.id, field: `custom.${def.key}` },
        detail: { label: def.label || def.key, value: custom[def.key] }, warnings,
        confidence: date ? 0.9 : 0.2,
      });
    }).filter(Boolean);
}

export function normalizeCalendarSources({ documents = [], payments = [], forms = [], customFieldDefs = [], range, timezone }) {
  const events = [];
  for (const row of documents) {
    const customer = row.customer_name || "Unknown customer";
    if (row.doc_type === "quotation" && row.status === "issued") {
      const date = asDate(row.valid_until);
      if (date) events.push(event({ id: `quotation-expiry:${row.id}`, kind: "quotation_expiry", title: `Quotation ${row.number || "Draft"} expires`, date, displayDate: date < range.from ? range.from : date, range, timezone, severity: date < range.from ? "high" : "warning", status: date < range.from ? "expired" : "upcoming", source: { table: "di.document", recordId: row.id, field: "valid_until" }, detail: { number: row.number, customer, total: Number(row.total || 0) } }));
    }
    if (row.doc_type === "invoice" && ["issued", "partially_paid"].includes(row.status) && Number(row.total || 0) - Number(row.amount_paid || 0) > 0.005) {
      const date = asDate(row.due_date);
      if (date) events.push(event({ id: `payment-due:${row.id}`, kind: "payment_due", title: `Payment due for ${row.number || "invoice"}`, date, displayDate: date < range.from ? range.from : date, range, timezone, severity: date < range.from ? "high" : "warning", status: date < range.from ? "overdue" : "upcoming", source: { table: "di.document", recordId: row.id, field: "due_date" }, detail: { number: row.number, customer, balance: Number(row.total || 0) - Number(row.amount_paid || 0) } }));
    }
    events.push(...customDateEvents(row, customFieldDefs, range, timezone, "document", row.number || "Document reminder"));
  }
  for (const row of payments) {
    const date = asDate(row.received_on);
    if (date) events.push(event({ id: `payment-received:${row.id}`, kind: "payment_received", title: `Payment received ${row.number || ""}`.trim(), date, range, timezone, status: "recorded", severity: "info", source: { table: "di.payment", recordId: row.id, field: "received_on" }, detail: { number: row.number, amount: Number(row.amount || 0), method: row.method } }));
    events.push(...customDateEvents(row, customFieldDefs, range, timezone, "payment", row.number || "Payment reminder"));
  }
  for (const row of forms) {
    const date = asDate(row.closes_at);
    if (date) events.push(event({ id: `form-close:${row.id}`, kind: "reminder", title: `${row.title || "Form"} closes`, date, range, timezone, status: date < range.from ? "expired" : "upcoming", severity: date < range.from ? "high" : "info", source: { table: "di.form_version", recordId: row.id, field: "settings.closes_at" }, detail: { form: row.title } }));
  }
  const seen = new Set();
  return events.filter((item) => item && !seen.has(item.id) && seen.add(item.id)).sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title));
}

export async function readCalendar(tx, args = {}) {
  const range = validateCalendarRange(args);
  const [documents, payments, forms, defs, profile] = await Promise.all([
    tx.query(`SELECT d.id,d.doc_type,d.number,d.status,d.valid_until,d.due_date,d.total,d.amount_paid,d.custom,c.name AS customer_name FROM di.document d LEFT JOIN di.customer c ON c.id=d.customer_id WHERE d.deleted_at IS NULL AND ((d.valid_until BETWEEN $1::date AND $2::date) OR (d.due_date BETWEEN $1::date AND $2::date) OR (d.valid_until < $1::date AND d.doc_type='quotation' AND d.status='issued') OR (d.due_date < $1::date AND d.doc_type='invoice' AND d.status IN ('issued','partially_paid')) OR d.custom <> '{}'::jsonb)`, [range.from, range.to]),
    tx.query(`SELECT p.id,p.number,p.received_on,p.amount,p.method,p.custom FROM di.payment p WHERE p.deleted_at IS NULL AND p.status='recorded' AND (p.received_on BETWEEN $1::date AND $2::date OR p.custom <> '{}'::jsonb)`, [range.from, range.to]),
    tx.query(`SELECT fv.id,f.title,fv.settings FROM di.form_version fv JOIN di.form f ON f.id=fv.form_id WHERE fv.status='published' AND fv.deleted_at IS NULL`, []),
    tx.query(`SELECT entity,key,label,type FROM di.field_def WHERE deleted_at IS NULL AND type='date'`, []),
    tx.query(`SELECT timezone FROM di.company_profile WHERE tenant_id=di.current_tenant()`, []),
  ]);
  const timezone = args.timezone || profile.rows[0]?.timezone || range.timezone;
  validateCalendarRange({ ...range, timezone });
  const formRows = forms.rows.map((row) => ({ id: row.id, title: row.title, closes_at: row.settings?.closes_at }));
  return { schemaVersion: CALENDAR_SCHEMA_VERSION, range, timezone, events: normalizeCalendarSources({ documents: documents.rows, payments: payments.rows, forms: formRows, customFieldDefs: defs.rows, range, timezone }), warnings: [] };
}
