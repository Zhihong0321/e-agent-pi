import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getPool } from "./db.mjs";
import { agentWorkspace } from "./paths.mjs";

const SOP_SELECT = `s.id, s.agent_id AS "agentId", s.content,
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
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      created_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
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

export async function getAgentSop(agentId) {
  const result = await getPool().query(
    `SELECT ${SOP_SELECT} FROM agent_sops s JOIN agents a ON a.id = s.agent_id WHERE s.agent_id = $1`,
    [agentId],
  );
  return result.rows[0] ?? null;
}

export async function getApprovedAgentSop(agentId) {
  return getAgentSop(agentId);
}

export async function listAgentSops() {
  const result = await getPool().query(
    `SELECT ${SOP_SELECT} FROM agent_sops s JOIN agents a ON a.id = s.agent_id ORDER BY a.name`,
  );
  return result.rows;
}

export async function saveAgentSop(agentId, content, updatedBy = null) {
  const value = contentOf(content);
  const result = await getPool().query(
    `INSERT INTO agent_sops (agent_id, id, content, created_by)
     SELECT a.id, $2, $3, $4 FROM agents a WHERE a.id = $1
     ON CONFLICT (agent_id) DO UPDATE SET content = EXCLUDED.content, created_by = EXCLUDED.created_by, updated_at = NOW()
     RETURNING id`,
    [agentId, randomUUID(), value, updatedBy],
  );
  if (!result.rows[0]) throw new Error("Agent not found");
  const sop = await getAgentSop(agentId);
  await writeAgentSopFile(agentId, sop.content);
  return sop;
}

export async function writeAgentSopFile(agentId, content, workspace = null) {
  const dir = workspace || agentWorkspace({ id: agentId, slug: agentId });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SOP.md");
  await writeFile(file, `${String(content).trim()}\n`, "utf8");
  return file;
}

export async function syncAgentSopFile(agent) {
  const sop = await getAgentSop(agent.id);
  if (!sop) return null;
  return writeAgentSopFile(agent.id, sop.content, agentWorkspace(agent));
}
