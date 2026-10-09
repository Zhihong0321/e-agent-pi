import assert from "node:assert/strict";
import test, { mock } from "node:test";

const calls = [];
const rows = new Map();
const key = (agentId, companyId) => `${agentId}|${companyId || ""}`;
const pool = {
  query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO agent_sops")) {
      const [agentId, id, content, createdBy, companyId] = params;
      const prior = rows.get(key(agentId, companyId));
      rows.set(key(agentId, companyId), { id: prior?.id || id, agentId, companyId: companyId || null, content, createdBy, updatedAt: new Date().toISOString() });
      return { rows: [{ id }] };
    }
    if (sql.includes("s.company_id IS NULL OR s.company_id = $2")) {
      const [agentId, companyId] = params;
      const row = (companyId && rows.get(key(agentId, companyId))) || rows.get(key(agentId, null));
      return { rows: row ? [{ ...row, agentSlug: agentId, agentName: agentId }] : [] };
    }
    if (sql.includes("ORDER BY a.name")) return { rows: [...rows.values()] };
    if (sql.includes("DELETE FROM agent_sops")) {
      const [agentId, companyId] = params;
      const had = rows.delete(key(agentId, companyId));
      return { rows: had ? [{ id: "x" }] : [] };
    }
    return { rows: [] };
  },
};

mock.module("./db.mjs", { namedExports: { getPool: () => pool } });
mock.module("./paths.mjs", {
  namedExports: {
    agentWorkspace: ({ slug }, tenantId) => `/tmp/sop-test/${tenantId || "platform"}/${slug}`,
    isPlatformAgent: (agent) => ["website"].includes(typeof agent === "string" ? agent : agent?.id),
  },
});
const sops = await import(`./sops.mjs?test=${Date.now()}`);
const A = "company-a";
const B = "company-b";

test("SOP schema keeps one row per agent and scope, not one per agent", async () => {
  calls.length = 0;
  await sops.ensureSopSchema();
  assert.match(calls[0].sql, /agent_id TEXT NOT NULL REFERENCES agents\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(calls[0].sql, /agent_id TEXT PRIMARY KEY/);
  assert.match(calls[0].sql, /content TEXT NOT NULL/);
  assert.doesNotMatch(calls[0].sql, /status TEXT/);
  const text = calls.map((call) => call.sql).join("\n");
  assert.match(text, /ADD COLUMN IF NOT EXISTS company_id TEXT/);
  assert.match(text, /DROP CONSTRAINT IF EXISTS agent_sops_pkey/);
  assert.match(text, /agent_sops_scope_idx ON agent_sops \(agent_id, \(COALESCE\(company_id, ''\)\)\)/);
});

test("saving the platform default upserts one row", async () => {
  rows.clear();
  const sop = await sops.saveAgentSop("di-documents", "# Email SOP\nOnly internal transactional email.", "demo-user");
  assert.equal(sop.agentId, "di-documents");
  assert.match(sop.content, /Only internal transactional email/);
  assert.equal((await sops.getAgentSop("di-documents")).content, sop.content);
});

test("a company's SOP is its own: other companies and the default never see it", async () => {
  rows.clear();
  await sops.saveAgentSop("di-documents", "# Default rules");
  await sops.saveAgentSop("di-documents", "# Alpha rules", "alpha-admin", A);
  assert.equal((await sops.getAgentSop("di-documents", A)).content, "# Alpha rules");
  assert.equal((await sops.getAgentSop("di-documents", B)).content, "# Default rules");
  assert.equal((await sops.getAgentSop("di-documents")).content, "# Default rules");
  assert.equal(rows.size, 2);
});

test("a company editing its SOP never changes the default or another company", async () => {
  rows.clear();
  await sops.saveAgentSop("di-documents", "# Default rules");
  await sops.saveAgentSop("di-documents", "# Alpha v1", null, A);
  await sops.saveAgentSop("di-documents", "# Beta v1", null, B);
  await sops.saveAgentSop("di-documents", "# Alpha v2", null, A);
  assert.equal((await sops.getAgentSop("di-documents", A)).content, "# Alpha v2");
  assert.equal((await sops.getAgentSop("di-documents", B)).content, "# Beta v1");
  assert.equal((await sops.getAgentSop("di-documents")).content, "# Default rules");
});

test("clearing a company SOP falls back to the default and leaves other companies alone", async () => {
  rows.clear();
  await sops.saveAgentSop("di-documents", "# Default rules");
  await sops.saveAgentSop("di-documents", "# Alpha", null, A);
  await sops.saveAgentSop("di-documents", "# Beta", null, B);
  assert.equal(await sops.clearAgentSop("di-documents", null, A), true);
  assert.equal((await sops.getAgentSop("di-documents", A)).content, "# Default rules");
  assert.equal((await sops.getAgentSop("di-documents", B)).content, "# Beta");
  assert.equal(await sops.clearAgentSop("di-documents", null, A), false);
});

test("fingerprint changes on every save so a warm runtime is replaced", async () => {
  rows.clear();
  assert.equal(await sops.sopFingerprint("di-documents"), "");
  await sops.saveAgentSop("di-documents", "# One");
  const first = await sops.sopFingerprint("di-documents");
  assert.ok(first);
  rows.get(key("di-documents", null)).updatedAt = new Date(Date.now() + 5000).toISOString();
  assert.notEqual(await sops.sopFingerprint("di-documents"), first);
});

test("clearing the default removes the row and reports whether one existed", async () => {
  rows.clear();
  await sops.saveAgentSop("di-documents", "# One");
  assert.equal(await sops.clearAgentSop("di-documents", "/tmp/sop-test/platform/di-documents"), true);
  assert.equal(await sops.getAgentSop("di-documents"), null);
  assert.equal(await sops.sopFingerprint("di-documents"), "");
  assert.equal(await sops.clearAgentSop("di-documents", "/tmp/sop-test/platform/di-documents"), false);
});

test("approved lookup is the same current SOP lookup", async () => {
  rows.clear();
  await sops.saveAgentSop("di-documents", "# Email SOP\nOnly internal transactional email.");
  assert.equal((await sops.getApprovedAgentSop("di-documents")).content, "# Email SOP\nOnly internal transactional email.");
  assert.equal(await sops.getAgentSop("missing"), null);
});
