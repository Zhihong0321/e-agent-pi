import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCalendarSources, validateCalendarRange, validateCalendarOptions, readCalendar } from "./calendar.mjs";

test("validates bounded ranges and IANA timezones", () => {
  assert.deepEqual(validateCalendarRange({ from: "2026-10-01", to: "2026-10-31", timezone: "Asia/Kuala_Lumpur" }), {
    from: "2026-10-01", to: "2026-10-31", timezone: "Asia/Kuala_Lumpur",
  });
  assert.throws(() => validateCalendarRange({ from: "2026-10-31", to: "2026-10-01" }), /from must not be after/);
  assert.throws(() => validateCalendarRange({ from: "2026-01-01", to: "2027-02-01" }), /cannot exceed/);
  assert.throws(() => validateCalendarRange({ from: "2026-10-01", to: "2026-10-02", timezone: "Not/AZone" }), /valid IANA/);
});

test("only selected source tables are scanned and invalid scopes cannot reach the DB", async () => {
  const queries = [];
  const tx = { query: async (sql) => { queries.push(sql); return { rows: [] }; } };
  const out = await readCalendar(tx, { from: "2026-10-01", to: "2026-10-31", sources: ["procurement"] });
  assert.equal(queries.length, 3);
  assert.ok(queries.some((q) => q.includes("FROM di.supplier_document")));
  assert.ok(queries.some((q) => q.includes("FROM di.purchase_order")));
  assert.ok(!queries.some((q) => /FROM di\.(document |payment |form_version )/.test(q)));
  assert.deepEqual(out.sources, ["procurement"]);
  assert.equal(out.include_demo, false);
  assert.ok(!Number.isNaN(Date.parse(out.refreshedAt)));
  const before = queries.length;
  await assert.rejects(readCalendar(tx, { from: "2026-10-01", to: "2026-10-31", sources: ["users"] }), /sources/);
  assert.equal(queries.length, before);
  assert.throws(() => validateCalendarOptions({ include_demo: "false" }), /boolean/);
});

test("procurement reminders follow status transitions, disputes and original overdue dates", () => {
  const base = { range: { from: "2026-10-01", to: "2026-10-31" }, timezone: "Asia/Kuala_Lumpur", sources: ["procurement"] };
  const quote = { id: "q", number: "SQ-1", doc_type: "quotation", status: "received", valid_until: "2026-10-09" };
  const invoice = { id: "i", number: "SI-1", doc_type: "invoice", status: "unpaid", due_date: "2026-09-20", total: 100 };
  const po = { id: "p", number: "PO-1", status: "partially_received", expected_date: "2026-09-30" };
  const run = (changes = {}) => normalizeCalendarSources({ ...base, supplierDocuments: [quote, invoice], purchaseOrders: [po], ...changes });
  const events = run();
  assert.equal(events.length, 3);
  assert.equal(events.find((e) => e.source.field === "due_date").detail.sourceDate, "2026-09-20");
  assert.equal(events.find((e) => e.kind === "delivery_due").status, "late");
  assert.deepEqual(run().map((e) => e.id), events.map((e) => e.id));
  assert.equal(run({ supplierDocuments: [{ ...quote, status: "converted" }, { ...invoice, status: "paid" }], purchaseOrders: [{ ...po, status: "received" }] }).length, 0);
  const [disputed] = run({ supplierDocuments: [{ ...invoice, status: "disputed" }], purchaseOrders: [] });
  assert.equal(disputed.status, "disputed");
  assert.equal(disputed.needsReview, true);
  assert.match(disputed.warnings[0], /resolve/);
});

test("demo records are opt-in and filtering applies to every source group", () => {
  const input = { range: { from: "2026-10-01", to: "2026-10-31" }, timezone: "Asia/Kuala_Lumpur",
    supplierDocuments: [{ id: "demo-q", number: "SQ-D", doc_type: "quotation", status: "accepted", valid_until: "2026-10-04", note: "DEMO ONLY" }],
    purchaseOrders: [{ id: "demo-po", number: "PO-D", status: "issued", expected_date: "2026-10-05", demo: true }],
    payments: [{ id: "demo-pay", received_on: "2026-10-06", custom: { demo: true } }],
    forms: [{ id: "demo-form", closes_at: "2026-10-07", demo: true }],
    documents: [{ id: "demo-sale", doc_type: "quotation", status: "issued", valid_until: "2026-10-08", custom: { demo: "true" } }],
  };
  assert.equal(normalizeCalendarSources(input).length, 0);
  assert.equal(normalizeCalendarSources({ ...input, include_demo: true }).length, 5);
  assert.equal(normalizeCalendarSources({ ...input, include_demo: true, sources: ["sales"] }).length, 1);
});

test("normalizes quote expiry, unpaid invoice due dates, receipts, and custom reminders", () => {
  const range = { from: "2026-10-01", to: "2026-10-31" };
  const events = normalizeCalendarSources({
    range,
    timezone: "Asia/Kuala_Lumpur",
    documents: [
      { id: "q1", doc_type: "quotation", number: "Q-1", status: "issued", valid_until: "2026-10-04", customer_name: "Acme", total: "100" },
      { id: "i1", doc_type: "invoice", number: "I-1", status: "issued", due_date: "2026-10-10", total: "100", amount_paid: "25", customer_name: "Acme" },
      { id: "paid", doc_type: "invoice", number: "I-2", status: "paid", due_date: "2026-10-10", total: "100", amount_paid: "100", customer_name: "Acme" },
    ],
    payments: [{ id: "p1", number: "R-1", received_on: "2026-10-12", amount: "25", method: "bank_transfer" }],
    customFieldDefs: [{ entity: "document", key: "renewal_date", label: "Renewal", type: "date" }],
  });
  assert.deepEqual(events.map((event) => event.kind), ["quotation_expiry", "payment_due", "payment_received"]);
  assert.equal(events[0].source.field, "valid_until");
  assert.equal(events[1].detail.balance, 75);
  assert.equal(events[2].source.table, "di.payment");
});

test("deduplicates deterministic source identities and flags overdue items", () => {
  const range = { from: "2026-10-10", to: "2026-10-31" };
  const [event] = normalizeCalendarSources({
    range,
    timezone: "Asia/Kuala_Lumpur",
    documents: [{ id: "i1", doc_type: "invoice", number: "I-1", status: "partially_paid", due_date: "2026-10-01", total: 10, amount_paid: 1 }],
  });
  assert.equal(event.id, "payment-due:i1");
  assert.equal(event.status, "overdue");
  assert.equal(event.severity, "high");
  assert.equal(normalizeCalendarSources({ range, timezone: "Asia/Kuala_Lumpur", documents: [{ id: "i1", doc_type: "invoice", number: "I-1", status: "partially_paid", due_date: "2026-10-01", total: 10, amount_paid: 1 }, { id: "i1", doc_type: "invoice", number: "I-1", status: "partially_paid", due_date: "2026-10-01", total: 10, amount_paid: 1 }] }).length, 1);
});
