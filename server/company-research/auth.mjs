import { randomBytes, timingSafeEqual } from 'node:crypto';
export const RESEARCH_AGENT_ID = 'company-deep-research';
export const RESEARCH_TOKEN = randomBytes(32).toString('hex');
export function researchAuthorized(req) {
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got), b = Buffer.from(RESEARCH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function researchEnv(agent, from = process.env) {
  const id = typeof agent === 'string' ? agent : agent?.id || agent?.slug;
  return id === RESEARCH_AGENT_ID ? { CLOUD_PI_RESEARCH_URL: `http://127.0.0.1:${from.PORT || process.env.PORT || '8080'}`, CLOUD_PI_RESEARCH_TOKEN: RESEARCH_TOKEN } : {};
}
