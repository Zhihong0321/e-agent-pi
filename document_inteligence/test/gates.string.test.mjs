// `when` sent as JSON text (what the SOP AI sends) is accepted and stored as parsed JSON; bad JSON is refused clearly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError } from "../core/actions.mjs";
import { gateDb, gateCompany, quote } from "./gates-fixture.mjs";

const WHEN = { and: [{ "==": [{ var: "requester.category" }, "Sales"] }, { ">": [{ var: "document.discount_pct" }, 8] }] };
const EXAMPLES = [
  { facts: { action: "save", document: { discount_pct: 15 }, requester: { access: "user", category: "Sales" } }, expect: "block" },
  { facts: { action: "save", document: { discount_pct: 5 }, requester: { access: "user", category: "Sales" } }, expect: "allow" },
];

test("set_gates accepts `when` as JSON text, stores it as JSON, and enforces it", async () => {
  const c = await gateCompany(await gateDb(), "TextWhen");
  const rules = [{ id: "sales-max-8", when: JSON.stringify(WHEN), then: "block", message: "Sales can give at most 8% discount." }];
  await c.byOwner("di-fde", "set_gates", { record_type: "document", rules, examples: EXAMPLES });
  assert.deepEqual((await c.byOwner("di-fde", "get_gates", { record_type: "document" })).rules[0].when, WHEN);
  await assert.rejects(c.bySales("di-documents", "create_draft", quote(150)), /Blocked by company rule "sales-max-8"/);
  await c.bySales("di-documents", "create_draft", quote(50));
});

test("set_gates refuses `when` that is not valid JSON, naming the rule", async () => {
  const c = await gateCompany(await gateDb(), "BadJson");
  const rules = [{ id: "oops", when: '{"and": [', then: "block", message: "m" }];
  await assert.rejects(c.byOwner("di-fde", "set_gates", { record_type: "document", rules, examples: EXAMPLES }), (e) => /Rule "oops": when is not valid JSON/.test(describeError(e)));
});
