// Registers the Google Ads MCP server (server/google-ads-mcp-server.mjs) in the
// catalog and keeps it attached to the Google Ads agent only — mirrors
// server/sales-mcp.mjs's ensureSalesMcp pattern.
import { createMcpServer, getMcpServer, updateMcpServer, attachAgentResources } from "./catalog.mjs";
import { GOOGLE_ADS_MCP_SERVER, GOOGLE_ADS_MCP_SLUG, GOOGLE_ADS_AGENT_ID } from "./paths.mjs";

export async function ensureGoogleAdsMcp() {
  const payload = {
    name: "Google Ads Tools",
    slug: GOOGLE_ADS_MCP_SLUG,
    command: process.execPath,
    args: [GOOGLE_ADS_MCP_SERVER],
    description:
      "Google Ads reporting (access check, account overview, campaign performance, search terms, wasted spend) plus campaign building that can only ever create PAUSED entities — no tool can enable, unpause, or edit a serving campaign.",
  };
  const existing = await getMcpServer(GOOGLE_ADS_MCP_SLUG);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  await attachAgentResources(GOOGLE_ADS_AGENT_ID, { skills: [], mcp: [GOOGLE_ADS_MCP_SLUG] });
  return server;
}
