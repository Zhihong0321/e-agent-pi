import { secret } from "./secrets.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, "..", "agent", "model-catalog.json");

const DEFAULT_BASE_URL = {
  CAVOTI: "https://cavoti.com/v1",
  KIMI: "https://api2.cmkey.cn/v1",
};

/** @typedef {{ id: string; label: string; shortLabel: string; provider: string; model: string; vaultCredential?: string; envPrefix: string; vision?: boolean; available?: boolean }} CatalogEntry */

/** @type {CatalogEntry[] | null} */
let catalogCache = null;

export async function loadCatalog() {
  if (!catalogCache) {
    catalogCache = JSON.parse(await readFile(CATALOG_FILE, "utf8"));
  }
  return catalogCache;
}

/**
 * @returns {Promise<{ models: CatalogEntry[]; env: Record<string, string>; defaultModelId: string | null }>}
 */
export async function resolveModelCredentials() {
  const catalog = await loadCatalog();
  /** @type {Record<string, string>} */
  const env = {};
  /** @type {CatalogEntry[]} */
  const models = [];

  for (const entry of catalog) {
    const apiKey = secret(`${entry.envPrefix.toLowerCase()}_api_key`);
    const baseUrl =
      secret(`${entry.envPrefix.toLowerCase()}_base_url`) ||
      DEFAULT_BASE_URL[entry.envPrefix] ||
      "";

    if (apiKey) {
      env[`${entry.envPrefix}_API_KEY`] = apiKey;
      if (baseUrl) env[`${entry.envPrefix}_BASE_URL`] = baseUrl;
      models.push({ ...entry, available: true });
    } else {
      models.push({ ...entry, available: false });
    }
  }

  const defaultModelId = models.find((entry) => entry.available)?.id ?? null;
  return { models, env, defaultModelId };
}

/**
 * @param {CatalogEntry[]} models
 * @param {string} modelId
 */
export function findModel(models, modelId) {
  return models.find((entry) => entry.id === modelId);
}

/**
 * Write real API keys into a models.json document so Pi does not need them in env.
 * @param {string} modelsJson
 */
export function interpolatePiModels(modelsJson) {
  const data = JSON.parse(modelsJson);
  const cavoti = secret("cavoti_api_key");
  const kimi = secret("kimi_api_key");
  if (cavoti && data.providers?.cavoti) data.providers.cavoti.apiKey = cavoti;
  if (kimi && data.providers?.["kimi-k3"]) data.providers["kimi-k3"].apiKey = kimi;
  return JSON.stringify(data, null, 2);
}
