// Runtime policy shared by the web server and CLI.
// Local development keeps the existing Legion fallback; hosted deployments must
// use explicitly configured services and must never depend on a developer path.

export const isHosted = Boolean(
  process.env.HOSTED_MODE === 'true'
  || process.env.RAILWAY_ENVIRONMENT
  || process.env.RAILWAY_PROJECT_ID
  || process.env.NODE_ENV === 'production',
);

export const hasHostedLlm = Boolean(
  process.env.ADS_LLM_BASE_URL
  && process.env.ADS_LLM_MODEL
  && process.env.ADS_LLM_KEY
);

export function hostedStageError(cmd) {
  if (!isHosted) return null;
  if (['run', 'analyze'].includes(cmd) && !hasHostedLlm) {
    return `${cmd} requires ADS_LLM_BASE_URL, ADS_LLM_MODEL, and ADS_LLM_KEY in hosted mode; the local Legion fallback is disabled`;
  }
  return null;
}

export function assertHostedStage(cmd) {
  const message = hostedStageError(cmd);
  if (message) throw new Error(message);
}
