// HARNESS (written before the build, see sop-logical-gates-build-plan.md): gates enforced at the
// save, on a real Postgres engine (PGlite), through the same runTool path an agent's tool call takes.
// Judged by the records: a blocked save leaves nothing behind.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError } from "../core/actions.mjs";
import { TOOLS } from "../core/tools.mjs";
import { gateDb, gateCompany, quote, liveDocuments } from "./gates-fixture.mjs";

const SALES = { "==": [{ var: "requester.category" }, "Sales"] };
const OVER = (pct) => ({ ">": [{ var: "document.discount_pct" }, pct] });
const DISCOUNT_RULES = [
  { id: "superadmin-any", when: { "==": [{ var: "requester.access" }, "superadmin"] }, then: "allow", message: "" },
  { id: "sales-max-8", when: { and: [SALES, OVER(8)] }, then: "block", message: "Sales can give at most 8% discount. A Superadmin can approve more." },
  { id: "head-max-11", when: { and: [{ "==": [{ var: "requester.access" }, "department_head"] }, OVER(11)] }, then: "block", message: "A department head can give at most 11% discount." },
];
const EXAMPLES = [
  { facts: { action: "save", document: { discount_pct: 15 }, requester: { access: "user", category: "Sales" } }, expect: "block" },
  { facts: { action: "save", document: { discount_pct: 5 }, requester: { access: "user", category: "Sales" } }, expect: "allow" },
];

const blocked = async (promise, ruleId) => {
  try { await promise; } catch (error) {
    assert.match(describeError(error), new RegExp(`Blocked by company rule "${ruleId}"`));
    return;
  }
  assert.fail(`expected the save to be blocked by ${ruleId}`);
};

async function withDiscountGates(name) {
  const db = await gateDb();
  const c = await gateCompany(db, name);
  await c.byOwner("di-fde", "set_gates", { record_type: "document", rules: DISCOUNT_RULES, examples: EXAMPLES });
  return c;
}

test("tools: only the Forward Deploy Engineer sets gates, and only a Superadmin", () => {
  assert.deepEqual(TOOLS.set_gates.agents, ["di-fde"]);
  assert.equal(TOOLS.set_gates.superadminOnly, true);
  assert.deepEqual(TOOLS.get_gates.agents, ["di-fde"]);
});

test("no gates: saving works exactly as today", async () => {
  const db = await gateDb();
  const c = await gateCompany(db, "NoGates");
  const r = await c.bySales("di-documents", "create_draft", quote(150));
  assert.equal(r.document.status, "draft");
});

test("S1-S4 at the save: Sales and the head are held to their limits, the Superadmin is not", async () => {
  const c = await withDiscountGates("Discount");
  await blocked(c.bySales("di-documents", "create_draft", quote(150)), "sales-max-8");
  assert.equal((await liveDocuments(c.db, c.tenantId)).length, 0, "a blocked create leaves no draft");
  await c.bySales("di-documents", "create_draft", quote(50));
  await c.byHead("di-documents", "create_draft", quote(100));
  await blocked(c.byHead("di-documents", "create_draft", quote(150)), "head-max-11");
  await c.byOwner("di-documents", "create_draft", quote(200));
  assert.deepEqual((await liveDocuments(c.db, c.tenantId)).map((d) => d.discount_total), [50, 100, 200]);
});

test("the discount is measured against the catalogue price, so lowering the unit price is a discount too", async () => {
  const c = await withDiscountGates("Override");
  await blocked(c.bySales("di-documents", "create_draft", quote(0, { unit_price: 850 })), "sales-max-8");
  await c.bySales("di-documents", "create_draft", quote(0, { unit_price: 950 }));
});

test("editing a draft past the limit is blocked and the draft keeps its old values", async () => {
  const c = await withDiscountGates("Edit");
  const draft = await c.bySales("di-documents", "create_draft", quote(50));
  const lineId = draft.document.lines?.[0]?.id ?? (await c.db.query("SELECT id FROM di.document_line WHERE document_id = $1", [draft.document.id])).rows[0].id;
  await blocked(c.bySales("di-documents", "update_draft", { document: draft.document.id, update_lines: [{ line_id: lineId, discount_amount: 150 }] }), "sales-max-8");
  await blocked(c.bySales("di-documents", "update_draft", { document: draft.document.id, add_lines: [{ product: "SOLAR-5KW", discount_amount: 400 }] }), "sales-max-8");
  assert.deepEqual((await liveDocuments(c.db, c.tenantId)).map((d) => d.discount_total), [50]);
});

test("S3 run 3 trap: a voided 20% quotation in the records cannot be copied by a department head", async () => {
  const c = await withDiscountGates("Trap");
  const old = await c.byOwner("di-documents", "create_draft", quote(200));
  await c.byOwner("di-documents", "issue_document", { document: old.document.id });
  await c.byOwner("di-documents", "void_document", { document: old.document.id, reason: "test" });
  await blocked(c.byHead("di-documents", "create_draft", quote(200)), "head-max-11");
});

test("issue is gated too, and a rule can target issue only", async () => {
  const db = await gateDb();
  const c = await gateCompany(db, "Issue");
  const ISSUE_ONLY = [
    { id: "owner-issues-big", when: { and: [{ "==": [{ var: "action" }, "issue"] }, { ">": [{ var: "document.total" }, 900] }, { "!=": [{ var: "requester.access" }, "superadmin"] }] },
      then: "block", message: "Only a Superadmin can issue a quotation above 900." },
  ];
  await c.byOwner("di-fde", "set_gates", { record_type: "document", rules: ISSUE_ONLY, examples: [
    { facts: { action: "issue", document: { total: 1000 }, requester: { access: "user" } }, expect: "block" },
    { facts: { action: "save", document: { total: 1000 }, requester: { access: "user" } }, expect: "allow" },
  ] });
  const draft = await c.bySales("di-documents", "create_draft", quote(0));
  await blocked(c.bySales("di-documents", "issue_document", { document: draft.document.id }), "owner-issues-big");
  assert.equal((await liveDocuments(c.db, c.tenantId))[0].status, "draft", "a blocked issue leaves the draft a draft");
  const issued = await c.byOwner("di-documents", "issue_document", { document: draft.document.id });
  assert.equal(issued.document.status, "issued");
});

test("converting a quotation to an invoice is a save of the invoice, gated for the person converting", async () => {
  const c = await withDiscountGates("Convert");
  const q = await c.byOwner("di-documents", "create_draft", quote(200));
  await c.byOwner("di-documents", "issue_document", { document: q.document.id });
  await blocked(c.bySales("di-documents", "convert_to_invoice", { quotation: q.document.id }), "sales-max-8");
  await c.byOwner("di-documents", "convert_to_invoice", { quotation: q.document.id });
});

test("set_gates: refused without passing examples, replaces the whole ordered list, readable with its facts menu", async () => {
  const db = await gateDb();
  const c = await gateCompany(db, "SetGates");
  await assert.rejects(c.byOwner("di-fde", "set_gates", { record_type: "document", rules: DISCOUNT_RULES, examples: [EXAMPLES[0]] }));
  await assert.rejects(c.byOwner("di-fde", "set_gates", { record_type: "document", rules: DISCOUNT_RULES,
    examples: [{ ...EXAMPLES[0], expect: "allow" }, EXAMPLES[1]] }));
  await assert.rejects(c.byOwner("di-fde", "set_gates", { record_type: "document", rules: [{ id: "x", when: { ">": [{ var: "document.nope" }, 1] }, then: "block", message: "m" }], examples: EXAMPLES }));
  assert.deepEqual((await c.byOwner("di-fde", "get_gates", { record_type: "document" })).rules, [], "nothing was saved by a refused call");

  await c.byOwner("di-fde", "set_gates", { record_type: "document", rules: DISCOUNT_RULES, examples: EXAMPLES });
  const read = await c.byOwner("di-fde", "get_gates", { record_type: "document" });
  assert.deepEqual(read.rules.map((r) => r.id), ["superadmin-any", "sales-max-8", "head-max-11"]);
  assert.ok(read.facts["document.discount_pct"], "get_gates returns the facts menu");

  const resorted = [DISCOUNT_RULES[1], DISCOUNT_RULES[0]];
  await c.byOwner("di-fde", "set_gates", { record_type: "document", rules: resorted, examples: EXAMPLES });
  assert.deepEqual((await c.byOwner("di-fde", "get_gates", { record_type: "document" })).rules.map((r) => r.id), ["sales-max-8", "superadmin-any"]);

  await c.byOwner("di-fde", "set_gates", { record_type: "document", rules: [], examples: [] });
  assert.deepEqual((await c.byOwner("di-fde", "get_gates", { record_type: "document" })).rules, [], "an empty list clears the gates");
});

test("gates belong to one company", async () => {
  const db = await gateDb();
  const a = await gateCompany(db, "CompanyA");
  const b = await gateCompany(db, "CompanyB");
  await a.byOwner("di-fde", "set_gates", { record_type: "document", rules: DISCOUNT_RULES, examples: EXAMPLES });
  await blocked(a.bySales("di-documents", "create_draft", quote(150)), "sales-max-8");
  await b.bySales("di-documents", "create_draft", quote(150));
  assert.deepEqual((await b.byOwner("di-fde", "get_gates", { record_type: "document" })).rules, []);
});
