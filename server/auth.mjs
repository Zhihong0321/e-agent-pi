import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DEFAULT_PASSWORD, secret } from "./secrets.mjs";

export const SESSION_COOKIE = "e_agent_session";

function sha(value) {
  return createHash("sha256").update(value).digest();
}

function password() {
  return secret("settings_password") || DEFAULT_PASSWORD;
}

function sameSecret(got, expected) {
  const a = sha(String(got ?? ""));
  const b = sha(String(expected ?? ""));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function checkPassword(input) {
  return sameSecret(input, password());
}

export function sessionToken() {
  return createHmac("sha256", password()).update("e-agent-settings").digest("hex");
}

export function parseCookies(header) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function hasSession(req) {
  const got = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!got) return false;
  const expect = sessionToken();
  const left = Buffer.from(got);
  const right = Buffer.from(expect);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function apiToken(req) {
  const auth = String(req.headers.authorization || "");
  const match = auth.match(/^Bearer\s+(\S+)/i);
  if (match) return match[1].trim();
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]) return String(header[0]).trim();
  return "";
}

/**
 * Settings cookie, or Bearer / X-Api-Key matching the settings password
 * or CLOUD_PI_MANAGE_KEY / manage_api_key.
 */
export function hasApiAuth(req) {
  if (hasSession(req)) return true;
  const token = apiToken(req);
  if (!token) return false;
  if (checkPassword(token)) return true;
  const manageKey = process.env.CLOUD_PI_MANAGE_KEY?.trim() || secret("manage_api_key");
  return Boolean(manageKey) && sameSecret(token, manageKey);
}

export function sessionCookie(token, clear = false) {
  const secure = process.env.RAILWAY_PUBLIC_DOMAIN ? "; Secure" : "";
  if (clear) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}
