import { tenantContext } from "../document_inteligence/host.mjs";
import { withContext } from "../document_inteligence/core/db.mjs";
import { getCompanyProfile, updateCompanyProfile } from "../document_inteligence/core/company.mjs";
import { listCompanyMembers, saveCompanyMember } from "../document_inteligence/core/members.mjs";
import { listPeople, managePeople } from "./users.mjs";
import { findCustomers, saveCustomer } from "../document_inteligence/core/records.mjs";
import { createDraft, getDocument, issueDocument, listDocuments } from "../document_inteligence/core/documents.mjs";
import { readCalendar, validateCalendarRange } from "../document_inteligence/core/calendar.mjs";

const profileKeys = new Set([
  "name", "legal_name", "reg_no", "country", "business_type", "business_activity",
  "website", "email", "phone", "address", "currency", "tax_status", "tin", "payment_terms_days",
]);

/** Runs `fn` as the signed-in user's company. */
function scope(tenantId, fn) {
  if (!tenantId) throw new Error("Company tenant is required");
  const ctx = tenantContext(tenantId);
  return withContext(ctx.db, { ...ctx, actor: "owner", agent: "demo-form" }, fn);
}

export async function demoCalendar(query = {}, tenantId) {
  const range = validateCalendarRange({ from: query.from, to: query.to, timezone: query.timezone });
  if (query.include_demo !== undefined && !["true", "false"].includes(query.include_demo)) throw new Error("include_demo must be true or false");
  return scope(tenantId, (tx) => readCalendar(tx, { ...range, sources: query.sources === undefined ? undefined : query.sources.split(","), include_demo: query.include_demo === "true" }));
}

export async function demoState(tenantId) {
  if (!tenantId) throw new Error("Company tenant is required");
  const people = await listPeople(tenantId);
  return scope(tenantId, async (tx) => {
    const [profile, customers, documents] = await Promise.all([
      getCompanyProfile(tx), findCustomers(tx, { limit: 50 }),
      listDocuments(tx, { doc_type: "invoice", limit: 100 }),
    ]);
    const invoices = await Promise.all(documents.documents.map(async (row) => {
      const { document } = await getDocument(tx, { ref: row.id });
      return document;
    }));
    return { profile, members: people.people, people: people.people, customers: customers.customers, invoices };
  });
}

export async function demoAction(body, actorUserId, tenantId) {
  const action = String(body?.action || "");
  if (action === "person") {
    if (!tenantId) throw new Error("Company tenant is required");
    const person = body.person || {};
    return managePeople(body.person_id ? "update_person" : "create_person", { ...person, ...(body.person_id ? { person_id: body.person_id } : {}) }, { tenantId, actorUserId });
  }
  return scope(tenantId, async (tx) => {
    switch (action) {
      case "profile": {
        const key = String(body.key || "");
        if (!profileKeys.has(key)) throw new Error("Unsupported company profile field");
        const value = body.value;
        if (typeof value !== "string" && !(key === "payment_terms_days" && Number.isInteger(value))) throw new Error("Invalid profile value");
        return updateCompanyProfile(tx, { expected_revision: body.revision, [key]: value });
      }
      case "member":
        return saveCompanyMember(tx, body.member || {});
      case "customer":
        return saveCustomer(tx, body.customer || {});
      case "invoice": {
        const invoice = body.invoice || {};
        const amount = Number(invoice.amount);
        if (!invoice.customer || !String(invoice.description || "").trim() || !Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(String(invoice.due || ""))) {
          throw new Error("Customer, description, positive amount and due date are required");
        }
        return createDraft(tx, { doc_type: "invoice", customer: String(invoice.customer), due_date: invoice.due,
          lines: [{ description: String(invoice.description).trim(), quantity: 1, unit_price: amount }] });
      }
      case "issue":
        if (typeof body.id !== "string") throw new Error("Invoice id is required");
        return issueDocument(tx, { document: body.id });
      default:
        throw new Error("Unknown demo action");
    }
  });
}
