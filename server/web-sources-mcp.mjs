import path from "node:path";
import { ROOT } from "./paths.mjs";
import { createMcpServer, getMcpServer, updateMcpServer, attachAgentResources, listAgents } from "./catalog.mjs";

export async function ensureWebSourcesMcp() {
  const payload = { name: "Web Sources", slug: "web-sources", command: process.execPath,
    args: [path.join(ROOT, "server", "web-sources-mcp-server.mjs")],
    description: "Fetch once, preserve full page text in managed temporary storage, and read by source ID or section without another fetch.",
    config: { directTools: true, lifecycle: "eager" } };
  const existing = await getMcpServer(payload.slug);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  for (const agent of await listAgents()) {
    if (agent.slug === "whatsapp-assistant") continue;
    await attachAgentResources(agent.id, { mcp: [payload.slug] });
  }
  return server;
}
