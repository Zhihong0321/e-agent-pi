// End-to-end tests on a real Postgres engine (PGlite, in-process). They exercise the
// safety guarantees (no hard delete, tenant isolation, frozen documents, per-agent
// tools) and the two demo flows: name card -> CRM, and quotation -> invoice -> paid.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter, roleAvailable, withContext } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { runTool, describeError } from "../core/actions.mjs";
import { renderTemplate, checkTemplate } from "../core/templates.mjs";
import { todayMY } from "../core/common.mjs";
import { TOOLS, AGENTS } from "../core/tools.mjs";

const year = todayMY().slice(0, 4);

async function setup() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const mk = async (name) => (await db.query("INSERT INTO di.tenant (name, is_default) VALUES ($1, $2) RETURNING id", [name, name === "A"])).rows[0].id;
  const tenantA = await mk("A");
  const tenantB = await mk("B");
  await seedTenant(db, tenantA);
  await seedTenant(db, tenantB);
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-test-"));
  const rendered = [];
  const deps = (tenantId) => ({
    db,
    tenantId: () => tenantId,
    workspace: (agent) => path.join(dir, agent),
    renderPdf: async (html, abs) => {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, html);
      rendered.push(abs);
    },
  });
  const as = (agent, tenantId = tenantA) => (tool, args) => runTool(deps(tenantId), { agent, tool, args });
  return { db, tenantA, tenantB, as, rendered };
}

const rejects = async (promise, pattern) => {
  try {
    await promise;
  } catch (error) {
    assert.match(describeError(error), pattern);
    return;
  }
  assert.fail(`expected rejection matching ${pattern}`);
};

test("document intelligence", async (t) => {
  const { db, tenantA, tenantB, as, rendered } = await setup();
  const clerk = as("di-records");
  const docs = as("di-documents");
  const tpl = as("di-templates");
  const dbm = as("di-db");

  await t.test("migration is idempotent and the agent role exists", async () => {
    assert.deepEqual(await migrate(db), []);
    assert.equal(await roleAvailable(db), true);
  });

  let acme;
  await t.test("name card creates customer + contact + evidence", async () => {
    const card = {
      person_name: "Tan Mei Ling",
      job_title: "Procurement Manager",
      company_name: "Acme Solar Sdn. Bhd.",
      reg_no: "202301012345 (1500000-A)",
      email: "meiling@acmesolar.com.my",
      mobile: "012-345 6789",
      address: { line1: "12 Jalan Teknologi", postcode: "47810", city: "Petaling Jaya", state: "Selangor" },
    };
    const match = await clerk("match_customer", { company_name: card.company_name, email: card.email, person_name: card.person_name });
    assert.equal(match.verdict, "new");
    const saved = await clerk("save_name_card", { card, image_path: "_inbox/card.jpg" });
    assert.equal(saved.created.customer, true);
    assert.equal(saved.created.contact, true);
    assert.equal(saved.customer.code, "C-0001");
    acme = saved.customer;
  });

  await t.test("a second card from the same company is recognised, not duplicated", async () => {
    const match = await clerk("match_customer", {
      company_name: "ACME SOLAR",
      person_name: "Raj Kumar",
      email: "raj@acmesolar.com.my",
      phone: "+60 3-7777 8888",
    });
    assert.notEqual(match.verdict, "new");
    assert.equal(match.candidates[0].customer_id, acme.id);
    assert.ok(match.candidates[0].reasons.some((r) => r.includes("email domain")));

    const byReg = await clerk("match_customer", { reg_no: "202301012345" });
    assert.equal(byReg.verdict, "existing");

    const linked = await clerk("save_name_card", {
      card: { person_name: "Raj Kumar", company_name: "Acme Solar", email: "raj@acmesolar.com.my", website: "acmesolar.com.my" },
      customer_id: acme.id,
    });
    assert.equal(linked.created.customer, false);
    assert.equal(linked.created.contact, true);
    assert.deepEqual(linked.filled_blanks, ["website"]);

    await rejects(clerk("save_customer", { name: "Acme Solar Sdn Bhd", reg_no: "202301012345" }), /existing customer: C-0001/);
  });

  await t.test("hard delete is impossible, for agents and for the owner", async () => {
    await rejects(
      withContext(db, { tenantId: tenantA, agent: "x" }, (tx) => tx.query("DELETE FROM di.customer")),
      /permission denied/,
    );
    await rejects(db.query("DELETE FROM di.customer"), /Hard delete is disabled/);
    await rejects(db.query("TRUNCATE di.document_line"), /Hard delete is disabled|permission|cannot truncate/i);
    await rejects(
      withContext(db, { tenantId: tenantA }, (tx) => tx.query("DROP TABLE di.customer")),
      /must be owner|permission denied/,
    );
  });

  await t.test("tenants cannot see each other", async () => {
    const other = as("di-records", tenantB);
    assert.equal((await other("find_customers", {})).customers.length, 0);
    await rejects(other("get_customer", { ref: acme.id }), /not found/);
    const rows = await withContext(db, { tenantId: tenantB }, (tx) => tx.query("SELECT count(*)::int AS n FROM di.customer"));
    assert.equal(rows.rows[0].n, 0);
  });

  await t.test("each micro-agent only has its own tools", async () => {
    await rejects(clerk("define_custom_field", { entity: "customer", key: "x", label: "X", type: "text" }), /not allowed/);
    await rejects(docs("save_customer", { name: "Nope" }), /not allowed/);
    await rejects(tpl("issue_document", { document: acme.id }), /not allowed/);
    for (const [name, spec] of Object.entries(TOOLS)) {
      for (const agent of spec.agents) assert.ok(AGENTS[agent], `${name} names unknown agent ${agent}`);
    }
  });

  await t.test("custom fields must be defined by the DB Manager first", async () => {
    await rejects(clerk("save_customer", { id: acme.id, custom: { segment: "C&I" } }), /Unknown custom field customer\.segment/);
    await dbm("define_custom_field", { entity: "customer", key: "segment", label: "Segment", type: "select", options: ["Residential", "C&I"] });
    await clerk("save_customer", { id: acme.id, custom: { segment: "C&I" } });
    await rejects(clerk("save_customer", { id: acme.id, custom: { segment: "Other" } }), /must be one of/);
  });

  await t.test("catalogue: products and a package", async () => {
    await clerk("save_product", { sku: "PNL-550", name: "Solar panel 550W", unit: "unit", unit_price: 650, tax_code: "ST10" });
    await clerk("save_product", { sku: "INV-10K", name: "Hybrid inverter 10kW", unit: "unit", unit_price: 5200, tax_code: "ST10" });
    await clerk("save_product", { sku: "SVC-INSTALL", name: "Installation service", unit: "job", unit_price: 3000, tax_code: "SV8" });
    const pkg = await clerk("save_package", {
      code: "PKG-10KWP",
      name: "10kWp rooftop package",
      price: 22000,
      tax_code: "SV8",
      items: [{ product: "PNL-550", quantity: 18 }, { product: "INV-10K", quantity: 1 }],
    });
    assert.equal(pkg.effective_price, 22000);
    assert.equal(pkg.items.length, 2);
  });

  let quote;
  await t.test("quotation: prepare asks the right questions before anything is written", async () => {
    const prep = await docs("prepare_document", {
      doc_type: "quotation",
      customer: "acme",
      items: [{ query: "10kWp", quantity: 1 }, { query: "installation" }],
    });
    assert.equal(prep.resolved.customer.code, "C-0001");
    assert.equal(prep.resolved.items.length, 2);
    const about = prep.questions.map((q) => q.about);
    assert.ok(about.includes("contact"), "two contacts -> asks which one");
    assert.ok(about.includes("valid_until"));
    assert.ok(about.includes("issuer_profile_complete"), "company address missing");
    assert.equal(prep.ready_to_issue, false);
    assert.equal(prep.estimate.total, Math.round((22000 * 1.08 + 3000 * 1.08) * 100) / 100);
    const count = await db.query("SELECT count(*)::int AS n FROM di.document");
    assert.equal(count.rows[0].n, 0);
  });

  await t.test("quotation: draft -> blocked issue -> fix -> issued with number and PDF", async () => {
    const draft = await docs("create_draft", {
      doc_type: "quotation",
      customer: "C-0001",
      lines: [{ package: "PKG-10KWP" }, { product: "SVC-INSTALL", discount_amount: 500 }],
    });
    assert.equal(draft.document.status, "draft");
    assert.equal(draft.document.number, null);
    assert.equal(draft.document.total, Math.round((22000 * 1.08 + 2500 * 1.08) * 100) / 100);
    await rejects(docs("issue_document", { document: draft.document.id }), /valid[\s\S]*company name and address/i);

    await rejects(docs("update_company_profile", { name: "x" }), /not allowed/);
    await dbm("update_company_profile", {
      name: "Eternalgy",
      legal_name: "Eternalgy Sdn Bhd",
      address: { line1: "1 Jalan Demo", postcode: "50000", city: "Kuala Lumpur" },
      bank_details: "Maybank 5000 0000 0000",
    });
    await docs("update_draft", { document: draft.document.id, set: { valid_until: "2099-12-31" } });
    const issued = await docs("issue_document", { document: draft.document.id });
    assert.equal(issued.document.number, `QT-${year}-0001`);
    assert.equal(issued.document.status, "issued");
    assert.match(issued.pdf.link, /QT-\d{4}-0001\.pdf/);
    const pdfUrl = new URL(issued.pdf.url, "https://test.local");
    assert.equal(pdfUrl.pathname, "/api/files/raw");
    assert.equal(pdfUrl.searchParams.get("agent"), "di-documents");
    assert.equal(pdfUrl.searchParams.get("path"), issued.pdf.path);
    assert.ok(rendered.some((abs) => abs.endsWith(path.join("di-documents", issued.pdf.path))));
    const retrieved = await tpl("get_document", { ref: issued.document.number });
    assert.equal(retrieved.pdf.url, issued.pdf.url, "retrieving from another agent preserves the PDF owner");
    const html = await readFile(rendered.at(-1), "utf8");
    assert.match(html, /Eternalgy Sdn Bhd/);
    assert.match(html, /10kWp rooftop package/);
    assert.match(html, /18 × Solar panel 550W/);
    quote = issued.document;
  });

  await t.test("issued documents are frozen, even to raw SQL", async () => {
    await rejects(docs("update_draft", { document: quote.id, set: { notes: "x" } }), /not a draft/);
    await rejects(
      withContext(db, { tenantId: tenantA }, (tx) => tx.query("UPDATE di.document SET total = 1 WHERE id = $1", [quote.id])),
      /frozen/,
    );
    await rejects(
      withContext(db, { tenantId: tenantA }, (tx) =>
        tx.query("INSERT INTO di.document_line (document_id, description) VALUES ($1, 'sneaky')", [quote.id]),
      ),
      /only change while the document is a draft/,
    );
  });

  let invoice;
  await t.test("convert quotation -> invoice draft; invoice rules differ", async () => {
    const draft = await docs("convert_to_invoice", { quotation: quote.number });
    assert.equal(draft.document.doc_type, "invoice");
    assert.equal(draft.document.total, quote.total);
    assert.deepEqual(draft.source_quotation, { id: quote.id, number: quote.number, status: "converted" });
    await rejects(docs("convert_to_invoice", { quotation: quote.number }), /already converted/);
    await rejects(docs("issue_document", { document: draft.document.id }), /When is payment due/);
    await docs("update_draft", { document: draft.document.id, set: { due_date: "2099-01-31" } });
    const issued = await docs("issue_document", { document: draft.document.id });
    assert.equal(issued.document.number, `INV-${year}-0001`);
    assert.ok(issued.warnings.some((w) => w.check === "customer_has_tin"), "MyInvois TIN warning");
    invoice = issued.document;
  });

  await t.test("payments: partial then full; paid invoices cannot be voided", async () => {
    const part = await docs("record_payment", { amount: 10000, allocations: [{ invoice: invoice.number, amount: 10000 }], reference: "IBG123" });
    assert.equal(part.allocations[0].status, "partially_paid");
    await rejects(docs("record_payment", { amount: 99999, allocations: [{ invoice: invoice.number, amount: 99999 }] }), /only has/);
    const rest = Math.round((invoice.total - 10000) * 100) / 100;
    const full = await docs("record_payment", { amount: rest, allocations: [{ invoice: invoice.number, amount: rest }] });
    assert.equal(full.allocations[0].status, "paid");
    assert.equal(full.payment.number, `RCP-${year}-0002`);
    await rejects(docs("void_document", { document: invoice.number, reason: "test" }), /^(?!.*issue a credit note).*payments recorded.*cannot be voided/s);
    const cust = await clerk("get_customer", { ref: "C-0001" });
    assert.equal(cust.outstanding, 0);
  });

  await t.test("custom field can become a hard requirement for issuing", async () => {
    await dbm("define_custom_field", { entity: "document", key: "po_number", label: "Customer PO no.", type: "text", required_for: "invoice.issue" });
    const draft = await docs("create_draft", { doc_type: "invoice", customer: "C-0001", lines: [{ product: "PNL-550", quantity: 2 }], due_date: "2099-01-01" });
    assert.ok(draft.document.readiness.blockers.some((b) => b.field === "document.po_number"));
    await docs("update_draft", { document: draft.document.id, set: { custom: { po_number: "PO-1" } } });
    const issued = await docs("issue_document", { document: draft.document.id });
    assert.equal(issued.document.number, `INV-${year}-0002`);
  });

  await t.test("archiving is soft and guarded", async () => {
    await rejects(clerk("archive_record", { entity: "customer", id: acme.id }), /open documents/);
    const p = (await clerk("find_catalog", { query: "inverter" })).products[0];
    await clerk("archive_record", { entity: "product", id: p.id, reason: "discontinued" });
    assert.equal((await clerk("find_catalog", { query: "inverter" })).products.length, 0);
    const still = await db.query("SELECT deleted_at FROM di.product WHERE id = $1", [p.id]);
    assert.ok(still.rows[0].deleted_at, "row still exists, only flagged");
    await dbm("restore_record", { entity: "product", id: p.id });
    assert.equal((await clerk("find_catalog", { query: "inverter" })).products.length, 1);
  });

  await t.test("templates: versioned, validated, escaped", async () => {
    await rejects(tpl("save_template", { doc_type: "invoice", name: "Bad", html: "{{#each lines}}oops" }), /Unclosed/);
    const saved = await tpl("save_template", { doc_type: "invoice", name: "Minimal", html: "<h1>{{doc.number}}</h1>{{#each lines}}<p>{{description}}</p>{{/each}}{{doc.bogus}}" });
    assert.equal(saved.template.version, 1);
    assert.deepEqual(saved.unknown_fields, ["doc.bogus"]);
    const again = await tpl("save_template", { doc_type: "invoice", name: "Minimal", html: "<h1>{{doc.number}}</h1>" });
    assert.equal(again.template.version, 2);
    const preview = await tpl("preview_template", { id: again.template.id });
    assert.match(preview.pdf.link, /preview/);
    assert.equal(new URL(preview.pdf.url, "https://test.local").searchParams.get("agent"), "di-templates");
    assert.equal(renderTemplate("{{x}}", { x: "<script>" }), "&lt;script&gt;");
    assert.equal(checkTemplate("{{#if a}}x{{else}}y{{/if}}").ok, true);
    // the invoice issued earlier keeps its original template
    const inv = await docs("get_document", { ref: invoice.number });
    assert.equal(inv.document.template.name, "Standard invoice");
  });

  await t.test("every change is in the audit log with the acting agent", async () => {
    const log = await dbm("read_audit_log", { entity: "customer", entity_id: acme.id, limit: 50 });
    assert.ok(log.entries.some((e) => e.action === "insert" && e.agent === "di-records"));
    assert.ok(log.entries.some((e) => e.changed?.website));
    await rejects(
      withContext(db, { tenantId: tenantA }, (tx) => tx.query("UPDATE di.audit_log SET actor = 'me'")),
      /permission denied/,
    );
  });
});
