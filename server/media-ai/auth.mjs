import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const MEDIA_AI_AGENT_ID = "media-ai";
export const MEDIA_AI_TOKEN = randomBytes(32).toString("hex");

// One token per company: the MCP helper started for a run carries its company's token, so the
// host knows which company a call is for without trusting the helper's claim.
const tokenForTenant = (tenantId) => createHmac("sha256", MEDIA_AI_TOKEN).update(String(tenantId)).digest("hex");

/** The company a bearer token was issued for, or null when the claim and token do not match. */
export function mediaAiTenantFrom(req, claimedTenant) {
  const tenant = typeof claimedTenant === "string" ? claimedTenant.trim() : "";
  if (!tenant) return null;
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const left = Buffer.from(got);
  const right = Buffer.from(tokenForTenant(tenant));
  return left.length === right.length && timingSafeEqual(left, right) ? tenant : null;
}

export function mediaAiEnv(agent, from = process.env, tenantId = "") {
  const id = typeof agent === "string" ? agent : agent?.id || agent?.slug || "";
  if (id !== MEDIA_AI_AGENT_ID && id !== "media-ai") return {};
  if (!tenantId) return {};
  return {
    MEDIA_AI_URL: `http://127.0.0.1:${from.PORT || process.env.PORT || "8080"}`,
    MEDIA_AI_TENANT: tenantId,
    MEDIA_AI_TOKEN: tokenForTenant(tenantId),
  };
}

export function shareTokenHash(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}
