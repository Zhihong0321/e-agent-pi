// Registers the Orchestrator dispatch MCP server and keeps it attached to
// Orchestrator only — mirrors server/sales-mcp.mjs's ensureSalesMcp pattern.
import { createMcpServer, getMcpServer, updateMcpServer, attachAgentResources } from "./catalog.mjs";
import { ORCHESTRATOR_AGENT_ID, ORCHESTRATOR_MCP_SERVER, ORCHESTRATOR_MCP_SLUG } from "./paths.mjs";
import { ensureOrchestratorSchema } from "./orchestrator.mjs";

export async function ensureOrchestratorMcp() {
  await ensureOrchestratorSchema();
  const payload = {
    name: "Orchestrator Dispatch",
    slug: ORCHESTRATOR_MCP_SLUG,
    command: process.execPath,
    args: [ORCHESTRATOR_MCP_SERVER],
    description:
      "Live specialist roster, plans, and task dispatch. Orchestrator lists catalog agents and sends each task to the matching specialist; it cannot do their jobs itself.",
  };
  const existing = await getMcpServer(ORCHESTRATOR_MCP_SLUG);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  await attachAgentResources(ORCHESTRATOR_AGENT_ID, { skills: [], mcp: [ORCHESTRATOR_MCP_SLUG] });
  return server;
}
