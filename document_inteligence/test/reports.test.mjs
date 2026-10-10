// Company reports defined as data: validated specs, a pure grouping engine, scoped execution and the
// Forward Deploy Engineer adding, previewing and removing them.
// Worked example: "monthly mileage claims for all sales employees".
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { runTool, describeError } from "../core/actions.mjs";
import { aggregate, normaliseReportSpec, toMarkdown } from "../core/reports.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a30000000049454e44ae426082", "hex");
const USERS = {
  "tok-admin": { id: "u-admin", username: "admin", display_name: "Admin", role: "admin", email: null },
  "tok-aisyah": { id: "u-aisyah", username: "aisyah", display_name: "Aisyah Rahman", role: "user", email: "aisyah@acme.test" },
  "tok-priya": { id: "u-priya", username: "priya", display_name: "Priya Nair", role: "user", email: "priya@acme.test" },
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

const MILEAGE = {
  target_agent: "di-expenses",
  summary: "Mileage claims need a route screenshot and the distance",
  categories: [{ key: "mileage", label: "Mileage (km driven)" }],
  custom_fields: [{ key: "distance_km", label: "Distance (km)", type: "number" }, { key: "note_text", label: "Note", type: "text" }],
  rules: [
    { id: "mileage-distance", when: { category: ["mileage"] }, check: "custom_field", arg: "expense_claim.distance_km", severity: "block", message: "Mileage claims need the distance in km." },
    { id: "mileage-map", when: { category: ["mileage"] }, check: "attachment_kind", arg: "route_map", severity: "block", message: "Mileage claims need the Google Maps route screenshot." },
  ],
  examples: [
    { claim: { category: "mileage", amount: 50, custom: { distance_km: 10 }, attachment_kinds: ["route_map"] }, expect: "ok" },
    { claim: { category: "mileage", amount: 50, custom: {}, attachment_kinds: [] }, expect: "blocked" },
  ],
};
const MILEAGE_REPORT = {
  slug: "mileage-monthly-sales", title: "Mileage claims, Sales, this month",
  where: { category: ["mileage"], department: ["Sales"], period: "current" },
  group_by: ["employee"],
  measures: [{ key: "claims", fn: "count" }, { key: "total", label: "Total (MYR)", fn: "sum", field: "amount" }, { key: "km", label: "Distance (km)", fn: "sum", field: "custom.distance_km" }],
  include_members: true, audience: "admin",
};
const reportChange = (over = {}) => ({ target_agent: "di-expenses", summary: "Monthly mileage report for Sales", reports: [MILEAGE_REPORT], examples: [], ...over });

// ------------------------------------------------------------------ the spec (pure)

test("a report spec is checked against a closed vocabulary", () => {
  const ok = normaliseReportSpec(MILEAGE_REPORT, { categories: ["mileage"], numberFields: ["distance_km"] });
  assert.equal(ok.period_basis, "submission", "the claim cycle is the default month");
  assert.equal(ok.audience, "admin");
  assert.deepEqual(normaliseReportSpec({ slug: "all-claims", title: "All" }).measures, [{ key: "claims", fn: "count" }], "no measures means a count");
  const bad = (over, pattern, refs) => assert.throws(() => normaliseReportSpec({ ...MILEAGE_REPORT, ...over }, refs), pattern);
  bad({ slug: "Bad Slug" }, /slug must be/);
  bad({ title: "" }, /title is required/);
  bad({ dataset: "invoices" }, /dataset/);
  bad({ where: { colour: ["red"] } }, /does not know colour/);
  bad({ where: { status: ["paid"] } }, /where\.status/);
  bad({ where: { period: "last week" } }, /where\.period/);
  bad({ period_basis: "weekly" }, /period_basis/);
  bad({ group_by: ["employee", "employee"] }, /group_by/);
  bad({ group_by: ["employee", "department", "category"] }, /group_by/);
  bad({ measures: [{ key: "x", fn: "sum" }] }, /needs a field/);
  bad({ measures: [{ key: "x", fn: "median", field: "amount" }] }, /fn must be/);
  bad({ measures: [{ key: "x", fn: "sum", field: "password" }] }, /field must be/);
  bad({ measures: [{ key: "x", fn: "count" }, { key: "x", fn: "count" }] }, /own key/);
  bad({ include_members: true, group_by: ["category"] }, /employee alone/);
  bad({ audience: "everyone" }, /audience/);
  bad({ sort: { by: "nothing" } }, /sort\.by/);
  bad({}, /category "mileage" does not exist/, { categories: ["meals"], numberFields: ["distance_km"] });
  bad({}, /custom\.distance_km is not a number field/, { categories: ["mileage"], numberFields: [] });
});

// ------------------------------------------------------------------ grouping (pure)

const claim = (over) => ({ number: "EXP-1", status: "submitted", category: "mileage", amount: 10, tax_amount: null, expense_date: "2026-10-01", claimant_key: "m1", claimant_name: "Aisyah", department: "Sales", custom: {}, period_key: "2026-10", ...over });

test("grouping, measures, sorting and totals", () => {
  const rows = [
    claim({ number: "1", amount: 40, custom: { distance_km: 100 } }),
    claim({ number: "2", amount: 100, custom: { distance_km: 250.5 } }),
    claim({ number: "3", amount: 25, claimant_key: "m2", claimant_name: "Priya", custom: { distance_km: 60 } }),
    claim({ number: "4", amount: 18, claimant_key: "m2", claimant_name: "Priya", category: "meals", custom: {} }),
  ];
  const spec = normaliseReportSpec({
    slug: "t", title: "T", group_by: ["employee"], sort: { by: "total", dir: "desc" },
    measures: [{ key: "n", fn: "count" }, { key: "total", fn: "sum", field: "amount" }, { key: "avg", fn: "avg", field: "amount" }, { key: "top", fn: "max", field: "amount" }, { key: "km", fn: "sum", field: "custom.distance_km" }, { key: "km_n", fn: "count", field: "custom.distance_km" }],
  });
  const out = aggregate(rows, spec);
  assert.deepEqual(out.columns.map((c) => c.label), ["Employee", "Claims", "Sum amount", "Avg amount", "Max amount", "Sum distance km", "Claims"]);
  assert.deepEqual(out.rows[0], { employee: "Aisyah", n: 2, total: 140, avg: 70, top: 100, km: 350.5, km_n: 2 });
  assert.deepEqual(out.rows[1], { employee: "Priya", n: 2, total: 43, avg: 21.5, top: 25, km: 60, km_n: 1 }, "a claim without the field is left out of that measure only");
  assert.deepEqual(out.totals, { n: 4, total: 183, avg: 45.75, top: 100, km: 410.5, km_n: 3 });

  const byTwo = aggregate(rows, normaliseReportSpec({ slug: "t2", title: "T", group_by: ["department", "category"] }));
  assert.deepEqual(byTwo.rows.map((r) => [r.department, r.category, r.claims]), [["Sales", "mileage", 3], ["Sales", "meals", 1]].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])));
  const none = aggregate(rows, normaliseReportSpec({ slug: "t3", title: "T" }));
  assert.deepEqual(none.rows, [{ claims: 4 }], "no grouping is one total row");
  const byMonth = aggregate([claim({ expense_date: "2026-09-30", period_key: "2026-10" })], normaliseReportSpec({ slug: "t4", title: "T", group_by: ["month"], period_basis: "expense_date" }));
  assert.equal(byMonth.rows[0].month, "2026-09", "expense_date basis groups by the calendar month of the expense");
  assert.equal(aggregate([claim({ expense_date: "2026-09-30", period_key: "2026-10" })], normaliseReportSpec({ slug: "t5", title: "T", group_by: ["month"] })).rows[0].month, "2026-10");
});

test("people with no claims can be listed, and the table escapes what it shows", () => {
  const spec = normaliseReportSpec({ slug: "t", title: "T", group_by: ["employee"], include_members: true, measures: [{ key: "n", fn: "count" }] });
  const out = aggregate([claim({ claimant_key: "m1", claimant_name: "A|B" })], spec, { members: [{ key: "m1", name: "A|B", department: "Sales" }, { key: "m9", name: "Hana", department: "Sales" }] });
  assert.deepEqual(out.rows.map((r) => [r.employee, r.n]), [["A|B", 1], ["Hana", 0]]);
  const md = toMarkdown(out, spec);
  assert.match(md, /\| A\\\|B \| 1 \|/);
  assert.match(md, /\| Hana \| 0 \|/);
  assert.match(md, /\*\*Total\*\* \| \*\*1\*\*/);
});

// ------------------------------------------------------------------ the mileage report on a real engine

async function setup() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const mk = async (name) => (await db.query("INSERT INTO di.tenant (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
  const tenantA = await mk("A");
  const tenantB = await mk("B");
  await seedTenant(db, tenantA);
  await seedTenant(db, tenantB);
  await db.query(
    "INSERT INTO di.company_member (tenant_id, name, email, user_id, department) VALUES ($1, 'Aisyah Rahman', 'aisyah@acme.test', 'u-aisyah', 'Sales'), ($1, 'Priya Nair', 'priya@acme.test', 'u-priya', 'Sales'), ($1, 'Daniel Lee', 'daniel@acme.test', 'u-daniel', 'Ops'), ($1, 'Hana Said', 'hana@acme.test', NULL, 'Sales')",
    [tenantA],
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-rep-"));
  const sops = new Map();
  const sop = { get: async (id) => (sops.has(id) ? { content: sops.get(id) } : null), save: async (id, c) => { sops.set(id, c); }, clear: async (id) => { sops.delete(id); } };
  const deps = (tenantId) => ({
    db, tenantId: () => tenantId, sop,
    workspace: (agent) => path.join(dir, agent),
    now: () => new Date("2026-10-02T04:00:00Z"),
    resolveIdentity: async (code) => USERS[code] ?? null,
  });
  let n = 0;
  const inbox = async (name) => {
    const rel = `_inbox/1759${String(++n).padStart(9, "0")}-0-${name}`;
    await mkdir(path.join(dir, "di-expenses", "_inbox"), { recursive: true });
    await writeFile(path.join(dir, "di-expenses", rel), Buffer.concat([PNG, Buffer.from(`f${n}`)]));
    return rel;
  };
  const as = (agent, who, tenantId = tenantA) => (tool, args = {}) => runTool(deps(tenantId), { agent, tool, args: { identity: `tok-${who}`, ...args } });
  const trip = async (who, merchant, km, amount, extra = {}) =>
    as("di-expenses", who)("file_claim", { expense_date: "2026-10-01", merchant, category: "mileage", amount, custom: { distance_km: km }, receipts: [await inbox("map.png")], receipt_kinds: ["route_map"], ...extra });
  return { db, tenantA, tenantB, as, inbox, trip, fde: as("di-fde", "admin"), boss: as("di-expenses", "admin") };
}

const deploy = async (fde, changeset) => {
  const preview = await fde("fde_apply", { changeset });
  return { preview, done: await fde("fde_apply", { changeset, fingerprint: preview.fingerprint }) };
};

test("monthly mileage for all sales employees: added in chat, previewed on real data, run, removed", async (t) => {
  const { tenantB, as, inbox, trip, fde, boss } = await setup();
  const aisyah = as("di-expenses", "aisyah");
  const priya = as("di-expenses", "priya");
  let withdrawn;

  await t.test("the mileage rules go in first, then the claims the report will count", async () => {
    await deploy(fde, MILEAGE);
    await trip("aisyah", "KL to Penang", 100, 40);
    await trip("aisyah", "KL to Ipoh", 250.5, 100);
    await trip("priya", "KL to Melaka", 60, 25);
    await trip("daniel", "KL to Johor", 300, 150);
    withdrawn = (await trip("priya", "Cancelled trip", 999, 999)).claim.number;
    await priya("withdraw_claim", { claim: withdrawn, reason: "wrong date" });
    await aisyah("file_claim", { expense_date: "2026-10-01", merchant: "Lunch", category: "meals", amount: 18, receipts: [await inbox("lunch.png")] });
  });

  await t.test("the preview shows the admin the report on today's data before it exists", async () => {
    const preview = await fde("fde_apply", { changeset: reportChange() });
    assert.equal(preview.valid, true);
    assert.match(preview.diff[0], /^\+ report mileage-monthly-sales: "Mileage claims, Sales, this month" \(admins only, by employee\)/);
    const rep = preview.impact.reports[0];
    assert.equal(rep.claims_covered, 3, "Daniel is in Ops, the lunch is not mileage, the withdrawn trip never counts");
    assert.deepEqual(rep.rows.map((r) => r.employee), ["Aisyah Rahman", "Hana Said", "Priya Nair"], "Hana has no claims but is a Sales person");
    assert.deepEqual(rep.totals, { claims: 3, total: 165, km: 410.5 });
  });

  await t.test("before it is applied nothing exists", async () => {
    assert.deepEqual((await boss("run_report")).reports, []);
    await rejects(boss("run_report", { report: "mileage-monthly-sales" }), /No report "mileage-monthly-sales"/);
  });

  await t.test("applied: an admin runs it and gets the table", async () => {
    const { done } = await deploy(fde, reportChange());
    assert.equal(done.applied, true);
    const out = await boss("run_report", { report: "mileage-monthly-sales" });
    assert.equal(out.period.month, "2026-10");
    assert.equal(out.scope, "all claims");
    assert.deepEqual(out.columns.map((c) => c.label), ["Employee", "Claims", "Total (MYR)", "Distance (km)"]);
    assert.deepEqual(out.rows, [
      { employee: "Aisyah Rahman", claims: 2, total: 140, km: 350.5 },
      { employee: "Hana Said", claims: 0, total: 0, km: 0 },
      { employee: "Priya Nair", claims: 1, total: 25, km: 60 },
    ]);
    assert.deepEqual(out.totals, { claims: 3, total: 165, km: 410.5 });
    assert.match(out.markdown, /\| Aisyah Rahman \| 2 \| 140 \| 350\.5 \|/);
    assert.equal(out.truncated, false);
    assert.equal((await boss("get_expense_settings")).reports[0].slug, "mileage-monthly-sales");
    const September = await boss("run_report", { report: "mileage-monthly-sales", month: "2026-09" });
    assert.deepEqual(September.rows.map((r) => r.claims), [0, 0, 0], "another month: the same people, nothing claimed");
  });

  await t.test("only admins run an admin report, and employees never see it listed", async () => {
    await rejects(aisyah("run_report", { report: "mileage-monthly-sales" }), /No report "mileage-monthly-sales" is available to you/);
    assert.deepEqual((await aisyah("run_report")).reports, []);
    assert.deepEqual((await aisyah("get_expense_settings")).reports, []);
  });

  await t.test("a scoped report lets everyone run it but only over their own claims", async () => {
    await deploy(fde, reportChange({
      summary: "Everyone can see their own mileage",
      reports: [{ slug: "my-mileage", title: "My mileage", where: { category: ["mileage"], period: "all" }, group_by: ["category"], measures: [{ key: "claims", fn: "count" }, { key: "km", fn: "sum", field: "custom.distance_km" }], audience: "scoped" }],
    }));
    const mine = await aisyah("run_report", { report: "my-mileage" });
    assert.equal(mine.scope, "your claims only");
    assert.deepEqual(mine.rows, [{ category: "Mileage", claims: 2, km: 350.5 }]);
    assert.deepEqual((await priya("run_report", { report: "my-mileage" })).rows, [{ category: "Mileage", claims: 1, km: 60 }]);
    assert.deepEqual((await boss("run_report", { report: "my-mileage" })).rows, [{ category: "Mileage", claims: 4, km: 710.5 }], "an admin sees everyone's");
    assert.deepEqual((await aisyah("run_report")).reports.map((r) => r.slug), ["my-mileage"], "only the scoped one is listed to an employee");
  });

  await t.test("a report is refused when it names something that will not exist", async () => {
    await rejects(fde("fde_apply", { changeset: reportChange({ reports: [{ ...MILEAGE_REPORT, slug: "bad-one", where: { category: ["flying"] } }] }) }), /category "flying" does not exist/);
    await rejects(fde("fde_apply", { changeset: reportChange({ reports: [{ ...MILEAGE_REPORT, slug: "bad-two", measures: [{ key: "k", fn: "sum", field: "custom.note_text" }] }] }) }), /not a number field/);
    await rejects(fde("fde_apply", { changeset: reportChange({ reports: [{ ...MILEAGE_REPORT, slug: "bad-three", measures: [{ key: "k", fn: "sum", field: "custom.unknown_field" }] }] }) }), /not a number field/);
  });

  await t.test("a report on its own describes itself, and is removed without touching the rules", async () => {
    const described = await fde("fde_describe");
    assert.equal(described.current.reports.length, 2);
    assert.ok(described.current.managed.reports.includes("mileage-monthly-sales"));
    assert.match(described.vocabulary.report.period, /submission/);
    const preview = await fde("fde_revert", { scope: "item", kind: "report", key: "mileage-monthly-sales" });
    assert.deepEqual(preview.diff, ["- report mileage-monthly-sales"]);
    await fde("fde_revert", { scope: "item", kind: "report", key: "mileage-monthly-sales", fingerprint: preview.fingerprint });
    await rejects(boss("run_report", { report: "mileage-monthly-sales" }), /No report/);
    assert.deepEqual((await boss("run_report")).reports.map((r) => r.slug), ["my-mileage"]);
    assert.equal((await boss("get_expense_settings")).policy.requirements.length, 2, "the mileage rules are still in force");
  });

  await t.test("undo brings the removed report back, and a reset takes every report away", async () => {
    const undo = await fde("fde_revert", { scope: "last" });
    await fde("fde_revert", { scope: "last", fingerprint: undo.fingerprint });
    assert.deepEqual((await boss("run_report")).reports.map((r) => r.slug).sort(), ["mileage-monthly-sales", "my-mileage"]);
    const reset = await fde("fde_revert", { scope: "all" });
    assert.ok(reset.diff.includes("- report my-mileage"));
    await fde("fde_revert", { scope: "all", fingerprint: reset.fingerprint });
    assert.deepEqual((await boss("run_report")).reports, []);
    assert.equal((await boss("get_expense_settings")).categories.length, 11);
  });

  await t.test("another company has no reports", async () => {
    assert.deepEqual((await as("di-expenses", "admin", tenantB)("run_report")).reports, []);
  });
});

test("a report on a company with no claims yet says so instead of failing the preview", async () => {
  const { fde } = await setup();
  const preview = await fde("fde_apply", { changeset: { ...reportChange(), custom_fields: [{ key: "distance_km", label: "Distance (km)", type: "number" }], categories: [{ key: "mileage", label: "Mileage" }] } });
  assert.match(preview.impact.reports[0].note, /no open monthly submission/i);
  assert.equal(preview.valid, true);
});
