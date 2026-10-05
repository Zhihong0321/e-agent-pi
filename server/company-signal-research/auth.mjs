import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNAL_RESEARCH_AGENT_ID = 'company-signal-research';
export const SIGNAL_RESEARCH_TOKEN = randomBytes(32).toString('hex');

export function signalResearchAuthorized(req) {
  const got = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(SIGNAL_RESEARCH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signalResearchEnv(agent, from = process.env) {
  const id = typeof agent === 'string' ? agent : agent?.id || agent?.slug;
  return id === SIGNAL_RESEARCH_AGENT_ID
    ? {
        CLOUD_PI_SIGNAL_RESEARCH_URL: `http://127.0.0.1:${from.PORT || process.env.PORT || '8080'}`,
        CLOUD_PI_SIGNAL_RESEARCH_TOKEN: SIGNAL_RESEARCH_TOKEN,
      }
    : {};
}
