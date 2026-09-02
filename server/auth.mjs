import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DEFAULT_PASSWORD, secret } from "./secrets.mjs";

export const SESSION_COOKIE = "e_agent_session";

function sha(value) {
  return createHash("sha256").update(value).digest();
}

function password() {
  return secret("settings_password") || DEFAULT_PASSWORD;
}

export function checkPassword(input) {
  const a = sha(String(input ?? ""));
  const b = sha(password());
  return timingSafeEqual(a, b);
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

export function sessionCookie(token, clear = false) {
  const secure = process.env.RAILWAY_PUBLIC_DOMAIN ? "; Secure" : "";
  if (clear) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}
