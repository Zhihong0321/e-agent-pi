import os from "node:os";
import path from "node:path";
import {
  CATALOG_CLI,
  IMAGEN_CLI,
  PACKAGE_SHEET_CLI,
  PDF_CLI,
  PI_PACKAGE_DIR,
  ROOT,
  SITES_CLI,
  isPackageAgent,
} from "./paths.mjs";
import { secret } from "./secrets.mjs";

const ALLOW_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TZ",
  "TERM",
  "NODE_PATH",
  "SCRAPLING_BIN",
]);

const ALLOW_PREFIX = ["PI_", "CLOUD_PI_"];

/**
 * Environment for an agent child process. Host secrets (DATABASE_URL, model
 * keys, Railway, GitHub, ee-html) stay on the host. Pi reads model keys from
 * the per-agent models.json, not from env.
 *
 * @param {{ id?: string; slug?: string } | string | null | undefined} agent
 * @param {Record<string, string | undefined>} [extra]
 * @param {NodeJS.ProcessEnv} [from]
 */
export function agentEnv(agent, extra = {}, from = process.env) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(from)) {
    if (value == null || value === "") continue;
    if (ALLOW_EXACT.has(key) || ALLOW_PREFIX.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }

  env.PATH = ["/opt/scrapling/bin", from.PATH || process.env.PATH || ""]
    .filter(Boolean)
    .join(path.delimiter);
  env.HOME = from.HOME || os.homedir();
  env.USER = from.USER || from.USERNAME || "root";
  env.LANG = from.LANG || "C.UTF-8";
  env.TMPDIR = from.TMPDIR || from.TEMP || os.tmpdir();
  env.NODE_PATH = from.NODE_PATH || path.join(ROOT, "node_modules");
  env.SCRAPLING_BIN = from.SCRAPLING_BIN || process.env.SCRAPLING_BIN || "/opt/scrapling/bin/scrapling";
  env.CLOUD_PI_ROOT = ROOT;
  env.CLOUD_PI_CATALOG = CATALOG_CLI;
  env.CLOUD_PI_IMAGEN = IMAGEN_CLI;
  env.CLOUD_PI_SITES = SITES_CLI;
  env.CLOUD_PI_PDF = PDF_CLI;
  env.PI_PACKAGE_DIR = from.PI_PACKAGE_DIR || PI_PACKAGE_DIR;

  if (isPackageAgent(agent)) {
    const token = secret("pg_proxy_token");
    if (token) env.PG_PROXY_TOKEN = token;
    env.CLOUD_PI_PACKAGE_SHEET = PACKAGE_SHEET_CLI;
  }

  for (const [key, value] of Object.entries(extra)) {
    if (value == null || value === "") continue;
    env[key] = value;
  }
  return env;
}
