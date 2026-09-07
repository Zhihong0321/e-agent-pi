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
  TNB_CLI,
  isAfaAgent,
  isGoogleAdsAgent,
  isOmAgent,
  isPackageAgent,
  isSalesAgent,
  isTnbAgent,
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
  env.CLOUD_PI_TNB = TNB_CLI;
  env.PI_PACKAGE_DIR = from.PI_PACKAGE_DIR || PI_PACKAGE_DIR;

  if (isPackageAgent(agent)) {
    const token = secret("pg_proxy_token");
    if (token) env.PG_PROXY_TOKEN = token;
    env.CLOUD_PI_PACKAGE_SHEET = PACKAGE_SHEET_CLI;
  }

  if (isAfaAgent(agent)) {
    const passkey = secret("afa_passkey");
    const baseUrl = secret("afa_base_url");
    if (passkey) env.AFA_PASSKEY = passkey;
    if (baseUrl) env.AFA_BASE_URL = baseUrl;
  }

  if (isTnbAgent(agent)) {
    const email = secret("tnb_email");
    const password = secret("tnb_password");
    if (email) env.TNB_EMAIL = email;
    if (password) env.TNB_PASSWORD = password;
  }

  if (isGoogleAdsAgent(agent)) {
    // The MCP server reads these directly; nothing touches disk or the vault.
    const clientId = secret("google_ads_client_id");
    const clientSecret = secret("google_ads_client_secret");
    const developerToken = secret("google_ads_developer_token");
    const refreshToken = secret("google_ads_refresh_token");
    const customerId = secret("google_ads_customer_id");
    const loginCustomerId = secret("google_ads_login_customer_id");
    if (clientId) env.GOOGLE_ADS_CLIENT_ID = clientId;
    if (clientSecret) env.GOOGLE_ADS_CLIENT_SECRET = clientSecret;
    if (developerToken) env.GOOGLE_ADS_DEVELOPER_TOKEN = developerToken;
    if (refreshToken) env.GOOGLE_ADS_REFRESH_TOKEN = refreshToken;
    if (customerId) env.GOOGLE_ADS_CUSTOMER_ID = customerId;
    if (loginCustomerId) env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = loginCustomerId;
  }

  if (isSalesAgent(agent)) {
    const token = secret("sales_pg_proxy_token");
    if (token) env.SALES_PG_PROXY_TOKEN = token;
    const expiresAt = secret("sales_pg_proxy_expires_at");
    if (expiresAt) env.SALES_PG_PROXY_EXPIRES_AT = expiresAt;

    const stockToken = secret("stock_api_token");
    if (stockToken) env.STOCK_API_TOKEN = stockToken;
    env.STOCK_API_URL = `http://127.0.0.1:${from.PORT || "8080"}`;
  }

  if (isOmAgent(agent)) {
    // The MCP server reads this directly; nothing touches disk or the vault.
    const token = secret("om_api_token");
    if (token) env.OM_API_TOKEN = token;
  }

  for (const [key, value] of Object.entries(extra)) {
    if (value == null || value === "") continue;
    env[key] = value;
  }
  return env;
}
