import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.join(__dirname, "..");
export const DATA_DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ||
  process.env.DATA_DIR?.trim() ||
  "/storage";
export const WORKSPACE = path.join(DATA_DIR, "workspace");
export const WORKSPACES_DIR = path.join(DATA_DIR, "workspaces");
export const STORAGE = path.join(DATA_DIR, "storage");
export const PI_AGENT_DIR = path.join(DATA_DIR, "pi");
export const LIBRARY_DIR = path.join(DATA_DIR, "library");
export const SKILLS_DIR = path.join(LIBRARY_DIR, "skills");
export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
export const ROLE_FILE = path.join(ROOT, "agent", "ROLE.md");
export const SETTINGS_ROLE_FILE = path.join(ROOT, "agent", "roles", "settings.md");
export const PROPOSAL_ROLE_FILE = path.join(ROOT, "agent", "roles", "proposal.md");
export const NEWPAGES_ROLE_FILE = path.join(ROOT, "agent", "roles", "newpages.md");
export const PACKAGE_ROLE_FILE = path.join(ROOT, "agent", "roles", "package.md");
export const AFA_ROLE_FILE = path.join(ROOT, "agent", "roles", "afa-rate.md");
export const SALES_ROLE_FILE = path.join(ROOT, "agent", "roles", "sales.md");
export const BUNDLED_SKILLS = path.join(ROOT, "agent", "skills");
export const DEFAULT_AGENT_ID = "website";
export const OPS_AGENT_ID = "ops";
export const SETTINGS_AGENT_ID = OPS_AGENT_ID;
export const PROPOSAL_AGENT_ID = "proposal";
export const NEWPAGES_AGENT_ID = "newpages";
export const PACKAGE_AGENT_ID = "package";
export const AFA_AGENT_ID = "afa-rate";
export const SALES_AGENT_ID = "sales";
export const DEFAULT_PROPOSAL_REPO = "Zhihong0321/ee-proposal";
export const DEFAULT_PROPOSAL_LIVE_URL = "https://ee-proposal-production.up.railway.app/shell.html#proposal";
export const DEFAULT_NEWPAGES_LIVE_URL = "https://merchant.newpages.com.my";

export function isWebsiteAgent(agent) {
  const id = typeof agent === "string" ? agent : agent?.id || "";
  const slug = typeof agent === "string" ? agent : agent?.slug || "";
  return id === DEFAULT_AGENT_ID || slug === "website";
}

export function isSettingsAgent(agent) {
  const id = typeof agent === "string" ? agent : agent?.id || "";
  const slug = typeof agent === "string" ? agent : agent?.slug || "";
  return id === OPS_AGENT_ID || slug === "ops" || slug === "settings";
}

/**
 * Pi cwd for an agent. Website Dev Agent owns `/storage/workspace`.
 * Everyone else gets `/storage/workspaces/<slug>` (ops → settings).
 * @param {{ id?: string; slug?: string } | string | null | undefined} agent
 */
export function agentWorkspace(agent) {
  const id = typeof agent === "string" ? agent : agent?.id || agent?.slug || "";
  const slug = typeof agent === "string" ? agent : agent?.slug || "";
  if (id === PROPOSAL_AGENT_ID || slug === "proposal") {
    return path.join(WORKSPACES_DIR, "proposal");
  }
  if (id === NEWPAGES_AGENT_ID || slug === "newpages" || slug === "newpages-site-manager") {
    return path.join(WORKSPACES_DIR, "newpages");
  }
  if (id === PACKAGE_AGENT_ID || slug === "package" || slug === "package-updater") {
    return path.join(WORKSPACES_DIR, "package");
  }
  if (id === AFA_AGENT_ID || slug === "afa-rate") {
    return path.join(WORKSPACES_DIR, "afa-rate");
  }
  if (id === SALES_AGENT_ID || slug === "sales") {
    return path.join(WORKSPACES_DIR, "sales");
  }
  if (isWebsiteAgent(agent)) return WORKSPACE;
  const folder = isSettingsAgent(agent) ? "settings" : slug || id || "scratch";
  return path.join(WORKSPACES_DIR, folder);
}

export function isProposalAgent(agent) {
  const id = typeof agent === "string" ? agent : agent?.id || "";
  const slug = typeof agent === "string" ? agent : agent?.slug || "";
  return id === PROPOSAL_AGENT_ID || slug === "proposal";
}

export function isNewpagesAgent(agent) {
  const id = typeof agent === "string" ? agent : agent?.id || "";
  const slug = typeof agent === "string" ? agent : agent?.slug || "";
  return id === NEWPAGES_AGENT_ID || slug === "newpages" || slug === "newpages-site-manager";
}

export function isPackageAgent(agent) {
  const id = typeof agent === "string" ? agent : agent?.id || "";
  const slug = typeof agent === "string" ? agent : agent?.slug || "";
  return id === PACKAGE_AGENT_ID || slug === "package" || slug === "package-updater";
}

export function isAfaAgent(agent) {
  const id = typeof agent === "string" ? agent : agent?.id || "";
  const slug = typeof agent === "string" ? agent : agent?.slug || "";
  return id === AFA_AGENT_ID || slug === "afa-rate";
}

export function isSalesAgent(agent) {
  const id = typeof agent === "string" ? agent : agent?.id || "";
  const slug = typeof agent === "string" ? agent : agent?.slug || "";
  return id === SALES_AGENT_ID || slug === "sales";
}

export const DIST_DIR = path.join(ROOT, "dist");
export const SEED_INDEX = path.join(ROOT, "agent-workspace", "index.html");
export const BUNDLED_MODELS = path.join(ROOT, ".pi", "agent", "models.json");
export const PI_CLI_PATH = path.join(
  ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
export const PI_PACKAGE_DIR = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
export const CATALOG_CLI = path.join(ROOT, "server", "catalog-cli.mjs");
export const IMAGEN_CLI = path.join(ROOT, "server", "imagen-cli.mjs");
export const SITES_CLI = path.join(ROOT, "server", "sites-cli.mjs");
export const PDF_CLI = path.join(ROOT, "server", "pdf-cli.mjs");
export const PACKAGE_SHEET_CLI = path.join(ROOT, "server", "package-sheet-cli.mjs");
export const SALES_MCP_SERVER = path.join(ROOT, "server", "sales-mcp-server.mjs");
export const SALES_MCP_SLUG = "sales-data";
export const IMAGEN_SKILL_DIR = path.join(ROOT, "agent", "imagen");
export const SUBAGENTS_EXTENSION = path.join(ROOT, "agent", "extensions", "subagents.ts");
export const MCP_ADAPTER_EXTENSION = path.join(ROOT, "node_modules", "pi-mcp-adapter");
export const SPAWN_SUBAGENTS_SLUG = "spawn-subagents";
