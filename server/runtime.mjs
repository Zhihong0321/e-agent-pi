import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { imagenConfigured, imagenSystemPrompt } from "./imagen.mjs";
import { hostSystemPrompt } from "./ee-html.mjs";
import { IMAGEN_SKILL_DIR, RUNTIME_DIR, SPAWN_SUBAGENTS_SLUG, STORAGE, SUBAGENTS_EXTENSION } from "./paths.mjs";

/**
 * @param {{ slug?: string; dirPath?: string }[] | undefined} skills
 */
export function agentHasSubagents(skills) {
  return (skills || []).some(
    (skill) => skill.slug === SPAWN_SUBAGENTS_SLUG || (skill.dirPath && skill.dirPath.replace(/\\/g, "/").endsWith(`/${SPAWN_SUBAGENTS_SLUG}`)),
  );
}

/**
 * @param {{ slug: string; command?: string | null; args?: unknown; url?: string | null; env?: Record<string, string> | null; config?: Record<string, unknown> | null }} server
 */
export function mcpServerConfig(server) {
  /** @type {Record<string, unknown>} */
  const entry = { ...(server.config && typeof server.config === "object" ? server.config : {}) };
  if (server.url) entry.url = server.url;
  if (server.command) entry.command = server.command;
  if (Array.isArray(server.args) && server.args.length) entry.args = server.args;
  if (server.env && Object.keys(server.env).length) entry.env = server.env;
  if (!entry.lifecycle) entry.lifecycle = "lazy";
  return entry;
}

/**
 * Write a per-agent Pi dir so skills/MCP are not loaded from the shared host Pi folder.
 * @param {{ id: string; name: string; rolePrompt: string }} agent
 * @param {object[]} mcpServers
 * @param {string} modelsJson
 */
export async function materializeAgentRuntime(agent, mcpServers, modelsJson) {
  const dir = path.join(RUNTIME_DIR, agent.id);
  await mkdir(dir, { recursive: true });
  const role = String(agent.rolePrompt || "").trim();
  const extras = [imagenSystemPrompt()];
  if (agent.id === "website" || agent.slug === "website") extras.push(hostSystemPrompt());
  const extraText = extras.filter(Boolean).join("\n\n");
  const roleText = extraText ? `${role}\n\n${extraText}`.trim() + "\n" : `${role}\n`;
  await writeFile(path.join(dir, "ROLE.md"), roleText, "utf8");
  await writeFile(path.join(dir, "models.json"), modelsJson);
  /** @type {Record<string, unknown>} */
  const mcp = {};
  for (const server of mcpServers) {
    mcp[server.slug] = mcpServerConfig(server);
  }
  await writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: mcp }, null, 2));
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify(
      {
        packages: mcpServers.length ? ["npm:pi-mcp-adapter"] : [],
        enableSkillCommands: true,
      },
      null,
      2,
    ),
  );
  return dir;
}

/**
 * @param {{
 *   agent: { name: string };
 *   skills: { slug?: string; dirPath: string }[];
 *   mcpCount: number;
 *   runtimeDir: string;
 *   provider: string;
 *   model: string;
 *   sessionFile?: string | null;
 * }} opts
 */
export function buildPiArgs(opts) {
  const args = [
    "--append-system-prompt",
    path.join(opts.runtimeDir, "ROLE.md"),
    "--session-dir",
    STORAGE,
    "--name",
    opts.agent.name,
    "--provider",
    opts.provider,
    "--model",
    opts.model,
    "--no-skills",
    "--no-extensions",
    "--no-prompt-templates",
  ];
  const skills = [...(opts.skills || [])];
  if (imagenConfigured()) skills.push({ dirPath: IMAGEN_SKILL_DIR });
  for (const skill of skills) {
    if (skill.dirPath) args.push("--skill", skill.dirPath);
  }
  if (opts.mcpCount) args.push("--extension", "npm:pi-mcp-adapter");
  if (agentHasSubagents(opts.skills)) args.push("--extension", SUBAGENTS_EXTENSION);
  if (opts.sessionFile) args.push("--session", opts.sessionFile);
  return args;
}
