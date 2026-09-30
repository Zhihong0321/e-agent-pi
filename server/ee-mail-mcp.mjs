import { createMcpServer, getMcpServer, updateMcpServer, attachAgentResources } from "./catalog.mjs";
import { EE_MAIL_AGENT_ID, EE_MAIL_MCP_SERVER, EE_MAIL_MCP_SLUG } from "./paths.mjs";

export async function ensureEeMailMcp() {
  const payload = {
    name: "EE-Mail",
    slug: EE_MAIL_MCP_SLUG,
    command: process.execPath,
    args: [EE_MAIL_MCP_SERVER],
    description: "Confirmed email delivery through the host-proxied EE-Mail REST service. Available only to the Document Agent.",
  };
  const existing = await getMcpServer(EE_MAIL_MCP_SLUG);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  await attachAgentResources(EE_MAIL_AGENT_ID, { skills: [], mcp: [EE_MAIL_MCP_SLUG] });
  return server;
}
