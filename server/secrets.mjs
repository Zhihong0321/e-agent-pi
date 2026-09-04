import { dbReady, getSetting, setSetting } from "./db.mjs";

const KEYS = [
  "cavoti_api_key",
  "cavoti_base_url",
  "kimi_api_key",
  "kimi_base_url",
  "glm53_api_key",
  "glm53_base_url",
  "imagen_api_key",
  "imagen_base_url",
  "imagen_model",
  "imagen_api",
  "github_token",
  "github_repo",
  "github_branch",
  "pg_proxy_token",
  "ee_html_api_key",
  "ee_html_base_url",
  "ee_html_slug",
  "ee_html_name",
  "ee_html_url",
  "ee_html_bundle_hash",
  "ee_html_last_error",
  "settings_password",
];

export const DEFAULT_PASSWORD = "eternalgy2026";

/** @type {Record<string, string>} */
let cache = {};

export function secret(key) {
  return String(cache[key] ?? "").trim();
}

export async function loadSecrets() {
  cache = {};
  if (!dbReady()) return cache;
  for (const key of KEYS) {
    cache[key] = (await getSetting(key)) ?? "";
  }
  if (!secret("settings_password")) {
    await setSetting("settings_password", DEFAULT_PASSWORD);
    cache.settings_password = DEFAULT_PASSWORD;
  }
  return cache;
}

/**
 * @param {Record<string, string | undefined>} patch
 */
export async function saveSecrets(patch) {
  const secretFields = new Set([
    "cavoti_api_key",
    "kimi_api_key",
    "glm53_api_key",
    "imagen_api_key",
    "github_token",
    "pg_proxy_token",
    "ee_html_api_key",
    "settings_password",
  ]);
  for (const key of KEYS) {
    if (!(key in patch) || patch[key] === undefined) continue;
    const trimmed = String(patch[key] ?? "").trim();
    if (secretFields.has(key) && !trimmed) continue;
    await setSetting(key, trimmed);
  }
  await loadSecrets();
}

export function publicSettings() {
  return {
    cavotiApiKeySet: Boolean(secret("cavoti_api_key")),
    cavotiBaseUrl: secret("cavoti_base_url") || "https://cavoti.com/v1",
    kimiApiKeySet: Boolean(secret("kimi_api_key")),
    kimiBaseUrl: secret("kimi_base_url") || "https://api2.cmkey.cn/v1",
    glm53ApiKeySet: Boolean(secret("glm53_api_key")),
    glm53BaseUrl: secret("glm53_base_url") || "https://vectide.cn/v1",
    imagenApiKeySet: Boolean(secret("imagen_api_key")),
    imagenBaseUrl: secret("imagen_base_url") || "https://generativelanguage.googleapis.com/v1beta",
    imagenModel: secret("imagen_model") || "gemini-3.1-flash-image",
    imagenApi: secret("imagen_api") || "auto",
    githubTokenSet: Boolean(secret("github_token")),
    githubRepo: secret("github_repo"),
    githubBranch: secret("github_branch") || "main",
    pgProxyTokenSet: Boolean(secret("pg_proxy_token")),
    eeHtmlApiKeySet: Boolean(secret("ee_html_api_key") || process.env.EE_HTML_API_KEY),
    eeHtmlBaseUrl: secret("ee_html_base_url") || process.env.EE_HTML_BASE_URL || "https://ee-html.up.railway.app",
    eeHtmlSlug: secret("ee_html_slug") || "e-agent-site",
    eeHtmlName: secret("ee_html_name") || "Website Dev Agent",
    eeHtmlUrl: secret("ee_html_url") || "",
    eeHtmlLastError: secret("ee_html_last_error") || "",
  };
}

export function secretFlags() {
  return {
    cavotiApiKey: Boolean(secret("cavoti_api_key")),
    kimiApiKey: Boolean(secret("kimi_api_key")),
    glm53ApiKey: Boolean(secret("glm53_api_key")),
    imagenApiKey: Boolean(secret("imagen_api_key")),
    githubToken: Boolean(secret("github_token")),
    githubRepo: Boolean(secret("github_repo")),
    pgProxyToken: Boolean(secret("pg_proxy_token")),
    eeHtmlApiKey: Boolean(secret("ee_html_api_key") || process.env.EE_HTML_API_KEY),
  };
}

/**
 * Persist a settings row and keep the in-memory cache in sync.
 * @param {string} key
 * @param {string} value
 */
export async function rememberSecret(key, value) {
  const text = String(value ?? "");
  if (dbReady()) await setSetting(key, text);
  cache[key] = text;
}
