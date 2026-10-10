// Procurement on a real Postgres engine (PGlite): suppliers with duplicate matching, supplier
// quotations and invoices as evidence, PO drafts that freeze when an admin issues them, goods
// received against lines, and the invoice-vs-PO-vs-received match that guards payment.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter, withContext } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { runTool, describeError } from "../core/actions.mjs";
import { AGENTS, TOOLS, toolsFor } from "../core/tools.mjs";
import { judgeMatch, normaliseLines } from "../core/procurement.mjs";
import { renderPoHtml } from "../core/procurement-report.mjs";
import { demoDocumentHtml, seedDemoProcurement } from "../core/procurement-demo.mjs";

const round = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const USERS = {
  "tok-admin": { id: "u-admin", username: "admin", display_name: "Admin", role: "admin", email: null },
  "tok-aisyah": { id: "u-aisyah", username: "aisyah", display_name: "Aisyah Rahman", role: "user", email: "aisyah@acme.test" },
  "tok-hana": { id: "u-hana", username: "hana", display_name: "Hana Ops", role: "department_head", department: "Ops", email: "hana@acme.test" },
  "tok-sam": { id: "u-sam", username: "sam", display_name: "Sam Sales", role: "user", department: "Sales", email: "sam@acme.test" },
};

const rejects = async (promise, pattern) => {
  try {
    await promise;
  } catch (error) {
    assert.match(describeError(error), pattern);
    return;
  }
  assert.fail(`expected rejection matching ${pattern}`);
};

async function setup() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const mk = async (name) => (await db.query("INSERT INTO di.tenant (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
  const tenantA = await mk("A");
  const tenantB = await mk("B");
  await seedTenant(db, tenantA);
  await seedTenant(db, tenantB);
  await db.query("UPDATE di.company_profile SET name = 'Acme Sdn Bhd', currency = 'MYR' WHERE tenant_id = $1", [tenantA]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-proc-"));
  const clock = { now: new Date("2026-10-02T04:00:00Z") }; // 2 Oct 2026, noon in Malaysia
  const deps = (tenantId) => ({
    db, tenantId: () => tenantId, workspace: (agent) => path.join(dir, agent), now: () => clock.now,
    resolveIdentity: async (code) => USERS[code] ?? null,
    renderPdf: async (html, abs) => { await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, html); },
  });
  let counter = 0;
  const inbox = async (name, kind = "pdf") => {
    const salt = `n${counter++}`;
    const rel = `_inbox/1759${String(counter).padStart(9, "0")}-0-${name}`;
    await mkdir(path.join(dir, "di-procurement", "_inbox"), { recursive: true });
    await writeFile(path.join(dir, "di-procurement", rel), kind === "pdf" ? Buffer.from(`%PDF-1.4\n% ${salt}\n`) : Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from(salt)]));
    return rel;
  };
  const as = (who, tenantId = tenantA) => (tool, args = {}) =>
    runTool(deps(tenantId), { agent: "di-procurement", tool, args: { identity: `tok-${who}`, ...args } });
  return { db, tenantA, tenantB, dir, clock, as, inbox, deps };
}

const cableLines = [
  { description: "Cable 4mm (100m)", quantity: 10, unit_price: 120, tax_rate: 8, unit: "roll" },
  { description: "Isolator 32A", quantity: 20, unit_price: 45, tax_rate: 8 },
];

test("the role prompt stays small and names every tool", async () => {
  const text = await readFile(new URL("../../agent/roles/di-procurement.md", import.meta.url), "utf8");
  assert.ok(text.length <= 4000, `di-procurement.md is ${text.length} chars; cap is 4000`);
  for (const tool of toolsFor("di-procurement")) assert.ok(text.includes(`\`${tool.name}\``), `the role prompt never mentions ${tool.name}`);
});

test("line maths and the match rule are pure and exact", () => {
  const n = normaliseLines(cableLines, { min: 1 });
  assert.deepEqual([n.subtotal, n.tax_total, n.total], [2100, 168, 2268]);
  assert.equal(n.lines[0].total, 1296);
  const fractional = normaliseLines([{ description: "Cable", quantity: 1.2344, unit_price: 10.004, tax_rate: 8.004 }]);
  assert.deepEqual([fractional.lines[0].quantity, fractional.lines[0].unit_price, fractional.lines[0].tax_rate, fractional.total], [1.234, 10, 8, 13.33]);
  assert.throws(() => normaliseLines([{ description: "x", quantity: 0.0001, unit_price: 1 }]), /quantity/);
  assert.throws(() => normaliseLines([{ description: "x", quantity: 0, unit_price: 1 }]), /quantity must be more than 0/);
  assert.throws(() => normaliseLines([{ description: "x", quantity: 1, unit_price: -1 }]), /unit_price/);
  assert.throws(() => normaliseLines([], { min: 1 }), /At least 1 line item/);
  const po = { id: "p", number: "PO-2026-0001", total: 1000 };
  const lines = [{ quantity: 10, received_qty: 5, unit_price: 100, tax_rate: 0 }];
  assert.equal(judgeMatch({ po, lines, invoicedToDate: 500 }).status, "matched");
  assert.match(judgeMatch({ po, lines, invoicedToDate: 1000 }).issues.join(" "), /only MYR 500\.00 of goods have been received/);
  assert.match(judgeMatch({ po, lines: [{ quantity: 10, received_qty: 10, unit_price: 100, tax_rate: 0 }], invoicedToDate: 1200 }).issues.join(" "), /more than PO-2026-0001/);
  assert.match(judgeMatch({ po, lines: [{ quantity: 10, received_qty: 10, unit_price: 100, tax_rate: 0 }], invoicedToDate: 400 }).issues.join(" "), /only MYR 400\.00 of MYR 1,000\.00 has been billed/);
  assert.equal(judgeMatch({ po, lines: [{ quantity: 10, received_qty: 10, unit_price: 100, tax_rate: 0 }], invoicedToDate: 1000.5 }).status, "matched", "within tolerance");
});

test("procurement", async (t) => {
  const { db, tenantA, tenantB, dir, clock, as, inbox, deps } = await setup();
  const admin = as("admin");
  const aisyah = as("aisyah");
  let maju;
  let solar;
  let quote;
  let po;
  let inv1;

  await t.test("every procurement tool needs a signed-in user", async () => {
    await rejects(runTool(deps(tenantA), { agent: "di-procurement", tool: "find_suppliers", args: {} }), /Sign-in required/);
    await rejects(runTool(deps(tenantA), { agent: "di-procurement", tool: "procurement_overview", args: { identity: "forged" } }), /Sign-in required/);
    for (const tool of toolsFor("di-procurement")) assert.equal(tool.identity, true, `${tool.name} must resolve the signed-in user`);
  });

  await t.test("suppliers: record once, match duplicates, update", async () => {
    const out = await aisyah("save_supplier", { name: "Maju Elektrik Sdn Bhd", reg_no: "202001012345", email: "sales@majuelektrik.example", phone: "03-1234 5678", contact_name: "Lim", payment_terms_days: 30, address: "Lot 5, Jalan Industri 3, Shah Alam" });
    maju = out.supplier.code;
    assert.equal(maju, "S-0001");
    assert.equal(out.supplier.address.line1, "Lot 5, Jalan Industri 3, Shah Alam");
    await rejects(aisyah("save_supplier", { name: "Maju Elektrik Sdn. Bhd." }), /S-0001 Maju Elektrik Sdn Bhd already looks like this supplier \(same company name\)/);
    await rejects(aisyah("save_supplier", { name: "Totally Different", reg_no: "2020-01-012345" }), /same registration number/);
    await rejects(aisyah("save_supplier", { name: "Other Co", email: "SALES@majuelektrik.example" }), /same email/);
    await rejects(aisyah("save_supplier", { name: "Other Co", phone: "+60 3-1234 5678" }), /same phone/);
    await rejects(aisyah("save_supplier", { email: "x@y.test" }), /needs a name/);
    await rejects(aisyah("save_supplier", { name: "Bad Email Co", email: "nope" }), /does not look valid/);
    const forced = await aisyah("save_supplier", { name: "Maju Elektrik Sdn Bhd (Penang)", allow_duplicate: true });
    assert.equal(forced.supplier.code, "S-0002");
    solar = (await aisyah("save_supplier", { name: "Solar Parts Asia Sdn Bhd", email: "orders@solarparts.example", payment_terms_days: 14 })).supplier.code;
    assert.equal(solar, "S-0003");
    const similar = await aisyah("save_supplier", { name: "Solar Panels Asia Sdn Bhd" });
    assert.match(similar.warnings.join(" "), /Similar to S-0003/);
    const updated = await aisyah("save_supplier", { supplier: "S-0001", contact_name: "Lim Wei", payment_terms_days: 45 });
    assert.equal(updated.created, false);
    assert.equal(updated.supplier.payment_terms_days, 45);
    await aisyah("save_supplier", { supplier: "S-0001", payment_terms_days: 30 });
    const found = await aisyah("find_suppliers", { query: "maju" });
    assert.deepEqual(found.suppliers.map((s) => s.code), ["S-0001", "S-0002"]);
    await rejects(aisyah("get_supplier", { supplier: "Maju" }), /matches 2 suppliers/);
    await rejects(aisyah("get_supplier", { supplier: "Nobody Ltd" }), /No supplier matches/);
  });

  await t.test("a supplier quotation is recorded with its file, once", async () => {
    const out = await aisyah("record_supplier_document", {
      doc_type: "quotation", supplier: maju, supplier_ref: "QT-8841", doc_date: "2026-09-25", valid_until: "2026-10-25",
      total: 2268, lines: cableLines, files: [await inbox("quote.pdf")],
    });
    quote = out.document.number;
    assert.equal(quote, "SQ-2026-0001");
    assert.equal(out.document.status, "received");
    assert.equal(out.document.total, 2268);
    assert.equal(out.document.file.name, "quote.pdf");
    assert.ok(out.shared_files.length === 1, "the supplier's file is kept in shared storage");
    assert.deepEqual(out.warnings, []);
    await rejects(aisyah("record_supplier_document", { doc_type: "quotation", supplier: maju, supplier_ref: "qt-8841", doc_date: "2026-09-26", total: 5 }), /already Maju Elektrik Sdn Bhd's quotation qt-8841/);
  });

  await t.test("refusals: dates, currency, missing money, wrong links, duplicate files", async () => {
    const base = { doc_type: "invoice", supplier: maju, supplier_ref: "X-1", doc_date: "2026-10-01", total: 10 };
    await rejects(aisyah("record_supplier_document", { ...base, doc_date: "2026-12-25" }), /in the future/);
    await rejects(aisyah("record_supplier_document", { ...base, doc_date: "1 Oct" }), /YYYY-MM-DD/);
    await rejects(aisyah("record_supplier_document", { ...base, currency: "usd" }), /recorded in MYR/);
    await rejects(aisyah("record_supplier_document", { ...base, total: undefined }), /total, or its line items/);
    await rejects(aisyah("record_supplier_document", { ...base, supplier: "S-0099" }), /No supplier matches/);
    await rejects(aisyah("record_supplier_document", { ...base, doc_type: "receipt" }), /Invalid input|doc_type/);
    await rejects(aisyah("record_supplier_document", { ...base, po: "PO-2026-0001" }), /Purchase order PO-2026-0001 not found/);
    await rejects(aisyah("record_supplier_document", { ...base, doc_type: "quotation", po: "PO-2026-0001" }), /Only a supplier invoice is linked/);
    const rel = await inbox("dup.pdf");
    await aisyah("record_supplier_document", { ...base, supplier_ref: "X-2", files: [rel] });
    const copy = path.join(dir, "di-procurement", rel);
    await writeFile(path.join(dir, "di-procurement", "_inbox", "1759999999999-0-copy.pdf"), await readFile(copy));
    await rejects(aisyah("record_supplier_document", { ...base, supplier_ref: "X-3", files: ["_inbox/1759999999999-0-copy.pdf"] }), /already recorded as SI-/);
    const forced = await aisyah("record_supplier_document", { ...base, supplier_ref: "X-3", files: ["_inbox/1759999999999-0-copy.pdf"], allow_duplicate: true });
    assert.match(forced.warnings.join(" "), /despite a possible duplicate/);
    const mismatch = await aisyah("record_supplier_document", { ...base, supplier_ref: "X-4", total: 100, lines: [{ description: "a", quantity: 1, unit_price: 90 }] });
    assert.match(mismatch.warnings.join(" "), /lines add up to MYR 90\.00 but the document total is MYR 100\.00/);
    assert.equal(mismatch.document.total, 100, "the printed total is what is kept");
    assert.match(mismatch.warnings.join(" "), /No file attached/);
    assert.equal(mismatch.document.due_date, "2026-10-31", "due date defaults to the supplier's 30 days");
    for (const n of ["SI-2026-0001", "SI-2026-0002", "SI-2026-0003"]) await admin("set_supplier_invoice_status", { invoice: n, status: "void", reason: "test data" });
  });

  await t.test("a draft PO from the quotation; only drafts are editable", async () => {
    await rejects(aisyah("create_po_draft", { supplier: maju, lines: [] }), /At least 1 line item/);
    await rejects(aisyah("create_po_draft", { from_quotation: quote, supplier: solar }), /is from Maju Elektrik Sdn Bhd, not Solar/);
    await rejects(aisyah("create_po_draft", { from_quotation: "SQ-2026-0999" }), /not found/);
    const out = await aisyah("create_po_draft", { from_quotation: quote, expected_date: "2026-10-20", ship_to: "Acme warehouse, Shah Alam", notes: "Deliver before 5pm" });
    po = out.po.number;
    assert.match(po, /^DRAFT-[0-9a-f]{8}$/);
    assert.equal(out.po.status, "draft");
    assert.equal(out.po.total, 2268);
    assert.equal(out.po.lines.length, 2);
    assert.equal(out.po.payment_terms_days, 30, "terms come from the supplier");
    assert.equal(out.from_quotation, quote);
    assert.equal((await aisyah("get_supplier_document", { doc: quote })).document.status, "accepted", "using a quotation accepts it");
    await rejects(aisyah("create_po_draft", { from_quotation: quote }), /already has DRAFT-/);
    const edited = await aisyah("update_po_draft", { po, notes: "Deliver before 4pm", lines: [{ ...cableLines[0], quantity: 12 }, cableLines[1]] });
    assert.equal(edited.po.total, round(12 * 120 * 1.08 + 20 * 45 * 1.08));
    assert.equal(edited.po.lines.length, 2);
    assert.equal(edited.po.lines[0].quantity, 12);
    await aisyah("update_po_draft", { po, lines: cableLines });
    await rejects(aisyah("update_po_draft", { po }), /Nothing to change/);
    await rejects(aisyah("update_po_draft", { po, expected_date: "2026-09-01" }), /before the order date/);
    const preview = await aisyah("po_pdf", { po });
    assert.match(preview.pdf.name, /DRAFT-[0-9a-f]{8}-draft\.pdf$/);
    const html = await readFile(path.join(dir, "di-procurement", "purchase-orders", preview.pdf.name), "utf8");
    assert.match(html, /Draft, not yet issued/);
    assert.match(html, /Maju Elektrik Sdn Bhd/);
  });

  await t.test("only an admin issues; issuing numbers, freezes and makes the PDF", async () => {
    await rejects(aisyah("issue_po", { po }), /Only a Superadmin can issue/);
    const out = await admin("issue_po", { po });
    po = out.po.number;
    assert.equal(po, "PO-2026-0001");
    assert.equal(out.po.status, "issued");
    assert.equal(out.po.issued_by, "admin");
    assert.match(out.pdf.name, /^PO-2026-0001\.pdf$/);
    const html = await readFile(path.join(dir, "di-procurement", "purchase-orders", "PO-2026-0001.pdf"), "utf8");
    assert.match(html, /Issued/);
    assert.match(html, /Deliver before 4pm|Deliver before 5pm/);
    assert.match(html, /Acme Sdn Bhd/, "company letterhead");
    assert.equal((await aisyah("get_supplier_document", { doc: quote })).document.status, "converted");
    assert.match((await db.query("SELECT pdf_path FROM di.purchase_order WHERE number = 'PO-2026-0001'")).rows[0].pdf_path, /^\/files\/[a-f0-9]{64}\//);
    await rejects(admin("issue_po", { po }), /only a draft can be issued/);
    await rejects(aisyah("update_po_draft", { po, notes: "x" }), /only a draft can be edited/);
    const again = await aisyah("po_pdf", { po });
    assert.equal(again.report_scope, "stored PDF of the issued order");
    assert.equal(again.pdf.id, out.pdf.id);
  });

  await t.test("the database itself freezes an issued PO and caps receiving", async () => {
    const ctx = { tenantId: tenantA, actor: "test", agent: "test" };
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.purchase_order SET total = 1 WHERE number = 'PO-2026-0001'")), /is issued and frozen/);
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.purchase_order SET status = 'draft' WHERE number = 'PO-2026-0001'")), /frozen|cannot go from/);
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.purchase_order_line SET quantity = 1 WHERE description LIKE 'Cable%'")), /frozen; only the received quantity changes/);
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.purchase_order_line SET received_qty = 999 WHERE description LIKE 'Cable%'")), /Cannot receive 999/);
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.purchase_order_line SET deleted_at = now() WHERE description LIKE 'Cable%'")), /frozen/);
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("DELETE FROM di.purchase_order")), /Hard delete is disabled|permission denied/);
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.supplier_document SET total = 1")), /evidence and cannot be edited/);
  });

  await t.test("receiving: partial, never beyond the order, then complete", async () => {
    await rejects(aisyah("receive_goods", { po: "DRAFT-00000000", receive_all: true }), /not found/);
    await rejects(aisyah("receive_goods", { po }), /Say what arrived/);
    await rejects(aisyah("receive_goods", { po, lines: [{ line_no: 1, quantity: 11 }] }), /only 10 still to come, but 11 were reported/);
    await rejects(aisyah("receive_goods", { po, lines: [{ line_no: 9, quantity: 1 }] }), /has no line 9/);
    await rejects(aisyah("receive_goods", { po, lines: [{ line_no: 1, quantity: 1 }, { line_no: 1, quantity: 1 }] }), /listed twice/);
    await rejects(aisyah("receive_goods", { po, lines: [{ line_no: 1, quantity: 0 }] }), /more than 0/);
    const first = await aisyah("receive_goods", { po, lines: [{ line_no: 1, quantity: 10 }], note: "Cables on the 8am lorry", files: [await inbox("do-1.pdf")] });
    assert.equal(first.po.status, "partially_received");
    assert.equal(first.complete, false);
    assert.deepEqual(first.outstanding.map((o) => [o.line_no, o.outstanding]), [[2, 20]]);
    assert.equal(first.shared_files.length, 1, "the delivery order is kept");
    assert.equal((await aisyah("get_po", { po })).goods_receipts[0].note, "Cables on the 8am lorry");
  });

  await t.test("an invoice is checked against the PO and what has arrived", async () => {
    const out = await aisyah("record_supplier_document", { doc_type: "invoice", supplier: maju, supplier_ref: "INV-5521", doc_date: "2026-10-01", total: 2268, po, files: [await inbox("inv-5521.pdf")] });
    inv1 = out.document.number;
    assert.match(inv1, /^SI-2026-\d{4}$/);
    assert.equal(out.match.status, "review");
    assert.match(out.match.issues.join(" "), /only MYR 1,296\.00 of goods have been received so far/);
    assert.equal(out.document.due_date, "2026-10-31");
    await rejects(admin("set_supplier_invoice_status", { invoice: inv1, status: "paid" }), /does not match its purchase order/);
    const rest = await aisyah("receive_goods", { po, receive_all: true });
    assert.equal(rest.po.status, "received");
    assert.equal(rest.complete, true);
    assert.equal(rest.invoices_to_check, 1);
    await rejects(aisyah("receive_goods", { po, receive_all: true }), /nothing left to receive/);
    const now = await aisyah("get_supplier_document", { doc: inv1 });
    assert.equal(now.match.status, "matched");
    assert.equal(now.document.po, "PO-2026-0001");
  });

  await t.test("paying: admin only, final, and a mismatch needs the user's confirmation", async () => {
    await rejects(aisyah("set_supplier_invoice_status", { invoice: inv1, status: "paid" }), /Only a Superadmin can mark this invoice paid/);
    const over = await aisyah("record_supplier_document", { doc_type: "invoice", supplier: maju, supplier_ref: "INV-5530", doc_date: "2026-10-02", total: 300, po });
    assert.equal(over.match.status, "review");
    assert.match(over.match.issues.join(" "), /more than PO-2026-0001/);
    await rejects(admin("set_supplier_invoice_status", { invoice: over.document.number, status: "paid" }), /does not match/);
    await rejects(aisyah("set_supplier_invoice_status", { invoice: over.document.number, status: "disputed" }), /reason/);
    const disputed = await aisyah("set_supplier_invoice_status", { invoice: over.document.number, status: "disputed", reason: "We never ordered this extra item" });
    assert.equal(disputed.document.status, "disputed");
    await rejects(admin("set_supplier_invoice_status", { invoice: over.document.number, status: "paid", confirm_mismatch: false }), /does not match/);
    await rejects(aisyah("set_supplier_invoice_status", { invoice: over.document.number, status: "void", reason: "x" }), /Only a Superadmin/);
    const voided = await admin("set_supplier_invoice_status", { invoice: over.document.number, status: "void", reason: "Supplier agreed to cancel it" });
    assert.equal(voided.document.status, "void");
    await rejects(admin("set_supplier_invoice_status", { invoice: over.document.number, status: "paid" }), /is void and final/);
    const paid = await admin("set_supplier_invoice_status", { invoice: inv1, status: "paid", paid_on: "2026-10-02", reference: "IBG 88123" });
    assert.equal(paid.document.status, "paid");
    assert.equal(paid.document.paid_on, "2026-10-02");
    assert.equal(paid.document.paid_by, "admin");
    await rejects(admin("set_supplier_invoice_status", { invoice: inv1, status: "void", reason: "oops" }), /is paid and final/);
    await rejects(admin("set_supplier_invoice_status", { invoice: inv1, status: "paid", paid_on: "2026-12-01" }), /final/);
  });

  await t.test("cancel: admin, with a reason, only before goods arrive and with no live invoice", async () => {
    const q2 = (await aisyah("record_supplier_document", { doc_type: "quotation", supplier: solar, supplier_ref: "SP-100", doc_date: "2026-09-30", total: 540, lines: [{ description: "MC4 connector pair", quantity: 100, unit_price: 5, tax_rate: 8 }] })).document.number;
    const draft = await aisyah("create_po_draft", { from_quotation: q2, order_date: "2026-09-20", expected_date: "2026-09-30" });
    await rejects(aisyah("cancel_po", { po: draft.po.number, reason: "changed mind" }), /Only a Superadmin/);
    await rejects(admin("cancel_po", { po: draft.po.number }), /Invalid input|reason/);
    const issued = await admin("issue_po", { po: draft.po.number });
    assert.equal(issued.po.number, "PO-2026-0002");
    assert.equal(issued.po.overdue, true, "expected 30 Sep, today is 2 Oct, nothing received");
    await rejects(admin("cancel_po", { po, reason: "wrong one" }), /goods have already arrived/);
    const inv = await aisyah("record_supplier_document", { doc_type: "invoice", supplier: solar, supplier_ref: "SP-INV-1", doc_date: "2026-08-01", total: 540, po: "PO-2026-0002" });
    await rejects(admin("cancel_po", { po: "PO-2026-0002", reason: "changed mind" }), /bills this order/);
    await admin("set_supplier_invoice_status", { invoice: inv.document.number, status: "void", reason: "billed too early" });
    const cancelled = await admin("cancel_po", { po: "PO-2026-0002", reason: "Supplier out of stock" });
    assert.equal(cancelled.po.status, "cancelled");
    assert.equal((await aisyah("get_supplier_document", { doc: q2 })).document.status, "accepted", "the quotation is free again");
    await rejects(admin("cancel_po", { po: "PO-2026-0002", reason: "again" }), /already cancelled/);
    await rejects(aisyah("po_pdf", { po: "PO-2026-0002" }), /is cancelled/);
    await rejects(aisyah("receive_goods", { po: "PO-2026-0002", receive_all: true }), /cancelled; there is nothing left/);
  });

  await t.test("the overview shows what needs attention", async () => {
    await aisyah("record_supplier_document", { doc_type: "invoice", supplier: solar, supplier_ref: "SP-INV-2", doc_date: "2026-08-01", total: 800 });
    const draft = await aisyah("create_po_draft", { supplier: solar, order_date: "2026-09-10", expected_date: "2026-09-25", lines: [{ description: "Inverter 5kW", quantity: 1, unit_price: 3000, tax_rate: 8 }] });
    await admin("issue_po", { po: draft.po.number });
    const o = await aisyah("procurement_overview");
    assert.equal(o.suppliers, 4);
    assert.equal(o.purchase_orders.by_status.received.count, 1);
    assert.equal(o.purchase_orders.by_status.cancelled.count, 1);
    assert.equal(o.purchase_orders.awaiting_delivery.count, 1);
    assert.deepEqual(o.purchase_orders.late_deliveries.map((p) => p.number), ["PO-2026-0003"]);
    assert.equal(o.invoices.overdue.count, 1, "SP-INV-2 was due 15 Aug");
    assert.equal(o.invoices.overdue.total, 800);
    assert.equal(o.invoices.unpaid_without_po, 1);
    assert.equal(o.invoices.unpaid.count, 1);
    assert.equal(o.quotations.open, 0);
    const listed = await aisyah("list_supplier_documents", { status: "overdue" });
    assert.deepEqual(listed.documents.map((d) => d.supplier_ref), ["SP-INV-2"]);
    assert.equal(listed.documents[0].overdue, true);
    const open = await aisyah("list_pos", { status: "open" });
    assert.deepEqual(open.pos.map((p) => p.number), ["PO-2026-0003"]);
    assert.equal(open.pos[0].overdue, true);
  });

  await t.test("a quotation can be rejected, and expiry is shown without being stored", async () => {
    const q = (await aisyah("record_supplier_document", { doc_type: "quotation", supplier: maju, supplier_ref: "QT-OLD", doc_date: "2026-08-01", valid_until: "2026-08-31", total: 999 })).document;
    assert.equal(q.expired, true);
    assert.equal(q.status, "received");
    const rejected = await aisyah("decide_supplier_quotation", { doc: q.number, decision: "reject", note: "Too dear" });
    assert.equal(rejected.document.status, "rejected");
    await rejects(aisyah("create_po_draft", { from_quotation: q.number }), /only a received or accepted quotation/);
    await rejects(aisyah("decide_supplier_quotation", { doc: "SQ-2026-0001", decision: "reject" }), /already become a purchase order/);
  });

  await t.test("the other company sees nothing; other agents have none of these tools", async () => {
    const other = as("admin", tenantB);
    assert.equal((await other("find_suppliers")).suppliers.length, 0);
    assert.equal((await other("list_pos")).pos.length, 0);
    await rejects(other("get_po", { po: "PO-2026-0001" }), /not found/);
    await rejects(other("record_supplier_document", { doc_type: "invoice", supplier: maju, supplier_ref: "1", doc_date: "2026-10-01", total: 1 }), /No supplier matches/);
    await rejects(runTool(deps(tenantA), { agent: "di-records", tool: "list_pos", args: {} }), /not allowed/);
    await rejects(runTool(deps(tenantA), { agent: "di-expenses", tool: "issue_po", args: {} }), /not allowed/);
    await rejects(runTool(deps(tenantA), { agent: "di-procurement", tool: "find_customers", args: {} }), /not allowed/);
    await rejects(runTool(deps(tenantA), { agent: "di-procurement", tool: "issue_document", args: {} }), /not allowed/);
    assert.equal(AGENTS["di-procurement"].name, "Procurement Clerk");
    assert.equal(toolsFor("di-procurement").length, 17);
    assert.ok(clock);
  });

  await t.test("fractional quantities stay exact through partial and full receiving", async () => {
    const draft = await aisyah("create_po_draft", { supplier: maju, lines: [{ description: "Measured cable", quantity: 1.234, unit_price: 100, unit: "m" }] });
    const issued = await admin("issue_po", { po: draft.po.id });
    const ref = issued.po.number;
    assert.equal(issued.po.progress.ordered, 1.234);
    assert.equal((await aisyah("list_pos")).pos.find(p => p.number === ref).received, "0/1.234");
    await rejects(aisyah("receive_goods", { po: ref, lines: [{ line_no: 1, quantity: 0.0001 }] }), /quantity/);
    const partial = await aisyah("receive_goods", { po: ref, lines: [{ line_no: 1, quantity: 1.23 }] });
    assert.equal(partial.po.status, "partially_received");
    assert.equal(partial.po.lines[0].outstanding, 0.004);
    assert.equal(partial.outstanding[0].outstanding, 0.004);
    assert.equal((await aisyah("list_pos")).pos.find(p => p.number === ref).received, "1.23/1.234");
    await rejects(aisyah("receive_goods", { po: ref, lines: [{ line_no: 1, quantity: 0.005 }] }), /only 0.004 still to come/);
    const rest = await aisyah("receive_goods", { po: ref, receive_all: true });
    assert.equal(rest.received[0].quantity, 0.004);
    assert.equal(rest.po.lines[0].received_qty, 1.234);
    assert.equal(rest.po.progress.received, 1.234);
    assert.equal(rest.complete, true);
    assert.equal((await aisyah("list_pos")).pos.find(p => p.number === ref).received, "1.234/1.234");
  });
});

test("the PO page escapes everything and shows the right state", () => {
  const base = {
    po: { number: "PO-2026-0009", status: "issued", currency: "MYR", order_date: "2026-10-01", expected_date: null, ship_to: "<b>dock</b>", payment_terms_days: 30, subtotal: 100, tax_total: 8, total: 108, notes: "<script>alert(1)</script>", issued_by: "admin", cancel_reason: null,
      lines: [{ line_no: 1, description: "A & B <i>", sku: null, unit: "pcs", quantity: 1, unit_price: 100, tax_rate: 8, total: 108 }] },
    supplier: { name: "S <x>", address: {}, contact_name: null, phone: null, email: null }, company: { name: "Co & Co", address: {} },
  };
  const html = renderPoHtml(base);
  assert.match(html, /A &amp; B &lt;i&gt;/);
  assert.match(html, /S &lt;x&gt;/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /To be confirmed/);
  const fractional = renderPoHtml({ ...base, po: { ...base.po, lines: [{ ...base.po.lines[0], quantity: 1.234 }] } });
  assert.match(fractional, /<td class="r">1\.234<\/td>/, "the supplier sees all three decimal places on the PO");
  assert.match(renderPoHtml({ ...base, po: { ...base.po, status: "cancelled", cancel_reason: "No stock" } }), /Cancelled: No stock/);
  assert.ok(TOOLS.issue_po.report && TOOLS.po_pdf.report);
});

test("demo procurement: a spread of states through the real pipeline, loaded once", async () => {
  const { as, deps, tenantA, clock } = await setup();
  const admin = as("admin");
  const withPdf = { ...deps(tenantA), renderPdf: async (html, abs) => { await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, `%PDF-1.4
${html}`); } };
  await rejects(seedDemoProcurement(withPdf, USERS["tok-aisyah"]), /Only an admin/);
  const out = await seedDemoProcurement(withPdf, USERS["tok-admin"], { now: clock.now });
  assert.deepEqual([out.suppliers, out.quotations, out.invoices, out.pos], [4, 6, 4, 3]);
  assert.deepEqual(await seedDemoProcurement(withPdf, USERS["tok-admin"], { now: clock.now }), { seeded: 0, already_loaded: 4 }, "loading twice changes nothing");

  const o = await admin("procurement_overview");
  const by = o.purchase_orders.by_status;
  assert.deepEqual([by.received.count, by.partially_received.count, by.issued.count, by.draft.count], [1, 1, 1, 1]);
  assert.equal(o.purchase_orders.late_deliveries.length, 1, "the solar order was due two days ago");
  assert.equal(o.invoices.overdue.count, 1);
  assert.equal(o.invoices.overdue.total, 1404);
  assert.equal(o.invoices.disputed.count, 1);
  assert.equal(o.invoices.not_matching_po.length, 1, "the supplier billed everything but only the rails arrived");
  assert.match(o.invoices.not_matching_po[0].issues.join(" "), /goods have been received so far/);
  assert.deepEqual([o.quotations.open, o.quotations.accepted_not_ordered], [1, 1]);

  const paid = await admin("list_supplier_documents", { doc_type: "invoice", status: "paid" });
  assert.equal(paid.documents.length, 1);
  const po = await admin("list_pos", { status: "received" });
  const full = await admin("get_po", { po: po.pos[0].number });
  assert.equal(full.po.progress.received, full.po.progress.ordered);
  assert.match(full.po.pdf_path, /^\/files\//, "issued demo orders have their PDF stored");
  assert.equal(full.documents.length, 2, "its quotation and its invoice");
  assert.equal((await as("admin")("find_suppliers", { query: "Maju" })).suppliers[0].open_pos, 0);
  assert.match(demoDocumentHtml({ kind: "Tax invoice", supplier: { name: "A & B", address: "x" }, ref: "R<1>", date: "2026-10-01", lines: CABLES_FOR_HTML, total: 1 }), /SAMPLE DOCUMENT, DEMO DATA/);
});

const CABLES_FOR_HTML = [{ description: "<b>x</b>", quantity: 1, unit_price: 1, tax_rate: 0 }];

test("a department head issues and cancels their own department's orders, nobody else's", async () => {
  const { as } = await setup();
  const supplier = (await as("sam")("save_supplier", { name: "Kedai Kabel Sdn Bhd", email: "orders@kabel.example" })).supplier.code;
  const ops = (await as("hana")("create_po_draft", { supplier, lines: cableLines })).po;
  const sales = (await as("sam")("create_po_draft", { supplier, lines: cableLines })).po;
  assert.equal(ops.department, "Ops", "the drafter's department is stamped on the PO");
  assert.equal(sales.department, "Sales");

  await rejects(as("hana")("issue_po", { po: sales.number }), /Only a Superadmin or the Sales department head can issue/);
  await rejects(as("sam")("issue_po", { po: ops.number }), /Only a Superadmin or the Ops department head can issue/);
  const issued = await as("hana")("issue_po", { po: ops.number });
  assert.equal(issued.po.status, "issued");
  await rejects(as("sam")("cancel_po", { po: issued.po.number, reason: "changed mind" }), /Only a Superadmin or the Ops department head/);
  assert.equal((await as("hana")("cancel_po", { po: issued.po.number, reason: "Supplier delayed" })).po.status, "cancelled");
  assert.equal((await as("admin")("issue_po", { po: sales.number })).po.status, "issued", "a Superadmin approves any department");
});
