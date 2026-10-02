import { randomBytes, timingSafeEqual } from "node:crypto";

export const ADS_RESEARCH_AGENT_ID = "ads-research";
export const ADS_RESEARCH_TOKEN = randomBytes(32).toString("hex");

export function adsResearchAuthorized(req) {
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(ADS_RESEARCH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function adsResearchEnv(agent, from = process.env) {
  const id = typeof agent === "string" ? agent : agent?.id || agent?.slug;
  return id === ADS_RESEARCH_AGENT_ID
    ? {
        ADS_RESEARCH_URL: `http://127.0.0.1:${from.PORT || process.env.PORT || "8080"}`,
        ADS_RESEARCH_TOKEN,
      }
    : {};
}
