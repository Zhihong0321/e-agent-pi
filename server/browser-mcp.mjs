import { attachAgentResources, createMcpServer, getMcpServer, listAgents, updateMcpServer } from "./catalog.mjs";
import { BROWSER_MCP_SERVER, BROWSER_MCP_SLUG, ORCHESTRATOR_AGENT_ID, WHATSAPP_AGENT_ID } from "./paths.mjs";
import { browserMcpToken } from "./browser-session.mjs";
import { ensureBrowserSchema } from "./browser-profiles.mjs";

function mcpPayload() {
  const port = Number(process.env.PORT) || 8080;
  return {
    name: "Persistent Browser",
    slug: BROWSER_MCP_SLUG,
    command: process.execPath,
    args: [BROWSER_MCP_SERVER],
    env: {
      BROWSER_API: `http://127.0.0.1:${port}`,
      BROWSER_MCP_TOKEN: browserMcpToken(),
    },
    description:
      "Persistent Chromium with saved Google/OAuth sessions. Navigate, snapshot, click, type. Never log out. If signed out, tell the owner to open /signin.",
  };
}

export async function ensureBrowserMcp({ exclude = [WHATSAPP_AGENT_ID, ORCHESTRATOR_AGENT_ID] } = {}) {
  await ensureBrowserSchema();
  const payload = mcpPayload();
  const existing = await getMcpServer(BROWSER_MCP_SLUG);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  const agents = await listAgents();
  const attached = [];
  for (const agent of agents) {
    if (exclude.includes(agent.id) || exclude.includes(agent.slug)) continue;
    await attachAgentResources(agent.id, { mcp: [BROWSER_MCP_SLUG] });
    attached.push(agent.slug);
  }
  return { server, attachedTo: attached };
}
