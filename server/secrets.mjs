import { dbReady, getSetting, setSetting } from "./db.mjs";

const KEYS = [
  "cavoti_api_key",
  "cavoti_base_url",
  "kimi_api_key",
  "kimi_base_url",
  "github_token",
  "github_repo",
  "github_branch",
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
  const secretFields = new Set(["cavoti_api_key", "kimi_api_key", "github_token", "settings_password"]);
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
    githubTokenSet: Boolean(secret("github_token")),
    githubRepo: secret("github_repo"),
    githubBranch: secret("github_branch") || "main",
  };
}

export function secretFlags() {
  return {
    cavotiApiKey: Boolean(secret("cavoti_api_key")),
    kimiApiKey: Boolean(secret("kimi_api_key")),
    githubToken: Boolean(secret("github_token")),
    githubRepo: Boolean(secret("github_repo")),
  };
}
