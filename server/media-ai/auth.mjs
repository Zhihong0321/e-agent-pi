import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MEDIA_AI_AGENT_ID = "media-ai";
export const MEDIA_AI_TOKEN = randomBytes(32).toString("hex");

export function mediaAiAuthorized(req) {
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const left = Buffer.from(got);
  const right = Buffer.from(MEDIA_AI_TOKEN);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function mediaAiEnv(agent, from = process.env) {
  const id = typeof agent === "string" ? agent : agent?.id || agent?.slug || "";
  if (id !== MEDIA_AI_AGENT_ID && id !== "media-ai") return {};
  return {
    MEDIA_AI_URL: `http://127.0.0.1:${from.PORT || process.env.PORT || "8080"}`,
    MEDIA_AI_TOKEN,
  };
}

export function shareTokenHash(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}
