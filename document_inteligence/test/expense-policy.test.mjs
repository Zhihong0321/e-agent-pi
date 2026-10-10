// Tenant policy for expense claims: extra categories, extra fields, attachment kinds and rules held as
// data. The worked example is the mileage rule ("a Google Maps route screenshot and the distance").
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter, withContext } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { runTool, describeError } from "../core/actions.mjs";
import { defineCustomField, removeCustomField, setWorkflowRules } from "../core/admin.mjs";
import { evaluate, validateRules } from "../core/workflows.mjs";
import { claimsToCsv } from "../core/expense-report.mjs";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a30000000049454e44ae426082", "hex");
const USERS = {
  "tok-admin": { id: "u-admin", username: "admin", display_name: "Admin", role: "admin", email: null },
  "tok-aisyah": { id: "u-aisyah", username: "aisyah", display_name: "Aisyah Rahman", role: "user", email: "aisyah@acme.test" },
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

const NEEDS_DISTANCE = { id: "mileage-distance", when: { category: ["mileage"] }, check: "custom_field", arg: "expense_claim.distance_km", severity: "block", message: "Mileage claims need the distance driven in km (custom.distance_km)." };
const NEEDS_MAP = { id: "mileage-map", when: { category: ["mileage"] }, check: "attachment_kind", arg: "route_map", severity: "block", message: "Mileage claims need the Google Maps route screenshot (receipt_kinds: route_map)." };
const CAP_WARN = { id: "mileage-cap", when: { category: ["mileage"] }, check: "amount_at_most", arg: 300, severity: "warn", message: "Mileage over 300 needs a reviewer's eye." };

async function setup() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const mk = async (name) => (await db.query("INSERT INTO di.tenant (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
  const tenantA = await mk("A");
  const tenantB = await mk("B");
  await seedTenant(db, tenantA);
  await seedTenant(db, tenantB);
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-pol-"));
  const clock = { now: new Date("2026-10-02T04:00:00Z") };
  const deps = (tenantId) => ({
    db, tenantId: () => tenantId,
    workspace: (agent) => path.join(dir, agent),
    now: () => clock.now,
    resolveIdentity: async (code) => USERS[code] ?? null,
  });
  let counter = 0;
  const inbox = async (name, salt = `n${counter++}`) => {
    const rel = `_inbox/1759${String(++counter).padStart(9, "0")}-0-${name}`;
    await mkdir(path.join(dir, "di-expenses", "_inbox"), { recursive: true });
    await writeFile(path.join(dir, "di-expenses", rel), Buffer.concat([PNG, Buffer.from(salt)]));
    return rel;
  };
  const as = (who, tenantId = tenantA) => (tool, args = {}) =>
    runTool(deps(tenantId), { agent: "di-expenses", tool, args: { identity: `tok-${who}`, ...args } });
  const admin = (tenantId, fn) => withContext(db, { tenantId, actor: "admin" }, fn);
  return { db, tenantA, tenantB, as, inbox, admin };
}

const claim = (over = {}) => ({ expense_date: "2026-10-01", merchant: "Grab", category: "transport", amount: 45.5, ...over });

// ------------------------------------------------------------------ the rule vocabulary (pure)

test("claim rules are validated against the claim vocabulary", () => {
  assert.ok(validateRules([NEEDS_DISTANCE, NEEDS_MAP, CAP_WARN], "expense_claim"));
  assert.throws(() => validateRules([{ check: "has_lines", severity: "block", message: "x" }], "expense_claim"), /does not apply to expense claims/);
  assert.throws(() => validateRules([NEEDS_MAP], "quotation"), /only applies to expense claims/);
  assert.throws(() => validateRules([{ ...NEEDS_DISTANCE, arg: "customer.distance_km" }], "expense_claim"), /expense_claim\.<field key>/);
  assert.throws(() => validateRules([{ ...NEEDS_MAP, arg: "Route Map" }], "expense_claim"), /lowercase kind/);
  assert.throws(() => validateRules([{ ...CAP_WARN, arg: 0 }], "expense_claim"), /above zero/);
  assert.throws(() => validateRules([{ ...NEEDS_MAP, when: { merchant: ["x"] } }], "expense_claim"), /when must be/);
  assert.throws(() => validateRules([{ ...NEEDS_MAP, when: { category: [] } }], "expense_claim"), /when must be/);
  assert.throws(() => validateRules([{ ...NEEDS_MAP, id: "Bad Id" }], "expense_claim"), /rule id/);
  assert.throws(() => validateRules([NEEDS_MAP, NEEDS_MAP], "expense_claim"), /duplicate rule id/);
  assert.throws(() => validateRules([{ ...NEEDS_MAP, message: "x".repeat(201) }], "expense_claim"), /too long/);
  assert.throws(() => validateRules([{ ...NEEDS_MAP, when: { category: ["mileage"] } }], "invoice"), /only applies to expense claims/);
});

test("rules only apply to the categories they name", () => {
  const rules = [NEEDS_DISTANCE, NEEDS_MAP];
  const mileage = evaluate(rules, { claim: { category: "mileage", amount: 50, custom: {} }, receipts: [{ kind: "receipt" }] });
  assert.equal(mileage.ready, false);
  assert.deepEqual(mileage.blockers.map((b) => b.id), ["mileage-distance", "mileage-map"]);
  const meals = evaluate(rules, { claim: { category: "meals", amount: 50, custom: {} }, receipts: [] });
  assert.equal(meals.ready, true);
  const ok = evaluate(rules, { claim: { category: "mileage", amount: 50, custom: { distance_km: 12.4 } }, receipts: [{ kind: "route_map" }] });
  assert.equal(ok.ready, true);
  assert.equal(evaluate([CAP_WARN], { claim: { category: "mileage", amount: 301, custom: {} }, receipts: [] }).warnings.length, 1);
});

// ------------------------------------------------------------------ the mileage scenario on a real engine

test("mileage policy: fields, categories, attachment kinds and rules held as data", async (t) => {
  const { db, tenantA, tenantB, as, inbox, admin } = await setup();
  const clerk = as("aisyah");
  const boss = as("admin");
  let legacy;

  await t.test("before any policy: 11 categories, no requirements", async () => {
    const out = await boss("get_expense_settings");
    assert.equal(out.categories.length, 11);
    assert.deepEqual(out.policy, { requirements: [], fields: [], attachment_kinds: ["receipt"] });
    legacy = (await clerk("file_claim", claim({ receipts: [await inbox("taxi.png")] }))).claim.number;
  });

  await t.test("an admin installs the policy (data only, no migration)", async () => {
    await admin(tenantA, async (tx) => {
      await defineCustomField(tx, { entity: "expense_claim", key: "distance_km", label: "Distance (km)", type: "number", help: "Total km from Google Maps" });
      await setWorkflowRules(tx, { doc_type: "expense_claim", transition: "file", rules: [NEEDS_DISTANCE, NEEDS_MAP, CAP_WARN] });
      await tx.query("UPDATE di.expense_setting SET custom = $1", [JSON.stringify({ categories: [{ key: "mileage", label: "Mileage (km driven)" }] })]);
    });
    const out = await boss("get_expense_settings");
    assert.equal(out.categories.length, 12);
    assert.equal(out.categories.at(-1).key, "mileage");
    assert.deepEqual(out.policy.attachment_kinds, ["receipt", "route_map"]);
    assert.equal(out.policy.fields[0].key, "distance_km");
    assert.equal(out.policy.requirements.length, 3);
    assert.deepEqual(out.policy.requirements[0].applies_to, ["mileage"]);
    assert.match(out.policy.requirements[1].needs, /route_map/);
  });

  await t.test("a mileage claim is refused without the distance, then without the screenshot", async () => {
    const map = await inbox("route.png", "route-1");
    await rejects(clerk("file_claim", claim({ category: "mileage", merchant: "KL to Penang", amount: 120, receipts: [map], receipt_kinds: ["route_map"] })), /distance driven in km/);
    await rejects(clerk("file_claim", claim({ category: "mileage", merchant: "KL to Penang", amount: 120, custom: { distance_km: 350.2 }, receipts: [await inbox("toll.png")] })), /Google Maps route screenshot/);
  });

  await t.test("with the distance and the route screenshot it is filed, and both are kept", async () => {
    const out = await clerk("file_claim", claim({
      category: "mileage", merchant: "KL to Penang", amount: 120, custom: { distance_km: "350.2" },
      receipts: [await inbox("route.png", "route-1")], receipt_kinds: ["route_map"],
    }));
    assert.equal(out.claim.category, "mileage");
    assert.deepEqual(out.claim.custom, { distance_km: 350.2 }, "the value is stored as a number");
    assert.deepEqual(out.claim.receipts.map((r) => r.kind), ["route_map"]);
    assert.equal(out.warnings.length, 0);
    const read = await clerk("get_claim", { claim: out.claim.number });
    assert.deepEqual(read.claim.policy_issues, []);
    assert.equal(read.claim.receipts[0].kind, "route_map", "the kind survives a read");
  });

  await t.test("the same screenshot on another claim is not a duplicate receipt", async () => {
    const out = await clerk("file_claim", claim({
      category: "mileage", merchant: "KL to Penang", expense_date: "2026-09-30", amount: 120, custom: { distance_km: 350.2 },
      receipts: [await inbox("route.png", "route-1")], receipt_kinds: ["route_map"],
    }));
    assert.equal(out.warnings.length, 0, "a reused supporting file raises no duplicate warning");
    // Real receipts are still protected: the same receipt file can't back two claims.
    await clerk("file_claim", claim({ merchant: "Petrol", amount: 80, receipts: [await inbox("petrol.png", "petrol-1")] }));
    await rejects(
      clerk("file_claim", claim({ merchant: "Petrol again", amount: 81, receipts: [await inbox("petrol.png", "petrol-1")] })),
      /Possible duplicate: This receipt file is already attached/,
    );
  });

  await t.test("a warn rule files the claim and tells the clerk why", async () => {
    const out = await clerk("file_claim", claim({
      category: "mileage", merchant: "KL to Johor", expense_date: "2026-09-29", amount: 410, custom: { distance_km: 700 },
      receipts: [await inbox("route.png", "route-2")], receipt_kinds: ["route_map"],
    }));
    assert.deepEqual(out.warnings, [CAP_WARN.message]);
  });

  await t.test("other categories are untouched, and bad input is named precisely", async () => {
    assert.ok((await clerk("file_claim", claim({ merchant: "Lunch", category: "meals", amount: 18, receipts: [await inbox("lunch.png")] }))).claim.number);
    await rejects(clerk("file_claim", claim({ category: "mileage", custom: { colour: "red", distance_km: 3 }, receipts: [await inbox("r.png")], receipt_kinds: ["route_map"] })), /Unknown custom field expense_claim\.colour/);
    await rejects(clerk("file_claim", claim({ receipts: [await inbox("s.png")], receipt_kinds: ["selfie"] })), /Attachment kind "selfie" is not one this company uses/);
    await rejects(clerk("file_claim", claim({ receipts: [await inbox("t.png")], receipt_kinds: ["receipt", "route_map"] })), /more entries than there are attachments/);
    await rejects(clerk("file_claim", claim({ custom: { distance_km: "far" }, receipts: [await inbox("u.png")] })), /must be a number/);
  });

  await t.test("a claim filed before a rule is flagged when read, and must comply when edited", async () => {
    await admin(tenantA, (tx) => setWorkflowRules(tx, {
      doc_type: "expense_claim", transition: "file",
      rules: [NEEDS_DISTANCE, NEEDS_MAP, CAP_WARN, { id: "taxi-proof", when: { category: ["transport"] }, check: "attachment_kind", arg: "route_map", severity: "block", message: "Taxi claims need the route screenshot." }],
    }));
    const read = await clerk("get_claim", { claim: legacy });
    assert.deepEqual(read.claim.policy_issues, ["Taxi claims need the route screenshot."]);
    await rejects(clerk("update_claim", { claim: legacy, description: "airport run" }), /Taxi claims need the route screenshot/);
    const fixed = await clerk("update_claim", { claim: legacy, description: "airport run", add_receipts: [await inbox("taxi-route.png")], add_receipt_kinds: ["route_map"] });
    assert.deepEqual(fixed.claim.receipts.map((r) => r.kind).sort(), ["receipt", "route_map"]);
    assert.deepEqual((await clerk("get_claim", { claim: legacy })).claim.policy_issues, []);
  });

  await t.test("update_claim sets and merges custom values, keeping the ones it does not mention", async () => {
    const filed = await clerk("file_claim", claim({
      category: "mileage", merchant: "KL to Ipoh", expense_date: "2026-09-28", amount: 90, custom: { distance_km: 200 },
      receipts: [await inbox("route.png", "route-3")], receipt_kinds: ["route_map"],
    }));
    const fixed = await clerk("update_claim", { claim: filed.claim.number, custom: { distance_km: 205.5 } });
    assert.deepEqual(fixed.claim.custom, { distance_km: 205.5 });
    assert.ok(fixed.changed.includes("custom"));
    await rejects(clerk("update_claim", { claim: filed.claim.number, custom: { distance_km: null } }), /distance driven in km/);
  });

  await t.test("a tenant category can be filtered on, and keeps working after it is removed while claims use it", async () => {
    assert.equal((await boss("list_claims", { category: "mileage", month: "all" })).claims.length >= 3, true);
    await admin(tenantA, (tx) => tx.query("UPDATE di.expense_setting SET custom = '{}'"));
    assert.equal((await boss("get_expense_settings")).categories.length, 11);
    assert.ok((await boss("list_claims", { category: "mileage", month: "all" })).claims.length >= 3, "existing claims keep their category");
    await rejects(clerk("file_claim", claim({ category: "mileage", custom: { distance_km: 3 }, receipts: [await inbox("v.png")], receipt_kinds: ["route_map"] })), /category must be one of/);
    await rejects(boss("list_claims", { category: "yacht" }), /category must be one of/);
  });

  await t.test("removing a field is a soft delete: values stay and come back when it is defined again", async () => {
    await admin(tenantA, async (tx) => {
      assert.deepEqual(await removeCustomField(tx, { entity: "expense_claim", key: "distance_km" }), { entity: "expense_claim", key: "distance_km", removed: true });
      assert.equal((await removeCustomField(tx, { entity: "expense_claim", key: "distance_km" })).removed, false);
    });
    const kept = (await db.query("SELECT count(*)::int AS n FROM di.expense_claim WHERE custom ? 'distance_km'")).rows[0].n;
    assert.ok(kept >= 3, "claims keep the values they were filed with");
    assert.deepEqual((await boss("get_expense_settings")).policy.fields, []);
    await admin(tenantA, (tx) => defineCustomField(tx, { entity: "expense_claim", key: "distance_km", label: "Distance (km)", type: "number" }));
    assert.equal((await boss("get_expense_settings")).policy.fields[0].key, "distance_km");
  });

  await t.test("the system's own keys cannot be redefined, and document rules stay document-only", async () => {
    await admin(tenantA, async (tx) => {
      await assert.rejects(defineCustomField(tx, { entity: "expense_claim", key: "withdrawn_reason", label: "x", type: "text" }), /used by the system/);
      await assert.rejects(setWorkflowRules(tx, { doc_type: "quotation", transition: "issue", rules: [NEEDS_MAP] }), /only applies to expense claims/);
      await assert.rejects(setWorkflowRules(tx, { doc_type: "expense_claim", transition: "file", rules: [{ check: "has_lines", severity: "block", message: "x" }] }), /does not apply to expense claims/);
    });
  });

  await t.test("another company sees none of it", async () => {
    const other = await as("admin", tenantB)("get_expense_settings");
    assert.equal(other.categories.length, 11);
    assert.deepEqual(other.policy, { requirements: [], fields: [], attachment_kinds: ["receipt"] });
  });
});

// ------------------------------------------------------------------ reports and exports

test("the CSV carries custom values and attachment kinds only when there are any", () => {
  const base = {
    number: "EXP-2026-0001", claimant: { name: "Aisyah", email: "a@x.test" }, expense_date: "2026-10-01", submitted_at: "2026-10-02T04:00:00.000Z",
    merchant: "Route", category: "mileage", description: null, payment_method: null, currency: "MYR", amount: 120, tax_amount: null,
    status: "submitted", reviewed_by: null, review_note: null, submission: { period_key: "2026-10" }, receipts: [{ kind: "route_map" }], custom: { distance_km: 350.2 },
  };
  const header = claimsToCsv([base]).split("\r\n")[0];
  assert.match(header, /,distance_km,Attachment kinds$/);
  assert.match(claimsToCsv([base]).split("\r\n")[1], /,350\.2,route_map$/);
  const plain = claimsToCsv([{ ...base, custom: {}, receipts: [{ kind: "receipt" }] }]).split("\r\n")[0];
  assert.doesNotMatch(plain, /distance_km|Attachment kinds/);
});
