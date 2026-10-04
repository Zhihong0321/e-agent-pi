// Guarded live smoke for the native execution path. This is intentionally
// separate from deterministic CI: it needs DATABASE_URL, a configured Pi model
// and an isolated test session. It is read-only (count_user_accounts/list_people)
// and never sends real external messages.
//
// Run: EXECUTION_LIVE_SMOKE=1 node server/execution/manual-execution-eval.mjs
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectDb, closeDb, getPool, createSession } from '../db.mjs';
import { ensureDocumentIntelligence } from '../../document_inteligence/host.mjs';
import * as catalog from '../catalog.mjs';
import { manifestForAgent } from './profiles.mjs';
import { initExecution, acceptChatRun, waitForChatRun, resetForTests } from './runner.mjs';
import { piWorkerFactory, setModelsJsonProvider } from './pi-adapter.mjs';
import { BUNDLED_MODELS } from '../paths.mjs';
import { handleExecutionToolRoute } from './routes.mjs';

if (process.env.EXECUTION_LIVE_SMOKE !== '1') {
  console.log(JSON.stringify({ skipped: true, reason: 'Set EXECUTION_LIVE_SMOKE=1 to run the authorized live smoke.' }));
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the live smoke');

let server;
try {
  await connectDb();
  const di = await ensureDocumentIntelligence({ pool: getPool(), catalog, logEvent: () => {} });
  const agent = await catalog.getAgent('orchestrator');
  if (!agent) throw new Error('Orchestrator profile is not configured');
  const session = await createSession({ title: 'Execution live smoke', agentId: agent.id, userId: null });
  const modelId = agent.modelId || process.env.EXECUTION_LIVE_MODEL || null;
  setModelsJsonProvider(async () => readFile(BUNDLED_MODELS, 'utf8'));

  server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/internal/execution/tool') {
      return handleExecutionToolRoute(req, res, {
        readBody: (request) => new Promise((resolve, reject) => {
          const chunks = [];
          request.on('data', (chunk) => chunks.push(chunk));
          request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          request.on('error', reject);
        }),
        json: (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); },
      });
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // The production adapter uses PORT for its bridge URL; this smoke is bounded
  // and reports configuration limitations rather than changing live server state.
  initExecution({ maxConcurrent: 1, workerFactory: piWorkerFactory, services: {
    pool: getPool(),
    logEvent: () => {},
    userLookup: async () => null,
  } });
  const profile = manifestForAgent(agent);
  const accepted = await acceptChatRun({
    session, profile, user: null,
    prompt: 'Use count_user_accounts once, then finish_run with a read-only summary.',
    images: [], modelId, submissionKey: `live-smoke-${randomUUID()}`,
    manifest: profile, chatContext: { companyId: di.tenantId }, sessionFile: null,
  });
  const settled = await waitForChatRun(accepted.run.id, 120_000);
  console.log(JSON.stringify({ skipped: false, tenantId: di.tenantId, runId: settled?.id, status: settled?.status, error: settled?.error || null }));
} finally {
  resetForTests();
  await new Promise((resolve) => server?.close(resolve));
  await closeDb().catch(() => {});
}
