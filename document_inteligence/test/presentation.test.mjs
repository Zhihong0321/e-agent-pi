// The visual layer agents hand to people: the default invoice/quotation template and
// the CRM dashboard. Real Postgres (PGlite) so the dashboard SQL is actually executed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter, withContext } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { runTool } from "../core/actions.mjs";
import { buildContext, checkTemplate, defaultTemplateHtml, renderTemplate, sampleContext, DEFAULT_TEMPLATE_REV } from "../core/templates.mjs";
import { renderCrmDashboard, sampleDashboard } from "../core/dashboard.mjs";
import { addDays, todayMY } from "../core/common.mjs";

async function setup() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const mk = async (name) => (await db.query("INSERT INTO di.tenant (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
  const a = await mk("A");
  await seedTenant(db, a);
  const ctx = { tenantId: a, actor: "test", agent: "test", asRole: false };
  const q = (sql, params) => withContext(db, ctx, (tx) => tx.query(sql, params)).then((r) => r.rows);
  const as = (agent) => (tool, args) => runTool({ db, tenantId: () => a, workspace: () => "." }, { agent, tool, args });
  return { db, a, q, as };
}

const doc = (over = {}) => ({
  doc_type: "invoice", status: "issued", number: "INV-1", issue_date: "2026-09-01", due_date: "2099-01-01",
  subtotal: 100, discount_total: 0, tax_total: 0, total: 100, amount_paid: 0, currency: "MYR", ...over,
});

test("default templates", async (t) => {
  await t.test("parse cleanly and use only known fields", () => {
    for (const type of ["invoice", "quotation", "credit_note"]) {
      const check = checkTemplate(defaultTemplateHtml(type));
      assert.equal(check.ok, true, check.error);
      // tax_summary rows are the only fields checkTemplate cannot see through {{#each}}
      assert.deepEqual(check.unknownFields.sort(), ["code", "rate", "tax", "taxable"]);
    }
  });

  await t.test("summary band tells the reader what matters for each state", () => {
    const html = (ctx) => renderTemplate(defaultTemplateHtml("invoice"), ctx);
    const build = (d) => buildContext({ ...sampleContext("invoice") && {}, doc: doc(d), lines: [], customer: { name: "X" }, tenant: { name: "Acme" } });
    assert.match(html(build({})), /Amount due[\s\S]*100\.00/);
    const overdue = html(build({ due_date: "2020-01-01" }));
    assert.match(overdue, /Overdue/);
    assert.match(overdue, /class="st red"/);
    const paid = html(build({ status: "paid", amount_paid: 100 }));
    assert.match(paid, /Paid in full/);
    assert.match(paid, /class="stamp/, "paid invoices carry a PAID stamp");
    const part = html(build({ status: "partially_paid", amount_paid: 40 }));
    assert.match(part, /Amount due[\s\S]*60\.00/);
    assert.match(part, /Received to date/);
    assert.ok(!part.includes(`class="stamp`));
    const draft = html(build({ status: "draft", number: null }));
    assert.match(draft, /class="wm">DRAFT/, "drafts are watermarked");
    assert.ok(!draft.includes("as the payment reference"), "no payment reference for an unnumbered draft");
  });

  await t.test("user content stays escaped and optional parts drop out", () => {
    const ctx = buildContext({ doc: doc({ notes: "<script>x</script>" }), lines: [], customer: { name: "<b>Evil</b>" }, tenant: { name: "Acme" } });
    const out = renderTemplate(defaultTemplateHtml("invoice"), ctx);
    assert.ok(!out.includes("<script>x"));
    assert.ok(!out.includes("<b>Evil"));
    assert.ok(!out.includes("Payment details"), "no bank details, no empty box");
    assert.ok(!/\{\{|undefined/.test(out));
  });

  await t.test("quotation has acceptance block and valid-until, no balance", () => {
    const ctx = buildContext({ doc: doc({ doc_type: "quotation", valid_until: "2026-10-30" }), lines: [], customer: { name: "X" }, tenant: { name: "Acme" } });
    const out = renderTemplate(defaultTemplateHtml("quotation"), ctx);
    assert.match(out, /Acceptance/);
    assert.match(out, /Valid until/);
    assert.ok(!out.includes("Received to date"));
    assert.ok(!out.includes("computer-generated"));
  });
});

test("seed upgrades untouched default templates only", async () => {
  const { db, a, q } = await setup();
  const current = () => q("SELECT version, is_default, notes FROM di.template WHERE doc_type = 'invoice' ORDER BY version");

  let rows = await current();
  assert.equal(rows.length, 1);
  assert.match(rows[0].notes, new RegExp(`v${DEFAULT_TEMPLATE_REV}$`));

  await seedTenant(db, a);
  assert.equal((await current()).length, 1, "re-seeding is idempotent");

  // A tenant created before versioned seeding still has the original v1 seed.
  await q("UPDATE di.template SET notes = 'Seeded default A4 template', html = '<old/>' WHERE doc_type = 'invoice'");
  await seedTenant(db, a);
  rows = await current();
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.is_default), [false, true]);
  assert.equal(rows[1].version, 2);

  // A default the tenant wrote themselves is never replaced.
  await q("UPDATE di.template SET is_default = false WHERE doc_type = 'invoice'");
  await q("INSERT INTO di.template (doc_type, name, version, html, is_default, notes) VALUES ('invoice', 'Ours', 1, '<ours/>', true, 'custom')");
  await q("UPDATE di.template SET notes = 'Seeded default A4 template' WHERE name = 'Standard invoice'");
  await seedTenant(db, a);
  const custom = await q("SELECT name FROM di.template WHERE doc_type = 'invoice' AND is_default");
  assert.deepEqual(custom.map((r) => r.name), ["Ours"]);
});

test("crm dashboard", async (t) => {
  await t.test("renders dummy data without leaking markup", () => {
    const d = sampleDashboard();
    d.top[0].name = "<img src=x onerror=alert(1)>";
    const html = renderCrmDashboard(d);
    assert.ok(!html.includes("<img src=x"));
    assert.match(html, /Business overview/);
    assert.match(html, /<svg[\s\S]*Billed versus collected/);
    assert.ok(!/undefined|NaN/.test(html));
    assert.ok(html.length < 22000, "must fit the MCP reply cap");
  });

  await t.test("empty tenant gets friendly empty states", async () => {
    const { as } = await setup();
    const out = await as("di-records")("crm_dashboard", {});
    assert.ok(out.startsWith("```html\n") && out.endsWith("\n```"));
    assert.match(out, /Nothing outstanding/);
    assert.match(out, /All clear/);
    assert.ok(!/undefined|NaN/.test(out));
  });

  await t.test("reads real records", async () => {
    const { q, as } = await setup();
    const [c] = await q("INSERT INTO di.customer (code, name) VALUES ('C-1', 'Kilang Maju Sdn Bhd') RETURNING id");
    const today = todayMY();
    const ins = (number, status, total, paid, due) =>
      q(`INSERT INTO di.document (doc_type, number, status, customer_id, issue_date, due_date, total, subtotal, amount_paid, issued_at)
         VALUES ('invoice', $1, $2, $3, $4, $5, $6, $6, $7, now())`, [number, status, c.id, today, due, total, paid]);
    await ins("INV-A", "issued", 1000, 0, addDays(today, -40));
    await ins("INV-B", "partially_paid", 500, 200, addDays(today, 10));
    await ins("INV-C", "paid", 300, 300, addDays(today, -5));
    await q("INSERT INTO di.payment (number, customer_id, received_on, amount) VALUES ('PAY-1', $1, $2, 500)", [c.id, today]);

    const out = await as("di-documents")("crm_dashboard", {});
    assert.match(out, /INV-A is 40 days overdue/);
    assert.match(out, /RM 1,300/, "outstanding = 1000 + 300");
    assert.match(out, /Kilang Maju Sdn Bhd/);
    assert.match(out, /RM 1,800/, "billed this month");
    assert.match(out, /RM 500/, "collected this month");
  });

  await t.test("is offered to the records, documents and db agents only", async () => {
    const { as } = await setup();
    await assert.rejects(as("di-forms")("crm_dashboard", {}), /not allowed/);
  });
});
