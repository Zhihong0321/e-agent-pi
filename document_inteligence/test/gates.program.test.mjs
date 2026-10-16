// A gate written as a Python-style program: compiled by reading the text (never running it) into the ordered rule list.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError } from "../core/actions.mjs";
import { compileProgram, renderProgram } from "../core/gate-program.mjs";
import { gateDb, gateCompany, quote } from "./gates-fixture.mjs";

const PROGRAM = `# Sales cannot create invoices above RM30,000
if requester.access == "superadmin":
    proceed = True
elif requester.category == "Sales" and document.doc_type == "invoice" and document.total > 30000:
    proceed = False
    reason = "Invoices above RM30,000 must be created by a manager."
`;
const EXAMPLES = [
  { facts: { "document.total": 45000, "document.doc_type": "invoice", "requester.category": "Sales", "requester.access": "user" }, expect: "block" },
  { facts: { "document.total": 28000, "document.doc_type": "invoice", "requester.category": "Sales", "requester.access": "user" }, expect: "allow" },
];

test("a program compiles to the ordered rules and renders back", () => {
  const rules = compileProgram(PROGRAM);
  assert.deepEqual(rules.map((r) => [r.id, r.then]), [["line-2", "allow"], ["line-4", "block"]]);
  assert.equal(rules[1].message, "Invoices above RM30,000 must be created by a manager.");
  assert.match(renderProgram(rules), /elif requester.category == "Sales" and document.doc_type == "invoice" and document.total > 30000:/);
  assert.deepEqual(compileProgram(renderProgram(rules)).map((r) => r.when), rules.map((r) => r.when));
});

test("anything that is not a plain condition is refused with the line", () => {
  for (const [text, re] of [
    ["if document.total = 3:\n    proceed = False", /line 1: use ==/],
    ["if document.total > 5 * 2:\n    proceed = False\n    reason = \"x\"", /line 1: calculations/],
    ["if a == 1:\n    if b == 2:\n        proceed = True", /line 2: nested if/],
    ["import os", /line 1: write "if/],
    ["if document.total > 5:\n    proceed = False\n    reason = \"x\"\n    os.system(\"x\")", /line 4/],
    ["if document.total > 5:\n    reason = \"x\"", /set proceed/],
  ]) assert.throws(() => compileProgram(text), re, text);
});

test("set_gates takes a program, enforces it, and get_gates gives the program back", async () => {
  const c = await gateCompany(await gateDb(), "Program");
  await assert.rejects(c.byOwner("di-fde", "set_gates", { record_type: "document", program: PROGRAM.replace("document.total", "document.totel"), examples: EXAMPLES }),
    (e) => /Unknown fact "document.totel"/.test(describeError(e)));
  await c.byOwner("di-fde", "set_gates", { record_type: "document", program: PROGRAM, examples: EXAMPLES });
  assert.equal((await c.byOwner("di-fde", "get_gates", { record_type: "document" })).program.split("\n")[0], 'if requester.access == "superadmin":');
  await assert.rejects(c.bySales("di-documents", "create_draft", { ...quote(0), doc_type: "invoice", lines: [{ product: "SOLAR-5KW", quantity: 31, discount_amount: 0 }] }), /Blocked by company rule "line-4": Invoices above RM30,000/);
  await c.bySales("di-documents", "create_draft", { ...quote(0), doc_type: "invoice" });
  await c.byOwner("di-fde", "set_gates", { record_type: "document", program: "" });
  assert.equal((await c.byOwner("di-fde", "get_gates", { record_type: "document" })).rules.length, 0);
});
