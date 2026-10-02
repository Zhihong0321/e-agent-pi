import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter, withContext } from "./db.mjs";
import { seedTenant } from "./seed.mjs";
import { saveSupplier, recordSupplierDocument, createPoDraft, issuePo, receiveGoods, setInvoiceStatus } from "./procurement.mjs";
import { readCalendar } from "./calendar.mjs";

test("real schema, tenant isolation and procurement lifecycle refresh", async () => {
  const pg = new PGlite();
  const db = pgliteAdapter(pg);
  try {
    await migrate(db);
    const tenants = [];
    for (const name of ["Calendar A", "Calendar B"]) {
      const id = (await db.query("INSERT INTO di.tenant (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
      tenants.push(id); await seedTenant(db, id);
    }
    const who = { id: "calendar-admin", username: "calendar-admin", role: "admin" };
    const run = (id, fn, asRole = true) => withContext(db, { tenantId: id, actor: who.username, agent: "di-calendar", asRole }, fn);
    const now = new Date("2026-10-02T04:00:00Z");
    const lines = [{ description: "Calendar test goods", quantity: 1, unit_price: 100, tax_rate: 8 }];
    const made = [];
    for (const tenant of tenants) {
      made.push(await run(tenant, async (tx) => {
        const supplier = (await saveSupplier(tx, { name: "Calendar supplier" }, { who })).supplier;
        const quote = (await recordSupplierDocument(tx, { supplier: supplier.code, doc_type: "quotation", supplier_ref: "CAL-Q", doc_date: "2026-10-02", valid_until: "2026-10-09", lines }, { who, now })).document;
        const draft = (await createPoDraft(tx, { supplier: supplier.code, lines, expected_date: "2026-10-06" }, { who, now })).po;
        const po = (await issuePo(tx, { po: draft.number }, { who, now })).po;
        const invoice = (await recordSupplierDocument(tx, { supplier: supplier.code, doc_type: "invoice", supplier_ref: "CAL-I", doc_date: "2026-10-02", due_date: "2026-10-13", po: po.number, lines }, { who, now })).document;
        return { supplier, quote, po, invoice };
      }));
    }
    const args = { from: "2026-10-01", to: "2026-10-31", sources: ["procurement"] };
    const first = await run(tenants[0], (tx) => readCalendar(tx, args), true);
    const allSources = await run(tenants[0], (tx) => readCalendar(tx, { ...args, sources: undefined }), true);
    assert.equal(allSources.events.length, 3, "all default source queries work against the migrated schema");
    assert.equal(first.events.length, 3);
    const ids = new Set(first.events.map((e) => e.source.recordId));
    assert.ok(ids.has(made[0].quote.id));
    assert.ok(ids.has(made[0].po.id));
    assert.ok(ids.has(made[0].invoice.id));
    assert.ok(!ids.has(made[1].invoice.id), "RLS must isolate the other company");
    await run(tenants[0], async (tx) => {
      await receiveGoods(tx, { po: made[0].po.number, receive_all: true }, { who, now });
      await setInvoiceStatus(tx, { invoice: made[0].invoice.number, status: "paid", reference: "TEST" }, { who, now });
    });
    const completed = await run(tenants[0], (tx) => readCalendar(tx, args), true);
    assert.equal(completed.events.length, 1, "only the unconverted open quotation remains");
    await run(tenants[0], (tx) => tx.query("UPDATE di.supplier SET custom = '{\"demo\":true}'::jsonb WHERE id=$1", [made[0].supplier.id]));
    assert.equal((await run(tenants[0], (tx) => readCalendar(tx, args), true)).events.length, 0);
    assert.equal((await run(tenants[0], (tx) => readCalendar(tx, { ...args, include_demo: true }), true)).events.length, 1);
  } finally { await pg.close(); }
});
