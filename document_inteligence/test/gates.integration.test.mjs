// Gates enforced at the save, on a real Postgres engine (PGlite), through the same runTool path an agent's tool
// call takes. The gates are written as programs, the way the Forward Deploy Engineer writes them.
// Judged by the records: a blocked save leaves nothing behind.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError } from "../core/actions.mjs";
import { TOOLS } from "../core/tools.mjs";
import { gateDb, gateCompany, quote, liveDocuments } from "./gates-fixture.mjs";

// Rule ids are the line of each branch: line-3 is the Sales cap, line-6 the department head cap.
const DISCOUNT = [
  'if requester.access == "superadmin":',
  "    proceed = True",
  'elif requester.category == "Sales" and document.discount_pct > 8:',
  "    proceed = False",
  '    reason = "Sales can give at most 8% discount. A Superadmin can approve more."',
  'elif requester.access == "department_head" and document.discount_pct > 11:',
  "    proceed = False",
  '    reason = "A department head can give at most 11% discount."',
].join("\n");
const SALES_CAP = "line-3";
const HEAD_CAP = "line-6";
const EXAMPLES = [
  { facts: { action: "save", document: { discount_pct: 15 }, requester: { access: "user", category: "Sales" } }, expect: "block" },
  { facts: { action: "save", document: { discount_pct: 5 }, requester: { access: "user", category: "Sales" } }, expect: "allow" },
];
const set = (c, program, examples = EXAMPLES) => c.byOwner("di-fde", "set_gates", { record_type: "document", program, examples });
const get = (c) => c.byOwner("di-fde", "get_gates", { record_type: "document" });

const blocked = async (promise, ruleId) => {
  try { await promise; } catch (error) {
    assert.match(describeError(error), new RegExp(`Blocked by company rule "${ruleId}"`));
    return;
  }
  assert.fail(`expected the save to be blocked by ${ruleId}`);
};

async function withDiscountGates(name) {
  const c = await gateCompany(await gateDb(), name);
  await set(c, DISCOUNT);
  return c;
}

test("tools: only the Forward Deploy Engineer sets gates, and only a Superadmin", () => {
  assert.deepEqual(TOOLS.set_gates.agents, ["di-fde"]);
  assert.equal(TOOLS.set_gates.superadminOnly, true);
  assert.deepEqual(TOOLS.get_gates.agents, ["di-fde"]);
  assert.deepEqual(Object.keys(TOOLS.set_gates.input), ["record_type", "program", "examples"], "one way to set gates");
});

test("no gates: saving works exactly as today", async () => {
  const c = await gateCompany(await gateDb(), "NoGates");
  const r = await c.bySales("di-documents", "create_draft", quote(150));
  assert.equal(r.document.status, "draft");
});

test("S1-S4 at the save: Sales and the head are held to their limits, the Superadmin is not", async () => {
  const c = await withDiscountGates("Discount");
  await blocked(c.bySales("di-documents", "create_draft", quote(150)), SALES_CAP);
  assert.equal((await liveDocuments(c.db, c.tenantId)).length, 0, "a blocked create leaves no draft");
  await c.bySales("di-documents", "create_draft", quote(50));
  await c.byHead("di-documents", "create_draft", quote(100));
  await blocked(c.byHead("di-documents", "create_draft", quote(150)), HEAD_CAP);
  await c.byOwner("di-documents", "create_draft", quote(200));
  assert.deepEqual((await liveDocuments(c.db, c.tenantId)).map((d) => d.discount_total), [50, 100, 200]);
});

test("the discount is measured against the catalogue price, so lowering the unit price is a discount too", async () => {
  const c = await withDiscountGates("Override");
  await blocked(c.bySales("di-documents", "create_draft", quote(0, { unit_price: 850 })), SALES_CAP);
  await c.bySales("di-documents", "create_draft", quote(0, { unit_price: 950 }));
});

test("editing a draft past the limit is blocked and the draft keeps its old values", async () => {
  const c = await withDiscountGates("Edit");
  const draft = await c.bySales("di-documents", "create_draft", quote(50));
  const lineId = draft.document.lines?.[0]?.id ?? (await c.db.query("SELECT id FROM di.document_line WHERE document_id = $1", [draft.document.id])).rows[0].id;
  await blocked(c.bySales("di-documents", "update_draft", { document: draft.document.id, update_lines: [{ line_id: lineId, discount_amount: 150 }] }), SALES_CAP);
  await blocked(c.bySales("di-documents", "update_draft", { document: draft.document.id, add_lines: [{ product: "SOLAR-5KW", discount_amount: 400 }] }), SALES_CAP);
  assert.deepEqual((await liveDocuments(c.db, c.tenantId)).map((d) => d.discount_total), [50]);
});

test("S3 run 3 trap: a voided 20% quotation in the records cannot be copied by a department head", async () => {
  const c = await withDiscountGates("Trap");
  const old = await c.byOwner("di-documents", "create_draft", quote(200));
  await c.byOwner("di-documents", "issue_document", { document: old.document.id });
  await c.byOwner("di-documents", "void_document", { document: old.document.id, reason: "test" });
  await blocked(c.byHead("di-documents", "create_draft", quote(200)), HEAD_CAP);
});

test("issue is gated too, and a rule can target issue only", async () => {
  const c = await gateCompany(await gateDb(), "Issue");
  const program = [
    'if requester.access != "superadmin" and action == "issue" and document.total > 900:',
    "    proceed = False",
    '    reason = "Only a Superadmin can issue a quotation above 900."',
  ].join("\n");
  await set(c, program, [
    { facts: { action: "issue", document: { total: 1000 }, requester: { access: "user" } }, expect: "block" },
    { facts: { action: "save", document: { total: 1000 }, requester: { access: "user" } }, expect: "allow" },
  ]);
  const draft = await c.bySales("di-documents", "create_draft", quote(0));
  await blocked(c.bySales("di-documents", "issue_document", { document: draft.document.id }), "line-1");
  assert.equal((await liveDocuments(c.db, c.tenantId))[0].status, "draft", "a blocked issue leaves the draft a draft");
  const issued = await c.byOwner("di-documents", "issue_document", { document: draft.document.id });
  assert.equal(issued.document.status, "issued");
});

test("converting a quotation to an invoice is a save of the invoice, gated for the person converting", async () => {
  const c = await withDiscountGates("Convert");
  const q = await c.byOwner("di-documents", "create_draft", quote(200));
  await c.byOwner("di-documents", "issue_document", { document: q.document.id });
  await blocked(c.bySales("di-documents", "convert_to_invoice", { quotation: q.document.id }), SALES_CAP);
  await c.byOwner("di-documents", "convert_to_invoice", { quotation: q.document.id });
});

test("set_gates: refused without passing examples, replaces the whole list, readable as a program with its facts menu", async () => {
  const c = await gateCompany(await gateDb(), "SetGates");
  await assert.rejects(set(c, DISCOUNT, [EXAMPLES[0]]), /allow/);
  await assert.rejects(set(c, DISCOUNT, [{ ...EXAMPLES[0], expect: "allow" }, EXAMPLES[1]]), /Example 1: expected allow/);
  await assert.rejects(set(c, 'if document.nope > 1:\n    proceed = False\n    reason = "m"'), /document\.nope/);
  assert.deepEqual((await get(c)).rules, [], "nothing was saved by a refused call");

  await set(c, DISCOUNT);
  const read = await get(c);
  assert.deepEqual(read.rules.map((r) => r.id), ["line-1", SALES_CAP, HEAD_CAP]);
  assert.equal(read.program, DISCOUNT, "the program is read back as it was written");
  assert.ok(read.facts["document.discount_pct"], "get_gates returns the facts menu");

  const resorted = [
    'if requester.category == "Sales" and document.discount_pct > 8:',
    "    proceed = False",
    '    reason = "Sales can give at most 8% discount."',
    'elif requester.access == "superadmin":',
    "    proceed = True",
  ].join("\n");
  await set(c, resorted);
  assert.deepEqual((await get(c)).rules.map((r) => r.id), ["line-1", "line-4"]);

  await set(c, "", []);
  assert.deepEqual((await get(c)).rules, [], "an empty program clears the gates");
  await assert.rejects(c.byOwner("di-fde", "set_gates", { record_type: "document", examples: [] }), /program/);
});

test("gates belong to one company", async () => {
  const db = await gateDb();
  const a = await gateCompany(db, "CompanyA");
  const b = await gateCompany(db, "CompanyB");
  await set(a, DISCOUNT);
  await blocked(a.bySales("di-documents", "create_draft", quote(150)), SALES_CAP);
  await b.bySales("di-documents", "create_draft", quote(150));
  assert.deepEqual((await get(b)).rules, []);
});
