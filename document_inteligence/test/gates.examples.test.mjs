// Regression for the production RM30,000 failure: valid operators, flat dotted example facts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter } from "../core/db.mjs";
import { checkExamples, setGates, validateGates } from "../core/gates.mjs";
import { gateCompany, quote, liveDocuments } from "./gates-fixture.mjs";

const RULES = [
  { id: "no-limit-superadmin", when: { "==": [{ var: "requester.access" }, "superadmin"] }, then: "allow" },
  { id: "sales-invoice-cap-30000", when: { and: [
    { "==": [{ var: "document.doc_type" }, "invoice"] },
    { "==": [{ var: "requester.category" }, "Sales"] },
    { ">": [{ var: "document.total" }, 30000] },
  ] }, then: "block", message: "Ask a Manager to create invoices over RM30,000." },
];
const flat = (total, category = "Sales", access = "user", docType = "invoice") => ({
  "document.total": total, "document.doc_type": docType, "requester.category": category, "requester.access": access,
});
const EXAMPLES = [
  { facts: { ...flat(45000), "requester.username": "ali" }, expect: "block" },
  { facts: flat(28000), expect: "allow" },
  { facts: flat(50000, "Sales", "superadmin"), expect: "allow" },
  { facts: flat(30000), expect: "allow" },
  { facts: flat(30000.01), expect: "block" },
  { facts: flat(45000, "Service"), expect: "allow" },
  { facts: flat(45000, "Sales", "user", "quotation"), expect: "allow" },
];
const rules = validateGates("document", RULES);

test("the recorded RM30,000 examples pass with flat dotted facts and retain strict boundaries", () => {
  const before = structuredClone(EXAMPLES);
  assert.doesNotThrow(() => checkExamples(rules, EXAMPLES));
  assert.deepEqual(EXAMPLES, before, "normalization must not mutate tool arguments");
});

test("nested, mixed, duplicate equal and null requester examples remain supported", () => {
  for (const facts of [
    { document: { total: 45000, doc_type: "invoice" }, requester: { category: "Sales", access: "user" } },
    { document: { doc_type: "invoice" }, "document.total": 45000, requester: { category: "Sales" } },
    { ...flat(45000), document: { total: 45000 } },
    { document: { total: 45000 }, ...flat(45000) },
  ]) assert.doesNotThrow(() => checkExamples(rules, [{ facts, expect: "block" }, EXAMPLES[1]]));
  assert.doesNotThrow(() => checkExamples(rules, [EXAMPLES[0], { facts: { document: { total: 45000, doc_type: "invoice" }, requester: null }, expect: "allow" }]));
});

test("ambiguous, misspelled and malformed example facts are rejected before writing", async () => {
  for (const facts of [
    { ...flat(45000), document: { total: 100 } },
    { document: { total: 100 }, ...flat(45000) },
    { requester: null, "requester.category": "Sales" },
    { "requester.category": "Sales", requester: null },
    { "document.totel": 45000 },
    { document: { totel: 45000 } },
    { "document.total": [] },
    { document: [] },
    JSON.parse('{"__proto__.polluted":true}'),
    JSON.parse('{"document":{"__proto__":45000}}'),
    [], null,
  ]) {
    let writes = 0;
    await assert.rejects(setGates({ query: async () => { writes++; } }, {
      record_type: "document", rules: RULES, examples: [{ facts, expect: "block" }, EXAMPLES[1]],
    }), /Example 1: (Conflicting|Unknown|Example fact|facts must)/);
    assert.equal(writes, 0);
  }
  assert.equal({}.polluted, undefined);
  assert.throws(() => checkExamples(rules, [{ facts: flat(45000), expect: "allow" }, EXAMPLES[0]]), /expected allow, got block/);
});

test("FDE saves flat examples through the real tool and the invoice cap is enforced transactionally", async () => {
  const pglite = new PGlite();
  const db = pgliteAdapter(pglite);
  try {
    await migrate(db);
    const c = await gateCompany(db, "FlatGateExamples");
    for (const textWhen of [false, true]) {
      const sent = RULES.map((r) => ({ ...r, when: textWhen ? JSON.stringify(r.when) : r.when }));
      await c.byOwner("di-fde", "set_gates", { record_type: "document", rules: sent, examples: EXAMPLES });
      const read = await c.byOwner("di-fde", "get_gates", { record_type: "document" });
      assert.deepEqual(read.rules, rules);
    }
    const invoice = (amount) => ({ ...quote(0, { unit_price: amount }), doc_type: "invoice", due_date: "2099-12-31" });
    const before = (await liveDocuments(db, c.tenantId)).length;
    await assert.rejects(c.bySales("di-documents", "create_draft", invoice(30000.01)), /Blocked by company rule "sales-invoice-cap-30000"/);
    assert.equal((await liveDocuments(db, c.tenantId)).length, before, "blocked invoice must roll back");
    await c.bySales("di-documents", "create_draft", invoice(30000));
    await c.byOwner("di-documents", "create_draft", invoice(45000));
    await c.bySales("di-documents", "create_draft", quote(0, { unit_price: 45000 }));
    await assert.rejects(c.byOwner("di-fde", "set_gates", {
      record_type: "document", rules: RULES, examples: [
        { facts: { ...flat(45000), document: { total: 100 } }, expect: "block" }, EXAMPLES[1],
      ],
    }), /Conflicting example facts/);
    assert.deepEqual((await c.byOwner("di-fde", "get_gates", { record_type: "document" })).rules, rules);
  } finally { await pglite.close(); }
});
