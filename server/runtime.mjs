import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { imagenConfigured, imagenSystemPrompt } from "./imagen.mjs";
import { replyStyleSystemPrompt } from "./reply-style.mjs";
import { FILE_SHARING_PROMPT } from "./file-sharing.mjs";
import { hostSystemPrompt } from "./ee-html.mjs";
import { proposalSystemPrompt } from "./github.mjs";
import { loadContextPack } from "./context-pack.mjs";
import { getAgentSop } from "./sops.mjs";
import { interpolatePiModels } from "./models.mjs";
import {
  DEFAULT_TOOL_PROFILE,
  TOOL_PROFILES,
  normalizeThinkingLevel,
  normalizeToolProfile,
  skillMarkdownNeedsBash,
} from "./agent-profiles.mjs";
import {
  IMAGEN_SKILL_DIR,
  MCP_ADAPTER_EXTENSION,
  RUNTIME_DIR,
  ROOT,
  SPAWN_SUBAGENTS_SLUG,
  STORAGE,
  SUBAGENTS_EXTENSION,
  WHATSAPP_AGENT_ID,
  WHATSAPP_CONTACTS_FILE,
  WHATSAPP_MEMORY_FILE,
  isProposalAgent,
} from "./paths.mjs";

function isWhatsappAgent(agent) {
  return agent?.id === WHATSAPP_AGENT_ID || agent?.slug === "whatsapp-assistant";
}

async function readOptionalFile(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

/**
 * memory.md and contacts.md: owner instructions and per-contact notes the
 * `remember`/`save_contact` MCP tools (and the Settings tab) write to disk;
 * folded into every turn's role text so the agent always has them without
 * needing to call a tool first. Not part of contextPackFingerprint, same as
 * the other per-agent extras below — no process restart needed to pick them up.
 */
async function whatsappNotesSystemPrompt() {
  const [memory, contacts] = await Promise.all([
    readOptionalFile(WHATSAPP_MEMORY_FILE),
    readOptionalFile(WHATSAPP_CONTACTS_FILE),
  ]);
  const parts = [];
  if (memory) parts.push(`## Remembered instructions\n\n${memory}`);
  if (contacts) parts.push(`## Contact notes\n\n${contacts}`);
  return parts.join("\n\n");
}

/**
 * @param {{ slug?: string; dirPath?: string }[] | undefined} skills
 */
export function agentHasSubagents(skills) {
  return (skills || []).some(
    (skill) => skill.slug === SPAWN_SUBAGENTS_SLUG || (skill.dirPath && skill.dirPath.replace(/\\/g, "/").endsWith(`/${SPAWN_SUBAGENTS_SLUG}`)),
  );
}

/**
 * A skill whose instructions shell out (host CLI wrappers or raw curl) needs `bash`
 * even under the `assistant` tool profile.
 * @param {{ dirPath?: string }[] | undefined} skills
 */
export async function skillsNeedBash(skills) {
  for (const skill of skills || []) {
    if (!skill.dirPath) continue;
    const markdown = await readFile(path.join(skill.dirPath, "SKILL.md"), "utf8").catch(() => "");
    if (skillMarkdownNeedsBash(markdown)) return true;
  }
  return false;
}

/**
 * Resolves an agent's stored tool_profile to the profile actually safe to launch with:
 * `assistant` (no built-in tools) falls back to `ops` (read+bash, no edit/write) when an
 * attached skill needs to shell out, so the agent doesn't lose a tool a skill promises.
 * @param {{ toolProfile?: string | null; slug?: string; id?: string }} agent
 * @param {{ dirPath?: string }[] | undefined} skills
 */
export async function resolveToolProfile(agent, skills) {
  if (agent?.id === "company-deep-research" || agent?.slug === "company-deep-research") return { profile: "assistant", warning: null };
  const requested = normalizeToolProfile(agent?.toolProfile ?? DEFAULT_TOOL_PROFILE);
  if (requested !== "assistant" || !(await skillsNeedBash(skills))) {
    return { profile: requested, warning: null };
  }
  return {
    profile: "ops",
    warning: `agent ${agent?.slug || agent?.id} requested tool_profile "assistant" but an attached skill needs bash; using "ops" instead`,
  };
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
 * Assembles ROLE.md's text: role prompt, then reply-style/imagen/host/proposal extras, then
 * the context pack (which itself ends with the one model-varying line, the vision note) —
 * the long agent- and skill-stable prefix comes first so provider prompt caches hit on it
 * across model switches and journal-only STATE.md updates.
 * @param {{ id: string; rolePrompt: string; slug?: string }} agent
 * @param {{ modelId?: string | null }} [opts]
 */
export async function buildRoleText(agent, { modelId } = {}) {
  const role = String(agent.rolePrompt || "").trim();
  const research = agent.id === "company-deep-research" || agent.slug === "company-deep-research";
  const extras = research ? [replyStyleSystemPrompt()] : [replyStyleSystemPrompt(), FILE_SHARING_PROMPT, imagenSystemPrompt()];
  if (agent.id === "website" || agent.slug === "website") extras.push(hostSystemPrompt());
  if (isProposalAgent(agent)) extras.push(proposalSystemPrompt(agent));
  if (isWhatsappAgent(agent)) extras.push(await whatsappNotesSystemPrompt());
  const sop = await getAgentSop(agent.id).catch(() => null);
  if (sop?.content) {
    extras.push(`## Mandatory agent SOP\n\nRead and follow this SOP for every task. It is the agent-specific operating procedure.\n\n${sop.content}`);
  }
  const pack = await loadContextPack(agent, { modelId });
  const extraText = [...extras.filter(Boolean), pack].filter(Boolean).join("\n\n");
  return extraText ? `${role}\n\n${extraText}`.trim() + "\n" : `${role}\n`;
}

/**
 * Write a per-agent Pi dir so skills/MCP are not loaded from the shared host Pi folder.
 * @param {{ id: string; name: string; rolePrompt: string; slug?: string }} agent
 * @param {object[]} mcpServers
 * @param {string} modelsJson
 * @param {{ modelId?: string | null; runtimeKey?: string | null }} [opts]
 */
export async function materializeAgentRuntime(agent, mcpServers, modelsJson, { modelId, runtimeKey } = {}) {
  if (agent.id === "company-deep-research" || agent.slug === "company-deep-research") {
    mcpServers = mcpServers.filter(server => server.slug === "company-research");
  }
  if (agent.id === "ads-research" || agent.slug === "ads-research") {
    mcpServers = mcpServers.filter(server => server.slug === "ads-research");
  }
  const dir = path.join(RUNTIME_DIR, runtimeKey || agent.id);
  await mkdir(dir, { recursive: true });
  const roleText = await buildRoleText(agent, { modelId });
  await writeFile(path.join(dir, "ROLE.md"), roleText, "utf8");
  const sop = await getAgentSop(agent.id).catch(() => null);
  await writeFile(
    path.join(dir, "SOP.md"),
    `${sop?.content?.trim() || "# Agent SOP\n\nNo custom SOP has been set for this agent yet."}\n`,
    "utf8",
  );
  await writeFile(path.join(dir, "models.json"), interpolatePiModels(modelsJson));
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
        packages: [],
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
 *   toolProfile?: string | null;
 *   thinkingLevel?: string | null;
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
  const research = opts.agent.id === "company-deep-research" || opts.agent.slug === "company-deep-research";
  const adsResearch = opts.agent.id === "ads-research" || opts.agent.slug === "ads-research";
  const restricted = research || adsResearch;
  const profile = restricted ? TOOL_PROFILES.assistant : TOOL_PROFILES[normalizeToolProfile(opts.toolProfile)] || TOOL_PROFILES[DEFAULT_TOOL_PROFILE];
  if (profile.systemPrompt) args.push("--system-prompt", profile.systemPrompt);
  if (profile.tools) args.push("--tools", profile.tools.join(","));
  if (profile.noBuiltinTools) args.push("--no-builtin-tools");
  const thinkingLevel = normalizeThinkingLevel(opts.thinkingLevel);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  const skills = [...(opts.skills || [])];
  if (restricted) skills.length = 0;
  if (!restricted && imagenConfigured()) skills.push({ dirPath: IMAGEN_SKILL_DIR });
  for (const skill of skills) {
    if (skill.dirPath) args.push("--skill", skill.dirPath);
  }
  if (opts.mcpCount) args.push("--extension", MCP_ADAPTER_EXTENSION);
  if (!restricted) args.push("--extension", path.join(ROOT, "agent", "extensions", "share-file.ts"));
  if (!restricted && agentHasSubagents(opts.skills)) args.push("--extension", SUBAGENTS_EXTENSION);
  if (opts.sessionFile) args.push("--session", opts.sessionFile);
  return args;
}
