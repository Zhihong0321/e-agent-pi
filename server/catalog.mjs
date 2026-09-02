import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPool } from "./db.mjs";
import {
  BUNDLED_SKILLS,
  DEFAULT_AGENT_ID,
  OPS_AGENT_ID,
  ROLE_FILE,
  SETTINGS_ROLE_FILE,
  SKILLS_DIR,
} from "./paths.mjs";

export const WEBSITE_AGENT_ID = DEFAULT_AGENT_ID;

/**
 * @param {string} value
 */
export function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "item";
}

/**
 * @param {string} markdown
 */
export function parseSkillMarkdown(markdown) {
  const text = String(markdown || "").replace(/^\uFEFF/, "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { name: "", description: "", body: text.trim() };
  const yaml = match[1];
  const name = yaml.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ?? "";
  let description = "";
  const descLine = yaml.match(/^description:\s*[>|]?-?\s*["']?(.+?)["']?\s*$/m);
  if (descLine) description = descLine[1].trim();
  return { name: slugify(name), description, body: match[2].trim() };
}

function skillMarkdown({ name, description, content }) {
  const body = String(content || "").trim();
  if (body.startsWith("---")) return body.endsWith("\n") ? body : `${body}\n`;
  return `---\nname: ${name}\ndescription: ${description || name}\n---\n\n${body || `# ${name}\n`}\n`;
}

export async function ensureCatalogSchema() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      short TEXT NOT NULL DEFAULT 'A',
      headline TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT 'emerald',
      role_prompt TEXT NOT NULL DEFAULT '',
      model_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      source_url TEXT,
      dir_path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      args JSONB,
      url TEXT,
      env JSONB,
      config JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agent_skills (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, skill_id)
    );
    CREATE TABLE IF NOT EXISTS agent_mcp (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      mcp_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      PRIMARY KEY (agent_id, mcp_id)
    );
  `);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sessions_agent_id_idx ON sessions (agent_id)`);
}

function mapAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    short: row.short,
    headline: row.headline,
    description: row.description,
    color: row.color,
    rolePrompt: row.rolePrompt ?? row.role_prompt,
    modelId: row.modelId ?? row.model_id ?? null,
    createdAt: row.createdAt ?? row.created_at,
    updatedAt: row.updatedAt ?? row.updated_at,
  };
}

const AGENT_SELECT = `id, slug, name, short, headline, description, color,
  role_prompt AS "rolePrompt", model_id AS "modelId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

const SKILL_SELECT = `id, slug, name, description, source, source_url AS "sourceUrl",
  dir_path AS "dirPath", created_at AS "createdAt", updated_at AS "updatedAt"`;

const MCP_SELECT = `id, slug, name, description, transport, command, args, url, env, config,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export async function listAgents() {
  const result = await getPool().query(`SELECT ${AGENT_SELECT} FROM agents ORDER BY name ASC`);
  const agents = result.rows.map(mapAgent);
  const skillMap = await attachmentsByAgent("agent_skills", "skill_id");
  const mcpMap = await attachmentsByAgent("agent_mcp", "mcp_id");
  const skills = await listSkills();
  const mcp = await listMcpServers();
  const skillsById = new Map(skills.map((row) => [row.id, row]));
  const mcpById = new Map(mcp.map((row) => [row.id, row]));
  return agents.map((agent) => ({
    ...agent,
    skillIds: skillMap.get(agent.id) ?? [],
    mcpIds: mcpMap.get(agent.id) ?? [],
    skills: (skillMap.get(agent.id) ?? []).map((id) => publicSkill(skillsById.get(id))).filter(Boolean),
    mcp: (mcpMap.get(agent.id) ?? []).map((id) => publicMcp(mcpById.get(id))).filter(Boolean),
  }));
}

async function attachmentsByAgent(table, column) {
  const result = await getPool().query(`SELECT agent_id AS "agentId", ${column} AS id FROM ${table}`);
  /** @type {Map<string, string[]>} */
  const map = new Map();
  for (const row of result.rows) {
    const list = map.get(row.agentId) ?? [];
    list.push(row.id);
    map.set(row.agentId, list);
  }
  return map;
}

export async function getAgent(id) {
  const result = await getPool().query(`SELECT ${AGENT_SELECT} FROM agents WHERE id = $1 OR slug = $1`, [id]);
  const agent = mapAgent(result.rows[0]);
  if (!agent) return null;
  const skills = await listAgentSkills(agent.id);
  const mcp = await listAgentMcp(agent.id);
  return {
    ...agent,
    skillIds: skills.map((row) => row.id),
    mcpIds: mcp.map((row) => row.id),
    skills,
    mcp,
  };
}

export async function listAgentSkills(agentId) {
  const result = await getPool().query(
    `SELECT s.id, s.slug, s.name, s.description, s.source, s.source_url AS "sourceUrl",
            s.dir_path AS "dirPath", s.created_at AS "createdAt", s.updated_at AS "updatedAt"
     FROM skills s
     JOIN agent_skills a ON a.skill_id = s.id
     WHERE a.agent_id = $1
     ORDER BY s.name ASC`,
    [agentId],
  );
  return result.rows;
}

export async function listAgentMcp(agentId) {
  const result = await getPool().query(
    `SELECT m.id, m.slug, m.name, m.description, m.transport, m.command, m.args, m.url, m.env, m.config,
            m.created_at AS "createdAt", m.updated_at AS "updatedAt"
     FROM mcp_servers m
     JOIN agent_mcp a ON a.mcp_id = m.id
     WHERE a.agent_id = $1
     ORDER BY m.name ASC`,
    [agentId],
  );
  return result.rows.map(mapMcp);
}

function mapMcp(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport,
    command: row.command ?? null,
    args: Array.isArray(row.args) ? row.args : [],
    url: row.url ?? null,
    env: row.env && typeof row.env === "object" ? row.env : {},
    config: row.config && typeof row.config === "object" ? row.config : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * @param {object} [input]
 */
export async function createAgent(input = {}) {
  const id = input.id || randomUUID();
  const name = String(input.name || "").trim() || "New agent";
  const slug = slugify(input.slug || name);
  const result = await getPool().query(
    `INSERT INTO agents (id, slug, name, short, headline, description, color, role_prompt, model_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${AGENT_SELECT}`,
    [
      id,
      slug,
      name,
      String(input.short || name[0] || "A").slice(0, 2).toUpperCase(),
      String(input.headline || "").trim(),
      String(input.description || "").trim(),
      String(input.color || "emerald").trim() || "emerald",
      String(input.rolePrompt || "").trim(),
      input.modelId ?? null,
    ],
  );
  const agent = mapAgent(result.rows[0]);
  await setAgentAttachments(agent.id, input.skillIds, input.mcpIds);
  return getAgent(agent.id);
}

/**
 * @param {string} id
 * @param {object} patch
 */
export async function updateAgent(id, patch) {
  const current = await getAgent(id);
  if (!current) return null;
  const fields = [];
  const values = [];
  let i = 1;
  const map = {
    name: "name",
    slug: "slug",
    short: "short",
    headline: "headline",
    description: "description",
    color: "color",
    rolePrompt: "role_prompt",
    modelId: "model_id",
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    let value = patch[key];
    if (key === "slug") value = slugify(value);
    if (key === "short") value = String(value || "A").slice(0, 2).toUpperCase();
    fields.push(`${column} = $${i++}`);
    values.push(value);
  }
  if (fields.length) {
    fields.push("updated_at = NOW()");
    values.push(current.id);
    await getPool().query(`UPDATE agents SET ${fields.join(", ")} WHERE id = $${i}`, values);
  }
  if (patch.skillIds !== undefined || patch.mcpIds !== undefined) {
    await setAgentAttachments(
      current.id,
      patch.skillIds !== undefined ? patch.skillIds : current.skillIds,
      patch.mcpIds !== undefined ? patch.mcpIds : current.mcpIds,
    );
  }
  return getAgent(current.id);
}

async function setAgentAttachments(agentId, skillIds, mcpIds) {
  const pool = getPool();
  if (Array.isArray(skillIds)) {
    await pool.query(`DELETE FROM agent_skills WHERE agent_id = $1`, [agentId]);
    for (const skillId of skillIds) {
      if (!skillId) continue;
      await pool.query(`INSERT INTO agent_skills (agent_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        agentId,
        skillId,
      ]);
    }
  }
  if (Array.isArray(mcpIds)) {
    await pool.query(`DELETE FROM agent_mcp WHERE agent_id = $1`, [agentId]);
    for (const mcpId of mcpIds) {
      if (!mcpId) continue;
      await pool.query(`INSERT INTO agent_mcp (agent_id, mcp_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [agentId, mcpId]);
    }
  }
}

export async function attachAgentResources(agentRef, { skills = [], mcp = [], detach = false } = {}) {
  const agent = await getAgent(agentRef);
  if (!agent) throw new Error(`Agent not found: ${agentRef}`);
  let skillIds = [...(agent.skillIds ?? [])];
  let mcpIds = [...(agent.mcpIds ?? [])];
  for (const ref of skills) {
    const skill = await getSkill(ref);
    if (!skill) throw new Error(`Unknown skill: ${ref}`);
    if (!detach && skill.slug === "manage-host-settings" && (agent.id === WEBSITE_AGENT_ID || agent.slug === "website")) {
      throw new Error("manage-host-settings stays on Settings Agent only.");
    }
    if (detach) skillIds = skillIds.filter((id) => id !== skill.id);
    else if (!skillIds.includes(skill.id)) skillIds.push(skill.id);
  }
  for (const ref of mcp) {
    const server = await getMcpServer(ref);
    if (!server) throw new Error(`Unknown MCP server: ${ref}`);
    if (detach) mcpIds = mcpIds.filter((id) => id !== server.id);
    else if (!mcpIds.includes(server.id)) mcpIds.push(server.id);
  }
  return updateAgent(agent.id, { skillIds, mcpIds });
}

export async function deleteAgent(id) {
  const agent = await getAgent(id);
  if (!agent) return false;
  if (agent.id === WEBSITE_AGENT_ID || agent.slug === "website") {
    throw new Error("The Website Dev Agent cannot be deleted.");
  }
  if (agent.id === OPS_AGENT_ID || agent.slug === "settings" || agent.slug === "ops") {
    throw new Error("The Settings Agent cannot be deleted.");
  }
  await getPool().query(`UPDATE sessions SET agent_id = $1 WHERE agent_id = $2`, [WEBSITE_AGENT_ID, agent.id]);
  await getPool().query(`DELETE FROM agents WHERE id = $1`, [agent.id]);
  return true;
}

export async function listSkills() {
  const result = await getPool().query(`SELECT ${SKILL_SELECT} FROM skills ORDER BY name ASC`);
  return result.rows;
}

export async function getSkill(id) {
  const result = await getPool().query(`SELECT ${SKILL_SELECT} FROM skills WHERE id = $1 OR slug = $1`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  let content = "";
  try {
    content = await readFile(path.join(row.dirPath, "SKILL.md"), "utf8");
  } catch {
    content = "";
  }
  return { ...row, content };
}

export async function listMcpServers() {
  const result = await getPool().query(`SELECT ${MCP_SELECT} FROM mcp_servers ORDER BY name ASC`);
  return result.rows.map(mapMcp);
}

export async function getMcpServer(id) {
  const result = await getPool().query(`SELECT ${MCP_SELECT} FROM mcp_servers WHERE id = $1 OR slug = $1`, [id]);
  return mapMcp(result.rows[0]);
}

/**
 * @param {object} input
 */
export async function createMcpServer(input) {
  const name = String(input.name || "").trim() || "MCP server";
  const slug = slugify(input.slug || name);
  const args = normalizeArgs(input.args);
  const env = input.env && typeof input.env === "object" ? input.env : {};
  const url = String(input.url || "").trim() || null;
  const command = String(input.command || "").trim() || null;
  const result = await getPool().query(
    `INSERT INTO mcp_servers (id, slug, name, description, transport, command, args, url, env, config)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb)
     RETURNING ${MCP_SELECT}`,
    [
      input.id || randomUUID(),
      slug,
      name,
      String(input.description || "").trim(),
      url ? "http" : "stdio",
      command,
      JSON.stringify(args),
      url,
      JSON.stringify(env),
      JSON.stringify(input.config && typeof input.config === "object" ? input.config : {}),
    ],
  );
  return mapMcp(result.rows[0]);
}

export async function updateMcpServer(id, patch) {
  const current = await getMcpServer(id);
  if (!current) return null;
  const next = {
    name: patch.name !== undefined ? String(patch.name).trim() : current.name,
    slug: patch.slug !== undefined ? slugify(patch.slug) : current.slug,
    description: patch.description !== undefined ? String(patch.description).trim() : current.description,
    command: patch.command !== undefined ? String(patch.command).trim() || null : current.command,
    args: patch.args !== undefined ? normalizeArgs(patch.args) : current.args,
    url: patch.url !== undefined ? String(patch.url).trim() || null : current.url,
    env: patch.env !== undefined && typeof patch.env === "object" ? patch.env : current.env,
    config: patch.config !== undefined && typeof patch.config === "object" ? patch.config : current.config,
  };
  const transport = next.url ? "http" : "stdio";
  const result = await getPool().query(
    `UPDATE mcp_servers SET slug = $2, name = $3, description = $4, transport = $5, command = $6,
      args = $7::jsonb, url = $8, env = $9::jsonb, config = $10::jsonb, updated_at = NOW()
     WHERE id = $1
     RETURNING ${MCP_SELECT}`,
    [
      current.id,
      next.slug,
      next.name,
      next.description,
      transport,
      next.command,
      JSON.stringify(next.args),
      next.url,
      JSON.stringify(next.env || {}),
      JSON.stringify(next.config || {}),
    ],
  );
  return mapMcp(result.rows[0]);
}

export async function deleteMcpServer(id) {
  const result = await getPool().query(`DELETE FROM mcp_servers WHERE id = $1 OR slug = $1 RETURNING id`, [id]);
  return Boolean(result.rows[0]);
}

function normalizeArgs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string" && value.trim()) {
    return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => part.replace(/^"|"$/g, "")) ?? [];
  }
  return [];
}

/**
 * @param {{ name?: string; description?: string; content?: string; url?: string; source?: string }} input
 */
export async function installSkill(input) {
  let content = String(input.content || "");
  let source = input.source || "manual";
  let sourceUrl = input.url || null;
  if (!content && !input.url) throw new Error("Paste SKILL.md content or a URL.");
  if (input.url && !content) {
    const res = await fetch(input.url);
    if (!res.ok) throw new Error(`Could not download skill (${res.status}).`);
    content = await res.text();
    source = "url";
    sourceUrl = input.url;
  }
  const parsed = parseSkillMarkdown(content);
  const name = slugify(input.name || parsed.name || "skill");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error("Skill name must be lowercase letters, numbers, and hyphens.");
  }
  const description = String(input.description || parsed.description || name).slice(0, 1024);
  const dir = path.join(SKILLS_DIR, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), skillMarkdown({ name, description, content: content || parsed.body }), "utf8");
  return upsertSkillRow({
    slug: name,
    name,
    description,
    source,
    sourceUrl,
    dirPath: dir,
  });
}

/**
 * Register a skill folder already on disk under SKILLS_DIR.
 * @param {{ slug: string; source?: string; sourceUrl?: string | null }} input
 */
export async function registerSkillDir(input) {
  const slug = slugify(input.slug);
  const dir = path.join(SKILLS_DIR, slug);
  let markdown = "";
  try {
    markdown = await readFile(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    throw new Error(`Skill folder has no SKILL.md: ${dir}`);
  }
  const parsed = parseSkillMarkdown(markdown);
  return upsertSkillRow({
    slug,
    name: slug,
    description: String(parsed.description || slug).slice(0, 1024),
    source: input.source || "library",
    sourceUrl: input.sourceUrl ?? null,
    dirPath: dir,
  });
}

async function upsertSkillRow(row) {
  const existing = await getPool().query(`SELECT id FROM skills WHERE slug = $1`, [row.slug]);
  const id = existing.rows[0]?.id || randomUUID();
  const result = await getPool().query(
    `INSERT INTO skills (id, slug, name, description, source, source_url, dir_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       source = EXCLUDED.source,
       source_url = COALESCE(EXCLUDED.source_url, skills.source_url),
       dir_path = EXCLUDED.dir_path,
       updated_at = NOW()
     RETURNING ${SKILL_SELECT}`,
    [id, row.slug, row.name, row.description, row.source, row.sourceUrl, row.dirPath],
  );
  return result.rows[0];
}

export async function deleteSkill(id) {
  const skill = await getSkill(id);
  if (!skill) return false;
  await getPool().query(`DELETE FROM skills WHERE id = $1`, [skill.id]);
  return true;
}

export async function rescanSkillLibrary() {
  await mkdir(SKILLS_DIR, { recursive: true });
  let entries = [];
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return listSkills();
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, entry.name);
    let markdown = "";
    try {
      markdown = await readFile(path.join(dir, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillMarkdown(markdown);
    const slug = slugify(parsed.name || entry.name);
    await upsertSkillRow({
      slug,
      name: slug,
      description: parsed.description || slug,
      source: "library",
      sourceUrl: null,
      dirPath: dir,
    });
  }
  return listSkills();
}

export async function copyBundledSkills() {
  await mkdir(SKILLS_DIR, { recursive: true });
  let entries = [];
  try {
    entries = await readdir(BUNDLED_SKILLS, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const from = path.join(BUNDLED_SKILLS, entry.name);
    const to = path.join(SKILLS_DIR, entry.name);
    await cp(from, to, { recursive: true });
  }
}

async function seedAgent(row) {
  await getPool().query(
    `INSERT INTO agents (id, slug, name, short, headline, description, color, role_prompt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       role_prompt = CASE
         WHEN agents.role_prompt IS NULL OR agents.role_prompt = '' THEN EXCLUDED.role_prompt
         ELSE agents.role_prompt
       END`,
    [row.id, row.slug, row.name, row.short, row.headline, row.description, row.color, row.rolePrompt],
  );
}

async function seedSystemAgent(row) {
  await getPool().query(
    `INSERT INTO agents (id, slug, name, short, headline, description, color, role_prompt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       slug = EXCLUDED.slug,
       name = EXCLUDED.name,
       short = EXCLUDED.short,
       headline = EXCLUDED.headline,
       description = EXCLUDED.description,
       color = EXCLUDED.color,
       role_prompt = EXCLUDED.role_prompt,
       updated_at = NOW()`,
    [row.id, row.slug, row.name, row.short, row.headline, row.description, row.color, row.rolePrompt],
  );
}

export async function seedAgentCatalog() {
  await ensureCatalogSchema();
  await mkdir(SKILLS_DIR, { recursive: true });
  await copyBundledSkills();
  await rescanSkillLibrary();

  const websiteRole = await readFile(ROLE_FILE, "utf8").catch(() => "You are Website Dev Agent.");
  const settingsRole = await readFile(SETTINGS_ROLE_FILE, "utf8").catch(() => "You are Settings Agent.");
  await seedAgent({
    id: WEBSITE_AGENT_ID,
    slug: "website",
    name: "Website Dev Agent",
    short: "W",
    headline: "Ready to build in the workspace",
    description: "Designs static websites in the GitHub-backed workspace",
    color: "emerald",
    rolePrompt: websiteRole,
  });
  await seedSystemAgent({
    id: OPS_AGENT_ID,
    slug: "settings",
    name: "Settings Agent",
    short: "S",
    headline: "Installs and attaches skills and MCP in chat",
    description: "Host catalog: install skills/MCP, then attach them per agent.",
    color: "violet",
    rolePrompt: settingsRole,
  });

  const manageRow = await getPool().query(`SELECT id FROM skills WHERE slug = 'manage-host-settings'`);
  const manageId = manageRow.rows[0]?.id;
  if (manageId) {
    await getPool().query(`INSERT INTO agent_skills (agent_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      OPS_AGENT_ID,
      manageId,
    ]);
  }

  await getPool().query(`UPDATE sessions SET agent_id = $1 WHERE agent_id IS NULL`, [WEBSITE_AGENT_ID]);
}

export async function catalogCounts() {
  const pool = getPool();
  const agents = await pool.query(`SELECT COUNT(*)::int AS n FROM agents`);
  const skills = await pool.query(`SELECT COUNT(*)::int AS n FROM skills`);
  const mcp = await pool.query(`SELECT COUNT(*)::int AS n FROM mcp_servers`);
  return {
    agents: agents.rows[0]?.n ?? 0,
    skills: skills.rows[0]?.n ?? 0,
    mcp: mcp.rows[0]?.n ?? 0,
  };
}

export function publicSkill(skill) {
  if (!skill) return null;
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    sourceUrl: skill.sourceUrl ?? null,
    dirPath: skill.dirPath,
  };
}

export function publicMcp(server, { secrets = false } = {}) {
  if (!server) return null;
  return {
    id: server.id,
    slug: server.slug,
    name: server.name,
    description: server.description,
    transport: server.transport,
    command: server.command,
    args: server.args ?? [],
    url: server.url,
    hasEnv: Boolean(server.env && Object.keys(server.env).length),
    env: secrets ? server.env || {} : undefined,
    config: server.config || {},
  };
}

export function publicAgent(agent, { includeRole = false } = {}) {
  if (!agent) return null;
  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    short: agent.short,
    headline: agent.headline,
    description: agent.description,
    color: agent.color,
    modelId: agent.modelId ?? null,
    rolePrompt: includeRole ? agent.rolePrompt : undefined,
    skillIds: agent.skillIds ?? agent.skills?.map((row) => row.id) ?? [],
    mcpIds: agent.mcpIds ?? agent.mcp?.map((row) => row.id) ?? [],
    skills: (agent.skills ?? []).map((row) => publicSkill(row)),
    mcp: (agent.mcp ?? []).map((row) => publicMcp(row)),
  };
}
