// A3: a company's own fields on document lines (a panel's serial number, a warranty period).
// The values travel with the line through create, edit and conversion, and freeze with the document.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter, withContext } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { describeError, runTool } from "../core/actions.mjs";
import { removeCustomField } from "../core/admin.mjs";
import { TOOLS } from "../core/tools.mjs";

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
  const tenant = (await db.query("INSERT INTO di.tenant (name) VALUES ('Line Co') RETURNING id")).rows[0].id;
  await seedTenant(db, tenant);
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-lines-"));
  const deps = { db, tenantId: () => tenant, workspace: (agent) => path.join(dir, agent), renderPdf: async () => {} };
  const as = (agent) => (tool, args) => runTool(deps, { agent, tool, args });
  return { db, tenant, dbm: as("di-db"), docs: as("di-documents"), clerk: as("di-records") };
}

const SERIAL = { entity: "document_line", key: "serial_no", label: "Serial no.", type: "text", help: "Panel or inverter serial number, one per line" };
const WARRANTY = { entity: "document_line", key: "warranty_years", label: "Warranty (years)", type: "number", help: "Manufacturer warranty for this item" };
const panel = (custom, over = {}) => ({ description: "Solar panel 550W", quantity: 1, unit_price: 400, tax_code: "NT", ...(custom ? { custom } : {}), ...over });

test("a line field is defined through the tool, stored on the line, and read back", async () => {
  const { dbm, docs, clerk } = await setup();
  assert.deepEqual(TOOLS.define_custom_field.input.entity.options, ["customer", "contact", "product", "package", "document", "document_line", "payment"]);
  const defined = await dbm("define_custom_field", SERIAL);
  // The label "Serial no." is the key read as words, so the line leaves it out.
  assert.match(defined.bible, /^document_line \(platform\)\n {2}serial_no text "Panel or inverter serial number, one per line"$/m);
  await dbm("define_custom_field", WARRANTY);

  const customer = (await clerk("save_customer", { name: "Acme Solar Sdn Bhd", kind: "company" })).customer;
  const draft = await docs("create_draft", {
    doc_type: "invoice", customer: customer.code,
    lines: [panel({ serial_no: "SN-001", warranty_years: "25" }), panel(undefined, { description: "Delivery" })],
  });
  const [first, second] = draft.document.lines;
  assert.deepEqual(first.custom, { serial_no: "SN-001", warranty_years: 25 }, "validated like any custom value: the number is a number");
  assert.equal("custom" in second, false, "a line with no values carries no custom in the reply");
  const again = await docs("get_document", { ref: draft.document.id });
  assert.deepEqual(again.document.lines[0].custom, { serial_no: "SN-001", warranty_years: 25 });
});

test("an unknown line key is refused on create, add and update", async () => {
  const { dbm, docs, clerk } = await setup();
  await dbm("define_custom_field", SERIAL);
  const customer = (await clerk("save_customer", { name: "Acme Solar Sdn Bhd", kind: "company" })).customer;
  await rejects(docs("create_draft", { doc_type: "invoice", customer: customer.code, lines: [panel({ serial_nr: "SN-001" })] }), /Unknown custom field document_line\.serial_nr \(defined: serial_no\)/);
  const draft = await docs("create_draft", { doc_type: "invoice", customer: customer.code, lines: [panel({ serial_no: "SN-001" })] });
  await rejects(docs("update_draft", { document: draft.document.id, add_lines: [panel({ colour: "blue" })] }), /Unknown custom field document_line\.colour/);
  await rejects(docs("update_draft", { document: draft.document.id, update_lines: [{ line_id: draft.document.lines[0].id, custom: { colour: "blue" } }] }), /Unknown custom field document_line\.colour/);
});

test("a line field cannot be required: it cannot block issuing", async () => {
  const { dbm } = await setup();
  await rejects(dbm("define_custom_field", { ...SERIAL, required_for: "invoice.issue" }), /a line field cannot be required/);
  await rejects(dbm("define_custom_field", { ...SERIAL, required_for: "save" }), /a line field cannot be required/);
  await dbm("define_custom_field", { ...SERIAL, required_for: null });
});

test("editing a line merges its values, and an unrelated edit leaves them alone", async () => {
  const { db, tenant, dbm, docs, clerk } = await setup();
  await dbm("define_custom_field", SERIAL);
  await dbm("define_custom_field", WARRANTY);
  const customer = (await clerk("save_customer", { name: "Acme Solar Sdn Bhd", kind: "company" })).customer;
  const draft = await docs("create_draft", { doc_type: "invoice", customer: customer.code, lines: [panel({ serial_no: "SN-001" })] });
  const lineId = draft.document.lines[0].id;

  const priced = await docs("update_draft", { document: draft.document.id, update_lines: [{ line_id: lineId, unit_price: 450 }] });
  assert.equal(priced.document.lines[0].unit_price, 450);
  assert.deepEqual(priced.document.lines[0].custom, { serial_no: "SN-001" }, "a price change keeps the serial number");

  const merged = await docs("update_draft", { document: draft.document.id, update_lines: [{ line_id: lineId, custom: { warranty_years: 25 } }] });
  assert.deepEqual(merged.document.lines[0].custom, { serial_no: "SN-001", warranty_years: 25 });

  // A field removed since does not stop an edit to a line that still holds its value.
  await withContext(db, { tenantId: tenant }, (tx) => removeCustomField(tx, { entity: "document_line", key: "serial_no" }));
  const repriced = await docs("update_draft", { document: draft.document.id, update_lines: [{ line_id: lineId, unit_price: 500 }] });
  assert.equal(repriced.document.lines[0].unit_price, 500);
  assert.deepEqual(repriced.document.lines[0].custom, { serial_no: "SN-001", warranty_years: 25 }, "the stored values stay");
});

test("converting a quotation carries each line's values to the invoice draft", async () => {
  const { db, tenant, dbm, docs, clerk } = await setup();
  await dbm("define_custom_field", SERIAL);
  const customer = (await clerk("save_customer", { name: "Acme Solar Sdn Bhd", kind: "company" })).customer;
  const quote = await docs("create_draft", { doc_type: "quotation", customer: customer.code, lines: [panel({ serial_no: "SN-009" })] });
  // Issued by hand: this test is about the lines, not about the company profile an issue needs.
  await withContext(db, { tenantId: tenant, asRole: false }, (tx) =>
    tx.query("UPDATE di.document SET number = 'QT-TEST-1', status = 'issued', issued_at = now() WHERE id = $1", [quote.document.id]));
  const invoice = await docs("convert_to_invoice", { quotation: "QT-TEST-1" });
  assert.equal(invoice.document.doc_type, "invoice");
  assert.deepEqual(invoice.document.lines[0].custom, { serial_no: "SN-009" });
});

test("changing a line's values on an issued invoice is refused by the existing trigger", async () => {
  const { db, tenant, dbm, docs, clerk } = await setup();
  await dbm("define_custom_field", SERIAL);
  const customer = (await clerk("save_customer", { name: "Acme Solar Sdn Bhd", kind: "company" })).customer;
  const draft = await docs("create_draft", { doc_type: "invoice", customer: customer.code, lines: [panel({ serial_no: "SN-001" })] });
  await withContext(db, { tenantId: tenant, asRole: false }, (tx) =>
    tx.query("UPDATE di.document SET number = 'INV-TEST-1', status = 'issued', issued_at = now() WHERE id = $1", [draft.document.id]));
  const lineId = draft.document.lines[0].id;
  await rejects(
    withContext(db, { tenantId: tenant }, (tx) => tx.query(`UPDATE di.document_line SET custom = '{"serial_no":"CHANGED"}' WHERE id = $1`, [lineId])),
    /only change while the document is a draft/,
  );
  await rejects(docs("update_draft", { document: draft.document.id, update_lines: [{ line_id: lineId, custom: { serial_no: "CHANGED" } }] }), /not a draft/);
  const kept = await docs("get_document", { ref: "INV-TEST-1" });
  assert.deepEqual(kept.document.lines[0].custom, { serial_no: "SN-001" });
});
