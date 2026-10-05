// Forward Deploy Engineer: previews, applies, undoes and resets company rules held as data.
// Worked example: "mileage claims need a Google Maps route screenshot and the distance".
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgliteAdapter, withContext } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { runTool, describeError } from "../core/actions.mjs";
import { defineCustomField } from "../core/admin.mjs";
import { AGENTS, allowed, toolsFor } from "../core/tools.mjs";
import { extractBlock, mergeManagedBlock, normaliseChangeset } from "../core/fde.mjs";

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
const SOP = "## Mileage claims\nAsk for the Google Maps route screenshot, read the km from it, and send custom.distance_km with receipt_kinds [route_map].";

const mileage = (over = {}) => ({
  target_agent: "di-expenses",
  summary: "Mileage claims need a route screenshot and the distance",
  categories: [{ key: "mileage", label: "Mileage (km driven)" }],
  custom_fields: [{ key: "distance_km", label: "Distance (km)", type: "number", help: "Total km from Google Maps" }],
  rules: [NEEDS_DISTANCE, NEEDS_MAP],
  sop: { markdown: SOP },
  examples: [
    { claim: { category: "mileage", amount: 120, custom: { distance_km: 350 }, attachment_kinds: ["route_map"] }, expect: "ok" },
    { claim: { category: "mileage", amount: 120, custom: {}, attachment_kinds: ["receipt"] }, expect: "blocked" },
  ],
  ...over,
});

/** The Settings page's SOP table, as an in-memory store with the same three calls. */
function sopStore(seed = {}) {
  const rows = new Map(Object.entries(seed));
  return {
    rows,
    get: async (id) => (rows.has(id) ? { content: rows.get(id) } : null),
    save: async (id, content) => { rows.set(id, content); return { content }; },
    clear: async (id) => { rows.delete(id); return true; },
  };
}

async function setup(seed) {
  const db = pgliteAdapter(new PGlite());
  await migrate(db);
  const mk = async (name) => (await db.query("INSERT INTO di.tenant (name, is_default) VALUES ($1, $2) RETURNING id", [name, name === "A"])).rows[0].id;
  const tenantA = await mk("A");
  const tenantB = await mk("B");
  await seedTenant(db, tenantA);
  await seedTenant(db, tenantB);
  await db.query("INSERT INTO di.company_member (tenant_id, name, email, user_id, department) VALUES ($1, 'Aisyah Rahman', 'aisyah@acme.test', 'u-aisyah', 'Sales'), ($1, 'Daniel Lee', 'daniel@acme.test', NULL, 'Ops')", [tenantA]);
  const dir = await mkdtemp(path.join(os.tmpdir(), "di-fde-"));
  const sop = sopStore(seed);
  const deps = (tenantId) => ({
    db, tenantId: () => tenantId, sop,
    workspace: (agent) => path.join(dir, agent),
    now: () => new Date("2026-10-02T04:00:00Z"),
    resolveIdentity: async (code) => USERS[code] ?? null,
  });
  let counter = 0;
  const inbox = async (name, salt = `n${counter++}`) => {
    const rel = `_inbox/1759${String(++counter).padStart(9, "0")}-0-${name}`;
    await mkdir(path.join(dir, "di-expenses", "_inbox"), { recursive: true });
    await writeFile(path.join(dir, "di-expenses", rel), Buffer.concat([PNG, Buffer.from(salt)]));
    return rel;
  };
  const call = (agent, who, tenantId = tenantA) => (tool, args = {}) => runTool(deps(tenantId), { agent, tool, args: { identity: `tok-${who}`, ...args } });
  return { db, tenantA, tenantB, sop, inbox, fde: call("di-fde", "admin"), fdeAs: (who, tenantId) => call("di-fde", who, tenantId), clerk: call("di-expenses", "aisyah"), boss: call("di-expenses", "admin") };
}

/** Preview, then apply with the fingerprint, the way the agent does after the admin says yes. */
const deploy = async (fde, changeset) => {
  const preview = await fde("fde_apply", { changeset });
  assert.equal(preview.dry_run, true);
  return fde("fde_apply", { changeset, fingerprint: preview.fingerprint });
};

// ------------------------------------------------------------------ pure

test("the SOP block is replaced or removed without touching the text around it", () => {
  const human = "# Expenses SOP\nAlways greet the user.";
  const withBlock = mergeManagedBlock(human, "## Mileage\nAsk for the map.");
  assert.match(withBlock, /^# Expenses SOP\nAlways greet the user\.\n\n<!-- fde:start -->\n## Mileage/);
  assert.equal(extractBlock(withBlock), "## Mileage\nAsk for the map.");
  const replaced = mergeManagedBlock(withBlock, "## Mileage\nNew text.");
  assert.equal(replaced.match(/fde:start/g).length, 1);
  assert.equal(extractBlock(replaced), "## Mileage\nNew text.");
  assert.equal(mergeManagedBlock(replaced, null), `${human}\n`);
  assert.equal(mergeManagedBlock(mergeManagedBlock("", "x"), null), "", "an SOP that was only the block becomes empty");
  assert.equal(extractBlock(human), null);
});

test("a changeset is checked before anything is looked up", () => {
  const ok = normaliseChangeset(mileage());
  assert.equal(ok.rules.length, 2);
  assert.throws(() => normaliseChangeset({}), /target_agent/);
  assert.throws(() => normaliseChangeset({ target_agent: "di-expenses", summary: "x" }), /empty/);
  assert.throws(() => normaliseChangeset(mileage({ examples: [] })), /at least one claim that must be accepted/);
  assert.throws(() => normaliseChangeset(mileage({ categories: [{ key: "meals", label: "Meals" }] })), /built-in/);
  assert.throws(() => normaliseChangeset(mileage({ custom_fields: [{ key: "Bad Key", label: "x", type: "number" }] })), /snake_case/);
  assert.throws(() => normaliseChangeset(mileage({ custom_fields: [{ key: "colour", label: "x", type: "select" }] })), /needs options/);
  assert.throws(() => normaliseChangeset(mileage({ rules: [{ ...NEEDS_MAP, id: undefined }] })), /needs an id/);
  assert.throws(() => normaliseChangeset(mileage({ rules: [{ check: "has_lines", id: "x", severity: "block", message: "x" }] })), /does not apply to expense claims/);
  assert.throws(() => normaliseChangeset(mileage({ sop: { markdown: "x".repeat(1201) } })), /too long/);
  assert.throws(() => normaliseChangeset(mileage({ sop: { markdown: "a <!-- fde:end --> b" } })), /markers/);
  assert.throws(() => normaliseChangeset(mileage({ summary: "" })), /summary is required/);
});

// ------------------------------------------------------------------ the agent and who may use it

test("the FDE has only its own tools, and only an admin may use them", async () => {
  assert.ok(AGENTS["di-fde"]);
  assert.deepEqual(toolsFor("di-fde").map((t) => t.name).sort(), ["fde_apply", "fde_describe", "fde_revert"]);
  assert.equal(allowed("di-expenses", "fde_apply"), false, "the Expenses Clerk cannot change the rules it follows");
  assert.equal(allowed("di-fde", "file_claim"), false);
  const text = await readFile(new URL("../../agent/roles/di-fde.md", import.meta.url), "utf8");
  assert.ok(text.length <= 4000, `di-fde.md is ${text.length} chars; cap is 4000`);
  for (const tool of toolsFor("di-fde")) assert.ok(text.includes(`\`${tool.name}\``), `the role prompt never mentions ${tool.name}`);

  const { fdeAs } = await setup();
  await rejects(fdeAs("aisyah")("fde_describe"), /Only a Superadmin/);
  await rejects(fdeAs("aisyah")("fde_apply", { changeset: mileage() }), /Only a Superadmin/);
  await rejects(fdeAs("aisyah")("fde_revert", { scope: "all" }), /Only a Superadmin/);
  await rejects(runTool({ db: null, tenantId: () => "x" }, { agent: "di-fde", tool: "fde_describe", args: {} }), /Sign-in required/);
});

// ------------------------------------------------------------------ the full flow

test("preview, apply, enforce, undo, remove one item, reset to default", async (t) => {
  const human = "# Expenses SOP\nAlways greet the user.";
  const { db, tenantA, tenantB, sop, inbox, fde, fdeAs, clerk, boss } = await setup({ "di-expenses": human });
  const filed = {};

  await t.test("describe: the vocabulary, an empty company, and real names to check against", async () => {
    const out = await fde("fde_describe");
    assert.deepEqual(out.vocabulary.rule_checks.map((c) => c.check), ["custom_field", "attachment_kind", "amount_at_most"]);
    assert.equal(out.vocabulary.limits.sop_chars, 1200);
    assert.deepEqual(out.current.categories, []);
    assert.deepEqual(out.current.managed, { categories: [], fields: [], rules: [], reports: [], sop: false });
    assert.deepEqual(out.facts.departments.map((d) => [d.department, d.people]), [["Ops", 1], ["Sales", 1]]);
    filed.legacy = (await clerk("file_claim", { expense_date: "2026-10-01", merchant: "Grab", category: "transport", amount: 40, receipts: [await inbox("grab.png")] })).claim.number;
  });

  await t.test("a dry run writes nothing and says what would happen", async () => {
    const preview = await fde("fde_apply", { changeset: mileage() });
    assert.equal(preview.dry_run, true);
    assert.equal(preview.valid, true);
    assert.equal(preview.diff.length, 5);
    assert.match(preview.diff[0], /^\+ category mileage/);
    assert.ok(preview.diff.some((d) => /^\+ rule mileage-map \(block, mileage only\)/.test(d)));
    assert.deepEqual(preview.impact.examples.map((e) => [e.expect, e.got, e.pass]), [["ok", "ok", true], ["blocked", "blocked", true]]);
    assert.match(preview.impact.examples[1].because[0], /distance|route/i);
    assert.deepEqual(preview.impact.open_claims, { checked: 1, failing: 0, numbers: [] });
    assert.match(preview.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal((await boss("get_expense_settings")).categories.length, 11, "no category yet");
    assert.equal(sop.rows.get("di-expenses"), human, "the SOP is untouched");
  });

  await t.test("applying needs the preview's fingerprint for this exact change", async () => {
    const preview = await fde("fde_apply", { changeset: mileage() });
    await rejects(fde("fde_apply", { changeset: mileage(), fingerprint: "0".repeat(64) }), /changed since the preview/);
    await rejects(fde("fde_apply", { changeset: mileage({ summary: "something else" }), fingerprint: preview.fingerprint }), /changed since the preview/);
    assert.equal((await boss("get_expense_settings")).categories.length, 11);
  });

  await t.test("a rule that does not behave as its examples say is not applied", async () => {
    const wrong = mileage({ examples: [
      { claim: { category: "mileage", amount: 120, custom: { distance_km: 350 }, attachment_kinds: ["route_map"] }, expect: "blocked" },
      { claim: { category: "mileage", amount: 120, custom: {}, attachment_kinds: [] }, expect: "ok" },
    ] });
    const preview = await fde("fde_apply", { changeset: wrong });
    assert.equal(preview.valid, false);
    await rejects(fde("fde_apply", { changeset: wrong, fingerprint: preview.fingerprint }), /examples do not behave/);
  });

  await t.test("references are checked: unknown field, unknown category, and a field someone else owns", async () => {
    await rejects(fde("fde_apply", { changeset: mileage({ custom_fields: undefined }) }), /needs field expense_claim\.distance_km/);
    await rejects(fde("fde_apply", { changeset: mileage({ rules: [{ ...NEEDS_MAP, when: { category: ["flying"] } }] }) }), /category "flying", which does not exist/);
    await withContext(db, { tenantId: tenantA, actor: "dba" }, (tx) => defineCustomField(tx, { entity: "expense_claim", key: "cost_centre", label: "Cost centre", type: "text" }));
    await rejects(fde("fde_apply", { changeset: mileage({ custom_fields: [{ key: "cost_centre", label: "Cost centre 2", type: "text" }] }) }), /not created by the Forward Deploy Engineer/);
  });

  await t.test("applied: the rule is enforced for claims, and the SOP block sits beside the human text", async () => {
    const done = await deploy(fde, mileage());
    assert.equal(done.applied, true);
    assert.equal(done.change, 1);
    assert.equal(done.sop, "saved");
    assert.equal(sop.rows.get("di-expenses").startsWith(human), true, "text outside the block is kept");
    assert.equal(extractBlock(sop.rows.get("di-expenses")), SOP);

    const settings = await boss("get_expense_settings");
    assert.equal(settings.categories.at(-1).key, "mileage");
    assert.equal(settings.policy.requirements.length, 2);
    await rejects(clerk("file_claim", { expense_date: "2026-10-01", merchant: "Penang", category: "mileage", amount: 120, receipts: [await inbox("m.png")] }), /distance driven in km/);
    const ok = await clerk("file_claim", {
      expense_date: "2026-10-01", merchant: "Penang", category: "mileage", amount: 120, custom: { distance_km: 350.2 },
      receipts: [await inbox("route.png", "route-a")], receipt_kinds: ["route_map"],
    });
    filed.mileage = ok.claim.number;
    assert.deepEqual(ok.claim.custom, { distance_km: 350.2 });

    const audit = (await db.query("SELECT DISTINCT entity FROM di.audit_log WHERE agent = 'di-fde' ORDER BY entity")).rows.map((r) => r.entity);
    assert.deepEqual(audit, ["expense_setting", "field_def", "workflow_def"], "the audit trail names the Forward Deploy Engineer");
  });

  await t.test("the same change again is a no-op", async () => {
    const again = await fde("fde_apply", { changeset: mileage() });
    assert.equal(again.no_change, true);
  });

  await t.test("a second change shows which open claims it would catch, and undo takes it back", async () => {
    const taxi = mileage({
      summary: "Taxi claims need the route too",
      categories: undefined, custom_fields: undefined, sop: { markdown: "## Taxi\nAsk for the route screenshot too." },
      rules: [{ id: "taxi-map", when: { category: ["transport"] }, check: "attachment_kind", arg: "route_map", severity: "block", message: "Taxi claims need the route screenshot." }],
      examples: [
        { claim: { category: "transport", amount: 20, custom: {}, attachment_kinds: ["route_map"] }, expect: "ok" },
        { claim: { category: "transport", amount: 20, custom: {}, attachment_kinds: ["receipt"] }, expect: "blocked" },
      ],
    });
    const preview = await fde("fde_apply", { changeset: taxi });
    assert.deepEqual(preview.impact.open_claims, { checked: 2, failing: 1, numbers: [filed.legacy] }, "the earlier taxi claim would fail the new rule");
    await fde("fde_apply", { changeset: taxi, fingerprint: preview.fingerprint });
    assert.equal((await boss("get_expense_settings")).policy.requirements.length, 3);
    assert.deepEqual((await boss("get_claim", { claim: filed.legacy })).claim.policy_issues, ["Taxi claims need the route screenshot."]);

    const stale = await fde("fde_revert", { scope: "last" });
    await fde("fde_revert", { scope: "last", fingerprint: stale.fingerprint });
    assert.equal((await boss("get_expense_settings")).policy.requirements.length, 2, "the taxi rule is gone");
    assert.equal(extractBlock(sop.rows.get("di-expenses")), SOP, "the SOP block is back to the mileage text");
    assert.deepEqual((await boss("get_claim", { claim: filed.legacy })).claim.policy_issues, []);
    const history = (await fde("fde_describe")).current.history;
    assert.deepEqual(history.map((h) => [h.n, h.undone]), [[1, false], [2, true]]);
  });

  await t.test("a preview goes stale when something else changed first", async () => {
    const tweak = mileage({ summary: "Tweak the SOP", categories: undefined, custom_fields: undefined, rules: undefined, examples: [], sop: { markdown: "## Mileage\nTweaked wording." } });
    const preview = await fde("fde_apply", { changeset: tweak });
    await deploy(fde, mileage({
      summary: "Cap mileage", categories: undefined, custom_fields: undefined, sop: undefined,
      rules: [{ id: "mileage-cap", when: { category: ["mileage"] }, check: "amount_at_most", arg: 500, severity: "block", message: "Mileage over 500 needs a manager's pre-approval." }],
      // Examples run against every rule that would be in force, the mileage ones included.
      examples: [
        { claim: { category: "mileage", amount: 100, custom: { distance_km: 50 }, attachment_kinds: ["route_map"] }, expect: "ok" },
        { claim: { category: "mileage", amount: 900, custom: { distance_km: 50 }, attachment_kinds: ["route_map"] }, expect: "blocked" },
      ],
    }));
    await rejects(fde("fde_apply", { changeset: tweak, fingerprint: preview.fingerprint }), /changed since the preview/);
    const undo = await fde("fde_revert", { scope: "last" });
    await fde("fde_revert", { scope: "last", fingerprint: undo.fingerprint });
    assert.deepEqual((await fde("fde_describe")).current.managed.rules, ["mileage-distance", "mileage-map"], "the cap rule is gone again");
  });

  await t.test("remove one rule: the rest stays, and only what the FDE created can be removed", async () => {
    await rejects(fde("fde_revert", { scope: "item", kind: "rule", key: "no-such-rule" }), /was not created by the Forward Deploy Engineer/);
    await rejects(fde("fde_revert", { scope: "item", kind: "field", key: "cost_centre" }), /was not created by the Forward Deploy Engineer/);
    const preview = await fde("fde_revert", { scope: "item", kind: "rule", key: "mileage-map" });
    assert.deepEqual(preview.diff, ["- rule mileage-map"]);
    await fde("fde_revert", { scope: "item", kind: "rule", key: "mileage-map", fingerprint: preview.fingerprint });
    const settings = await boss("get_expense_settings");
    assert.deepEqual(settings.policy.requirements.map((r) => r.id), ["mileage-distance"]);
    assert.deepEqual(settings.policy.attachment_kinds, ["receipt"]);
    const described = await fde("fde_describe");
    assert.deepEqual(described.current.managed.rules, ["mileage-distance"]);
    assert.equal(described.current.managed.categories[0], "mileage");
  });

  await t.test("undo restores what an item removal took away", async () => {
    const preview = await fde("fde_revert", { scope: "last" });
    await fde("fde_revert", { scope: "last", fingerprint: preview.fingerprint });
    assert.deepEqual((await boss("get_expense_settings")).policy.requirements.map((r) => r.id), ["mileage-distance", "mileage-map"]);
  });

  await t.test("reset to default: everything the FDE created goes, filed claims keep their values, human SOP text stays", async () => {
    const preview = await fde("fde_revert", { scope: "all" });
    assert.ok(preview.diff.includes("- SOP block (your own SOP text is kept)"));
    assert.match(preview.note, /already filed are not changed/);
    const done = await fde("fde_revert", { scope: "all", fingerprint: preview.fingerprint });
    assert.equal(done.reverted, true);

    const settings = await boss("get_expense_settings");
    assert.equal(settings.categories.length, 11);
    assert.deepEqual(settings.policy.requirements, []);
    assert.deepEqual(settings.policy.attachment_kinds, ["receipt"]);
    assert.deepEqual(settings.policy.fields.map((f) => f.key), ["cost_centre"], "a field the FDE did not create is left alone");
    assert.equal(sop.rows.get("di-expenses"), `${human}\n`, "only the managed block was removed");
    const claim = (await boss("get_claim", { claim: filed.mileage })).claim;
    assert.equal(claim.category, "mileage", "the claim keeps its category");
    assert.deepEqual(claim.custom, { distance_km: 350.2 }, "and its value");
    assert.deepEqual((await boss("list_claims", { category: "mileage", month: "all" })).claims.map((c) => c.number), [filed.mileage], "and can still be found by category");
    assert.equal((await fde("fde_revert", { scope: "all" })).no_change, true, "nothing left to reset");
  });

  await t.test("defining the same rule again brings the stored values back to life", async () => {
    await deploy(fde, mileage());
    const claim = (await clerk("get_claim", { claim: filed.mileage })).claim;
    assert.deepEqual(claim.policy_issues, [], "the field is defined again, and the old value satisfies the rule");
  });

  await t.test("a reset can itself be undone", async () => {
    const reset = await fde("fde_revert", { scope: "all" });
    await fde("fde_revert", { scope: "all", fingerprint: reset.fingerprint });
    assert.deepEqual((await boss("get_expense_settings")).policy.requirements, []);
    assert.equal(extractBlock(sop.rows.get("di-expenses")), null);
    const undo = await fde("fde_revert", { scope: "last" });
    assert.ok(undo.diff.some((d) => /restore rule mileage-map|restore field distance_km|restore category mileage/.test(d)));
    await fde("fde_revert", { scope: "last", fingerprint: undo.fingerprint });
    const settings = await boss("get_expense_settings");
    assert.deepEqual(settings.policy.requirements.map((r) => r.id), ["mileage-distance", "mileage-map"]);
    assert.equal(settings.categories.at(-1).key, "mileage");
    assert.equal(extractBlock(sop.rows.get("di-expenses")), SOP);
    assert.ok(sop.rows.get("di-expenses").startsWith(human), "the human text is still there");
    assert.deepEqual((await fde("fde_describe")).current.managed.rules, ["mileage-distance", "mileage-map"], "the registry is restored too");
  });

  await t.test("another company sees none of it", async () => {
    const other = await fdeAs("admin", tenantB)("fde_describe");
    assert.deepEqual(other.current.managed, { categories: [], fields: [], rules: [], reports: [], sop: false });
    assert.deepEqual(other.current.rules, []);
  });
});

test("when the SOP was only the managed block, resetting clears it", async () => {
  const { fde, sop } = await setup();
  await deploy(fde, mileage());
  assert.ok(sop.rows.has("di-expenses"));
  const preview = await fde("fde_revert", { scope: "all" });
  await fde("fde_revert", { scope: "all", fingerprint: preview.fingerprint });
  assert.equal(sop.rows.has("di-expenses"), false);
});

test("an SOP change fails loudly when the host has no SOP storage", async () => {
  const { db, tenantA } = await setup();
  const bare = { db, tenantId: () => tenantA, resolveIdentity: async (code) => USERS[code] ?? null, now: () => new Date("2026-10-02T04:00:00Z") };
  const run = (args) => runTool(bare, { agent: "di-fde", tool: "fde_apply", args: { identity: "tok-admin", ...args } });
  const preview = await run({ changeset: mileage() });
  await rejects(run({ changeset: mileage(), fingerprint: preview.fingerprint }), /SOP storage is not available/);
  const gone = (await db.query("SELECT count(*)::int AS n FROM di.field_def WHERE key = 'distance_km' AND deleted_at IS NULL")).rows[0].n;
  assert.equal(gone, 0, "the failed apply rolled everything back");
});
