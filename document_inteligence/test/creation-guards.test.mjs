// A5: creating the schema cannot lock the company out or run away. A rule names a field that exists, a
// field key is never a standard column, and a table carries at most 50 live fields.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { describeError, runTool } from "../core/actions.mjs";
import { MAX_FIELDS_PER_ENTITY, defineCustomField, removeCustomField, setWorkflowRules } from "../core/admin.mjs";
import { asTenant } from "./solar-fixture.mjs";

async function setup(name = "Guard Co") {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const tenant = (await db.query("INSERT INTO di.tenant (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
  await seedTenant(db, tenant);
  return { db, tenant, run: (fn) => asTenant(db, tenant, fn) };
}
const field = (over = {}) => ({ entity: "document", key: "po_number", label: "PO number", type: "text", help: "Customer's purchase order number", ...over });
/** The invoice rules as they are, plus the ones given. */
const invoiceRules = async (tx, ...extra) => [
  ...(await tx.query("SELECT rules FROM di.workflow_def WHERE doc_type = 'invoice' AND transition = 'issue' AND deleted_at IS NULL")).rows[0].rules,
  ...extra,
];
const needs = (arg, severity = "block") => ({ check: "custom_field", arg, severity, message: `Needs ${arg}` });

test("a rule that names a field which is not defined is refused: the self-lock", async () => {
  const { run } = await setup();
  await run(async (tx) => {
    await defineCustomField(tx, field());
    // The typo that used to block every invoice with a message nobody could satisfy.
    await assert.rejects(setWorkflowRules(tx, { doc_type: "invoice", rules: await invoiceRules(tx, needs("document.po_numbr")) }), /document\.po_numbr.*not defined \(defined on document: po_number\)/);
    const stored = (await tx.query("SELECT rules FROM di.workflow_def WHERE doc_type = 'invoice'")).rows[0].rules;
    assert.ok(!stored.some((r) => r.arg === "document.po_numbr"), "nothing was stored");
    // The right name goes through, and the rule is saved.
    await setWorkflowRules(tx, { doc_type: "invoice", rules: await invoiceRules(tx, needs("document.po_number")) });
    assert.ok((await tx.query("SELECT rules FROM di.workflow_def WHERE doc_type = 'invoice'")).rows[0].rules.some((r) => r.arg === "document.po_number"));
  });
});

test("a rule on a removed field is refused, and so is a rule on a table the document cannot read", async () => {
  const { run } = await setup();
  await run(async (tx) => {
    await defineCustomField(tx, field());
    await defineCustomField(tx, { entity: "product", key: "panel_watt", label: "Panel watt", type: "number", help: "Rated watt-peak of one panel" });
    await defineCustomField(tx, { entity: "customer", key: "segment", label: "Segment", type: "text", help: "Market segment of the customer" });
    await defineCustomField(tx, { entity: "contact", key: "channel", label: "Channel", type: "text", help: "How this person wants to be contacted" });
    // customer, contact and document fields can be read by a document rule; a product's cannot.
    await setWorkflowRules(tx, { doc_type: "quotation", rules: await invoiceRules(tx, needs("customer.segment", "warn"), needs("contact.channel", "warn")) });
    await assert.rejects(setWorkflowRules(tx, { doc_type: "invoice", rules: await invoiceRules(tx, needs("product.panel_watt")) }), /a rule on invoice can only read fields on document, customer, contact/);
    await removeCustomField(tx, { entity: "document", key: "po_number" });
    await assert.rejects(setWorkflowRules(tx, { doc_type: "invoice", rules: await invoiceRules(tx, needs("document.po_number")) }), /not defined/);
    await assert.rejects(setWorkflowRules(tx, { doc_type: "invoice", rules: await invoiceRules(tx, needs("po_number")) }), /can only read fields on/);
  });
});

test("expense claim rules read expense claim fields only", async () => {
  const { run } = await setup();
  await run(async (tx) => {
    await defineCustomField(tx, { entity: "expense_claim", key: "distance_km", label: "Distance (km)", type: "number", help: "Total km from Google Maps" });
    const claim = (arg) => ({ doc_type: "expense_claim", transition: "file", rules: [{ id: "km", check: "custom_field", arg, severity: "block", message: "Give the distance" }] });
    await setWorkflowRules(tx, claim("expense_claim.distance_km"));
    await assert.rejects(setWorkflowRules(tx, claim("expense_claim.distance_mi")), /expense_claim\.distance_mi.*not defined/);
  });
});

test("a field key may not be a standard column", async () => {
  const { run } = await setup();
  await run(async (tx) => {
    await assert.rejects(defineCustomField(tx, { entity: "customer", key: "email", label: "Email", type: "text", help: "Where we write to them" }), /customer\.email is already a standard column/);
    await assert.rejects(defineCustomField(tx, { entity: "document", key: "number", label: "Number", type: "text", help: "The document number" }), /already a standard column/);
  });
});

test("the 51st live field on a table is refused, the 50th is not, and a re-define at the cap still works", async () => {
  const { run } = await setup();
  await run(async (tx) => {
    const key = (n) => `field_${String(n).padStart(2, "0")}`;
    for (let n = 1; n <= MAX_FIELDS_PER_ENTITY; n++) {
      await defineCustomField(tx, { entity: "contact", key: key(n), label: `Field ${n}`, type: "text", help: `Value number ${n} of a contact` });
    }
    await assert.rejects(
      defineCustomField(tx, { entity: "contact", key: key(51), label: "Field 51", type: "text", help: "One field too many" }),
      /This company already has 50 fields on contact/,
    );
    // Another table has its own 50.
    await defineCustomField(tx, { entity: "customer", key: "segment", label: "Segment", type: "text", help: "Market segment of the customer" });
    // Changing one that exists is not a new field.
    await defineCustomField(tx, { entity: "contact", key: key(1), label: "Field one", type: "text", help: "Value number 1 of a contact" });
    // A removed field frees a place, and bringing it back takes the place again.
    await removeCustomField(tx, { entity: "contact", key: key(2) });
    await defineCustomField(tx, { entity: "contact", key: key(51), label: "Field 51", type: "text", help: "Takes the freed place" });
    await assert.rejects(defineCustomField(tx, { entity: "contact", key: key(2), label: "Field 2", type: "text", help: "Value number 2 of a contact" }), /already has 50 fields on contact/);
  });
});

test("a Forward Deploy Engineer changeset that adds a field and a rule on it still succeeds", async () => {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const tenant = (await db.query("INSERT INTO di.tenant (name) VALUES ('Fleet Co') RETURNING id")).rows[0].id;
  await seedTenant(db, tenant);
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-guard-"));
  const sop = { get: async () => null, save: async () => ({}), clear: async () => true };
  const deps = {
    db, tenantId: () => tenant, sop, workspace: (agent) => path.join(dir, agent), now: () => new Date("2026-10-02T04:00:00Z"),
    resolveIdentity: async () => ({ id: "u-admin", username: "admin", display_name: "Admin", access: "superadmin", email: null }),
  };
  const fde = (tool, args) => runTool(deps, { agent: "di-fde", tool, args: { identity: "tok-admin", ...args } });
  const changeset = (rule) => ({
    target_agent: "di-expenses",
    summary: "Mileage claims need the distance",
    categories: [{ key: "mileage", label: "Mileage (km driven)" }],
    custom_fields: [{ key: "distance_km", label: "Distance (km)", type: "number", help: "Total km from Google Maps" }],
    rules: [{ id: "mileage-distance", when: { category: ["mileage"] }, check: "custom_field", arg: rule, severity: "block", message: "Mileage claims need the distance driven in km." }],
    examples: [
      { claim: { category: "mileage", amount: 120, custom: { distance_km: 350 } }, expect: "ok" },
      { claim: { category: "mileage", amount: 120, custom: {} }, expect: "blocked" },
    ],
  });
  const preview = await fde("fde_apply", { changeset: changeset("expense_claim.distance_km") });
  assert.equal(preview.valid, true);
  await fde("fde_apply", { changeset: changeset("expense_claim.distance_km"), fingerprint: preview.fingerprint });
  const live = await asTenant(db, tenant, async (tx) => ({
    field: (await tx.query("SELECT key FROM di.field_def WHERE entity = 'expense_claim' AND deleted_at IS NULL")).rows.map((r) => r.key),
    rule: (await tx.query("SELECT rules FROM di.workflow_def WHERE doc_type = 'expense_claim' AND deleted_at IS NULL")).rows[0].rules.map((r) => r.arg),
  }));
  assert.deepEqual(live, { field: ["distance_km"], rule: ["expense_claim.distance_km"] });
  // A rule naming a field the same change does not add is still refused by the engineer's own cross-check.
  await assert.rejects(fde("fde_apply", { changeset: changeset("expense_claim.distance_mi") }), (e) => /distance_mi/.test(describeError(e)));
});
