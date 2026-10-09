import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

async function callHost(body) {
  const base = process.env.ADS_RESEARCH_URL;
  const token = process.env.ADS_RESEARCH_TOKEN;
  const tenant = process.env.ADS_RESEARCH_TENANT;
  if (!base || !token || !tenant) throw new Error("Ads research host credentials were not injected");
  const response = await fetch(`${base}/api/internal/ads-research`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, tenant }),
    signal: AbortSignal.timeout(30_000),
  });
  const out = await response.json();
  if (!response.ok || !out.ok) throw new Error(out.error || `Ads research host HTTP ${response.status}`);
  return out.result;
}

const server = new McpServer({ name: "ads-research", version: "1.0.0" });
const register = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, async input => {
  try { return { content: [{ type: "text", text: JSON.stringify(await handler(input)) }] }; }
  catch (error) { return { isError: true, content: [{ type: "text", text: error.message }] }; }
});

register(
  "start_ads_research",
  "Start read-only advertising research for one country and advertising keyword. Uses Meta Ad Library and Google Ads Transparency Center; never bypasses bot walls or CAPTCHA. Returns a job id.",
  { country: z.string().min(1).max(120), keyword: z.string().min(1).max(120), language: z.enum(["en", "zh"]).optional() },
  input => callHost({ action: "start", ...input }),
);
register(
  "get_ads_research",
  "Retrieve ads research progress and the completed report URL. Wait up to 45 seconds if requested; queued/running is not complete.",
  { id: z.string().uuid(), wait_seconds: z.number().int().min(0).max(45).optional(), format: z.enum(["json", "md"]).optional() },
  async ({ id, wait_seconds = 0, format }) => {
    const until = Date.now() + wait_seconds * 1000;
    let row;
    do {
      row = await callHost({ action: "get", id });
      if (!["queued", "running"].includes(row.status) || Date.now() >= until) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    } while (Date.now() < until);
    if (format && row.result) return { ...row, artifact: await callHost({ action: "artifact", id, format }) };
    return row;
  },
);

await server.connect(new StdioServerTransport());
