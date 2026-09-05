// Registers the Sales Data Tools MCP server (server/sales-mcp-server.mjs) in
// the catalog and keeps it attached to the Sales and Procurement agent only —
// mirrors server/scrapling.mjs's ensureScraplingMcp pattern.
import { createMcpServer, getMcpServer, updateMcpServer, attachAgentResources } from "./catalog.mjs";
import { SALES_MCP_SERVER, SALES_MCP_SLUG, SALES_AGENT_ID } from "./paths.mjs";

export async function ensureSalesMcp() {
  const payload = {
    name: "Sales Data Tools",
    slug: SALES_MCP_SLUG,
    command: process.execPath,
    args: [SALES_MCP_SERVER],
    description:
      "Preset Postgres queries for Sales and Procurement: predicted stock-out, invoice status, sales summary, received payment, stock velocity — each returned as a ready-to-paste HTML report.",
  };
  const existing = await getMcpServer(SALES_MCP_SLUG);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  await attachAgentResources(SALES_AGENT_ID, { skills: [], mcp: [SALES_MCP_SLUG] });
  return server;
}
