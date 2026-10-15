// HARNESS (written before the build, see sop-logical-gates-build-plan.md): the gate language itself.
// Pure: no database. A gate list is ordered; the first enabled rule whose `when` is true decides
// (allow or block); no match = allow. `when` is JSONLogic limited to a fixed set of operators, and
// every `var` must be a fact the code provides for that record type.
import assert from "node:assert/strict";
import { test } from "node:test";
import { FACTS, OPS, decide, validateGates, checkExamples } from "../core/gates.mjs";

const SALES = { "==": [{ var: "requester.category" }, "Sales"] };
const OVER = (pct) => ({ ">": [{ var: "document.discount_pct" }, pct] });
const RULES = [
  { id: "superadmin-any", when: { "==": [{ var: "requester.access" }, "superadmin"] }, then: "allow", message: "" },
  { id: "sales-max-8", when: { and: [SALES, OVER(8)] }, then: "block", message: "Sales can give at most 8% discount." },
  { id: "head-max-11", when: { and: [{ "==": [{ var: "requester.access" }, "department_head"] }, OVER(11)] }, then: "block", message: "A department head can give at most 11% discount." },
];
const facts = (requester, pct, action = "save") => ({ action, document: { doc_type: "quotation", discount_pct: pct }, requester });
const sales = { access: "user", category: "Sales" };
const head = { access: "department_head", category: "Department head" };
const owner = { access: "superadmin", category: "Superadmin" };

test("the facts menu and operator list are the single vocabulary", () => {
  for (const key of ["action", "document.doc_type", "document.discount_pct", "document.list_total", "document.subtotal",
    "requester.access", "requester.category", "requester.department"]) assert.ok(key in FACTS.document, `fact ${key}`);
  assert.deepEqual([...OPS].sort(), ["!", "!=", "<", "<=", "==", ">", ">=", "and", "in", "or", "var"].sort());
});

test("first match wins, in list order; no match allows", () => {
  const rules = validateGates("document", RULES);
  assert.equal(decide(rules, facts(sales, 15)).decision, "block");
  assert.equal(decide(rules, facts(sales, 15)).rule.id, "sales-max-8");
  assert.equal(decide(rules, facts(sales, 5)).decision, "allow");
  assert.equal(decide(rules, facts(head, 10)).decision, "allow");
  assert.equal(decide(rules, facts(head, 15)).rule.id, "head-max-11");
  assert.equal(decide(rules, facts(owner, 20)).decision, "allow");
  assert.equal(decide(rules, facts(owner, 20)).rule.id, "superadmin-any", "the allow above stops evaluation");
  assert.equal(decide([], facts(sales, 99)).decision, "allow", "no gates = today's behaviour");
});

test("order matters: the same rules sorted differently decide differently", () => {
  const blockFirst = validateGates("document", [RULES[1], RULES[0]]);
  const ownerInSales = { access: "superadmin", category: "Sales" };
  assert.equal(decide(blockFirst, facts(ownerInSales, 15)).decision, "block");
  assert.equal(decide(validateGates("document", RULES), facts(ownerInSales, 15)).decision, "allow");
});

test("a rule switched off is skipped", () => {
  const rules = validateGates("document", [{ ...RULES[1], on: false }]);
  assert.equal(decide(rules, facts(sales, 50)).decision, "allow");
});

test("a missing fact is null, never an error (no signed-in user)", () => {
  const rules = validateGates("document", RULES);
  assert.equal(decide(rules, { action: "save", document: { discount_pct: 50 }, requester: null }).decision, "allow");
  const anyoneButOwner = validateGates("document", [{ id: "x", when: { and: [{ "!=": [{ var: "requester.access" }, "superadmin"] }, OVER(8)] }, then: "block", message: "Only a Superadmin can give more than 8%." }]);
  assert.equal(decide(anyoneButOwner, { action: "save", document: { discount_pct: 50 }, requester: null }).decision, "block");
});

test("validation refuses anything outside the vocabulary", () => {
  const ok = { id: "r1", when: OVER(8), then: "block", message: "m" };
  assert.throws(() => validateGates("document", [{ ...ok, when: { ">": [{ var: "document.margin_pct" }, 8] } }]), /document\.margin_pct/);
  assert.throws(() => validateGates("document", [{ ...ok, when: { map: [[1], { var: "" }] } }]), /map/);
  assert.throws(() => validateGates("document", [{ ...ok, when: { method: [{ var: "requester.username" }, "toString"] } }]), /method/);
  assert.throws(() => validateGates("document", [{ ...ok, then: "warn" }]), /allow|block/);
  assert.throws(() => validateGates("document", [{ ...ok, message: "" }]), /message/);
  assert.throws(() => validateGates("document", [ok, ok]), /r1/);
  assert.throws(() => validateGates("document", [{ ...ok, id: "Bad Id!" }]), /id/);
  assert.throws(() => validateGates("purchase_order", [ok]), /purchase_order/);
  assert.throws(() => validateGates("document", Array.from({ length: 31 }, (_, i) => ({ ...ok, id: `r${i}` }))), /30/);
  assert.doesNotThrow(() => validateGates("document", [{ id: "in-list", when: { in: [{ var: "document.doc_type" }, ["quotation", "invoice"]] }, then: "block", message: "m" }]));
});

test("examples prove a gate list before it is saved", () => {
  const rules = validateGates("document", RULES);
  const examples = [{ facts: facts(sales, 15), expect: "block" }, { facts: facts(sales, 5), expect: "allow" }];
  assert.doesNotThrow(() => checkExamples(rules, examples));
  assert.throws(() => checkExamples(rules, [{ facts: facts(sales, 15), expect: "allow" }, { facts: facts(sales, 5), expect: "allow" }]), /expected allow/i);
  assert.throws(() => checkExamples(rules, [{ facts: facts(sales, 15), expect: "block" }]), /allow/, "needs at least one allow and one block example");
});
