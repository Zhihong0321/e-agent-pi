// A1: the bible reaches an agent's prompt through buildRoleText, in its own section, for the agents that work
// with company records only, and never stops an agent from starting.
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pgliteAdapter } from "../core/db.mjs";
import { seedTenant } from "../core/seed.mjs";
import { seedSolar } from "./solar-fixture.mjs";

test("buildRoleText puts the company's slice into a DI agent's prompt, and nowhere else", async () => {
  const postgres = new PGlite();
  let failing = false;
  let tail = Promise.resolve();
  const acquire = async () => {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    await previous;
    return release;
  };
  const query = async (sql, params) => {
    if (failing) throw new Error("database is down");
    const result = params?.length ? await postgres.query(sql, params) : (await postgres.exec(sql)).at(-1);
    return { rows: result?.rows || [], rowCount: result?.affectedRows ?? result?.rows?.length ?? 0 };
  };
  const pool = {
    query: async (sql, params) => { const release = await acquire(); try { return await query(sql, params); } finally { release(); } },
    connect: async () => { const release = await acquire(); return { query, release }; },
    end: async () => {},
  };
  const host = await import("../host.mjs");
  const { buildRoleText } = await import("../../server/runtime.mjs");
  await host.ensureDocumentIntelligence({ pool, catalog: { seedSystemAgent: async () => {} } });
  const db = pgliteAdapter(postgres);
  const solar = await seedSolar(db, "Alpha Solar");
  const empty = (await db.query("INSERT INTO di.tenant (name) VALUES ('New Co') RETURNING id")).rows[0].id;
  await seedTenant(db, empty);

  const role = (id) => ({ id, slug: id, rolePrompt: `You are ${id}.`, skills: [] });

  const records = await buildRoleText(role("di-records"), { companyId: solar });
  assert.match(records, /^You are di-records\./);
  assert.match(records, /\n## Company schema: Alpha Solar \(v[0-9a-f]{8}\)\n/);
  assert.match(records, /^customer \(platform\)$/m);
  assert.match(records, /^  tnb_account_no text required:invoice\.issue /m);
  assert.doesNotMatch(records, /^po_number|^document \(platform\)/m, "the Records Clerk's slice has no document table");
  assert.match(records, /^Not shown here: product, document, document_line\. Call describe_schema to read them\.$/m);

  const docs = await buildRoleText(role("di-documents"), { companyId: solar });
  assert.match(docs, /^document_line \(platform\)$/m);
  assert.match(docs, /^  po_number text required:invoice\.issue /m);

  // A company with nothing of its own is told so, definitively.
  assert.match(await buildRoleText(role("di-records"), { companyId: empty }), /This company has no fields or tables of its own yet\./);

  // Not every agent: the orchestrator, agents with no company-record tools, the procurement clerk, and no company.
  for (const id of ["orchestrator", "sales", "di-procurement"]) {
    assert.doesNotMatch(await buildRoleText(role(id), { companyId: solar }), /Company schema/, id);
  }
  assert.doesNotMatch(await buildRoleText(role("di-records")), /Company schema/, "no company, no bible");

  // The read fails: the agent still starts, without the section.
  const logged = mock.method(console, "error", () => {});
  failing = true;
  try {
    const text = await buildRoleText(role("di-records"), { companyId: solar });
    assert.match(text, /^You are di-records\./);
    assert.doesNotMatch(text, /Company schema/);
    assert.ok(logged.mock.calls.some((c) => /schema bible for di-records/.test(String(c.arguments[0]))), "the failure is logged");
  } finally {
    failing = false;
    logged.mock.restore();
  }
});
