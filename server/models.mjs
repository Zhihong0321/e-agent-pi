import { secret } from "./secrets.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_FILE = path.join(__dirname, "..", "agent", "model-catalog.json");

const DEFAULT_BASE_URL = {
  CAVOTI: "https://cavoti.com/v1",
  KIMI: "https://api2.cmkey.cn/v1",
  GLM53: "https://vectide.cn/v1",
  OPENCODE_GO: "https://opencode.ai/zen/go/v1",
  HIVE_AI: "https://api.thehive.ai/api/v3",
};

/** Vault stores origin (`https://cavoti.com`); Pi needs the OpenAI `/v1` path. */
export function normalizeCavotiBaseUrl(value) {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (
    !trimmed ||
    trimmed === "https://cavoti.com" ||
    trimmed === "https://api.cavoti.com" ||
    trimmed === "https://api.cavoti.com/v1"
  ) {
    return DEFAULT_BASE_URL.CAVOTI;
  }
  return trimmed;
}

/** @typedef {{ id: string; label: string; shortLabel: string; provider: string; model: string; vaultCredential?: string; envPrefix: string; vision?: boolean; available?: boolean; requiresStream?: boolean }} CatalogEntry */

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
    const rawBase =
      secret(`${entry.envPrefix.toLowerCase()}_base_url`) ||
      DEFAULT_BASE_URL[entry.envPrefix] ||
      "";
    const baseUrl = entry.envPrefix === "CAVOTI" ? normalizeCavotiBaseUrl(rawBase) : rawBase;

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
 * Round-trip a single catalog entry against its real provider endpoint: one
 * minimal chat completion, timed end to end. Used by the settings page to
 * measure which model is actually fastest right now (varies with provider
 * load), not just which one the catalog lists first.
 * @param {CatalogEntry} entry
 * @param {Record<string, string>} env
 * @returns {Promise<{ id: string; ok: boolean; latencyMs: number; error?: string }>}
 */
export async function testModelRoundTrip(entry, env) {
  const apiKey = env[`${entry.envPrefix}_API_KEY`];
  const baseUrl = env[`${entry.envPrefix}_BASE_URL`];
  if (!apiKey || !baseUrl) {
    return { id: entry.id, ok: false, latencyMs: 0, error: "Missing API key" };
  }
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
    if (entry.requiresStream) headers.Accept = "text/event-stream";
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: entry.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 8,
        stream: Boolean(entry.requiresStream),
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { id: entry.id, ok: false, latencyMs, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}` };
    }
    // Streaming models (e.g. Hive AI) return SSE, not a single JSON body.
    if (entry.requiresStream) await res.text().catch(() => null);
    else await res.json().catch(() => null);
    return { id: entry.id, ok: true, latencyMs };
  } catch (error) {
    const latencyMs = Date.now() - started;
    const message = error instanceof Error ? (error.name === "AbortError" ? "Timed out after 20s" : error.message) : String(error);
    return { id: entry.id, ok: false, latencyMs, error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Write real API keys into a models.json document so Pi does not need them in env.
 * @param {string} modelsJson
 */
export function interpolatePiModels(modelsJson) {
  const data = JSON.parse(modelsJson);
  const cavoti = secret("cavoti_api_key");
  const kimi = secret("kimi_api_key");
  const glm53 = secret("glm53_api_key");
  const opencodeGo = secret("opencode_go_api_key");
  const hiveAi = secret("hive_ai_api_key");
  if (cavoti && data.providers?.cavoti) {
    data.providers.cavoti.apiKey = cavoti;
    data.providers.cavoti.baseUrl = normalizeCavotiBaseUrl(data.providers.cavoti.baseUrl);
  }
  if (kimi && data.providers?.["kimi-k3"]) data.providers["kimi-k3"].apiKey = kimi;
  if (glm53 && data.providers?.glm53) data.providers.glm53.apiKey = glm53;
  if (opencodeGo && data.providers?.["opencode-go"]) data.providers["opencode-go"].apiKey = opencodeGo;
  if (hiveAi && data.providers?.["hive-ai"]) data.providers["hive-ai"].apiKey = hiveAi;
  return JSON.stringify(data, null, 2);
}
