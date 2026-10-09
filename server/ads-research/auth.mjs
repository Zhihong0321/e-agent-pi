import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const ADS_RESEARCH_AGENT_ID = "ads-research";
export const ADS_RESEARCH_TOKEN = randomBytes(32).toString("hex");

// One token per company: the MCP helper started for a run carries its company's token, so the host
// knows which company a call is for without trusting the helper's claim.
const tokenForTenant = (tenantId) => createHmac("sha256", ADS_RESEARCH_TOKEN).update(String(tenantId)).digest("hex");

/** The company a bearer token was issued for, or null when the claim and token do not match. */
export function adsResearchTenantFrom(req, claimedTenant) {
  const tenant = typeof claimedTenant === "string" ? claimedTenant.trim() : "";
  if (!tenant) return null;
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(tokenForTenant(tenant));
  return a.length === b.length && timingSafeEqual(a, b) ? tenant : null;
}

export function adsResearchEnv(agent, from = process.env, tenantId = "") {
  const id = typeof agent === "string" ? agent : agent?.id || agent?.slug;
  if (id !== ADS_RESEARCH_AGENT_ID || !tenantId) return {};
  return {
    ADS_RESEARCH_URL: `http://127.0.0.1:${from.PORT || process.env.PORT || "8080"}`,
    ADS_RESEARCH_TENANT: tenantId,
    ADS_RESEARCH_TOKEN: tokenForTenant(tenantId),
  };
}
