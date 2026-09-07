// Google Ads API client — OAuth refresh, GAQL search, and nothing else.
//
// Read-only by design for Phase 1: there is no mutate path here yet, so no
// tool built on this module can spend money. See google-ads-agent-plan.md.
//
// Credentials arrive as env vars from server/agent-env.mjs, the same way the
// sales agent gets its Postgres proxy token. Nothing is read from disk.
//
// The non-obvious requirement: every call must carry login-customer-id set to
// the manager account. Calling the target account directly returns
// USER_PERMISSION_DENIED, which looks like a permissions problem but is really
// a routing one.

const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v25";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const BASE_URL = `https://googleads.googleapis.com/${API_VERSION}`;
const MAX_PAGES = 20;

/** Strips the dashes Google shows in the UI but rejects in the API. */
export function normalizeCustomerId(value) {
  return String(value || "").replace(/-/g, "").trim();
}

export function adsConfig() {
  return {
    clientId: (process.env.GOOGLE_ADS_CLIENT_ID || "").trim(),
    clientSecret: (process.env.GOOGLE_ADS_CLIENT_SECRET || "").trim(),
    refreshToken: (process.env.GOOGLE_ADS_REFRESH_TOKEN || "").trim(),
    developerToken: (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim(),
    customerId: normalizeCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID),
    loginCustomerId: normalizeCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
  };
}

/** Names what is missing, so the agent can tell the operator which Settings field to fill. */
export function missingConfig() {
  const cfg = adsConfig();
  const missing = [];
  if (!cfg.clientId) missing.push("client ID");
  if (!cfg.clientSecret) missing.push("client secret");
  if (!cfg.refreshToken) missing.push("refresh token");
  if (!cfg.developerToken) missing.push("developer token");
  if (!cfg.customerId) missing.push("customer ID");
  return missing;
}

let cachedToken = { value: "", expiresAt: 0 };

async function accessToken() {
  if (cachedToken.value && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const cfg = adsConfig();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // invalid_grant here almost always means the 7-day Testing-mode expiry, which is
    // worth saying plainly rather than making someone decode an OAuth error code.
    if (body.error === "invalid_grant") {
      throw new Error(
        "The Google Ads refresh token is no longer valid. While the OAuth app is in Testing mode tokens expire after 7 days — re-run scripts/google-ads-oauth.mjs and update Settings.",
      );
    }
    throw new Error(`Google rejected the refresh token (${res.status}): ${body.error_description || body.error || "unknown"}`);
  }

  cachedToken = {
    value: body.access_token,
    // Refresh a minute early so a call never races the expiry.
    expiresAt: Date.now() + Math.max(0, (Number(body.expires_in) || 3600) - 60) * 1000,
  };
  return cachedToken.value;
}

function headers(token, cfg) {
  const out = {
    authorization: `Bearer ${token}`,
    "developer-token": cfg.developerToken,
    "content-type": "application/json",
  };
  if (cfg.loginCustomerId) out["login-customer-id"] = cfg.loginCustomerId;
  return out;
}

/** Turns a GoogleAdsFailure body into one readable sentence. */
function describeFailure(status, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `Google Ads API error ${status}: ${text.slice(0, 300)}`;
  }
  const failure = parsed?.error?.details?.find((d) => Array.isArray(d.errors));
  const first = failure?.errors?.[0];
  const code = first?.errorCode ? Object.values(first.errorCode)[0] : null;
  const base = first?.message || parsed?.error?.message || `HTTP ${status}`;

  // Google names the offending field in location.fieldPathElements. Without it,
  // "The required field was not present" is unactionable.
  const fieldPath = (first?.location?.fieldPathElements || [])
    .map((part) => `${part.fieldName}${part.index != null ? `[${part.index}]` : ""}`)
    .join(" > ");
  const message = fieldPath ? `${base} (field: ${fieldPath})` : base;

  if (code === "USER_PERMISSION_DENIED") {
    return `${message} (this usually means login-customer-id is missing or wrong, not that access is absent)`;
  }
  if (code === "CUSTOMER_NOT_ENABLED") {
    return `${message} — that account is cancelled or still in setup.`;
  }
  if (code === "DEVELOPER_TOKEN_NOT_APPROVED") {
    return `${message} — the developer token only works against test accounts.`;
  }
  return code ? `${code}: ${message}` : message;
}

/**
 * Runs a GAQL query and returns every row, following pagination.
 * Read-only: this module exposes no mutate path.
 */
export async function gaqlSearch(query, { customerId } = {}) {
  const cfg = adsConfig();
  const missing = missingConfig();
  if (missing.length) throw new Error(`Google Ads is not configured yet — missing ${missing.join(", ")}. Set these in Settings.`);

  const target = normalizeCustomerId(customerId) || cfg.customerId;
  const token = await accessToken();
  const rows = [];
  let pageToken;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await fetch(`${BASE_URL}/customers/${target}/googleAds:search`, {
      method: "POST",
      headers: headers(token, cfg),
      body: JSON.stringify(pageToken ? { query, pageToken } : { query }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(describeFailure(res.status, text));

    const body = JSON.parse(text);
    rows.push(...(body.results || []));
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return rows;
}

/**
 * Low-level authenticated request. Exported so server/google-ads-mutate.mjs can
 * reuse the auth and error handling — writes still have to go through that
 * module's validators, which are the only place mutate operations are allowed.
 */
export async function adsRequest(pathSuffix, { method = "GET", body } = {}) {
  const missing = missingConfig();
  if (missing.length) throw new Error(`Google Ads is not configured yet — missing ${missing.join(", ")}. Set these in Settings.`);

  const cfg = adsConfig();
  const token = await accessToken();
  const res = await fetch(`${BASE_URL}/${pathSuffix}`, {
    method,
    headers: headers(token, cfg),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(describeFailure(res.status, text));
  return text ? JSON.parse(text) : {};
}

export function targetCustomerId(customerId) {
  return normalizeCustomerId(customerId) || adsConfig().customerId;
}

export async function listAccessibleCustomers() {
  const cfg = adsConfig();
  const token = await accessToken();
  const res = await fetch(`${BASE_URL}/customers:listAccessibleCustomers`, { headers: headers(token, cfg) });
  const text = await res.text();
  if (!res.ok) throw new Error(describeFailure(res.status, text));
  return (JSON.parse(text).resourceNames || []).map((name) => name.split("/").pop());
}

/** Cost comes back as an integer number of millionths of the account currency. */
export function fromMicros(value) {
  return Number(value || 0) / 1_000_000;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Builds the date predicate for a GAQL WHERE clause. Dates are validated rather
 * than escaped — GAQL has no parameter binding, so a bad value must never reach
 * the query string.
 */
export function dateRange({ from, to, days } = {}) {
  if (from || to) {
    if (!DATE_RE.test(from || "") || !DATE_RE.test(to || "")) {
      throw new Error("from and to must both be ISO dates (YYYY-MM-DD)");
    }
    return { from, to };
  }
  const window = Number(days) || 30;
  if (!Number.isInteger(window) || window < 1 || window > 365) {
    throw new Error("days must be a whole number between 1 and 365");
  }
  // Explicit dates rather than GAQL's LAST_N_DAYS enums, which only exist for a
  // few fixed windows — this way any window works and the report can name it.
  const end = new Date();
  const start = new Date(end.getTime() - (window - 1) * 86_400_000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(start), to: iso(end) };
}

export function dateClause(options = {}) {
  const { from, to } = dateRange(options);
  return `segments.date BETWEEN '${from}' AND '${to}'`;
}

/** Human label for whatever window dateClause just built. */
export function rangeLabel(options = {}) {
  const { from, to } = dateRange(options);
  return `${from} → ${to}`;
}
