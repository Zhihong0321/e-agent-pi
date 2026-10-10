// Per-company page layout (core/page-layout.mjs, sql/009_ui_config.sql): the default lives in code,
// a company stores only what it changed, and restoring the default removes that. Pure rules first,
// then the real database: two companies, admin-only writes, soft delete, history, stale edits.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { describeError } from "../core/actions.mjs";
import { migrate, pgliteAdapter, withContext } from "../core/db.mjs";
import { PAGES, loadLayout, resetLayout, resolveLayout, saveLayout, validateOverride } from "../core/page-layout.mjs";
import { seedTenant } from "../core/seed.mjs";
import { AGENTS, toolsFor } from "../core/tools.mjs";

const ADMIN = { id: "u-admin", username: "admin", role: "admin" };
const USER = { id: "u-aisyah", username: "aisyah", role: "user" };

const rejects = async (promise, pattern) => {
  try {
    await promise;
  } catch (error) {
    assert.match(describeError(error), pattern);
    return;
  }
  assert.fail(`expected rejection matching ${pattern}`);
};
const throwsMatch = (fn, pattern) => assert.throws(fn, (error) => pattern.test(describeError(error)));

const items = (layout, block) => layout.blocks[block].items;
const ids = (layout, block, { visibleOnly = false } = {}) => items(layout, block).filter((i) => !visibleOnly || i.visible).map((i) => i.id);
const find = (layout, block, id) => items(layout, block).find((i) => i.id === id);

// ------------------------------------------------------------------ the rules (pure)

test("with no override the page is exactly the default", () => {
  const layout = resolveLayout("expenses", undefined);
  assert.equal(layout.kicker.value, "EXPENSE CLAIMS");
  assert.deepEqual(ids(layout, "tiles"), ["claims", "claimed", "approved", "pending", "rejected"]);
  assert.deepEqual(ids(layout, "columns"), ["claim", "claimant", "date", "merchant", "category", "amount", "status"]);
  for (const block of Object.keys(layout.blocks)) {
    for (const item of items(layout, block)) {
      assert.equal(item.visible, true);
      assert.equal(item.label, item.default_label);
    }
  }
  assert.deepEqual(resolveLayout("expenses", {}), layout);
  assert.deepEqual(resolveLayout("expenses", null), layout);
});

test("hide, reorder and rename are applied; unknown ids and bad labels are ignored", () => {
  const layout = resolveLayout("expenses", {
    kicker: "CLAIMS",
    tiles: { order: ["pending", "ghost", "claims", "pending"], hidden: ["rejected", "ghost"] },
    columns: { hidden: ["category"], labels: { claimant: "Employee", date: "   ", merchant: "x".repeat(41), nope: "Nope" } },
  });
  assert.equal(layout.kicker.value, "CLAIMS");
  assert.deepEqual(ids(layout, "tiles"), ["pending", "claims", "claimed", "approved", "rejected"]);
  assert.deepEqual(ids(layout, "tiles", { visibleOnly: true }), ["pending", "claims", "claimed", "approved"]);
  assert.equal(find(layout, "columns", "category").visible, false);
  assert.equal(find(layout, "columns", "claimant").label, "Employee");
  assert.equal(find(layout, "columns", "claimant").default_label, "Claimant");
  assert.equal(find(layout, "columns", "date").label, "Date", "a blank label falls back to the default");
  assert.equal(find(layout, "columns", "merchant").label, "Merchant", "an over-long label falls back to the default");
});

test("locked items stay visible and pinned items stay first, whatever the stored choices say", () => {
  const layout = resolveLayout("expenses", {
    columns: { order: ["status", "amount", "claim", "date"], hidden: ["claim", "amount", "status", "date"] },
    form: { order: ["receipts", "claimant"], hidden: ["date", "tax_amount"] },
  });
  assert.equal(ids(layout, "columns")[0], "claim", "claim is pinned first");
  for (const id of ["claim", "amount", "status"]) assert.equal(find(layout, "columns", id).visible, true, `${id} is locked`);
  assert.equal(find(layout, "columns", "date").visible, false);
  assert.deepEqual(ids(layout, "form"), PAGES.expenses.blocks.form.items.map((i) => i.id), "the form keeps its order");
  assert.equal(find(layout, "form", "date").visible, true);
  assert.equal(find(layout, "form", "tax_amount").visible, false);
});

test("a status name is one setting: the chip and the badge read the same label", () => {
  const layout = resolveLayout("expenses", { chips: { labels: { submitted: "Awaiting" } } });
  assert.equal(find(layout, "chips", "submitted").label, "Awaiting");
});

test("a company that customized still gets what the default adds later", () => {
  const next = structuredClone(PAGES);
  next.expenses.rev = 2;
  next.expenses.blocks.columns.items.splice(3, 0, { id: "project", label: "Project" });
  next.expenses.blocks.tiles.items[0].label = "All claims";
  const override = { columns: { order: ["claim", "status", "amount", "category", "merchant", "date", "claimant"], hidden: ["date"], labels: { claimant: "Employee" } } };
  const layout = resolveLayout("expenses", override, next);
  assert.deepEqual(ids(layout, "columns"), ["claim", "status", "amount", "category", "merchant", "date", "claimant", "project"], "the new column follows their order");
  assert.equal(find(layout, "columns", "project").visible, true);
  assert.equal(find(layout, "columns", "date").visible, false, "their choices are kept");
  assert.equal(find(layout, "columns", "claimant").label, "Employee");
  assert.equal(find(layout, "tiles", "claims").label, "All claims", "an untouched label follows the new default");
  assert.equal(layout.default_rev, 2);
});

test("saved choices are checked, then stored in their smallest form", () => {
  assert.deepEqual(validateOverride("expenses", {}), {});
  assert.deepEqual(
    validateOverride("expenses", {
      kicker: "EXPENSE CLAIMS",
      tiles: { order: ["claims", "claimed", "approved", "pending", "rejected"], hidden: [], labels: { claims: "Claims" } },
      columns: { labels: {} },
    }),
    {},
    "choices equal to the default are not stored",
  );
  assert.deepEqual(
    validateOverride("expenses", {
      kicker: "  CLAIMS  ",
      tiles: { order: ["pending"], hidden: ["rejected", "claimed"], labels: { claims: " Total " } },
      chips: { labels: { approved: "Approved" } },
    }),
    {
      kicker: "CLAIMS",
      tiles: { order: ["pending", "claims", "claimed", "approved", "rejected"], hidden: ["claimed", "rejected"], labels: { claims: "Total" } },
    },
  );
});

test("a save the page could not draw is refused with a clear reason", () => {
  const bad = (input, pattern) => throwsMatch(() => validateOverride("expenses", input), pattern);
  bad("nope", /must be an object/);
  bad([], /must be an object/);
  bad({ colour: "red" }, /not a setting of this page/);
  bad({ tiles: "x" }, /tiles must be an object/);
  bad({ tiles: { sort: [] } }, /no setting "sort"/);
  bad({ columns: { hidden: ["ghost"] } }, /not on this page/);
  bad({ columns: { hidden: ["date", "date"] } }, /twice/);
  bad({ columns: { hidden: ["amount"] } }, /Amount cannot be hidden/);
  bad({ columns: { hidden: ["claim"] } }, /Claim cannot be hidden/);
  bad({ chips: { hidden: ["all"] } }, /All cannot be hidden/);
  bad({ form: { hidden: ["merchant"] } }, /Merchant cannot be hidden/);
  bad({ form: { order: ["description"] } }, /form cannot be reordered/);
  bad({ columns: { order: "date" } }, /must be a list/);
  bad({ columns: { labels: { date: "" } } }, /cannot be empty/);
  bad({ columns: { labels: { date: "x".repeat(41) } } }, /too long/);
  bad({ columns: { labels: { date: "a\nb" } } }, /control characters/);
  bad({ columns: { labels: { date: 5 } } }, /must be text/);
  bad({ columns: { labels: { ghost: "Ghost" } } }, /not on this page/);
  bad({ kicker: "" }, /cannot be empty/);
  bad({ kicker: "y".repeat(5000) }, /too large/);
  throwsMatch(() => validateOverride("invoices", {}), /cannot be customized/);
  // A renamed locked item is fine: only hiding it is not.
  assert.deepEqual(validateOverride("expenses", { columns: { labels: { amount: "Total" } } }), { columns: { labels: { amount: "Total" } } });
});

// ------------------------------------------------------------------ the database

async function setup() {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const mk = async (name) => (await db.query("INSERT INTO di.tenant (name) VALUES ($1) RETURNING id", [name])).rows[0].id;
  const tenantA = await mk("A");
  const tenantB = await mk("B");
  await seedTenant(db, tenantA);
  await seedTenant(db, tenantB);
  // Runs as di_app like the host does, so a missing grant or policy fails here.
  const as = (tenantId, actor = "admin") => (fn) => withContext(db, { tenantId, actor }, fn);
  return { db, tenantA, tenantB, as };
}

test("one company's choices never reach another, and restoring the default undoes them", async (t) => {
  const { db, tenantA, tenantB, as } = await setup();
  const a = as(tenantA);
  const b = as(tenantB);
  const choices = { kicker: "CLAIMS", columns: { hidden: ["category"], labels: { claimant: "Employee" } }, tiles: { hidden: ["rejected"] } };
  const defaults = resolveLayout("expenses", {});

  await t.test("a new company is on the default", async () => {
    const layout = await a((tx) => loadLayout(tx, "expenses"));
    assert.equal(layout.customized, false);
    assert.equal(layout.rev, 0);
    assert.equal(layout.override_invalid, false);
    assert.deepEqual({ ...layout, rev: 0, customized: false, override_invalid: false }, { ...defaults, rev: 0, customized: false, override_invalid: false });
  });

  await t.test("only an admin can save or restore", async () => {
    const user = as(tenantA, "aisyah");
    await rejects(user((tx) => saveLayout(tx, "expenses", choices, { who: USER, expected_rev: 0 })), /Only an admin/);
    await rejects(user((tx) => resetLayout(tx, "expenses", { who: USER })), /Only an admin/);
    await rejects(a((tx) => saveLayout(tx, "expenses", choices, { who: undefined, expected_rev: 0 })), /Sign-in required/);
    await rejects(a((tx) => saveLayout(tx, "expenses", choices, { who: { ...ADMIN, id: undefined }, expected_rev: 0 })), /Sign-in required/);
    assert.equal((await a((tx) => loadLayout(tx, "expenses"))).customized, false, "nothing was stored");
  });

  await t.test("the admin saves; the page changes; the other company is untouched", async () => {
    const saved = await a((tx) => saveLayout(tx, "expenses", choices, { who: ADMIN, expected_rev: 0 }));
    assert.equal(saved.restored, false);
    assert.equal(saved.layout.customized, true);
    assert.equal(saved.layout.rev, 1);
    assert.equal(saved.layout.kicker.value, "CLAIMS");
    assert.equal(find(saved.layout, "columns", "category").visible, false);
    assert.equal(find(saved.layout, "columns", "claimant").label, "Employee");
    assert.equal(find(saved.layout, "tiles", "rejected").visible, false);

    const other = await b((tx) => loadLayout(tx, "expenses"));
    assert.equal(other.customized, false);
    assert.equal(other.rev, 0);
    assert.equal(find(other, "columns", "category").visible, true);
    assert.equal(find(other, "columns", "claimant").label, "Claimant");
    assert.equal(other.kicker.value, "EXPENSE CLAIMS");

    const stored = (await db.query("SELECT tenant_id, config, rev FROM di.ui_config WHERE deleted_at IS NULL")).rows;
    assert.equal(stored.length, 1, "one row, only for the company that changed something");
    assert.equal(stored[0].tenant_id, tenantA);
    assert.deepEqual(stored[0].config, { kicker: "CLAIMS", columns: { hidden: ["category"], labels: { claimant: "Employee" } }, tiles: { hidden: ["rejected"] } }, "only the difference is stored");
  });

  await t.test("a company can't read or write the other's row", async () => {
    // Tenant B saving does not touch A's active row, and B's own save lands in B.
    const mine = await b((tx) => saveLayout(tx, "expenses", { columns: { hidden: ["merchant"] } }, { who: ADMIN, expected_rev: 0 }));
    assert.equal(mine.layout.rev, 1);
    assert.equal(find((await a((tx) => loadLayout(tx, "expenses"))), "columns", "merchant").visible, true);
    await b((tx) => resetLayout(tx, "expenses", { who: ADMIN }));
    assert.equal((await a((tx) => loadLayout(tx, "expenses"))).customized, true, "B restoring its default left A's choices alone");
  });

  await t.test("a stale editor is refused instead of overwriting", async () => {
    await rejects(a((tx) => saveLayout(tx, "expenses", { kicker: "OTHER" }, { who: ADMIN, expected_rev: 0 })), /Someone else changed this page/);
    await rejects(a((tx) => saveLayout(tx, "expenses", { kicker: "OTHER" }, { who: ADMIN })), /expected_rev is required/);
    const again = await a((tx) => saveLayout(tx, "expenses", { ...choices, kicker: "MY CLAIMS" }, { who: ADMIN, expected_rev: 1 }));
    assert.equal(again.layout.rev, 2);
    assert.equal(again.layout.kicker.value, "MY CLAIMS");
  });

  await t.test("restore default puts the page back, keeps the history, and works again after", async () => {
    const out = await a((tx) => resetLayout(tx, "expenses", { who: ADMIN }));
    assert.equal(out.reset, true);
    assert.equal(out.layout.customized, false);
    assert.equal(out.layout.rev, 0);
    assert.deepEqual({ ...out.layout, rev: 0 }, { ...defaults, rev: 0, customized: false, override_invalid: false });
    assert.equal((await a((tx) => resetLayout(tx, "expenses", { who: ADMIN }))).reset, false, "nothing left to restore");

    const history = (await db.query("SELECT deleted_at FROM di.ui_config WHERE tenant_id = $1", [tenantA])).rows;
    assert.equal(history.length, 1);
    assert.ok(history[0].deleted_at, "the old choices are soft-deleted, not gone");

    const next = await a((tx) => saveLayout(tx, "expenses", { tiles: { order: ["pending"] } }, { who: ADMIN, expected_rev: 0 }));
    assert.equal(next.layout.rev, 1, "a fresh row after a restore");
    assert.equal((await db.query("SELECT count(*)::int AS n FROM di.ui_config WHERE tenant_id = $1", [tenantA])).rows[0].n, 2);

    const actions = (await db.query("SELECT action FROM di.audit_log WHERE entity = 'ui_config' AND tenant_id = $1 ORDER BY id", [tenantA])).rows.map((r) => r.action);
    assert.ok(actions.includes("insert") && actions.includes("update") && actions.includes("soft_delete"), `audit trail: ${actions}`);
  });

  await t.test("saving choices equal to the default is a restore", async () => {
    const out = await a((tx) => saveLayout(tx, "expenses", { tiles: { order: ["claims", "claimed", "approved", "pending", "rejected"] }, kicker: "EXPENSE CLAIMS" }, { who: ADMIN, expected_rev: 1 }));
    assert.equal(out.restored, true);
    assert.equal(out.layout.customized, false);
    assert.equal(out.layout.rev, 0);
    await rejects(a((tx) => saveLayout(tx, "expenses", {}, { who: ADMIN, expected_rev: 1 })), /Someone else changed this page/);
    assert.equal((await a((tx) => saveLayout(tx, "expenses", {}, { who: ADMIN, expected_rev: 0 }))).restored, false, "already on the default: nothing to do");
  });

  await t.test("a refused save stores nothing", async () => {
    await rejects(a((tx) => saveLayout(tx, "expenses", { columns: { hidden: ["amount"] } }, { who: ADMIN, expected_rev: 0 })), /Amount cannot be hidden/);
    assert.equal((await a((tx) => loadLayout(tx, "expenses"))).customized, false);
    await rejects(a((tx) => loadLayout(tx, "invoices")), /cannot be customized/);
  });

  await t.test("the database itself refuses a hard delete and a second active row", async () => {
    await a((tx) => saveLayout(tx, "expenses", { kicker: "ONE" }, { who: ADMIN, expected_rev: 0 }));
    await rejects(db.query("DELETE FROM di.ui_config"), /Hard delete is disabled/);
    await rejects(db.query("INSERT INTO di.ui_config (tenant_id, page, config) VALUES ($1, 'expenses', '{}')", [tenantA]), /duplicate key|unique/i);
  });
});

test("a stored choice that no longer fits is flagged, never fatal", async () => {
  const { db, tenantA, as } = await setup();
  const a = as(tenantA);
  await a((tx) => saveLayout(tx, "expenses", { kicker: "CLAIMS" }, { who: ADMIN, expected_rev: 0 }));

  // Damaged beyond use: the page is simply the default, and the admin is told.
  await db.query("UPDATE di.ui_config SET config = '\"nope\"'::jsonb WHERE tenant_id = $1 AND deleted_at IS NULL", [tenantA]);
  const garbage = await a((tx) => loadLayout(tx, "expenses"));
  assert.equal(garbage.override_invalid, true);
  assert.deepEqual(items(garbage, "columns"), items(resolveLayout("expenses", {}), "columns"));
  assert.equal(garbage.kicker.value, "EXPENSE CLAIMS");

  // Partly stale (an item that became locked, an id that went away): what still fits is applied.
  await db.query(
    "UPDATE di.ui_config SET config = $1::jsonb WHERE tenant_id = $2 AND deleted_at IS NULL",
    [JSON.stringify({ kicker: "CLAIMS", columns: { hidden: ["amount", "category", "gone"] } }), tenantA],
  );
  const stale = await a((tx) => loadLayout(tx, "expenses"));
  assert.equal(stale.override_invalid, true);
  assert.equal(stale.kicker.value, "CLAIMS");
  assert.equal(find(stale, "columns", "amount").visible, true);
  assert.equal(find(stale, "columns", "category").visible, false);

  // The admin can fix it by saving over it, or by restoring the default.
  const fixed = await a((tx) => saveLayout(tx, "expenses", { kicker: "CLAIMS" }, { who: ADMIN, expected_rev: stale.rev }));
  assert.equal(fixed.layout.override_invalid, false);
  assert.equal(fixed.layout.customized, true);
});

test("the Expenses Clerk gets no layout tools: the page is for people, not the agent", () => {
  const names = toolsFor("di-expenses").map((tool) => tool.name ?? tool);
  assert.ok(Object.keys(AGENTS).includes("di-expenses"));
  assert.equal(names.some((name) => /layout|ui_config|customi[sz]e/i.test(String(name))), false, names.join(", "));
});
