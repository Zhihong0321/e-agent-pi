import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_DIR, STORAGE } from "./paths.mjs";

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
  await writeFile(path.join(dir, "ROLE.md"), agent.rolePrompt || "", "utf8");
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
 *   skills: { dirPath: string }[];
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
  for (const skill of opts.skills) {
    if (skill.dirPath) args.push("--skill", skill.dirPath);
  }
  if (opts.mcpCount) args.push("--extension", "npm:pi-mcp-adapter");
  if (opts.sessionFile) args.push("--session", opts.sessionFile);
  return args;
}
