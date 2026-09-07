// EE SAJ Data Fetcher API client — auth, request plumbing, and nothing else.
//
// Read-only against the client fleet: every tool built on this module reads
// plant/device data or triggers a live resync, never writes account/portal
// config. Credentials arrive as an env var from server/agent-env.mjs, the
// same way the other MCP-backed agents get theirs.
//
// The API's own auth is a bare `token` query param (or `x-trigger-token`
// header) on every non-health route — see https://ee-saj-api-production.up.railway.app/docs.
// Error bodies are informative JSON even on 4xx/5xx (`{"detail": {...}}`),
// so callers should read the body before deciding a request failed outright.

const BASE_URL = "https://ee-saj-api-production.up.railway.app";

export function omConfig() {
  return { token: (process.env.OM_API_TOKEN || "").trim() };
}

export function missingOmConfig() {
  return omConfig().token ? [] : ["API token"];
}

/** Turns the API's `{"detail": ...}` error shape into one readable sentence. */
function describeFailure(status, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `SAJ API error ${status}: ${text.slice(0, 300)}`;
  }
  const detail = parsed?.detail;
  if (detail && typeof detail === "object") {
    if (detail.error === "not_found") {
      return detail.detail || "No matching customer or plant.";
    }
    if (detail.error === "ambiguous") {
      const choices = (detail.choices || [])
        .map((c) => `${c.label} (customer_id: ${c.customer_id})`)
        .join("; ");
      return `"${detail.query}" matches more than one customer — pass an exact customerId to pick one. Candidates: ${choices || (detail.candidates || []).join("; ")}`;
    }
    if (typeof detail.detail === "string") return detail.detail;
    if (Array.isArray(detail)) {
      // FastAPI validation error shape: [{loc, msg, type}]
      return detail.map((d) => d.msg).join("; ") || `HTTP ${status}`;
    }
  }
  if (typeof detail === "string") return detail;
  return `SAJ API error ${status}: ${text.slice(0, 300)}`;
}

/**
 * @param {string} pathname e.g. "/device/ABC123/latest"
 * @param {{method?: string, query?: Record<string, string|number|boolean|undefined>}} [opts]
 */
export async function omRequest(pathname, { method = "GET", query = {} } = {}) {
  const missing = missingOmConfig();
  if (missing.length) throw new Error(`O&M (SAJ) API is not configured yet — missing ${missing.join(", ")}. Set it in Settings.`);

  const url = new URL(pathname, BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("token", omConfig().token);

  const res = await fetch(url, { method });
  const text = await res.text();
  if (!res.ok) throw new Error(describeFailure(res.status, text));
  return text ? JSON.parse(text) : {};
}

/**
 * Resolves a client by name or exact id and triggers a live pull from the SAJ
 * portal for it — this is both the lookup and the "refresh now" action, in
 * one ~2-4s call. Throws a readable error on no-match (404) or an ambiguous
 * name shared by multiple customers (409).
 */
export function syncFast({ customer, plant, customerId, plantUid, days } = {}) {
  return omRequest("/sync/fast", {
    method: "POST",
    query: { customer, plant, customer_id: customerId, plant_uid: plantUid, days, debug: true },
  });
}

export function deviceLatest(deviceSn) {
  return omRequest(`/device/${encodeURIComponent(deviceSn)}/latest`);
}

export function deviceInfo(deviceSn) {
  return omRequest(`/device/${encodeURIComponent(deviceSn)}/info`);
}

/** Refreshes + returns daily kWh and a 5-min power series for a plant, up to 31 days back. */
export function fetchPlant(plantUid, { days = 7, force = false } = {}) {
  const capped = Math.min(Math.max(Number(days) || 1, 1), 31);
  const pathname = capped > 30 ? `/fetch/plant/${encodeURIComponent(plantUid)}/last31` : `/fetch/plant/${encodeURIComponent(plantUid)}`;
  return omRequest(pathname, { method: "POST", query: { days: capped, force } });
}

/** Same as fetchPlant, for a single inverter. */
export function fetchDevice(deviceSn, { days = 7, force = false } = {}) {
  const capped = Math.min(Math.max(Number(days) || 1, 1), 31);
  const pathname = capped > 30 ? `/fetch/device/${encodeURIComponent(deviceSn)}/last31` : `/fetch/device/${encodeURIComponent(deviceSn)}`;
  return omRequest(pathname, { method: "POST", query: { days: capped, force } });
}

export async function health() {
  const res = await fetch(new URL("/health", BASE_URL));
  return res.ok;
}
