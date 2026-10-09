import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getPool } from "./db.mjs";
import { agentWorkspace, isPlatformAgent } from "./paths.mjs";

// An SOP has a scope: company_id NULL is the platform default every company starts from; a row
// with a company_id is that company's own version. A company only ever reads or writes its own.
const SOP_SELECT = `s.id, s.agent_id AS "agentId", s.company_id AS "companyId", s.content,
  s.created_by AS "createdBy", s.updated_at AS "updatedAt",
  a.slug AS "agentSlug", a.name AS "agentName"`;

function contentOf(value) {
  const content = String(value ?? "").trim();
  if (!content) throw new Error("SOP content is required.");
  if (content.length > 120_000) throw new Error("SOP content is too long.");
  return content;
}

export async function ensureSopSchema() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_sops (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE agent_sops ADD COLUMN IF NOT EXISTS company_id TEXT`);
  await pool.query(`ALTER TABLE agent_sops DROP CONSTRAINT IF EXISTS agent_sops_pkey`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS agent_sops_scope_idx ON agent_sops (agent_id, (COALESCE(company_id, '')))`);
  await pool.query(`ALTER TABLE agent_sops ADD COLUMN IF NOT EXISTS id TEXT`);
  await pool.query(`ALTER TABLE agent_sops ADD COLUMN IF NOT EXISTS content TEXT`);
  await pool.query(`ALTER TABLE agent_sops ADD COLUMN IF NOT EXISTS created_by TEXT`);
  await pool.query(`ALTER TABLE agent_sops ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`DO $do$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agent_sops' AND column_name = 'title'
      ) THEN
        EXECUTE $sql$UPDATE agent_sops SET id = COALESCE(id, md5(agent_id || random()::text)), content = COALESCE(content, title, '') WHERE id IS NULL OR content IS NULL$sql$;
      ELSE
        EXECUTE $sql$UPDATE agent_sops SET id = COALESCE(id, md5(agent_id || random()::text)), content = COALESCE(content, '') WHERE id IS NULL OR content IS NULL$sql$;
      END IF;
    END
  $do$`);
  await pool.query(`DO $do$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'agent_sops' AND column_name = 'title'
      ) THEN
        EXECUTE 'ALTER TABLE agent_sops ALTER COLUMN title DROP NOT NULL';
      END IF;
    END
  $do$`);
  await pool.query(`ALTER TABLE agent_sops ALTER COLUMN id SET NOT NULL`);
  await pool.query(`ALTER TABLE agent_sops ALTER COLUMN content SET NOT NULL`);
}

/** The SOP an agent follows for a company: its own version if it has one, else the platform default. */
export async function getAgentSop(agentId, companyId = null) {
  const result = await getPool().query(
    `SELECT ${SOP_SELECT} FROM agent_sops s JOIN agents a ON a.id = s.agent_id
      WHERE s.agent_id = $1 AND (s.company_id IS NULL OR s.company_id = $2)
      ORDER BY (s.company_id IS NULL) ASC LIMIT 1`,
    [agentId, companyId],
  );
  return result.rows[0] ?? null;
}

export async function getApprovedAgentSop(agentId, companyId = null) {
  return getAgentSop(agentId, companyId);
}

/**
 * Cheap change marker for the runtime bundle key: the SOP is part of an agent's prompt, so a save
 * from any path (UI, catalog CLI, FDE) must start a fresh runtime. Empty string when no SOP.
 */
export async function sopFingerprint(agentId, companyId = null) {
  const sop = await getAgentSop(agentId, companyId);
  return sop?.updatedAt ? new Date(sop.updatedAt).toISOString() : "";
}

export async function listAgentSops() {
  const result = await getPool().query(
    `SELECT ${SOP_SELECT} FROM agent_sops s JOIN agents a ON a.id = s.agent_id ORDER BY a.name`,
  );
  return result.rows;
}

function sopWorkspace(agentId, companyId) {
  const agent = { id: agentId, slug: agentId };
  if (isPlatformAgent(agent)) return companyId ? null : agentWorkspace(agent);
  return companyId ? agentWorkspace(agent, companyId) : null;
}

/** Saves the SOP for one scope: a company's own version, or (companyId null) the platform default. */
export async function saveAgentSop(agentId, content, updatedBy = null, companyId = null) {
  const value = contentOf(content);
  const result = await getPool().query(
    `INSERT INTO agent_sops (agent_id, company_id, id, content, created_by)
     SELECT a.id, $5, $2, $3, $4 FROM agents a WHERE a.id = $1
     ON CONFLICT (agent_id, (COALESCE(company_id, ''))) DO UPDATE SET content = EXCLUDED.content, created_by = EXCLUDED.created_by, updated_at = NOW()
     RETURNING id`,
    [agentId, randomUUID(), value, updatedBy, companyId],
  );
  if (!result.rows[0]) throw new Error("Agent not found");
  const sop = await getAgentSop(agentId, companyId);
  // The workspace copy exists where the agent's workspace does: the platform's for platform agents,
  // the company's for company agents. A platform default for a company agent has no workspace.
  const workspace = sopWorkspace(agentId, companyId);
  if (workspace) await writeAgentSopFile(agentId, sop.content, workspace);
  return sop;
}

/** Remove one scope's SOP (a company falls back to the platform default) and its mirrored workspace file. */
export async function clearAgentSop(agentId, workspace = null, companyId = null) {
  const result = await getPool().query(
    `DELETE FROM agent_sops WHERE agent_id = $1 AND company_id IS NOT DISTINCT FROM $2 RETURNING id`,
    [agentId, companyId],
  );
  const dir = workspace || sopWorkspace(agentId, companyId);
  if (dir) await rm(path.join(dir, "SOP.md"), { force: true });
  return result.rows.length > 0;
}

export async function writeAgentSopFile(agentId, content, workspace = null) {
  const dir = workspace || agentWorkspace({ id: agentId, slug: agentId });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SOP.md");
  await writeFile(file, `${String(content).trim()}\n`, "utf8");
  return file;
}

export async function syncAgentSopFile(agent, companyId = null) {
  const sop = await getAgentSop(agent.id, companyId);
  if (!sop) return null;
  return writeAgentSopFile(agent.id, sop.content, agentWorkspace(agent, companyId || undefined));
}
