import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SignalSeed } from './core.mjs';

async function callHost(body) {
  const base = process.env.CLOUD_PI_SIGNAL_RESEARCH_URL;
  const token = process.env.CLOUD_PI_SIGNAL_RESEARCH_TOKEN;
  if (!base || !token) throw new Error('Company signal research host credentials were not injected');

  const response = await fetch(`${base}/api/internal/company-signal-research`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const out = await response.json();
  if (!response.ok || !out.ok) throw new Error(out.error || `Signal research host HTTP ${response.status}`);
  return out.result;
}

const server = new McpServer({ name: 'company-signal-research', version: '1.0.0' });

const register = (name, description, inputSchema, handler) =>
  server.registerTool(name, { description, inputSchema }, async input => {
    try {
      const result = await handler(input);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });

register(
  'research_company_signals',
  'Starts an asynchronous research job to gather market-moving news, stock price catalysts and layer them onto previous reports. Returns dossier id.',
  {
    seed: SignalSeed,
    force: z.boolean().optional(),
  },
  input => callHost({ action: 'start', ...input })
);

register(
  'get_company_signal_dossier',
  'Retrieves status, verified signals and trend synthesis for a dossier. Can optionally poll up to 45 seconds while running. Supports format=md/json.',
  {
    id: z.string().uuid(),
    wait_seconds: z.number().int().min(0).max(45).optional(),
    format: z.enum(['json', 'md']).optional(),
  },
  async ({ id, wait_seconds = 0, format }) => {
    const until = Date.now() + wait_seconds * 1000;
    let row;
    do {
      row = await callHost({ action: 'get', id });
      if (!['queued', 'running'].includes(row?.status) || Date.now() >= until) break;
      await new Promise(r => setTimeout(r, 2000));
    } while (Date.now() < until);

    if (format && row?.result) {
      return {
        ...row,
        artifact: await callHost({ action: 'artifact', id, format }),
      };
    }
    return row;
  }
);

register(
  'get_company_trend_history',
  'Retrieves the chronological stack of previous signal reports for a company UID (e.g. AAPL.NASDAQ), showing how the narrative and thesis evolved over time.',
  {
    company_uid: z.string().min(2),
  },
  input => callHost({ action: 'history', ...input })
);

register(
  'list_company_catalysts',
  'Lists discrete verified market-moving catalysts (earnings beats, contract wins, regulatory actions) recorded for a company UID.',
  {
    company_uid: z.string().min(2),
  },
  input => callHost({ action: 'catalysts', ...input })
);

await server.connect(new StdioServerTransport());
