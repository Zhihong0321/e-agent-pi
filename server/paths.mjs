import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.join(__dirname, "..");
export const DATA_DIR =
  process.env.RAILWAY_VOLUME_MOUNT_PATH?.trim() ||
  process.env.DATA_DIR?.trim() ||
  "/storage";
export const WORKSPACE = path.join(DATA_DIR, "workspace");
export const STORAGE = path.join(DATA_DIR, "storage");
export const PI_AGENT_DIR = path.join(DATA_DIR, "pi");
export const LIBRARY_DIR = path.join(DATA_DIR, "library");
export const SKILLS_DIR = path.join(LIBRARY_DIR, "skills");
export const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
export const ROLE_FILE = path.join(ROOT, "agent", "ROLE.md");
export const SETTINGS_ROLE_FILE = path.join(ROOT, "agent", "roles", "settings.md");
export const BUNDLED_SKILLS = path.join(ROOT, "agent", "skills");
export const DEFAULT_AGENT_ID = "website";
export const OPS_AGENT_ID = "ops";
export const SETTINGS_AGENT_ID = OPS_AGENT_ID;
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
export const IMAGEN_SKILL_DIR = path.join(ROOT, "agent", "imagen");
export const SUBAGENTS_EXTENSION = path.join(ROOT, "agent", "extensions", "subagents.ts");
export const SPAWN_SUBAGENTS_SLUG = "spawn-subagents";
