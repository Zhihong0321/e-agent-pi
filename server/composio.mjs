// Registers Composio's hosted session MCP endpoint in the catalog and keeps it
// attached to the Composio agent — mirrors server/sales-mcp.mjs's ensureSalesMcp
// pattern, except the server is remote (http) rather than a spawned child process.
//
// The API key lives in Postgres settings (composio_api_key, edited on /settings)
// and is never written to a repo file or logged. See
// https://docs.composio.dev/docs/sessions-via-mcp
import { Composio } from "@composio/core";
import { attachAgentResources, createMcpServer, getMcpServer, updateMcpServer } from "./catalog.mjs";
import { COMPOSIO_AGENT_ID, COMPOSIO_MCP_SLUG } from "./paths.mjs";
import { rememberSecret, secret } from "./secrets.mjs";

/**
 * One Composio identity for the studio's single operator. Composio scopes user
 * ids to the project behind the API key, so the agent id is already unique here;
 * reusing it keeps one session (and its connected accounts) per agent.
 */
const COMPOSIO_USER_ID = `e-agent-${COMPOSIO_AGENT_ID}`;

/**
 * Toolkit slugs, verified against https://docs.composio.dev/toolkits/<slug>.md.
 * Composio uses no underscores here — `googlesheets`, not `google_sheets`.
 * A session can only discover tools inside this list.
 */
const COMPOSIO_TOOLKITS = ["googlesheets", "googledocs", "googleslides"];
const SCOPE = COMPOSIO_TOOLKITS.join(",");

const DESCRIPTION =
  "Composio session endpoint scoped to Google Sheets, Google Docs and Google Slides: search and call tools across those three toolkits, and return a Connect Link when Google still needs authorizing.";

export function composioConfigured() {
  return Boolean(secret("composio_api_key"));
}

/**
 * Boot logs failures through sanitizeError, which truncates but does not redact,
 * and those messages persist to debug_events. Strip the key before rethrowing.
 */
async function withRedactedKey(run) {
  try {
    return await run();
  } catch (error) {
    const key = secret("composio_api_key");
    const raw = error instanceof Error ? error.message : String(error);
    throw new Error(key ? raw.split(key).join("[redacted]") : raw);
  }
}

/**
 * Resume the stored session so the operator's Google connection survives a
 * redeploy. A resumed session keeps the toolkit scope it was created with, so
 * only reuse it while the recorded scope still matches — otherwise mint a new
 * one, or an edit to COMPOSIO_TOOLKITS would silently never apply.
 * @param {Composio} composio
 */
async function openSession(composio) {
  const stored = secret("composio_session_id");
  if (stored && secret("composio_session_scope") === SCOPE) {
    try {
      return await composio.sessions.use(stored, { mcp: true });
    } catch {
      // Deleted or expired server-side — create a replacement below.
    }
  }
  const session = await composio.sessions.create(COMPOSIO_USER_ID, {
    toolkits: COMPOSIO_TOOLKITS,
    mcp: true,
  });
  await rememberSecret("composio_session_id", session.sessionId);
  await rememberSecret("composio_session_scope", SCOPE);
  return session;
}

/**
 * @returns {Promise<{ skipped: true; reason: string } | { skipped: false; server: object }>}
 */
export async function ensureComposioMcp() {
  if (!composioConfigured()) {
    return { skipped: true, reason: "composio_api_key not set" };
  }

  const session = await withRedactedKey(async () => {
    const composio = new Composio({ apiKey: secret("composio_api_key") });
    return openSession(composio);
  });
  const { url, headers, type } = session.mcp;

  // `directTools` surfaces Composio's handful of meta-tools as named tools
  // instead of folding them behind the adapter's generic `mcp` proxy — they are
  // already a discovery layer, so a second one only costs a round trip.
  // `eager` because the adapter only dials a server at startup for eager or
  // keep-alive; a lazy one registers tools from its metadata cache alone, and a
  // fresh remote endpoint has none — which left the agent with zero tools.
  const payload = {
    name: "Composio",
    slug: COMPOSIO_MCP_SLUG,
    description: DESCRIPTION,
    url,
    config: {
      headers: headers ?? {},
      httpTransport: type === "sse" ? "sse" : "streamable-http",
      directTools: true,
      lifecycle: "eager",
    },
  };
  const existing = await getMcpServer(COMPOSIO_MCP_SLUG);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  await attachAgentResources(COMPOSIO_AGENT_ID, { skills: [], mcp: [COMPOSIO_MCP_SLUG] });

  return { skipped: false, server };
}
