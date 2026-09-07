// Registers the O&M MCP server (server/om-mcp-server.mjs) in the catalog and
// keeps it attached to the O&M agent only — mirrors server/google-ads-mcp.mjs's
// ensureGoogleAdsMcp pattern.
import { createMcpServer, getMcpServer, updateMcpServer, attachAgentResources } from "./catalog.mjs";
import { OM_MCP_SERVER, OM_MCP_SLUG, OM_AGENT_ID } from "./paths.mjs";

export async function ensureOmMcp() {
  const payload = {
    name: "O&M Data Tools",
    slug: OM_MCP_SLUG,
    command: process.execPath,
    args: [OM_MCP_SERVER],
    description:
      "Reads client solar plant/device data from the SAJ fleet API: live plant status (with a fresh resync), generation history, and inverter model/firmware info.",
  };
  const existing = await getMcpServer(OM_MCP_SLUG);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  await attachAgentResources(OM_AGENT_ID, { skills: [], mcp: [OM_MCP_SLUG] });
  return server;
}
