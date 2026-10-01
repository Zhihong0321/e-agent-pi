import assert from "node:assert/strict";
import test, { mock } from "node:test";

const calls = [];
const rows = new Map();
const pool = {
  query: async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO agent_sops")) {
      const [agentId, id, content, createdBy] = params;
      rows.set(agentId, { id, agentId, content, createdBy, updatedAt: new Date().toISOString() });
      return { rows: [{ id }] };
    }
    if (sql.includes("WHERE s.agent_id = $1")) {
      const row = rows.get(params[0]);
      return { rows: row ? [{ ...row, agentSlug: params[0], agentName: params[0] }] : [] };
    }
    if (sql.includes("ORDER BY a.name")) return { rows: [...rows.values()] };
    return { rows: [] };
  },
};

mock.module("./db.mjs", { namedExports: { getPool: () => pool } });
mock.module("./paths.mjs", { namedExports: { agentWorkspace: ({ slug }) => `/tmp/${slug}` } });
const sops = await import(`./sops.mjs?test=${Date.now()}`);

test("SOP schema is one simple Postgres row per agent", async () => {
  calls.length = 0;
  await sops.ensureSopSchema();
  assert.match(calls[0].sql, /agent_id TEXT PRIMARY KEY REFERENCES agents\(id\) ON DELETE CASCADE/);
  assert.match(calls[0].sql, /content TEXT NOT NULL/);
  assert.doesNotMatch(calls[0].sql, /status TEXT/);
});

test("saving an SOP upserts one agent row and writes its SOP file", async () => {
  rows.clear();
  const sop = await sops.saveAgentSop("di-documents", "# Email SOP\nOnly internal transactional email.", "demo-user");
  assert.equal(sop.agentId, "di-documents");
  assert.match(sop.content, /Only internal transactional email/);
  assert.equal((await sops.getAgentSop("di-documents")).content, sop.content);
});

test("approved lookup is now the same simple current SOP lookup", async () => {
  assert.equal((await sops.getApprovedAgentSop("di-documents")).content, "# Email SOP\nOnly internal transactional email.");
  assert.equal(await sops.getAgentSop("missing"), null);
});
