// Registers the Web Search MCP server (server/web-search-mcp-server.mjs) in the
// catalog. Unlike the sales/O&M servers it is attached to nobody: tick it on
// any agent under Settings -> Agents (or MCP) to give that agent `web_search`.
import { createMcpServer, getMcpServer, updateMcpServer } from "./catalog.mjs";
import { WEB_SEARCH_MCP_SERVER, WEB_SEARCH_MCP_SLUG } from "./paths.mjs";

export async function ensureWebSearchMcp() {
  const payload = {
    name: "Web Search",
    slug: WEB_SEARCH_MCP_SLUG,
    command: process.execPath,
    args: [WEB_SEARCH_MCP_SERVER],
    description:
      "web_search: keyword web search (title, URL, snippet) through the Jina tokens saved in Settings -> Keys, rotated round-robin.",
    // `directTools` shows web_search as a named tool instead of behind the adapter's
    // generic `mcp` proxy, and `eager` makes the adapter start the server at boot:
    // a lazy stdio server registers tools from a metadata cache it does not have yet.
    config: { directTools: true, lifecycle: "eager" },
  };
  const existing = await getMcpServer(WEB_SEARCH_MCP_SLUG);
  return existing ? updateMcpServer(existing.id, payload) : createMcpServer(payload);
}
