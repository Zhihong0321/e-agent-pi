#!/usr/bin/env node
// Stdio MCP server exposing one tool, `web_search`. Spawned per agent by the Pi
// runtime (see server/web-search-mcp.mjs for catalog registration). It holds no
// Jina tokens: it asks the host (/api/internal/web-search) using the URL and
// per-boot bearer the host puts in every agent's env (server/agent-env.mjs).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function fail(message) {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/** @param {{ title?: string; url: string; snippet?: string; content?: string }[]} results */
function render(query, results) {
  if (!results.length) return `No results for "${query}". Try different keywords.`;
  return results
    .map((r, i) => {
      const lines = [`${i + 1}. ${r.title || r.url}`, `   ${r.url}`];
      if (r.snippet) lines.push(`   ${r.snippet}`);
      if (r.content) lines.push(`   ---\n${r.content}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

async function search({ query, num, full }) {
  const base = process.env.CLOUD_PI_SEARCH_URL;
  const token = process.env.CLOUD_PI_SEARCH_TOKEN;
  if (!base || !token) {
    throw new Error("Web search is not configured on this host. Add Jina tokens in Settings -> Keys.");
  }
  const res = await fetch(`${base.replace(/\/+$/, "")}/api/internal/web-search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, num, full }),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Search failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok || !body.ok) throw new Error(body.error || `Search failed (HTTP ${res.status})`);
  return body;
}

const server = new McpServer({ name: "web-search", version: "1.0.0" });

server.registerTool(
  "web_search",
  {
    title: "Web search",
    description:
      "Search the web by keyword and get ranked results (title, URL, snippet). Use it when you need current or outside information you do not already have: news, prices, documentation, or anything the user asks you to look up. Give a few precise keywords, not a whole sentence. Results are snippets only; to read one page in full, open that URL with your page-fetching tools.",
    inputSchema: {
      query: z.string().min(1).describe("Search keywords"),
      num: z.number().int().min(1).max(10).optional().describe("How many results to return (default 5)"),
      full: z
        .boolean()
        .optional()
        .describe("Include page text for each result. Costs far more of the shared search allowance; leave off unless snippets are not enough."),
    },
  },
  async ({ query, num, full }) => {
    try {
      const out = await search({ query, num, full });
      return { content: [{ type: "text", text: render(out.query || query, out.results || []) }] };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
);

await server.connect(new StdioServerTransport());
