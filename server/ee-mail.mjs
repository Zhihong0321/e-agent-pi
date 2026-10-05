import { randomBytes, timingSafeEqual } from "node:crypto";
import { secret } from "./secrets.mjs";
import { EE_MAIL_AGENT_IDS } from "./paths.mjs";

export const EE_MAIL_AGENT_ID = "di-documents";
export const EE_MAIL_DEFAULT_BASE_URL = "https://ee-mail-production.up.railway.app/api";
export const EE_MAIL_DISPATCH_TOKEN = randomBytes(32).toString("hex");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_SUBJECT = 200;
const MAX_BODY = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;

export function eeMailBaseUrl() {
  return secret("ee_mail_base_url") || process.env.EE_MAIL_BASE_URL || EE_MAIL_DEFAULT_BASE_URL;
}

function sendUrl(baseUrl = eeMailBaseUrl()) {
  const url = new URL(String(baseUrl));
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api$/, "") + "/send";
  url.search = "";
  return url;
}

function emailList(value, field = "to") {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || list.length > 20 || list.some((item) => typeof item !== "string" || !EMAIL.test(item.trim()))) {
    throw new Error(`${field} must contain one to twenty valid email addresses`);
  }
  return list.map((item) => item.trim());
}

export function validateEmailRequest(input = {}) {
  const to = emailList(input.to);
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject || subject.length > MAX_SUBJECT) throw new Error(`subject must be between 1 and ${MAX_SUBJECT} characters`);
  const text = typeof input.text === "string" ? input.text : "";
  const html = typeof input.html === "string" ? input.html : "";
  if ((text && html) || (!text && !html)) throw new Error("Provide exactly one non-empty body: text or html");
  if (text.length > MAX_BODY || html.length > MAX_BODY) throw new Error(`email body must be at most ${MAX_BODY} characters`);
  return { to, subject, ...(text ? { text } : { html }) };
}

function providerSummary(body) {
  if (!body || typeof body !== "object") return undefined;
  const result = {};
  for (const key of ["id", "messageId", "message_id", "status", "accepted", "success"]) {
    if (body[key] !== undefined && (typeof body[key] === "string" || typeof body[key] === "number" || typeof body[key] === "boolean")) {
      result[key] = body[key];
    }
  }
  return Object.keys(result).length ? result : undefined;
}

export async function sendEmail(input, { fetchImpl = fetch, baseUrl = eeMailBaseUrl(), apiKey = secret("ee_mail_api_key") || process.env.EE_MAIL_API_KEY } = {}) {
  const payload = validateEmailRequest(input);
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response;
  try {
    response = await fetchImpl(sendUrl(baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") throw new Error("EE-Mail timed out while sending the email");
    throw new Error(`EE-Mail request failed: ${error?.message || String(error)}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object" && typeof body.error === "string" ? `: ${body.error.slice(0, 180)}` : "";
    throw new Error(`EE-Mail rejected the email (HTTP ${response.status})${detail}`);
  }
  return { sent: true, to: payload.to, subject: payload.subject, provider: providerSummary(body) };
}

function authorized(req, agent) {
  if (!EE_MAIL_AGENT_IDS.includes(agent)) return false;
  const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!supplied) return false;
  const expected = Buffer.from(EE_MAIL_DISPATCH_TOKEN);
  const given = Buffer.from(supplied);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export async function handleEmailRequest(req, body) {
  if (!authorized(req, body?.agent)) return { status: 401, body: { ok: false, error: "Unauthorized" } };
  try {
    const result = await sendEmail(body);
    return { status: 200, body: { ok: true, result } };
  } catch (error) {
    return { status: 400, body: { ok: false, error: error?.message || String(error) } };
  }
}
