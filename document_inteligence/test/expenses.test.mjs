// Expense claims on a real Postgres engine (PGlite): the cut-off arithmetic, the identity
// rules (admin sees all, a user only their own), duplicate refusal, receipts from chat
// attachments, closing a monthly submission (frozen by the database), and the report.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter, withContext } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { runTool, describeError } from "../core/actions.mjs";
import { AGENTS, TOOLS, allowed, toolsFor } from "../core/tools.mjs";
import { addMonths, batchLabel, cycleFor, cycleOf } from "../core/expenses.mjs";
import { claimsToCsv, renderExpenseReportHtml, summariseSubmission } from "../core/expense-report.mjs";
import { demoReceiptHtml, seedDemoClaims } from "../core/expense-demo.mjs";
import { readSharedFile, sharedFileLocation } from "../../server/shared-files.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a30000000049454e44ae426082", "hex");

const USERS = {
  "tok-admin": { id: "u-admin", username: "admin", display_name: "Admin", role: "admin", email: null },
  "tok-aisyah": { id: "u-aisyah", username: "aisyah", display_name: "Aisyah Rahman", role: "user", email: "aisyah@acme.test" },
  "tok-daniel": { id: "u-daniel", username: "daniel", display_name: "Daniel Lee", role: "user", email: "daniel@acme.test" },
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
  const mk = async (name) => (await db.query("INSERT INTO di.tenant (name, is_default) VALUES ($1, $2) RETURNING id", [name, name === "A"])).rows[0].id;
  const tenantA = await mk("A");
  const tenantB = await mk("B");
  await seedTenant(db, tenantA);
  await seedTenant(db, tenantB);
  await db.query("INSERT INTO di.company_member (tenant_id, name, email, user_id, department) VALUES ($1, 'Aisyah Rahman', 'aisyah@acme.test', 'u-aisyah', 'Sales'), ($1, 'Daniel Lee', 'daniel@acme.test', 'u-daniel', 'Ops'), ($1, 'Priya Nair', 'priya@acme.test', NULL, 'Ops')", [tenantA]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-exp-"));
  const clock = { now: new Date("2026-10-02T04:00:00Z") }; // 2 Oct 2026, noon in Malaysia
  const deps = (tenantId) => ({
    db, tenantId: () => tenantId,
    workspace: (agent) => path.join(dir, agent),
    now: () => clock.now,
    resolveIdentity: async (code) => USERS[code] ?? null,
    renderPdf: async (html, abs) => { await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, html); },
  });
  /** A chat attachment as the host stores it: _inbox/<stamp>-<n>-<name>. `salt` makes the bytes unique. */
  let counter = 0;
  const inbox = async (name, salt = `n${counter++}`, bytes = null) => {
    const rel = `_inbox/1759${String(counter).padStart(9, "0")}-0-${name}`;
    await mkdir(path.join(dir, "di-expenses", "_inbox"), { recursive: true });
    await writeFile(path.join(dir, "di-expenses", rel), bytes ?? Buffer.concat([PNG, Buffer.from(salt)]));
    return rel;
  };
  const as = (who, tenantId = tenantA) => (tool, args = {}) =>
    runTool(deps(tenantId), { agent: "di-expenses", tool, args: { identity: `tok-${who}`, ...args } });
  return { db, tenantA, tenantB, dir, clock, as, inbox, filesRoot: path.join(dir, "files"), deps };
}

const claim = (over = {}) => ({ expense_date: "2026-10-01", merchant: "Grab", category: "transport", amount: 45.5, ...over });

test("tool names are unique (a duplicate key silently replaces another agent's tool)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../core/tools.mjs", import.meta.url), "utf8");
  const keys = [...source.matchAll(/^  ([a-z_]+): \{/gm)].map((m) => m[1]);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dupes, []);
  assert.ok(keys.length > 60);
});

test("the role prompt stays small (the shared cap test stops at the first oversized file)", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(new URL("../../agent/roles/di-expenses.md", import.meta.url), "utf8");
  assert.ok(text.length <= 4000, `di-expenses.md is ${text.length} chars; cap is 4000`);
  for (const tool of toolsFor("di-expenses")) {
    if (tool.name === "list_company_members") continue;
    assert.ok(text.includes(`\`${tool.name}\``), `the role prompt never mentions ${tool.name}`);
  }
});

test("cut-off arithmetic", () => {
  assert.deepEqual(cycleFor("2026-10-10", 10), { period_key: "2026-10", period_start: "2026-09-11", cutoff_date: "2026-10-10" });
  assert.deepEqual(cycleFor("2026-10-11", 10), { period_key: "2026-11", period_start: "2026-10-11", cutoff_date: "2026-11-10" });
  assert.equal(cycleFor("2026-10-01", 10).period_key, "2026-10");
  assert.equal(cycleFor("2026-12-20", 10).period_key, "2027-01", "December rolls into January");
  assert.deepEqual(cycleOf("2027-01", 10), { period_key: "2027-01", period_start: "2026-12-11", cutoff_date: "2027-01-10" });
  assert.deepEqual(cycleFor("2026-03-01", 28), { period_key: "2026-03", period_start: "2026-03-01", cutoff_date: "2026-03-28" }, "cut-off 28 starts on the 1st");
  assert.equal(cycleFor("2026-03-29", 28).period_key, "2026-04");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.equal(batchLabel("2026-10"), "Oct 2026 submission");
});

test("expense claims", async (t) => {
  const { db, tenantA, tenantB, dir, clock, as, inbox, filesRoot, deps } = await setup();
  const admin = as("admin");
  const aisyah = as("aisyah");
  const daniel = as("daniel");
  let a1;
  let a2;
  let d1;
  let d3;

  await t.test("every expense tool needs a signed-in user", async () => {
    await rejects(runTool(deps(tenantA), { agent: "di-expenses", tool: "list_claims", args: {} }), /Sign-in required/);
    await rejects(runTool(deps(tenantA), { agent: "di-expenses", tool: "list_claims", args: { identity: "made-up" } }), /Sign-in required/);
    for (const [name, spec] of Object.entries(TOOLS)) {
      if (!spec.agents.includes("di-expenses") || name === "list_company_members") continue;
      assert.equal(spec.identity, true, `${name} must resolve the signed-in user`);
    }
  });

  await t.test("settings and the current submission", async () => {
    const out = await admin("get_expense_settings");
    assert.equal(out.me.role, "admin");
    assert.equal(out.settings.cutoff_day, 10);
    assert.equal(out.current_submission.period_key, "2026-10");
    assert.equal(out.current_submission.days_left, 8);
    assert.equal(out.categories.length, 11);
    const user = await aisyah("get_expense_settings");
    assert.equal(user.me.company_person.name, "Aisyah Rahman", "a login is linked to its company person");
  });

  await t.test("files a claim from a chat attachment and keeps a durable receipt", async () => {
    const out = await aisyah("file_claim", claim({ receipts: [await inbox("grab.png")], description: "Client visit, KLCC" }));
    a1 = out.claim.number;
    assert.equal(a1, "EXP-2026-0001");
    assert.equal(out.claim.claimant.name, "Aisyah Rahman");
    assert.equal(out.claim.status, "submitted");
    assert.equal(out.claim.submission.period_key, "2026-10");
    assert.equal(out.submission.cutoff_date, "2026-10-10");
    assert.equal(out.claim.receipts.length, 1);
    assert.equal(out.claim.receipts[0].name, "grab.png", "the inbox stamp is stripped from the stored name");
    assert.ok(out.shared_files.length === 1 && out.shared_files[0].link, "chat gets a link to the receipt");
    const stored = sharedFileLocation(out.claim.receipts[0].path);
    const { full } = await readSharedFile({ root: filesRoot, companyId: tenantA, ...stored });
    assert.equal((await readFile(full)).subarray(0, 8).toString("hex"), PNG.subarray(0, 8).toString("hex"));
    const audit = (await db.query("SELECT actor FROM di.audit_log WHERE entity = 'expense_claim' AND action = 'insert'")).rows;
    assert.deepEqual(audit.map((r) => r.actor), ["aisyah"], "the audit trail names the person, not 'owner'");
  });

  await t.test("refuses what a clerk must not accept", async () => {
    const ok = await inbox("ok.png");
    await rejects(aisyah("file_claim", claim({ expense_date: "2026-10-09", receipts: [ok] })), /in the future/);
    await rejects(aisyah("file_claim", claim({ expense_date: "10/01/2026", receipts: [ok] })), /YYYY-MM-DD/);
    await rejects(aisyah("file_claim", claim({ category: "yacht", receipts: [ok] })), /category must be one of/);
    await rejects(aisyah("file_claim", claim({ amount: 0, receipts: [ok] })), /must be a positive number/);
    await rejects(aisyah("file_claim", claim({ amount: 10, tax_amount: 11, receipts: [ok] })), /tax_amount cannot exceed/);
    await rejects(aisyah("file_claim", claim({ currency: "USD", receipts: [ok] })), /Claims are in MYR/);
    await rejects(aisyah("file_claim", claim({ merchant: "Other", amount: 5 })), /Attach the receipt/);
    await rejects(aisyah("file_claim", claim({ merchant: "Other", amount: 5, receipts: ["../../etc/passwd"] })), /not a file in your workspace/);
    await rejects(aisyah("file_claim", claim({ merchant: "Other", amount: 5, receipts: ["notes.txt"] })), /not a file in your workspace|Receipts must be chat attachments/);
    const fake = await inbox("evil.jpg", "", Buffer.from("MZ\x90\x00 this is not an image"));
    await rejects(aisyah("file_claim", claim({ merchant: "Other", amount: 5, receipts: [fake] })), /is not a JPEG, PNG, WebP, GIF or PDF/);
    await rejects(aisyah("file_claim", claim({ merchant: "Other", amount: 5, claimant: "Daniel Lee", receipts: [ok] })), /Only an admin can file a claim for someone else/);
    const count = (await db.query("SELECT count(*)::int AS n FROM di.expense_claim")).rows[0].n;
    assert.equal(count, 1, "nothing was written by any refused call");
  });

  await t.test("a claim without a receipt needs a stated reason", async () => {
    const out = await daniel("file_claim", claim({ merchant: "Mamak stall", amount: 33, category: "meals", no_receipt_reason: "Stall gave no receipt" }));
    assert.match(out.warnings.join(" "), /No receipt attached/);
    d1 = out.claim.number;
    assert.equal(d1, "EXP-2026-0002");
  });

  await t.test("duplicates: the same file, or the same claim, is refused until confirmed", async () => {
    const same = await inbox("again.png", "n0", Buffer.concat([PNG, Buffer.from("n0")]));
    await rejects(daniel("file_claim", claim({ merchant: "Elsewhere", amount: 99, receipts: [same] })), new RegExp(`already attached to ${a1}`));
    await rejects(daniel("file_claim", claim({ merchant: "Mamak stall", amount: 33, category: "meals", no_receipt_reason: "no receipt" })), /same claimant, date, merchant and amount/);
    const forced = await daniel("file_claim", claim({ merchant: "Mamak stall", amount: 33, category: "meals", no_receipt_reason: "second visit", allow_duplicate: true }));
    assert.match(forced.warnings.join(" "), /despite a possible duplicate/);
    await daniel("withdraw_claim", { claim: forced.claim.number, reason: "entered twice" });
  });

  await t.test("a regular user sees only their own claims; an admin sees everyone's", async () => {
    a2 = (await aisyah("file_claim", claim({ merchant: "Petronas", amount: 80, receipts: [await inbox("fuel.png")] }))).claim.number;
    d3 = (await daniel("file_claim", claim({ merchant: "Hilton <KL> & Co", category: "accommodation", amount: 310, tax_amount: 17.5, receipts: [await inbox("hotel.png")] }))).claim.number;
    const mine = await aisyah("list_claims", {});
    assert.deepEqual(mine.claims.map((c) => c.claimant), ["Aisyah Rahman", "Aisyah Rahman"]);
    assert.equal(mine.totals.claimed, 125.5);
    assert.equal(mine.scope, "your claims only");
    const all = await admin("list_claims", {});
    assert.equal(all.claims.filter((c) => c.status !== "withdrawn").length, 4);
    assert.equal(all.scope, "all claims");
    await rejects(aisyah("get_claim", { claim: d3 }), /not found/);
    await rejects(aisyah("list_claims", { claimant: "daniel" }), /only see their own/);
    await rejects(aisyah("update_claim", { claim: d3, amount: 1 }), /not found/);
    await rejects(aisyah("withdraw_claim", { claim: d3 }), /not found/);
    const onlyDaniel = await admin("list_claims", { claimant: "daniel" });
    assert.ok(onlyDaniel.claims.every((c) => c.claimant === "Daniel Lee"));
    assert.equal((await aisyah("list_monthly_submissions")).submissions[0].totals.claimed, 125.5, "submission totals are scoped too");
    assert.equal((await admin("list_monthly_submissions")).submissions[0].totals.claimed, 125.5 + 33 + 310);
  });

  await t.test("the other tenant sees nothing", async () => {
    const other = as("admin", tenantB);
    assert.equal((await other("list_claims", { month: "all" })).claims.length, 0);
    assert.equal((await other("list_monthly_submissions")).submissions.length, 0);
    await rejects(other("get_claim", { claim: a1 }), /not found/);
  });

  await t.test("an admin can file for someone else; the claimant then sees it", async () => {
    const out = await admin("file_claim", claim({ merchant: "Toll", category: "transport", amount: 12.4, receipts: [await inbox("toll.png")], claimant: "priya@acme.test" }));
    assert.equal(out.claim.claimant.name, "Priya Nair");
    assert.equal(out.filed_on_behalf_of, "Priya Nair");
    await rejects(admin("file_claim", claim({ amount: 3, no_receipt_reason: "x", claimant: "Nobody Here" })), /No company person matches/);
    const viaName = await admin("file_claim", claim({ merchant: "Parking", category: "transport", amount: 4, no_receipt_reason: "ticket lost", claimant: "Aisyah Rahman" }));
    assert.equal(viaName.claim.claimant.user_id, "u-aisyah");
    assert.ok((await aisyah("list_claims", { query: "parking" })).claims.length === 1);
    await admin("withdraw_claim", { claim: viaName.claim.number });
  });

  await t.test("editing: owner while pending, never after review", async () => {
    const out = await aisyah("update_claim", { claim: a2, amount: 82.5, description: "Fuel to Ipoh", add_receipts: [await inbox("fuel2.png")] });
    assert.equal(out.claim.amount, 82.5);
    assert.equal(out.claim.receipts.length, 2);
    await rejects(aisyah("update_claim", { claim: a2 }), /Nothing to change/);
    const many = await Promise.all([1, 2, 3, 4].map((i) => inbox(`x${i}.png`)));
    await rejects(aisyah("update_claim", { claim: a2, add_receipts: many }), /at most 5 receipts/);
    await rejects(daniel("update_claim", { claim: a2, amount: 1 }), /not found/);
  });

  await t.test("only an admin reviews, and a rejection needs a reason", async () => {
    await rejects(aisyah("review_claim", { claim: a1, decision: "approve" }), /Only an admin/);
    await rejects(admin("review_claim", { claim: a2, decision: "reject" }), /Give a reason/);
    const approved = await admin("review_claim", { claim: a1, decision: "approve" });
    assert.equal(approved.claim.status, "approved");
    assert.equal(approved.claim.reviewed_by, "admin");
    const rejected = await admin("review_claim", { claim: a2, decision: "reject", note: "Personal trip" });
    assert.equal(rejected.claim.review_note, "Personal trip");
    await admin("review_claim", { claim: d3, decision: "approve" });
    await rejects(aisyah("update_claim", { claim: a2, amount: 5 }), /only a pending/);
    await rejects(aisyah("withdraw_claim", { claim: a1 }), /already approved/);
    assert.equal((await aisyah("get_claim", { claim: a2 })).claim.review_note, "Personal trip", "the claimant can read why");
  });

  await t.test("a draft report for the open month; CSV escapes formulas", async () => {
    const draft = await admin("claim_report", {});
    assert.equal(draft.submission.status, "open");
    assert.match(draft.pdf.name, /expense-claims-2026-10-draft\.pdf$/);
    const html = await readFile(path.join(dir, "di-expenses", "reports", "expense-claims-2026-10-draft.pdf"), "utf8");
    assert.match(html, /Draft · still open/);
    assert.match(html, /Hilton &lt;KL&gt; &amp; Co/, "merchant text is escaped");
    assert.doesNotMatch(html, /Hilton <KL>/);
    assert.match(html, /<img src="data:image\/png;base64,/, "image receipts are embedded");
    const mine = await aisyah("claim_report", {});
    assert.match(mine.pdf.name, /-mine-draft\.pdf$/);
    const mineHtml = await readFile(path.join(dir, "di-expenses", "reports", "expense-claims-2026-10-mine-draft.pdf"), "utf8");
    assert.match(mineHtml, /Aisyah Rahman/);
    assert.doesNotMatch(mineHtml, /Daniel Lee/, "a user's report never includes anyone else");
    await rejects(aisyah("claim_report", { claimant: "daniel" }), /only see their own/);
    await admin("file_claim", claim({ merchant: "=HYPERLINK(\"http://x\")", amount: 7, no_receipt_reason: "n/a", claimant: "Priya Nair", category: "other" }));
    const csv = await admin("export_claims", {});
    const text = await readFile(path.join(dir, "di-expenses", "exports", csv.file_name), "utf8");
    assert.match(text, /^Claim no,Claimant,Email/);
    assert.match(text, /'=HYPERLINK/, "a leading = is defused so a spreadsheet won't run it");
    assert.ok(text.includes("\r\n"));
    const mineCsv = await aisyah("export_claims", {});
    assert.equal(mineCsv.count, 2);
  });

  await t.test("closing needs the pending claims dealt with, then freezes everything", async () => {
    await rejects(aisyah("close_monthly_submission", { month: "2026-10" }), /Only an admin/);
    await rejects(admin("close_monthly_submission", { month: "2026-10" }), /still pending/);
    await rejects(admin("close_monthly_submission", { month: "2025-01" }), /No claims have been filed/);
    const closed = await admin("close_monthly_submission", { month: "2026-10", carry_forward_pending: true });
    assert.equal(closed.submission.status, "closed");
    assert.ok(closed.carried_forward.length >= 1, "the pending claims moved on");
    assert.match(closed.pdf.name, /expense-claims-2026-10\.pdf$/);
    assert.ok(!closed.pdf.name.includes("draft"));
    const finalHtml = await readFile(path.join(dir, "di-expenses", "reports", "expense-claims-2026-10.pdf"), "utf8");
    assert.match(finalHtml, /Final · closed/);
    assert.match(finalHtml, /Aisyah Rahman/);
    assert.doesNotMatch(finalHtml, /Mamak stall/, "carried-forward and withdrawn claims are not in the closed report");
    const batch = (await db.query("SELECT status, report_path, claim_count, total_claimed, total_approved FROM di.expense_batch WHERE period_key = '2026-10'")).rows[0];
    assert.equal(batch.status, "closed");
    assert.match(batch.report_path, /^\/files\/[a-f0-9]{64}\//);
    assert.equal(Number(batch.total_approved), 45.5 + 310);
    await rejects(admin("close_monthly_submission", { month: "2026-10" }), /already closed/);
    await rejects(admin("review_claim", { claim: a2, decision: "approve" }), /closed/);
    await rejects(aisyah("withdraw_claim", { claim: a2 }), /closed/);
    const again = await admin("claim_report", { month: "2026-10" });
    assert.equal(again.report_scope, "stored final report");
    assert.equal(again.pdf.id, closed.pdf.id, "the final report is the stored file, not a rebuilt one");
  });

  await t.test("the database itself refuses changes to a closed submission", async () => {
    const ctx = { tenantId: tenantA, actor: "test", agent: "test" };
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.expense_claim SET amount = 1 WHERE number = $1", [a1])), /closed monthly submission/);
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.expense_batch SET status = 'open' WHERE period_key = '2026-10'")), /closed and frozen/);
    await assert.rejects(
      withContext(db, ctx, (tx) => tx.query("INSERT INTO di.expense_receipt (claim_id, file_path, name, mime, bytes, sha256) SELECT id, '/x', 'x', 'image/png', 1, 'x' FROM di.expense_claim WHERE number = $1", [a1])),
      /receipts can no longer be added/,
    );
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("DELETE FROM di.expense_claim")), /Hard delete is disabled|permission denied/);
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.expense_claim SET number = 'EXP-9999-0001' WHERE number = $1", [d1])), /never change|closed/);
    await assert.rejects(withContext(db, ctx, (tx) => tx.query("UPDATE di.expense_receipt SET sha256 = 'tampered'")), /cannot be edited/);
  });

  await t.test("a claim filed after a submission closes rolls into the next one", async () => {
    const out = await daniel("file_claim", claim({ merchant: "Starbucks", category: "meals", amount: 18.9, receipts: [await inbox("coffee.png")] }));
    assert.equal(out.claim.submission.period_key, "2026-11");
    assert.equal(out.submission.cutoff_date, "2026-11-10");
    const subs = await admin("list_monthly_submissions");
    assert.deepEqual(subs.submissions.map((s) => [s.period_key, s.status]), [["2026-11", "open"], ["2026-10", "closed"]]);
    const carried = await admin("list_claims", {});
    assert.ok(carried.claims.some((c) => c.number === d1 && c.submission === "2026-11"), "the carried-forward claim is in the new submission");
    clock.now = new Date("2026-10-12T04:00:00Z");
    const late = await aisyah("file_claim", claim({ expense_date: "2026-10-11", merchant: "Bookshop", category: "office", amount: 21, receipts: [await inbox("books.png")] }));
    assert.equal(late.claim.submission.period_key, "2026-11");
    clock.now = new Date("2026-10-02T04:00:00Z");
  });

  await t.test("the cut-off day is a setting; claims in open submissions follow it", async () => {
    const b = as("admin", tenantB);
    const user = as("aisyah", tenantB);
    clock.now = new Date("2026-10-08T04:00:00Z");
    const first = await user("file_claim", claim({ expense_date: "2026-10-07", amount: 20, no_receipt_reason: "app booking" }));
    assert.equal(first.claim.submission.period_key, "2026-10", "filed on the 8th, cut-off 10");
    await rejects(user("set_expense_settings", { cutoff_day: 5 }), /Only an admin/);
    await rejects(b("set_expense_settings", { cutoff_day: 31 }), /1 to 28/);
    await rejects(b("set_expense_settings", {}), /at least one setting/);
    const changed = await b("set_expense_settings", { cutoff_day: 5 });
    assert.equal(changed.settings.cutoff_day, 5);
    assert.equal(changed.claims_moved_between_open_submissions, 1);
    const moved = await user("get_claim", { claim: first.claim.number });
    assert.equal(moved.claim.submission.period_key, "2026-11", "filed after the 5th, so it belongs to the next month");
    const subs = await b("list_monthly_submissions");
    assert.deepEqual(subs.submissions.map((s) => s.period_key), ["2026-11"], "the emptied submission was archived");
    assert.equal(subs.submissions[0].cutoff_date, "2026-11-05");
    assert.equal(subs.submissions[0].period_start, "2026-10-06");
    clock.now = new Date("2026-10-02T04:00:00Z");
  });

  await t.test("only the Expenses Clerk has these tools, and it has no CRM tools", async () => {
    await rejects(runTool(deps(tenantA), { agent: "di-records", tool: "list_claims", args: {} }), /not allowed/);
    await rejects(runTool(deps(tenantA), { agent: "di-expenses", tool: "find_customers", args: {} }), /not allowed/);
    await rejects(runTool(deps(tenantA), { agent: "di-expenses", tool: "issue_document", args: {} }), /not allowed/);
    assert.ok(allowed("di-expenses", "list_company_members"));
    assert.equal(AGENTS["di-expenses"].name, "Expenses Clerk");
    const names = toolsFor("di-expenses").map((tool) => tool.name).sort();
    assert.deepEqual(names, ["claim_report", "close_monthly_submission", "export_claims", "file_claim", "get_claim", "get_expense_settings", "list_claims", "list_company_members", "list_monthly_submissions", "review_claim", "run_report", "set_expense_settings", "update_claim", "withdraw_claim"]);
  });
});

test("the report renderer is pure and escapes everything", () => {
  const claims = [
    { id: "1", number: "EXP-2026-0001", status: "approved", claimant: { name: "A <b>", email: "a@x.test", user_id: "u1", member_id: null }, expense_date: "2026-10-01", merchant: "<script>alert(1)</script>", category: "meals", description: "d & e", currency: "MYR", amount: 10, tax_amount: null, payment_method: "cash", submitted_at: "2026-10-02T04:00:00.000Z", reviewed_by: null, review_note: null, no_receipt_reason: null, submission: { period_key: "2026-10" }, receipts: [{ id: "r1", name: "r.png", mime: "image/png", bytes: 1, path: "/files/x/y.png" }] },
    { id: "2", number: "EXP-2026-0002", status: "withdrawn", claimant: { name: "A <b>", email: null, user_id: "u1", member_id: null }, expense_date: "2026-10-01", merchant: "Gone", category: "meals", currency: "MYR", amount: 99, submitted_at: "2026-10-02T04:00:00.000Z", receipts: [], submission: { period_key: "2026-10" } },
  ];
  const sum = summariseSubmission(claims);
  assert.equal(sum.totals.claimed, 10, "withdrawn claims never count");
  assert.equal(sum.withdrawn, 1);
  const html = renderExpenseReportHtml({
    batch: { id: "b", period_key: "2026-10", label: "Oct 2026 submission", status: "open", period_start: "2026-09-11", cutoff_date: "2026-10-10", closed_at: null, closed_by: null },
    claims, company: { name: "Acme <Sdn> Bhd", address: { line1: "1 Jalan & Co" } }, currency: "MYR", cutoff_day: 10, scope: "all", claimant_filter: null,
  }, { images: new Map([["r1", "data:image/png;base64,AAAA"]]), generatedOn: "2026-10-02" });
  assert.match(html, /Acme &lt;Sdn&gt; Bhd/);
  assert.match(html, /A &lt;b&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /Gone/);
  assert.match(html, /src="data:image\/png;base64,AAAA"/);
  assert.equal(claimsToCsv(claims).split("\r\n")[0].split(",")[0], "Claim no");
});

test("demo claims: filed through the real pipeline, across a closed and an open submission", async () => {
  const { db, as, deps, tenantA, filesRoot, dir } = await setup();
  const admin = as("admin");
  const withPdf = { ...deps(tenantA), filesRoot, renderPdf: async (html, abs) => { await mkdir(path.dirname(abs), { recursive: true }); await writeFile(abs, `%PDF-1.4
${html}`); } };
  await rejects(seedDemoClaims(withPdf, USERS["tok-aisyah"]).catch((e) => { throw new Error(e.message); }), /Only an admin/);
  const out = await seedDemoClaims(withPdf, USERS["tok-admin"], { now: new Date("2026-10-02T04:00:00Z") });
  assert.equal(out.seeded, 12);
  assert.equal(out.closed_submission.label, "Sep 2026 submission");
  assert.match(out.closed_submission.report, /expense-claims-2026-09\.pdf/);
  assert.equal(out.open_submission, "Oct 2026 submission");

  const again = await seedDemoClaims(withPdf, USERS["tok-admin"], { now: new Date("2026-10-02T04:00:00Z") });
  assert.deepEqual(again, { seeded: 0, already_loaded: 12 }, "loading twice changes nothing");

  const subs = await admin("list_monthly_submissions");
  assert.deepEqual(subs.submissions.map((s) => [s.period_key, s.status]), [["2026-10", "open"], ["2026-09", "closed"]]);
  const sep = subs.submissions[1];
  assert.equal(sep.totals.claimed, 733.7);
  assert.equal(sep.totals.approved, 668.8);
  assert.equal(sep.totals.rejected, 64.9);
  assert.equal(sep.totals.pending_count, 0, "the closed month has nothing pending");
  assert.match(sep.report_path, /^\/files\//);
  const oct = subs.submissions[0];
  assert.equal(oct.totals.pending_count, 4);
  const stillOpen = await admin("list_claims", {});
  assert.ok(stillOpen.claims.every((c) => c.submission === "2026-10"));
  const one = await admin("get_claim", { claim: stillOpen.claims[0].number });
  assert.equal(one.claim.receipts[0].mime, "application/pdf");
  assert.equal(one.claim.claimant.user_id === null || one.claim.claimant.user_id === "u-admin", true);
  const rejected = await admin("list_claims", { month: "2026-09", status: "rejected" });
  assert.equal(rejected.claims[0].claimant, "Priya Nair");
  assert.equal((await as("aisyah")("list_claims", { month: "all" })).claims.length, 0, "demo people have no login, so a regular user sees none of it");
  assert.equal((await admin("list_claims", { month: "all", claimant: "daniel" })).claims.length, 4);
  const receiptHtml = demoReceiptHtml({ merchant: "A & B", address: "x", amount: 10, description: "d", pay: "cash" }, { date: "2026-10-01", number: "R-1" });
  assert.match(receiptHtml, /SAMPLE RECEIPT, DEMO DATA/);
  assert.match(receiptHtml, /A &amp; B/);
  assert.ok((await db.query("SELECT count(*)::int AS n FROM di.expense_claim WHERE custom->>'demo' = 'true'")).rows[0].n === 12);
  assert.ok(dir);
});
