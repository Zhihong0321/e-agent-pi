// Procurement: suppliers, what they send us (quotations, invoices), our purchase orders, and the
// goods that arrive. The mirror image of the sales side, kept in its own tables.
//
// Rules that live in the database (sql/007_procurement.sql): an issued PO is frozen, a PO line can't
// be received beyond what was ordered, a recorded supplier document can't be edited. The checks here
// give readable errors first and hold the business rules the database can't see: who may approve,
// duplicate suppliers/documents, and the invoice-vs-PO-vs-goods-received match.
//
// Every handler takes (tx, args, { who, receipts, now }); `who` is the signed-in host user.
import { DiError, addDays, isUuid, isoDate, nameSimilarity, nextNumber, normEmail, normPhone, normRegNo, round2, todayMY } from "./common.mjs";
import { isAdmin, isDate, requireWho } from "./expenses.mjs";
import { headsDepartment } from "../../server/roles.mjs";
import { money } from "./templates.mjs";

const num = (v) => Number(v) || 0;
// Match the numeric(12,3) quantities stored on PO lines; money stays at two decimals.
const roundQty = (v) => Math.round(v * 1000) / 1000;
const cur = (n, c = "MYR") => `${c} ${money(n)}`;
const SUPPLIER_FIELDS = ["name", "reg_no", "tin", "sst_no", "contact_name", "email", "phone", "address", "payment_terms_days", "bank_details", "notes"];
export const DEFAULT_TERMS_DAYS = 30;
export const PO_OPEN = ["issued", "partially_received"];

// ---------------------------------------------------------------- small helpers

async function companyCurrency(tx) {
  return (await tx.query("SELECT currency FROM di.company_profile WHERE tenant_id = di.current_tenant()")).rows[0]?.currency || "MYR";
}

function text(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === "") {
    if (required) throw new DiError(`${label} is required`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) throw new DiError(`${label} is too long (max ${max} characters)`);
  return s;
}

function dateField(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new DiError(`${label} is required (YYYY-MM-DD)`);
    return null;
  }
  if (!isDate(value)) throw new DiError(`${label} must be a date as YYYY-MM-DD`);
  return String(value);
}

/** Validates line items and works out their totals. Throws a readable DiError per bad line. */
export function normaliseLines(lines, { min = 0 } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  if (list.length < min) throw new DiError(`At least ${min} line item${min === 1 ? " is" : "s are"} needed`);
  if (list.length > 100) throw new DiError("At most 100 line items");
  const out = list.map((l, i) => {
    const at = `Line ${i + 1}`;
    const description = text(l?.description, `${at} description`, 200, { required: true });
    let quantity = Number(l?.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) throw new DiError(`${at}: quantity must be more than 0`);
    quantity = roundQty(quantity);
    if (quantity <= 0) throw new DiError(`${at}: quantity must be at least 0.001`);
    let unit_price = Number(l?.unit_price);
    if (!Number.isFinite(unit_price) || unit_price < 0 || unit_price > 100_000_000) throw new DiError(`${at}: unit_price must be 0 or more`);
    unit_price = round2(unit_price);
    let tax_rate = Number(l?.tax_rate ?? 0);
    if (!Number.isFinite(tax_rate) || tax_rate < 0 || tax_rate > 100) throw new DiError(`${at}: tax_rate must be a percentage from 0 to 100`);
    tax_rate = round2(tax_rate);
    const subtotal = round2(quantity * unit_price);
    const tax_amount = round2((subtotal * tax_rate) / 100);
    return {
      line_no: i + 1, sku: text(l?.sku, `${at} sku`, 60), description, unit: text(l?.unit, `${at} unit`, 20) || "unit",
      quantity, unit_price, tax_rate, subtotal, tax_amount, total: round2(subtotal + tax_amount),
    };
  });
  const sum = (key) => round2(out.reduce((s, l) => s + l[key], 0));
  return { lines: out, subtotal: sum("subtotal"), tax_total: sum("tax_amount"), total: sum("total") };
}

// ---------------------------------------------------------------- suppliers

const shapeSupplier = (s) => ({
  id: s.id, code: s.code, name: s.name, reg_no: s.reg_no ?? null, tin: s.tin ?? null, sst_no: s.sst_no ?? null,
  contact_name: s.contact_name ?? null, email: s.email ?? null, phone: s.phone ?? null, address: s.address ?? {},
  payment_terms_days: s.payment_terms_days == null ? null : Number(s.payment_terms_days), bank_details: s.bank_details ?? null, notes: s.notes ?? null,
});

/** Scores existing suppliers against what we know: same reg no 100, email 90, name 80, phone 75, similar name 50. */
export async function matchSupplier(tx, input = {}, excludeId = null) {
  const reg = normRegNo(input.reg_no) || null;
  const email = normEmail(input.email) || null;
  const phone = normPhone(input.phone).slice(-9) || null;
  const rows = (await tx.query("SELECT * FROM di.supplier WHERE deleted_at IS NULL")).rows.filter((r) => r.id !== excludeId);
  const scored = rows.map((r) => {
    let score = 0;
    let why = "";
    const hit = (s, w) => { if (s > score) { score = s; why = w; } };
    if (reg && normRegNo(r.reg_no) === reg) hit(100, "same registration number");
    if (email && normEmail(r.email) === email) hit(90, "same email");
    const sim = input.name ? nameSimilarity(input.name, r.name) : 0;
    if (sim >= 0.85) hit(80, "same company name");
    if (phone && normPhone(r.phone).slice(-9) === phone) hit(75, "same phone");
    if (sim >= 0.5) hit(50, "similar name");
    return { supplier: r, score, why };
  }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score);
  return { verdict: scored[0]?.score >= 75 ? "existing" : scored[0] ? "possible" : "new", matches: scored.slice(0, 3) };
}

export async function resolveSupplier(tx, ref) {
  const q = String(ref ?? "").trim();
  if (!q) throw new DiError("Name the supplier (code like S-0001, id, or name)");
  let rows;
  if (isUuid(q)) rows = (await tx.query("SELECT * FROM di.supplier WHERE id = $1::uuid AND deleted_at IS NULL", [q])).rows;
  else {
    rows = (await tx.query("SELECT * FROM di.supplier WHERE deleted_at IS NULL AND (upper(code) = upper($1) OR lower(name) = lower($1))", [q])).rows;
    if (!rows.length) {
      const like = `%${q.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
      rows = (await tx.query("SELECT * FROM di.supplier WHERE deleted_at IS NULL AND lower(name) LIKE $1 ORDER BY name LIMIT 6", [like])).rows;
    }
  }
  if (!rows.length) throw new DiError(`No supplier matches "${q}". Record it first with save_supplier (find_suppliers shows what exists).`);
  if (rows.length > 1) throw new DiError(`"${q}" matches ${rows.length} suppliers (${rows.map((r) => `${r.code} ${r.name}`).join("; ")}). Use the code.`);
  return rows[0];
}

function cleanSupplierPatch(input) {
  const patch = {};
  for (const key of SUPPLIER_FIELDS) {
    if (input[key] === undefined) continue;
    if (key === "address") {
      patch.address = typeof input.address === "string" ? { line1: text(input.address, "address", 300) } : (input.address ?? {});
    } else if (key === "payment_terms_days") {
      if (input[key] !== null && (!Number.isInteger(input[key]) || input[key] < 0 || input[key] > 3650)) throw new DiError("payment_terms_days must be 0-3650");
      patch[key] = input[key];
    } else patch[key] = text(input[key], key, key === "notes" || key === "bank_details" ? 1000 : 200);
  }
  if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) throw new DiError("That email address does not look valid");
  if (patch.email) patch.email = patch.email.toLowerCase();
  return patch;
}

export async function saveSupplier(tx, input = {}, { who } = {}) {
  requireWho(who);
  const patch = cleanSupplierPatch(input);
  if (input.supplier) {
    const existing = await resolveSupplier(tx, input.supplier);
    if (!Object.keys(patch).length) throw new DiError("Give at least one supplier field to change");
    const cols = Object.keys(patch);
    const row = (await tx.query(
      `UPDATE di.supplier SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map((c) => (c === "address" ? JSON.stringify(patch[c]) : patch[c])), existing.id],
    )).rows[0];
    return { supplier: shapeSupplier(row), created: false };
  }
  if (!patch.name) throw new DiError("A supplier needs a name");
  const match = await matchSupplier(tx, patch);
  if (match.verdict === "existing" && !input.allow_duplicate) {
    const top = match.matches[0];
    throw new DiError(`${top.supplier.code} ${top.supplier.name} already looks like this supplier (${top.why}). Use it, update it with the supplier field, or pass allow_duplicate=true only if the user says it is a different company.`);
  }
  const code = await nextNumber(tx, "supplier");
  const cols = ["code", ...Object.keys(patch)];
  const values = [code, ...Object.keys(patch).map((k) => (k === "address" ? JSON.stringify(patch[k]) : patch[k]))];
  const row = (await tx.query(
    `INSERT INTO di.supplier (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, values,
  )).rows[0];
  return {
    supplier: shapeSupplier(row), created: true,
    ...(match.verdict === "possible" ? { warnings: [`Similar to ${match.matches[0].supplier.code} ${match.matches[0].supplier.name} (${match.matches[0].why}); check it is not the same company`] } : {}),
  };
}

export async function findSuppliers(tx, { query, limit } = {}, { who } = {}) {
  requireWho(who);
  const like = query ? `%${String(query).toLowerCase().replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = (await tx.query(
    `SELECT s.*,
       (SELECT count(*)::int FROM di.purchase_order p WHERE p.supplier_id = s.id AND p.status IN ('issued','partially_received') AND p.deleted_at IS NULL) AS open_pos,
       (SELECT coalesce(sum(d.total), 0) FROM di.supplier_document d WHERE d.supplier_id = s.id AND d.doc_type = 'invoice' AND d.status IN ('unpaid','disputed') AND d.deleted_at IS NULL) AS owed
       FROM di.supplier s
      WHERE s.deleted_at IS NULL AND ($1::text IS NULL OR lower(s.name) LIKE $1 OR lower(s.code) LIKE $1 OR lower(coalesce(s.email,'')) LIKE $1 OR lower(coalesce(s.contact_name,'')) LIKE $1)
      ORDER BY s.name LIMIT ${Math.min(Math.max(Number(limit) || 30, 1), 50)}`,
    [like],
  )).rows;
  return { suppliers: rows.map((r) => ({ ...shapeSupplier(r), open_pos: r.open_pos, owed: round2(num(r.owed)) })) };
}

export async function getSupplier(tx, { supplier } = {}, { who } = {}) {
  requireWho(who);
  const s = await resolveSupplier(tx, supplier);
  const pos = (await tx.query("SELECT number, id, status, total, expected_date FROM di.purchase_order WHERE supplier_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 8", [s.id])).rows;
  const docs = (await tx.query("SELECT number, doc_type, supplier_ref, status, total, due_date FROM di.supplier_document WHERE supplier_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 8", [s.id])).rows;
  return {
    supplier: shapeSupplier(s),
    recent_pos: pos.map((p) => ({ number: p.number || `DRAFT-${p.id.slice(0, 8)}`, status: p.status, total: num(p.total), expected_date: isoDate(p.expected_date) })),
    recent_documents: docs.map((d) => ({ number: d.number, type: d.doc_type, supplier_ref: d.supplier_ref, status: d.status, total: num(d.total), due_date: isoDate(d.due_date) })),
  };
}

// ---------------------------------------------------------------- purchase orders

async function poLines(tx, poId) {
  return (await tx.query("SELECT * FROM di.purchase_order_line WHERE po_id = $1 AND deleted_at IS NULL ORDER BY line_no", [poId])).rows;
}

async function loadPo(tx, ref, { lock = false } = {}) {
  const q = String(ref ?? "").trim();
  if (!q) throw new DiError("Give the PO number (PO-2026-0001, or DRAFT-xxxxxxxx for a draft) or id");
  const tail = lock ? " FOR UPDATE" : "";
  let row;
  if (isUuid(q)) row = (await tx.query(`SELECT * FROM di.purchase_order WHERE id = $1::uuid AND deleted_at IS NULL${tail}`, [q])).rows[0];
  else if (/^DRAFT-[0-9a-f]{8}$/i.test(q)) row = (await tx.query(`SELECT * FROM di.purchase_order WHERE id::text LIKE $1 AND deleted_at IS NULL${tail}`, [`${q.slice(6).toLowerCase()}%`])).rows[0];
  else row = (await tx.query(`SELECT * FROM di.purchase_order WHERE upper(number) = upper($1) AND deleted_at IS NULL${tail}`, [q])).rows[0];
  if (!row) throw new DiError(`Purchase order ${q} not found`);
  return row;
}

const poNumber = (po) => po.number || `DRAFT-${po.id.slice(0, 8)}`;

function shapeLine(l) {
  return {
    line_no: Number(l.line_no), sku: l.sku ?? null, description: l.description, unit: l.unit, quantity: num(l.quantity), unit_price: num(l.unit_price),
    tax_rate: num(l.tax_rate), total: num(l.total), received_qty: num(l.received_qty), outstanding: roundQty(num(l.quantity) - num(l.received_qty)),
  };
}

function shapePo(po, lines, supplier, today = todayMY()) {
  const ordered = lines.reduce((s, l) => s + num(l.quantity), 0);
  const received = lines.reduce((s, l) => s + num(l.received_qty), 0);
  const expected = isoDate(po.expected_date);
  return {
    id: po.id, number: poNumber(po), status: po.status, is_draft: po.status === "draft",
    supplier: supplier ? { code: supplier.code, name: supplier.name } : null,
    order_date: isoDate(po.order_date), expected_date: expected,
    overdue: Boolean(expected && PO_OPEN.includes(po.status) && expected < today),
    ship_to: po.ship_to ?? null, payment_terms_days: po.payment_terms_days == null ? null : Number(po.payment_terms_days), currency: po.currency,
    subtotal: num(po.subtotal), tax_total: num(po.tax_total), total: num(po.total), notes: po.notes ?? null,
    department: po.department ?? null, issued_by: po.issued_by ?? null, cancel_reason: po.cancel_reason ?? null, pdf_path: po.pdf_path ?? null,
    progress: { ordered: roundQty(ordered), received: roundQty(received) },
    lines: lines.map(shapeLine),
  };
}

async function poWithLines(tx, po) {
  const supplier = (await tx.query("SELECT * FROM di.supplier WHERE id = $1", [po.supplier_id])).rows[0];
  return { lines: await poLines(tx, po.id), supplier };
}

async function writeLines(tx, poId, norm) {
  await tx.query("UPDATE di.purchase_order_line SET deleted_at = now() WHERE po_id = $1 AND deleted_at IS NULL", [poId]);
  for (const l of norm.lines) {
    await tx.query(
      `INSERT INTO di.purchase_order_line (po_id, line_no, sku, description, unit, quantity, unit_price, tax_rate, subtotal, tax_amount, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [poId, l.line_no, l.sku, l.description, l.unit, l.quantity, l.unit_price, l.tax_rate, l.subtotal, l.tax_amount, l.total],
    );
  }
  await tx.query("UPDATE di.purchase_order SET subtotal = $1, tax_total = $2, total = $3 WHERE id = $4", [norm.subtotal, norm.tax_total, norm.total, poId]);
}

async function loadQuotation(tx, ref) {
  const q = String(ref ?? "").trim();
  const row = (await tx.query(
    `SELECT * FROM di.supplier_document WHERE doc_type = 'quotation' AND deleted_at IS NULL AND ${isUuid(q) ? "id = $1::uuid" : "upper(number) = upper($1)"}`, [q],
  )).rows[0];
  if (!row) throw new DiError(`Supplier quotation ${q} not found`);
  return row;
}

export async function createPoDraft(tx, input = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  const today = todayMY(now);
  let supplier;
  let source = null;
  let norm;
  if (input.from_quotation) {
    source = await loadQuotation(tx, input.from_quotation);
    if (!["received", "accepted"].includes(source.status)) throw new DiError(`Quotation ${source.number} is ${source.status}; only a received or accepted quotation can become a PO.`);
    if (source.po_id) {
      const linked = (await tx.query("SELECT number, id, status FROM di.purchase_order WHERE id = $1", [source.po_id])).rows[0];
      if (linked && linked.status !== "cancelled") throw new DiError(`Quotation ${source.number} already has ${poNumber(linked)}.`);
    }
    supplier = (await tx.query("SELECT * FROM di.supplier WHERE id = $1", [source.supplier_id])).rows[0];
    if (input.supplier) {
      const named = await resolveSupplier(tx, input.supplier);
      if (named.id !== supplier.id) throw new DiError(`Quotation ${source.number} is from ${supplier.name}, not ${named.name}.`);
    }
    const quoteLines = Array.isArray(source.lines) ? source.lines : [];
    if (!quoteLines.length && !input.lines?.length) throw new DiError(`Quotation ${source.number} has no line items recorded; pass the lines for the PO.`);
    norm = normaliseLines(input.lines?.length ? input.lines : quoteLines, { min: 1 });
  } else {
    supplier = await resolveSupplier(tx, input.supplier);
    norm = normaliseLines(input.lines, { min: 1 });
  }
  const order_date = dateField(input.order_date, "order_date") ?? today;
  const expected_date = dateField(input.expected_date, "expected_date");
  if (expected_date && expected_date < order_date) throw new DiError("expected_date is before the order date");
  const currency = await companyCurrency(tx);
  const warnings = [];
  if (!expected_date) warnings.push("No expected delivery date yet");
  if (!supplier.email) warnings.push(`${supplier.name} has no email recorded`);
  const po = (await tx.query(
    `INSERT INTO di.purchase_order (supplier_id, order_date, expected_date, ship_to, payment_terms_days, currency, notes, department)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [supplier.id, order_date, expected_date, text(input.ship_to, "ship_to", 300), input.payment_terms_days ?? supplier.payment_terms_days ?? null, currency, text(input.notes, "notes", 1000), String(who.department ?? "").trim() || null],
  )).rows[0];
  await writeLines(tx, po.id, norm);
  if (source) {
    await tx.query("UPDATE di.supplier_document SET po_id = $1, status = CASE WHEN status = 'received' THEN 'accepted' ELSE status END WHERE id = $2", [po.id, source.id]);
  }
  const fresh = (await tx.query("SELECT * FROM di.purchase_order WHERE id = $1", [po.id])).rows[0];
  return { po: shapePo(fresh, await poLines(tx, po.id), supplier, today), warnings, ...(source ? { from_quotation: source.number } : {}) };
}

export async function updatePoDraft(tx, input = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  const po = await loadPo(tx, input.po, { lock: true });
  if (po.status !== "draft") throw new DiError(`${poNumber(po)} is ${po.status}; only a draft can be edited. Cancel it and draft a new one if it needs changing.`);
  const patch = {};
  if (input.expected_date !== undefined) patch.expected_date = dateField(input.expected_date, "expected_date");
  if (input.order_date !== undefined) patch.order_date = dateField(input.order_date, "order_date", { required: true });
  if (input.ship_to !== undefined) patch.ship_to = text(input.ship_to, "ship_to", 300);
  if (input.notes !== undefined) patch.notes = text(input.notes, "notes", 1000);
  if (input.payment_terms_days !== undefined) patch.payment_terms_days = input.payment_terms_days;
  if (input.supplier !== undefined) patch.supplier_id = (await resolveSupplier(tx, input.supplier)).id;
  const orderDate = patch.order_date ?? isoDate(po.order_date);
  const expected = patch.expected_date !== undefined ? patch.expected_date : isoDate(po.expected_date);
  if (expected && expected < orderDate) throw new DiError("expected_date is before the order date");
  if (!Object.keys(patch).length && !input.lines) throw new DiError("Nothing to change: give the fields to correct or the full list of lines");
  const cols = Object.keys(patch);
  if (cols.length) await tx.query(`UPDATE di.purchase_order SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1}`, [...cols.map((c) => patch[c]), po.id]);
  if (input.lines) await writeLines(tx, po.id, normaliseLines(input.lines, { min: 1 }));
  const fresh = (await tx.query("SELECT * FROM di.purchase_order WHERE id = $1", [po.id])).rows[0];
  const { lines, supplier } = await poWithLines(tx, fresh);
  return { po: shapePo(fresh, lines, supplier, todayMY(now)) };
}

async function linkedDocs(tx, poId) {
  const docs = (await tx.query("SELECT * FROM di.supplier_document WHERE po_id = $1 AND deleted_at IS NULL ORDER BY created_at", [poId])).rows;
  return docs.map((d) => ({ number: d.number, type: d.doc_type, supplier_ref: d.supplier_ref, status: d.status, total: num(d.total), due_date: isoDate(d.due_date) }));
}

export async function getPo(tx, { po } = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  const row = await loadPo(tx, po);
  const { lines, supplier } = await poWithLines(tx, row);
  const receipts = (await tx.query("SELECT received_on, received_by, note, lines FROM di.goods_receipt WHERE po_id = $1 AND deleted_at IS NULL ORDER BY received_on, created_at", [row.id])).rows;
  return {
    po: shapePo(row, lines, supplier, todayMY(now)),
    documents: await linkedDocs(tx, row.id),
    goods_receipts: receipts.map((r) => ({ received_on: isoDate(r.received_on), received_by: r.received_by, note: r.note, lines: r.lines })),
  };
}

export async function listPos(tx, { status, supplier, query, limit } = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  const values = [];
  const arg = (v) => { values.push(v); return `$${values.length}`; };
  const conds = ["p.deleted_at IS NULL"];
  if (status) {
    if (status === "open") conds.push("p.status IN ('issued','partially_received')");
    else if (["draft", "issued", "partially_received", "received", "cancelled"].includes(status)) conds.push(`p.status = ${arg(status)}`);
    else throw new DiError("status must be draft, issued, partially_received, received, cancelled or open");
  }
  if (supplier) conds.push(`p.supplier_id = ${arg((await resolveSupplier(tx, supplier)).id)}::uuid`);
  if (query) {
    const p = arg(`%${String(query).toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    conds.push(`(lower(coalesce(p.number,'')) LIKE ${p} OR lower(s.name) LIKE ${p} OR lower(coalesce(p.notes,'')) LIKE ${p})`);
  }
  const max = Math.min(Math.max(Number(limit) || 30, 1), 50);
  const rows = (await tx.query(
    `SELECT p.*, s.name AS supplier_name, s.code AS supplier_code,
        (SELECT coalesce(sum(quantity),0) FROM di.purchase_order_line l WHERE l.po_id = p.id AND l.deleted_at IS NULL) AS ordered,
        (SELECT coalesce(sum(received_qty),0) FROM di.purchase_order_line l WHERE l.po_id = p.id AND l.deleted_at IS NULL) AS received
       FROM di.purchase_order p JOIN di.supplier s ON s.id = p.supplier_id
      WHERE ${conds.join(" AND ")} ORDER BY p.created_at DESC LIMIT ${max + 1}`, values,
  )).rows;
  const today = todayMY(now);
  return {
    pos: rows.slice(0, max).map((p) => ({
      id: p.id, number: poNumber(p), status: p.status, supplier: `${p.supplier_code} ${p.supplier_name}`, total: num(p.total), currency: p.currency,
      order_date: isoDate(p.order_date), expected_date: isoDate(p.expected_date),
      overdue: Boolean(p.expected_date && PO_OPEN.includes(p.status) && isoDate(p.expected_date) < today),
      received: `${roundQty(num(p.received))}/${roundQty(num(p.ordered))}`,
    })),
    has_more: rows.length > max,
  };
}

/**
 * A Superadmin approves every order; a department head the orders drafted in their department
 * (the drafter's department is stamped on the PO). Invoices follow their linked PO.
 */
function mayApprove(who, department) {
  return isAdmin(who) || headsDepartment(who, department);
}

function approverOnly(action, department) {
  return new DiError(`Only a Superadmin${department ? ` or the ${department} department head` : ""} can ${action}.`);
}

/** Superadmin, or the PO's department head. Takes the PO number and freezes the order; the host then renders the PDF from `report`. */
export async function issuePo(tx, { po } = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  const row = await loadPo(tx, po, { lock: true });
  if (!mayApprove(who, row.department)) throw approverOnly("issue this purchase order", row.department);
  if (row.status !== "draft") throw new DiError(`${poNumber(row)} is ${row.status}; only a draft can be issued.`);
  const { lines, supplier } = await poWithLines(tx, row);
  if (!lines.length || num(row.total) <= 0) throw new DiError("A purchase order needs at least one line with a price before it can be issued.");
  const today = todayMY(now);
  const number = await nextNumber(tx, "purchase_order", today);
  const updated = (await tx.query(
    "UPDATE di.purchase_order SET status = 'issued', number = $1, issued_at = $2, issued_by = $3 WHERE id = $4 RETURNING *",
    [number, now.toISOString(), who.username, row.id],
  )).rows[0];
  await tx.query("UPDATE di.supplier_document SET status = 'converted' WHERE po_id = $1 AND doc_type = 'quotation' AND status IN ('received','accepted') AND deleted_at IS NULL", [row.id]);
  const warnings = [];
  if (!supplier.email) warnings.push(`${supplier.name} has no email on file; send the PDF to them another way`);
  if (!updated.expected_date) warnings.push("No expected delivery date was set");
  return { po: shapePo(updated, lines, supplier, today), warnings, report: { po_id: row.id } };
}

export async function cancelPo(tx, { po, reason } = {}, { who } = {}) {
  requireWho(who);
  const cleanReason = text(reason, "reason", 300, { required: true });
  const row = await loadPo(tx, po, { lock: true });
  if (!mayApprove(who, row.department)) throw approverOnly("cancel this purchase order", row.department);
  if (row.status === "cancelled") throw new DiError(`${poNumber(row)} is already cancelled.`);
  if (!["draft", "issued"].includes(row.status)) throw new DiError(`${poNumber(row)} is ${row.status}: goods have already arrived, so it can no longer be cancelled.`);
  const live = (await tx.query("SELECT number FROM di.supplier_document WHERE po_id = $1 AND doc_type = 'invoice' AND status <> 'void' AND deleted_at IS NULL", [row.id])).rows;
  if (live.length) throw new DiError(`${live.map((d) => d.number).join(", ")} bills this order. Void or dispute the invoice first.`);
  const updated = (await tx.query(
    "UPDATE di.purchase_order SET status = 'cancelled', cancelled_at = now(), cancelled_by = $1, cancel_reason = $2 WHERE id = $3 RETURNING *",
    [who.username, cleanReason, row.id],
  )).rows[0];
  await tx.query("UPDATE di.supplier_document SET po_id = NULL, status = 'accepted' WHERE po_id = $1 AND doc_type = 'quotation' AND deleted_at IS NULL", [row.id]);
  const { lines, supplier } = await poWithLines(tx, updated);
  return { po: shapePo(updated, lines, supplier) };
}

export async function receiveGoods(tx, input = {}, { who, receipts = [], now = new Date() } = {}) {
  requireWho(who);
  const row = await loadPo(tx, input.po, { lock: true });
  if (!PO_OPEN.includes(row.status)) {
    throw new DiError(row.status === "draft" ? `${poNumber(row)} is still a draft; goods can only be received against an issued PO.` : `${poNumber(row)} is ${row.status}; there is nothing left to receive against it.`);
  }
  const lines = await poLines(tx, row.id);
  const today = todayMY(now);
  const received_on = dateField(input.received_on, "received_on") ?? today;
  if (received_on > today) throw new DiError("received_on is in the future");
  let items;
  if (input.receive_all) {
    items = lines.filter((l) => num(l.quantity) > num(l.received_qty)).map((l) => ({ line_no: Number(l.line_no), quantity: roundQty(num(l.quantity) - num(l.received_qty)) }));
  } else {
    if (!input.lines?.length) throw new DiError("Say what arrived: lines [{ line_no, quantity }], or receive_all=true if everything outstanding arrived.");
    items = input.lines.map((i) => ({ line_no: Number(i.line_no), quantity: roundQty(Number(i.quantity)) }));
  }
  if (!items.length) throw new DiError("Everything on this PO has already been received.");
  const seen = new Set();
  const recorded = [];
  for (const item of items) {
    const line = lines.find((l) => Number(l.line_no) === item.line_no);
    if (!line) throw new DiError(`PO ${poNumber(row)} has no line ${item.line_no}`);
    if (seen.has(item.line_no)) throw new DiError(`Line ${item.line_no} is listed twice`);
    seen.add(item.line_no);
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) throw new DiError(`Line ${item.line_no}: quantity must be more than 0`);
    const left = roundQty(num(line.quantity) - num(line.received_qty));
    if (item.quantity > left) throw new DiError(`Line ${item.line_no} (${line.description}): only ${left} still to come, but ${item.quantity} were reported. Ask the supplier about the difference rather than receiving extra.`);
    await tx.query("UPDATE di.purchase_order_line SET received_qty = received_qty + $1 WHERE id = $2", [item.quantity, line.id]);
    recorded.push({ line_no: item.line_no, description: line.description, quantity: item.quantity });
  }
  const file = receipts[0] ?? null;
  await tx.query(
    "INSERT INTO di.goods_receipt (po_id, received_on, received_by, note, lines, file_path, file_name, file_sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [row.id, received_on, who.username, text(input.note, "note", 500), JSON.stringify(recorded), file?.path ?? null, file?.name ?? null, file?.sha256 ?? null],
  );
  const after = await poLines(tx, row.id);
  const complete = after.every((l) => num(l.received_qty) >= num(l.quantity));
  const updated = (await tx.query("UPDATE di.purchase_order SET status = $1 WHERE id = $2 RETURNING *", [complete ? "received" : "partially_received", row.id])).rows[0];
  const supplier = (await tx.query("SELECT * FROM di.supplier WHERE id = $1", [row.supplier_id])).rows[0];
  const billed = (await tx.query("SELECT count(*)::int AS n FROM di.supplier_document WHERE po_id = $1 AND doc_type = 'invoice' AND status <> 'void' AND deleted_at IS NULL", [row.id])).rows[0].n;
  return {
    po: shapePo(updated, after, supplier, today), received: recorded,
    outstanding: after.filter((l) => num(l.quantity) > num(l.received_qty)).map((l) => ({ line_no: Number(l.line_no), description: l.description, outstanding: roundQty(num(l.quantity) - num(l.received_qty)) })),
    complete, invoices_to_check: billed,
  };
}

export async function poPdf(tx, { po } = {}, { who } = {}) {
  requireWho(who);
  const row = await loadPo(tx, po);
  if (row.status === "cancelled") throw new DiError(`${poNumber(row)} is cancelled.`);
  const { lines, supplier } = await poWithLines(tx, row);
  return { po: shapePo(row, lines, supplier), report: { po_id: row.id } };
}

export async function setPoPdfPath(tx, id, pdfPath) {
  await tx.query("UPDATE di.purchase_order SET pdf_path = $1 WHERE id = $2", [pdfPath, id]);
}

/** Everything the PO PDF needs. */
export async function loadPoReportData(tx, poId) {
  const po = await loadPo(tx, poId);
  const { lines, supplier } = await poWithLines(tx, po);
  const company = (await tx.query("SELECT * FROM di.company_profile WHERE tenant_id = di.current_tenant()")).rows[0] ?? null;
  return { po: shapePo(po, lines, supplier), supplier: supplier ? shapeSupplier(supplier) : null, company };
}

// ---------------------------------------------------------------- supplier documents

/** Pure: does a supplier invoice agree with the PO it bills, and with what has arrived? */
export function judgeMatch({ po, lines, invoiceTotal, invoicedToDate, currency = "MYR" }) {
  const receivedValue = round2(lines.reduce((s, l) => s + num(l.received_qty) * num(l.unit_price) * (1 + num(l.tax_rate) / 100), 0));
  const tolerance = Math.max(1, round2(num(po.total) * 0.01));
  const issues = [];
  if (invoicedToDate > num(po.total) + tolerance) {
    issues.push(`Billed ${cur(invoicedToDate, currency)} in total, which is ${cur(round2(invoicedToDate - num(po.total)), currency)} more than ${poNumber(po)} (${cur(num(po.total), currency)})`);
  }
  if (invoicedToDate > receivedValue + tolerance) {
    issues.push(`Billed ${cur(invoicedToDate, currency)} but only ${cur(receivedValue, currency)} of goods have been received so far`);
  }
  const fully = lines.length > 0 && lines.every((l) => num(l.received_qty) >= num(l.quantity));
  if (fully && Math.abs(invoicedToDate - num(po.total)) > tolerance && invoicedToDate <= num(po.total) + tolerance) {
    issues.push(`Everything has arrived but only ${cur(invoicedToDate, currency)} of ${cur(num(po.total), currency)} has been billed`);
  }
  return { status: issues.length ? "review" : "matched", issues, po_total: num(po.total), invoiced_to_date: invoicedToDate, received_value: receivedValue, tolerance };
}

async function invoiceMatch(tx, inv) {
  if (inv.doc_type !== "invoice") return null;
  if (!inv.po_id) return { status: "no_po", issues: ["Not linked to a purchase order, so it can't be checked against what was ordered or received"] };
  const po = (await tx.query("SELECT * FROM di.purchase_order WHERE id = $1", [inv.po_id])).rows[0];
  const lines = await poLines(tx, po.id);
  const billed = (await tx.query("SELECT coalesce(sum(total),0) AS t FROM di.supplier_document WHERE po_id = $1 AND doc_type = 'invoice' AND status <> 'void' AND deleted_at IS NULL", [po.id])).rows[0].t;
  const result = judgeMatch({ po, lines, invoiceTotal: num(inv.total), invoicedToDate: round2(num(billed)), currency: inv.currency });
  return inv.status === "void" ? { ...result, status: "void", issues: [] } : { ...result, po: poNumber(po) };
}

function shapeDocument(d, supplier, extra = {}, today = todayMY()) {
  const due = isoDate(d.due_date);
  const valid = isoDate(d.valid_until);
  return {
    id: d.id, number: d.number, type: d.doc_type, status: d.status,
    supplier: supplier ? { code: supplier.code, name: supplier.name } : null, supplier_ref: d.supplier_ref,
    doc_date: isoDate(d.doc_date), valid_until: valid, due_date: due, currency: d.currency,
    subtotal: num(d.subtotal), tax_total: num(d.tax_total), total: num(d.total),
    overdue: Boolean(d.doc_type === "invoice" && d.status === "unpaid" && due && due < today),
    expired: Boolean(d.doc_type === "quotation" && d.status === "received" && valid && valid < today),
    lines: d.lines ?? [], po_id: d.po_id ?? null,
    file: d.file_path ? { name: d.file_name, mime: d.file_mime, path: d.file_path } : null,
    note: d.note ?? null, paid_on: isoDate(d.paid_on), payment_ref: d.payment_ref ?? null, paid_by: d.paid_by ?? null, dispute_reason: d.dispute_reason ?? null,
    ...extra,
  };
}

async function findDocument(tx, ref, type = null) {
  const q = String(ref ?? "").trim();
  if (!q) throw new DiError("Give the document number (SQ-2026-0001 / SI-2026-0001) or id");
  const row = (await tx.query(
    `SELECT * FROM di.supplier_document WHERE deleted_at IS NULL AND ${isUuid(q) ? "id = $1::uuid" : "upper(number) = upper($1)"}`, [q],
  )).rows[0];
  if (!row || (type && row.doc_type !== type)) throw new DiError(`${type === "invoice" ? "Supplier invoice" : type === "quotation" ? "Supplier quotation" : "Supplier document"} ${q} not found`);
  const supplier = (await tx.query("SELECT * FROM di.supplier WHERE id = $1", [row.supplier_id])).rows[0];
  return { row, supplier };
}

export async function recordSupplierDocument(tx, input = {}, { who, receipts = [], now = new Date() } = {}) {
  requireWho(who);
  const type = input.doc_type;
  if (!["quotation", "invoice"].includes(type)) throw new DiError("doc_type must be quotation or invoice");
  const today = todayMY(now);
  const supplier = await resolveSupplier(tx, input.supplier);
  const supplier_ref = text(input.supplier_ref, "supplier_ref (the number printed on their document)", 80, { required: true });
  const doc_date = dateField(input.doc_date, "doc_date", { required: true });
  if (doc_date > addDays(today, 7)) throw new DiError(`doc_date ${doc_date} is in the future (today is ${today})`);
  const currency = await companyCurrency(tx);
  if (input.currency && String(input.currency).toUpperCase() !== currency) {
    throw new DiError(`Documents are recorded in ${currency}. Give the ${currency} total and note the original ${String(input.currency).toUpperCase()} amount.`);
  }
  const warnings = [];
  const hasLines = Array.isArray(input.lines) && input.lines.length > 0;
  const norm = normaliseLines(hasLines ? input.lines : [], { min: 0 });
  let total = input.total !== undefined ? Number(input.total) : null;
  if (total !== null && (!Number.isFinite(total) || total < 0)) throw new DiError("total must be zero or more (the grand total printed on the document)");
  if (total === null) {
    if (!hasLines) throw new DiError("Give the document's total, or its line items (description, quantity, unit_price).");
    total = norm.total;
  } else if (hasLines && Math.abs(norm.total - total) > 0.05) {
    warnings.push(`The lines add up to ${cur(norm.total, currency)} but the document total is ${cur(round2(total), currency)}; kept the printed total. Check for a missed line, discount or rounding.`);
  }
  total = round2(total);
  const tax_total = input.tax_total !== undefined ? round2(Number(input.tax_total)) : norm.tax_total;
  const subtotal = round2(total - tax_total);
  const files = receipts;
  // duplicates: the same supplier number, or the same file
  const sameRef = (await tx.query(
    "SELECT number FROM di.supplier_document WHERE supplier_id = $1 AND doc_type = $2 AND lower(supplier_ref) = lower($3) AND status <> 'void' AND deleted_at IS NULL LIMIT 1", [supplier.id, type, supplier_ref],
  )).rows[0];
  const sameFile = files.length ? (await tx.query("SELECT number FROM di.supplier_document WHERE file_sha256 = ANY($1::text[]) AND status <> 'void' AND deleted_at IS NULL LIMIT 1", [files.map((f) => f.sha256)])).rows[0] : null;
  const duplicate = sameRef ? `${sameRef.number} is already ${supplier.name}'s ${type} ${supplier_ref}` : sameFile ? `That file is already recorded as ${sameFile.number}` : null;
  if (duplicate && !input.allow_duplicate) throw new DiError(`Possible duplicate: ${duplicate}. Record it again with allow_duplicate=true only if the user confirms it is a different document.`);
  if (duplicate) warnings.push(`Recorded despite a possible duplicate: ${duplicate}`);

  let po = null;
  if (input.po) {
    if (type !== "invoice") throw new DiError("Only a supplier invoice is linked to a PO when it is recorded; a quotation becomes a PO with create_po_draft from_quotation.");
    po = await loadPo(tx, input.po);
    if (po.supplier_id !== supplier.id) throw new DiError(`${poNumber(po)} is addressed to a different supplier than ${supplier.name}.`);
    if (!["issued", "partially_received", "received"].includes(po.status)) throw new DiError(`${poNumber(po)} is ${po.status}; an invoice can only be matched to an issued order.`);
  }
  const valid_until = dateField(input.valid_until, "valid_until");
  const terms = supplier.payment_terms_days ?? po?.payment_terms_days ?? DEFAULT_TERMS_DAYS;
  const due_date = type === "invoice" ? (dateField(input.due_date, "due_date") ?? addDays(doc_date, Number(terms))) : null;
  if (type === "invoice" && !input.due_date) warnings.push(`No due date given; used ${terms} days from the invoice date (${due_date})`);
  const number = await nextNumber(tx, type === "quotation" ? "supplier_quotation" : "supplier_invoice", today);
  const first = files[0] ?? null;
  const row = (await tx.query(
    `INSERT INTO di.supplier_document (number, doc_type, supplier_id, supplier_ref, doc_date, valid_until, due_date, currency, subtotal, tax_total, total, lines, status, po_id, file_path, file_name, file_mime, file_sha256, note, custom)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [number, type, supplier.id, supplier_ref, doc_date, valid_until, due_date, currency, subtotal, tax_total, total, JSON.stringify(hasLines ? norm.lines : []),
      type === "quotation" ? "received" : "unpaid", po?.id ?? null, first?.path ?? null, first?.name ?? null, first?.mime ?? null, first?.sha256 ?? null,
      text(input.note, "note", 500), JSON.stringify({ ...(input.custom ?? {}), ...(files.length > 1 ? { more_files: files.slice(1).map((f) => ({ name: f.name, mime: f.mime, path: f.path, sha256: f.sha256 })) } : {}) })],
  )).rows[0];
  if (!files.length) warnings.push("No file attached; the original document should still be kept somewhere");
  const match = await invoiceMatch(tx, row);
  return { document: shapeDocument(row, supplier, {}, today), ...(match ? { match } : {}), warnings };
}

export async function getSupplierDocument(tx, { doc } = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  const { row, supplier } = await findDocument(tx, doc);
  const po = row.po_id ? (await tx.query("SELECT number, id, status FROM di.purchase_order WHERE id = $1", [row.po_id])).rows[0] : null;
  const match = await invoiceMatch(tx, row);
  return { document: shapeDocument(row, supplier, { po: po ? poNumber(po) : null }, todayMY(now)), ...(match ? { match } : {}) };
}

export async function listSupplierDocuments(tx, { doc_type, supplier, status, query, limit } = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  const values = [];
  const arg = (v) => { values.push(v); return `$${values.length}`; };
  const conds = ["d.deleted_at IS NULL"];
  if (doc_type) conds.push(`d.doc_type = ${arg(doc_type)}`);
  if (supplier) conds.push(`d.supplier_id = ${arg((await resolveSupplier(tx, supplier)).id)}::uuid`);
  if (status === "overdue") conds.push(`d.doc_type = 'invoice' AND d.status = 'unpaid' AND d.due_date < ${arg(todayMY(now))}::date`);
  else if (status) conds.push(`d.status = ${arg(status)}`);
  if (query) {
    const p = arg(`%${String(query).toLowerCase().replace(/[\\%_]/g, "\\$&")}%`);
    conds.push(`(lower(d.number) LIKE ${p} OR lower(d.supplier_ref) LIKE ${p} OR lower(s.name) LIKE ${p})`);
  }
  const max = Math.min(Math.max(Number(limit) || 30, 1), 50);
  const rows = (await tx.query(
    `SELECT d.*, s.name AS supplier_name, s.code AS supplier_code, p.number AS po_number FROM di.supplier_document d
       JOIN di.supplier s ON s.id = d.supplier_id LEFT JOIN di.purchase_order p ON p.id = d.po_id
      WHERE ${conds.join(" AND ")} ORDER BY d.doc_date DESC, d.number DESC LIMIT ${max + 1}`, values,
  )).rows;
  const today = todayMY(now);
  return {
    documents: rows.slice(0, max).map((d) => {
      const s = shapeDocument(d, { code: d.supplier_code, name: d.supplier_name }, {}, today);
      return { id: s.id, number: s.number, type: s.type, status: s.status, supplier: `${d.supplier_code} ${d.supplier_name}`, supplier_ref: s.supplier_ref, doc_date: s.doc_date, due_date: s.due_date, valid_until: s.valid_until, total: s.total, overdue: s.overdue, expired: s.expired, po: d.po_number ?? null };
    }),
    has_more: rows.length > max,
  };
}

export async function decideQuotation(tx, { doc, decision, note } = {}, { who } = {}) {
  requireWho(who);
  if (!["accept", "reject"].includes(decision)) throw new DiError("decision must be accept or reject");
  const { row, supplier } = await findDocument(tx, doc, "quotation");
  if (row.status === "converted") throw new DiError(`${row.number} has already become a purchase order.`);
  if (decision === "reject" && row.po_id) throw new DiError(`${row.number} already has a draft PO; cancel that first.`);
  const status = decision === "accept" ? "accepted" : "rejected";
  const updated = (await tx.query("UPDATE di.supplier_document SET status = $1, note = coalesce($2, note) WHERE id = $3 RETURNING *", [status, text(note, "note", 500), row.id])).rows[0];
  return { document: shapeDocument(updated, supplier), next: decision === "accept" ? "Use create_po_draft with from_quotation to turn it into a purchase order." : undefined };
}

export async function setInvoiceStatus(tx, input = {}, { who, now = new Date() } = {}) {
  requireWho(who);
  const { row, supplier } = await findDocument(tx, input.invoice, "invoice");
  const status = input.status;
  const today = todayMY(now);
  const warnings = [];
  if (row.status === "paid" || row.status === "void") throw new DiError(`${row.number} is ${row.status} and final.`);
  let patch;
  if (status === "disputed") {
    if (row.status !== "unpaid") throw new DiError(`${row.number} is ${row.status}; only an unpaid invoice can be disputed.`);
    patch = { status: "disputed", dispute_reason: text(input.reason, "reason", 400, { required: true }) };
  } else {
    const department = row.po_id ? (await tx.query("SELECT department FROM di.purchase_order WHERE id = $1", [row.po_id])).rows[0]?.department ?? null : null;
    if (!mayApprove(who, department)) throw approverOnly(`mark this invoice ${status === "unpaid" ? "resolved" : status}`, department);
    if (status === "unpaid") {
      if (row.status !== "disputed") throw new DiError(`${row.number} is not disputed.`);
      patch = { status: "unpaid", dispute_reason: null };
    } else if (status === "void") {
      patch = { status: "void", note: text(input.reason, "reason", 400, { required: true }) };
    } else if (status === "paid") {
      const paid_on = dateField(input.paid_on, "paid_on") ?? today;
      if (paid_on > today) throw new DiError("paid_on is in the future");
      const match = await invoiceMatch(tx, row);
      if (match?.status === "review" && !input.confirm_mismatch) {
        throw new DiError(`${row.number} does not match its purchase order: ${match.issues.join("; ")}. Tell the user, and mark it paid only with confirm_mismatch=true after they confirm.`);
      }
      if (match?.status === "no_po") warnings.push("This invoice is not linked to a purchase order");
      if (row.status === "disputed" && !input.confirm_mismatch) throw new DiError(`${row.number} is disputed (${row.dispute_reason}). Resolve the dispute first, or pass confirm_mismatch=true if the user confirms paying anyway.`);
      patch = { status: "paid", paid_on, paid_amount: num(row.total), payment_ref: text(input.reference, "reference", 120), paid_by: who.username };
    } else throw new DiError("status must be paid, disputed, unpaid (resolve a dispute) or void");
  }
  const cols = Object.keys(patch);
  const updated = (await tx.query(`UPDATE di.supplier_document SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1} RETURNING *`, [...cols.map((c) => patch[c]), row.id])).rows[0];
  return { document: shapeDocument(updated, supplier, {}, today), ...(warnings.length ? { warnings } : {}) };
}

export async function getSupplierDocumentFile(tx, id, { who } = {}) {
  requireWho(who);
  if (!isUuid(id)) throw new DiError("Document id is required");
  const row = (await tx.query("SELECT file_path, file_name, file_mime FROM di.supplier_document WHERE id = $1::uuid AND deleted_at IS NULL AND file_path IS NOT NULL", [id])).rows[0];
  if (!row) throw new DiError("File not found");
  return { path: row.file_path, name: row.file_name, mime: row.file_mime };
}

// ---------------------------------------------------------------- overview

export async function procurementOverview(tx, _args, { who, now = new Date() } = {}) {
  requireWho(who);
  const today = todayMY(now);
  const soon = addDays(today, 7);
  const one = async (sql, params = []) => (await tx.query(sql, params)).rows[0];
  const pos = (await tx.query("SELECT status, count(*)::int AS n, coalesce(sum(total),0) AS total FROM di.purchase_order WHERE deleted_at IS NULL GROUP BY status")).rows;
  const byStatus = Object.fromEntries(pos.map((r) => [r.status, { count: r.n, total: round2(num(r.total)) }]));
  const awaiting = await one("SELECT count(*)::int AS n, coalesce(sum(total),0) AS t FROM di.purchase_order WHERE status IN ('issued','partially_received') AND deleted_at IS NULL");
  const lateDelivery = (await tx.query(
    `SELECT p.number, p.expected_date, s.name FROM di.purchase_order p JOIN di.supplier s ON s.id = p.supplier_id
      WHERE p.status IN ('issued','partially_received') AND p.expected_date < $1::date AND p.deleted_at IS NULL ORDER BY p.expected_date LIMIT 10`, [today],
  )).rows;
  const inv = await one(
    `SELECT count(*) FILTER (WHERE status = 'unpaid')::int AS unpaid_n, coalesce(sum(total) FILTER (WHERE status = 'unpaid'),0) AS unpaid,
            count(*) FILTER (WHERE status = 'unpaid' AND due_date < $1::date)::int AS overdue_n, coalesce(sum(total) FILTER (WHERE status = 'unpaid' AND due_date < $1::date),0) AS overdue,
            count(*) FILTER (WHERE status = 'unpaid' AND due_date >= $1::date AND due_date <= $2::date)::int AS soon_n, coalesce(sum(total) FILTER (WHERE status = 'unpaid' AND due_date >= $1::date AND due_date <= $2::date),0) AS soon,
            count(*) FILTER (WHERE status = 'disputed')::int AS disputed_n, coalesce(sum(total) FILTER (WHERE status = 'disputed'),0) AS disputed
       FROM di.supplier_document WHERE doc_type = 'invoice' AND deleted_at IS NULL`, [today, soon],
  );
  const overdueList = (await tx.query(
    `SELECT d.number, d.supplier_ref, d.total, d.due_date, s.name FROM di.supplier_document d JOIN di.supplier s ON s.id = d.supplier_id
      WHERE d.doc_type = 'invoice' AND d.status = 'unpaid' AND d.due_date < $1::date AND d.deleted_at IS NULL ORDER BY d.due_date LIMIT 10`, [today],
  )).rows;
  const quotes = await one(
    `SELECT count(*) FILTER (WHERE status = 'received')::int AS open_n,
            count(*) FILTER (WHERE status = 'received' AND valid_until IS NOT NULL AND valid_until < $1::date)::int AS expired_n,
            count(*) FILTER (WHERE status = 'accepted')::int AS accepted_n
       FROM di.supplier_document WHERE doc_type = 'quotation' AND deleted_at IS NULL`, [today],
  );
  const needsReview = [];
  for (const d of (await tx.query("SELECT * FROM di.supplier_document WHERE doc_type = 'invoice' AND status IN ('unpaid','disputed') AND po_id IS NOT NULL AND deleted_at IS NULL")).rows) {
    const m = await invoiceMatch(tx, d);
    if (m?.status === "review") needsReview.push({ number: d.number, supplier_ref: d.supplier_ref, total: num(d.total), issues: m.issues });
  }
  const suppliers = (await one("SELECT count(*)::int AS n FROM di.supplier WHERE deleted_at IS NULL")).n;
  const withoutPo = (await one("SELECT count(*)::int AS n FROM di.supplier_document WHERE doc_type = 'invoice' AND status = 'unpaid' AND po_id IS NULL AND deleted_at IS NULL")).n;
  return {
    today, suppliers,
    purchase_orders: { by_status: byStatus, awaiting_delivery: { count: awaiting.n, value: round2(num(awaiting.t)) }, late_deliveries: lateDelivery.map((p) => ({ number: p.number, supplier: p.name, expected_date: isoDate(p.expected_date) })) },
    invoices: {
      unpaid: { count: inv.unpaid_n, total: round2(num(inv.unpaid)) }, overdue: { count: inv.overdue_n, total: round2(num(inv.overdue)) },
      due_within_7_days: { count: inv.soon_n, total: round2(num(inv.soon)) }, disputed: { count: inv.disputed_n, total: round2(num(inv.disputed)) },
      unpaid_without_po: withoutPo,
      overdue_list: overdueList.map((d) => ({ number: d.number, supplier: d.name, supplier_ref: d.supplier_ref, total: num(d.total), due_date: isoDate(d.due_date) })),
      not_matching_po: needsReview,
    },
    quotations: { open: quotes.open_n, expired_unanswered: quotes.expired_n, accepted_not_ordered: quotes.accepted_n },
  };
}
