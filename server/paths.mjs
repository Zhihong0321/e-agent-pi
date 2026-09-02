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
export const ROLE_FILE = path.join(ROOT, "agent", "ROLE.md");
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
