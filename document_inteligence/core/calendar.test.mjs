import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCalendarSources, validateCalendarRange } from "./calendar.mjs";

test("validates bounded ranges and IANA timezones", () => {
  assert.deepEqual(validateCalendarRange({ from: "2026-10-01", to: "2026-10-31", timezone: "Asia/Kuala_Lumpur" }), {
    from: "2026-10-01", to: "2026-10-31", timezone: "Asia/Kuala_Lumpur",
  });
  assert.throws(() => validateCalendarRange({ from: "2026-10-31", to: "2026-10-01" }), /from must not be after/);
  assert.throws(() => validateCalendarRange({ from: "2026-01-01", to: "2027-02-01" }), /cannot exceed/);
  assert.throws(() => validateCalendarRange({ from: "2026-10-01", to: "2026-10-02", timezone: "Not/AZone" }), /valid IANA/);
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
