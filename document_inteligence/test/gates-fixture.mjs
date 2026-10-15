// Fixture for the logical-gate tests: one company on PGlite with the three people the discount
// cases need, a customer, and one product at a known catalogue price. Calls go through runTool
// exactly as an agent's tool call does, with the signed-in user passed as `who`.
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter } from "../core/db.mjs";
import { runTool } from "../core/actions.mjs";
import { createTestCompany, createTestUser } from "./company-fixture.mjs";

export async function gateDb() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  return db;
}

/** A company with owner (Superadmin), head (Department head, Sales), sales (category "Sales"), customer C-0001, product SOLAR-5KW at 1000. */
export async function gateCompany(db, name) {
  const tenantId = await createTestCompany(db, name);
  const slug = name.replace(/\W/g, "").toLowerCase();
  const owner = await createTestUser(db, tenantId, { id: `${slug}-owner`, username: `${slug}-owner`, access: "superadmin" });
  const head = await createTestUser(db, tenantId, { id: `${slug}-head`, username: `${slug}-head`, access: "department_head", department: "Sales" });
  await createTestUser(db, tenantId, { id: `${slug}-sales`, username: `${slug}-sales`, access: "user", department: "Sales" });
  const cat = (await db.query("INSERT INTO user_category (company_tenant_id, name, access) VALUES ($1, 'Sales', 'user') RETURNING id", [tenantId])).rows[0].id;
  await db.query("UPDATE users SET category_id = $1 WHERE id = $2", [cat, `${slug}-sales`]);
  const sales = (await db.query(`SELECT u.*, c.name AS category, c.access, c.limits FROM users u JOIN user_category c ON c.id = u.category_id WHERE u.id = $1`, [`${slug}-sales`])).rows[0];

  const as = (who) => (agent, tool, args) => runTool({ db, tenantId: () => tenantId, who }, { agent, tool, args });
  const byOwner = as(owner);
  await byOwner("di-db", "update_company_profile", { name, legal_name: `${name} Sdn Bhd`, address: { line1: "1 Jalan Test", postcode: "50000", city: "Kuala Lumpur" } });
  await byOwner("di-records", "save_customer", { name: "Bintang Hijau Sdn Bhd", billing_address: { line1: "2 Jalan Test", postcode: "50000", city: "Kuala Lumpur" } });
  await byOwner("di-records", "save_product", { sku: "SOLAR-5KW", name: "Solar Panel Set 5kW", unit: "set", unit_price: 1000, tax_code: "NT" });

  return { db, tenantId, owner, head, sales, as, byOwner, bySales: as(sales), byHead: as(head) };
}

/** A quotation for 1 x SOLAR-5KW (catalogue 1000) with `discount` off, optionally at an overridden unit price. */
export const quote = (discount, extra = {}) => ({
  doc_type: "quotation", customer: "C-0001", valid_until: "2099-12-31",
  lines: [{ product: "SOLAR-5KW", quantity: 1, discount_amount: discount, ...extra }],
});

/** Live documents of the company, read without RLS (the test's own view of the records). */
export async function liveDocuments(db, tenantId) {
  return (await db.query(`SELECT id, doc_type, status, number, discount_total::float AS discount_total, subtotal::float AS subtotal, created_by
    FROM di.document WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at`, [tenantId])).rows;
}
