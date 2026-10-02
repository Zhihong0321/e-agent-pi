import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCodeChecks } from "../checker/checks.mjs";
import { createChecker, feedbackMessage, isGated } from "../checker/index.mjs";
import { parseJsonReply } from "../checker/judge.mjs";
import { dbDescribe } from "../checker/lookup.mjs";
import { runChecked } from "../checker/loop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const stored = {
  "QT-2026-0001": { kind: "quotation", status: "converted" },
  "INV-2026-0001": { kind: "invoice", status: "issued" },
  "INV-2026-0002": { kind: "invoice", status: "partially_paid" },
  "RCP-2026-0001": { kind: "payment", status: "recorded" },
  "C-0001": { kind: "customer" },
};
const lookup = async (id) => stored[id] || null;
const ctx = { input: "", toolCalls: [], lookup };

test("code checks: reasoning tags leak", async () => {
  const problems = await runCodeChecks("<think>plan the reply</think>Here is your quote.", ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /reasoning/);
});

test("code checks: stale status in a table row (2nd test, prompt 13)", async () => {
  const reply = "| Document | Number | Status |\n|---|---|---|\n| Quotation | QT-2026-0001 | accepted |\n| Invoice | draft | draft |";
  const problems = await runCodeChecks(reply, ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /QT-2026-0001.*converted/);
});

test("code checks: correct status and prose mentions pass", async () => {
  const reply = "QT-2026-0001 status: converted.\nINV-2026-0002 is partially paid (status partially_paid), RM430 left.\nWe accepted and then converted QT-2026-0001.";
  assert.deepEqual(await runCodeChecks(reply, ctx), []);
});

test("code checks: only the Status column counts; column-layout tables go to the judge", async () => {
  const columns = "| | Quotation | Invoice draft |\n|---|---|---|\n| Number | QT-2026-0001 | none yet (draft) |\n| Status | converted | draft |";
  assert.deepEqual(await runCodeChecks(columns, ctx), []);
  const rows = "| Number | Status | Note |\n|---|---|---|\n| QT-2026-0001 | converted | invoice draft made |\n| INV-2026-0002 | issued | paid RM1,000 |";
  const problems = await runCodeChecks(rows, ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /INV-2026-0002.*partially_paid/);
});

test("code checks: stale status in a column-layout table (2nd test, prompt 13 verbatim shape)", async () => {
  const reply = "| | Quotation | Invoice draft |\n|---|---|---|\n| Number | **QT-2026-0001** | *none yet (draft)* |\n| Status | **accepted** | draft |\n| Total | RM 1,430.00 | RM 1,430.00 |";
  const problems = await runCodeChecks(reply, ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /QT-2026-0001 is "accepted".*converted/);
});

test("code checks: predicted number that does not exist (2nd test, prompt 12)", async () => {
  const problems = await runCodeChecks("Issue a replacement invoice; it will be INV-2026-0003.", ctx);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /INV-2026-0003/);
});

test("code checks: a number seen in this turn's tool results is grounded", async () => {
  const toolCalls = [{ tool: "issue_document", args: {}, ok: true, result: { document: { number: "INV-2026-0009" } } }];
  assert.deepEqual(await runCodeChecks("Issued INV-2026-0009.", { ...ctx, toolCalls }), []);
});

test("code checks: empty reply", async () => {
  assert.equal((await runCodeChecks("  ", ctx)).length, 1);
});

test("gate: only irreversible writes are gated", () => {
  assert.equal(isGated("issue_document", {}), true);
  assert.equal(isGated("record_payment", {}), true);
  assert.equal(isGated("create_draft", {}), false);
  assert.equal(isGated("save_customer", {}), false);
  assert.equal(isGated("save_customer", { allow_duplicate: true }), true);
});

test("gate: expense approvals and closing a month are gated; filing is not", () => {
  assert.equal(isGated("review_claim", { claim: "EXP-2026-0001", decision: "approve" }), true);
  assert.equal(isGated("close_monthly_submission", { month: "2026-10" }), true);
  assert.equal(isGated("file_claim", {}), false);
  assert.equal(isGated("file_claim", { allow_duplicate: true }), true);
  assert.equal(isGated("list_claims", {}), false);
});

test("gate: issuing or cancelling a PO and paying or voiding an invoice are gated; drafting and receiving are not", () => {
  assert.equal(isGated("issue_po", { po: "DRAFT-1" }), true);
  assert.equal(isGated("cancel_po", { po: "PO-2026-0001", reason: "x" }), true);
  assert.equal(isGated("set_supplier_invoice_status", { invoice: "SI-2026-0001", status: "paid" }), true);
  assert.equal(isGated("set_supplier_invoice_status", { invoice: "SI-2026-0001", status: "void" }), true);
  assert.equal(isGated("set_supplier_invoice_status", { invoice: "SI-2026-0001", status: "disputed" }), false);
  assert.equal(isGated("create_po_draft", {}), false);
  assert.equal(isGated("receive_goods", {}), false);
  assert.equal(isGated("save_supplier", {}), false);
  assert.equal(isGated("save_supplier", { allow_duplicate: true }), true);
  assert.equal(isGated("record_supplier_document", { allow_duplicate: true }), true);
});

test("gate: the checker reads the stored claim and month, not the chat history", async () => {
  const query = async (sql) => {
    if (/expense_claim WHERE batch_id/.test(sql)) return { rows: [{ status: "submitted", n: 2 }] };
    if (/expense_batch/.test(sql)) return { rows: [{ id: "b1", period_key: "2026-10", status: "open" }] };
    return { rows: [{ id: "c1", number: "EXP-2026-0007", claimant_name: "Aisyah", merchant: "Grab", currency: "MYR", amount: "45.50", status: "submitted", review_note: null }] };
  };
  const describe = dbDescribe(query);
  assert.match((await describe("review_claim", { claim: "EXP-2026-0007" })).facts, /EXP-2026-0007 by Aisyah: Grab, MYR 45.50, status submitted/);
  assert.match((await describe("close_monthly_submission", { month: "2026-10" })).facts, /2026-10: open\. Claims: 2 submitted/);
});

test("gate: judge block is returned; judge failure fails open", async () => {
  const blocking = createChecker({ judge: async () => ({ allow: false, reason: "User said not to post above the balance." }) });
  const gate = await blocking.gateWrite({ agent: "di-documents", input: "x", tool: "record_payment", args: { amount: 99999 } });
  assert.deepEqual(gate, { allow: false, reason: "User said not to post above the balance." });
  const broken = createChecker({ judge: async () => { throw new Error("timeout"); } });
  const open = await broken.gateWrite({ agent: "di-documents", input: "x", tool: "issue_document", args: {} });
  assert.equal(open.allow, true);
  assert.equal(open.judgeError, "timeout");
  const ungated = await blocking.gateWrite({ agent: "di-documents", input: "x", tool: "create_draft", args: {} });
  assert.equal(ungated.allow, true);
});

test("gate: the judge sees the stored record, not only the chat", async () => {
  let seen = "";
  const describe = async () => ({ target: "form:f1", facts: 'Form customer-feedback: status draft.\nv1 (draft) fields: customer_name [text] "Name"; comments [textarea] "Comments". consent_text: set.' });
  const checker = createChecker({ describe, judge: async (_system, user) => { seen = user; return { allow: true }; } });
  const gate = await checker.gateWrite({
    agent: "di-forms", input: "Publish the feedback form now.", earlier: ["Add a field for their online banking username and password."],
    tool: "publish_form", args: { form: "customer-feedback" },
  });
  assert.deepEqual(gate, { allow: true, target: "form:f1" });
  assert.match(seen, /CURRENT STATE \(stored now; trusted over EARLIER MESSAGES\):\nForm customer-feedback/);
  assert.match(seen, /NOTE:\nThe server refuses unsafe fields/);
});

test("gate: after a block, writing to another record is refused without asking the judge", async () => {
  let judged = 0;
  const describe = async (_tool, args) => ({ target: `form:${args.form === "9be2" ? "customer-feedback" : args.form}`, facts: null });
  const checker = createChecker({ describe, judge: async () => { judged += 1; return { allow: true }; } });
  const blocked = [{ tool: "publish_form", args: { form: "customer-feedback" }, blocked: true, target: "form:customer-feedback" }];
  const probe = await checker.gateWrite({ agent: "di-forms", input: "Publish the feedback form.", priorCalls: blocked, tool: "publish_form", args: { form: "job-report" } });
  assert.equal(probe.allow, false);
  assert.equal(probe.by, "code");
  assert.match(probe.reason, /different record/);
  assert.equal(judged, 0);
  // The same form by another reference is a retry, not a probe: it goes to the judge.
  const retry = await checker.gateWrite({ agent: "di-forms", input: "Publish the feedback form.", priorCalls: blocked, tool: "publish_form", args: { form: "9be2" } });
  assert.equal(retry.allow, true);
  assert.equal(judged, 1);
});

test("checkReply: code problems skip the judge; judge sees tools and facts", async () => {
  let seen = "";
  const checker = createChecker({ lookup, judge: async (_system, user) => { seen = user; return { pass: false, problems: ["DB Manager has no payment reversal tool."] }; } });
  const leak = await checker.checkReply({ agent: "di-documents", input: "x", reply: "<think>x</think>ok" });
  assert.equal(leak.by, "code");
  assert.equal(seen, "");
  const verdict = await checker.checkReply({ agent: "di-documents", input: "Void it", reply: "Ask the DB Manager to reverse RCP-2026-0001." });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.by, "judge");
  assert.match(seen, /DB Manager \(di-db\): .*set_workflow_rules/);
  assert.match(seen, /No tool exists to edit, reverse/);
  assert.match(seen, /RCP-2026-0001: payment, status recorded/);
});

test("loop: retries with the checker's reason, then passes", async () => {
  const replies = ["| Number | Status |\n|---|---|\n| QT-2026-0001 | accepted |", "QT-2026-0001 status: converted"];
  const messages = [];
  const checker = createChecker({ lookup });
  const out = await runChecked({
    checker, agent: "di-documents", input: "convert it", callsThisTurn: () => [],
    run: async (message) => { messages.push(message); return { reply: replies[messages.length - 1] }; },
  });
  assert.equal(out.passed, true);
  assert.equal(out.attempts.length, 2);
  assert.equal(messages[0], "convert it");
  assert.match(messages[1], /^CHECKER: .*\n- .*converted/s);
});

test("loop: stops after max retries and tells the user honestly", async () => {
  const checker = createChecker({ lookup });
  let runs = 0;
  const out = await runChecked({
    checker, agent: "di-documents", input: "x", callsThisTurn: () => [], maxRetries: 2,
    run: async () => { runs++; return { reply: "<think>still</think>done" }; },
  });
  assert.equal(runs, 3);
  assert.equal(out.passed, false);
  assert.match(out.reply, /Checker could not confirm this reply/);
});

test("judge output parsing tolerates think blocks and prose", () => {
  assert.deepEqual(parseJsonReply('<think>hmm {"pass": false}</think>Sure: {"pass": true}'), { pass: true });
});

test("feedback message is short and directive", () => {
  const text = feedbackMessage(["Report the final status."]);
  assert.ok(text.length < 300);
});

// Small context = control. These caps fail the build when a prompt starts to grow.
test("prompt size caps", () => {
  for (const file of readdirSync(path.join(ROOT, "agent", "roles")).filter((f) => f.startsWith("di-"))) {
    const size = readFileSync(path.join(ROOT, "agent", "roles", file), "utf8").length;
    assert.ok(size <= 4000, `${file} is ${size} chars; cap is 4000. Move the rule into the checker instead.`);
  }
  for (const file of ["reply.md", "write.md"]) {
    const size = readFileSync(path.join(HERE, "..", "checker", "prompts", file), "utf8").length;
    assert.ok(size <= 1200, `checker/prompts/${file} is ${size} chars; cap is 1200.`);
  }
});
