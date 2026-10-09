// External MCP integration: one host-side owner per connection (server
// definition revision + credential scope), negotiated at setup — never
// duplicated across host and worker, and never re-enumerated by model search.
// Results are normalized; tool-level errors (isError), transport failures,
// authentication failures and timeouts stay distinct. External text is data.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import path from "node:path";
import { execError, redactArgs } from "./contracts.mjs";

/** bindingKey: one live owner per server revision + credential scope. */
function bindingKey(binding, scope) {
  return `${binding.slug}@${binding.revision}#${scope}`;
}

const owners = new Map(); // key -> { client, tools, status, lastChecked, lastError, ready }

function ownerFor(key) {
  return owners.get(key) || null;
}

export function classifyEffect() {
  return 'external';
}

async function resolveBindingEnv(binding) {
  const env = { ...(binding.env || {}) };
  const port = process.env.PORT || '8080';
  env.PORT = env.PORT || port;
  if (!env.PATH && !env.Path) {
    const nodeDir = path.dirname(process.execPath);
    const rawPath = process.env.PATH || process.env.Path || '';
    env.PATH = [nodeDir, '/opt/scrapling/bin', rawPath].filter(Boolean).join(path.delimiter);
    if (process.platform === 'win32') {
      env.Path = env.PATH;
    }
  }
  if (binding.slug === 'ads-research') {
    const { adsResearchEnv } = await import('../ads-research/auth.mjs');
    Object.assign(env, adsResearchEnv('ads-research'));
  } else if (binding.slug === 'media-ai') {
    const { mediaAiEnv } = await import('../media-ai/auth.mjs');
    Object.assign(env, mediaAiEnv('media-ai', process.env, binding.companyId));
  } else if (binding.slug === 'company-research') {
    const { researchEnv } = await import('../company-research/auth.mjs');
    Object.assign(env, researchEnv('company-deep-research'));
  } else if (binding.slug === 'ee-mail') {
    // The helper calls back into this host with a per-boot bearer; without it every send fails.
    const { eeMailEnv } = await import('../ee-mail.mjs');
    Object.assign(env, eeMailEnv(binding.agentId, env.PORT));
  }
  return env;
}

/**
 * Approve + materialize the exposed tools of an external binding. Called once
 * per connection setup, not per model turn. Returns the frozen tool list.
 * @param {{ slug: string, revision: string, command?: string, args?: string[], url?: string, env?: Record<string,string>, scope: string, timeoutMs?: number }} binding
 */
export async function connectBinding(binding) {
  const key = bindingKey(binding, binding.scope || 'shared');
  const existing = ownerFor(key);
  if (existing?.status === 'connected') return existing;
  if (existing?.ready) return existing.ready;

  const owner = { client: null, tools: [], status: 'connecting', lastChecked: new Date().toISOString(), lastError: null, ready: null };
  owners.set(key, owner);
  owner.ready = (async () => {
    try {
      const stdioEnv = await resolveBindingEnv(binding);
      const transport = binding.url
        ? new StreamableHTTPClientTransport(new URL(binding.url))
        : new StdioClientTransport({
            command: binding.command || process.execPath,
            args: binding.args || [],
            env: stdioEnv,
          });
      const client = new Client({ name: 'execution-host', version: '1.0.0' });
      await client.connect(transport);
      const listed = await client.listTools();
      owner.client = client;
      owner.tools = (listed.tools || []).map((tool) => ({
        mcpServer: binding.slug,
        mcpTool: tool.name,
        name: `${binding.slug}__${tool.name}`,
        description: String(tool.description || tool.name).slice(0, 1200),
        inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      }));
      owner.status = 'connected';
      owner.lastChecked = new Date().toISOString();
      return owner;
    } catch (error) {
      owner.status = 'unavailable';
      owner.lastError = safeReason(error);
      owner.lastChecked = new Date().toISOString();
      throw Object.assign(new Error(`MCP ${binding.slug} unavailable: ${owner.lastError}`), { execCode: 'EXTERNAL_ERROR' });
    }
  })();
  return owner.ready;
}

function safeReason(error) {
  const raw = String(error?.message || error || 'unknown error');
  if (/401|403|unauthorized|forbidden|api key|credential/i.test(raw)) return 'authentication failed';
  if (/timeout|ETIMEDOUT|aborted/i.test(raw)) return 'timed out';
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|connect/i.test(raw)) return 'connection failed';
  return raw.split('\n')[0].slice(0, 200);
}

/**
 * One normalized external call. Unknown outcomes surface as
 * blocked/OUTCOME_UNKNOWN material — never an automatic resend.
 */
export async function callExternal(binding, toolName, args = {}) {
  const key = bindingKey(binding, binding.scope || 'shared');
  const ownerEntry = owners.get(key);
  const owner = ownerEntry?.ready ? await ownerEntry.ready : ownerEntry || await connectBinding(binding);
  const timeoutMs = Math.max(1000, binding.timeoutMs || 60_000);
  let timer;
  try {
    const result = await Promise.race([
      owner.client.callTool({ name: toolName, arguments: args }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(`${binding.slug}.${toolName} timed out`), { execCode: 'EXTERNAL_TIMEOUT' }));
        }, timeoutMs);
      }),
    ]);
    owner.lastChecked = new Date().toISOString();
    const isError = Boolean(result?.isError);
    const text = (result?.content || [])
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
    const structured = result?.structuredContent ?? undefined;
    if (isError) {
      return {
        ok: false,
        effects: [],
        error: execError('EXTERNAL_ERROR', String(text || 'external tool reported an error').slice(0, 500), { effectState: 'unknown' }),
        externalText: text,
      };
    }
    return { ok: true, callId: null, data: structured ?? { text }, effects: [externalReceipt(binding, toolName, structured ?? text)] };
  } catch (error) {
    owner.lastChecked = new Date().toISOString();
    if (error?.execCode === 'EXTERNAL_TIMEOUT') {
      return { ok: false, effects: [], error: execError('EXTERNAL_TIMEOUT', error.message, { effectState: 'unknown' }) };
    }
    const reason = safeReason(error);
    return { ok: false, effects: [], error: execError('EXTERNAL_ERROR', `${binding.slug}.${toolName}: ${reason}`, { effectState: 'unknown' }) };
  } finally {
    clearTimeout(timer);
  }
}

function externalReceipt(binding, toolName, reference) {
  return { id: `${binding.slug}:${toolName}`, operationId: `${binding.slug}__${toolName}`, kind: 'external', reference: typeof reference === 'string' ? reference.slice(0, 500) : JSON.stringify(redactArgs(reference)).slice(0, 500) };
}

/** configured (binding exists) vs connected (handshake + enumeration succeeded). */
export function connectionStatus() {
  return [...owners.entries()].map(([key, owner]) => ({
    binding: key,
    status: owner.status,
    lastChecked: owner.lastChecked,
    tools: owner.tools.length,
    lastError: owner.lastError,
  }));
}

export async function closeAllConnections() {
  for (const owner of owners.values()) {
    try { await owner.client?.close(); } catch { /* best effort */ }
  }
  owners.clear();
}
