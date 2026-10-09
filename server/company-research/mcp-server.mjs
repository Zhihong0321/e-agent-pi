import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Seed } from './core.mjs';

async function callHost(body) {
  const base = process.env.CLOUD_PI_RESEARCH_URL, token = process.env.CLOUD_PI_RESEARCH_TOKEN, tenant = process.env.CLOUD_PI_RESEARCH_TENANT;
  if (!base || !token || !tenant) throw new Error('Company research host credentials were not injected');
  const response = await fetch(`${base}/api/internal/company-research`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...body, tenant }), signal: AbortSignal.timeout(30000) });
  const out = await response.json();
  if (!response.ok || !out.ok) throw new Error(out.error || `Research host HTTP ${response.status}`);
  return out.result;
}
const server = new McpServer({ name: 'company-research', version: '2.0.0' });
const register = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, async input => {
  try { const result = await handler(input); return { content: [{ type: 'text', text: JSON.stringify(result) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
});
register('research_company', 'Start an asynchronous, private Malaysian company dossier. Supply company name and known website/phone/address anchors. Returns dossier id. Identity mismatch stops at needs_review. Use get_company_dossier to wait for results; never treat queued as complete.', { seed: Seed, force: z.boolean().optional(), pitchSignals: z.boolean().optional() }, input => callHost({ action: 'start', ...input }));
register('get_company_dossier', 'Retrieve progress and a quote-validated dossier. Optionally wait up to 45 seconds. Artifacts can be retrieved as md/html/json after completion.', { id: z.string().uuid(), wait_seconds: z.number().int().min(0).max(45).optional(), format: z.enum(['json', 'md', 'html']).optional() }, async ({ id, wait_seconds = 0, format }) => {
  const until = Date.now() + wait_seconds * 1000;
  let row;
  do {
    row = await callHost({ action: 'get', id });
    if (!['queued', 'running'].includes(row.status) || Date.now() >= until) break;
    await new Promise(r => setTimeout(r, 2000));
  } while (Date.now() < until);
  if (format && row.result) return { ...row, artifact: await callHost({ action: 'artifact', id, format }) };
  return row;
});
register('replay_company_dossier', 'Re-run quote checks, reconciliation and deterministic scoring from stored evidence and submissions. Makes no searches, fetches or model calls and spends no credits.', { id: z.string().uuid() }, input => callHost({ action: 'replay', ...input }));
register('publish_company_report', 'Publish a designed HTML snapshot on the production site and return its shareable URL. Use only when the user requests publication. Identity must be resolved. A partial report preserves its unknowns and limitations.', { id: z.string().uuid() }, input => callHost({ action: 'publish', ...input }));
register('unpublish_company_report', 'Remove the public report link while preserving the private dossier. Use when the user requests removal.', { id: z.string().uuid() }, input => callHost({ action: 'unpublish', ...input }));
await server.connect(new StdioServerTransport());
