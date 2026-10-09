import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

async function callHost(body) {
  const base = process.env.MEDIA_AI_URL;
  const token = process.env.MEDIA_AI_TOKEN;
  if (!base || !token || !process.env.MEDIA_AI_TENANT) throw new Error("Media AI host credentials were not injected");
  const response = await fetch(`${base}/api/internal/media-ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ ...body, tenant: process.env.MEDIA_AI_TENANT }),
    signal: AbortSignal.timeout(30000),
  });
  const out = await response.json().catch(() => ({}));
  if (!response.ok || !out.ok) throw new Error(out.error || `Media AI host HTTP ${response.status}`);
  return out.result;
}

const server = new McpServer({ name: "media-ai", version: "1.0.0" });
const categories = z.enum(["logo", "event_photo", "news", "certification", "qualification", "award"]);
const visibility = z.enum(["draft", "published", "archived"]);
const register = (name, description, inputSchema, handler) => server.registerTool(name, { description, inputSchema }, async input => {
  try {
    const result = await handler(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
  }
});

register("list_media_assets", "List the company's Media Kit assets. Filter by category, visibility or a search phrase. Drafts are included for the Media AI workspace.", {
  category: categories.optional(), visibility: visibility.optional(), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(500).optional(),
}, input => callHost({ action: "list", ...input }));
register("ingest_media_asset", "Publish a completed file from the Media AI workspace into immutable company storage and create its Media Kit metadata. Use a workspace-relative path.", {
  path: z.string().min(1).max(1000), mime: z.string().max(120).optional(), category: categories, title: z.string().min(1).max(180), description: z.string().max(5000).optional(), altText: z.string().max(500).optional(), language: z.string().max(20).optional(), assetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), issuer: z.string().max(300).optional(), sourceUrl: z.string().url().optional(), credential: z.string().max(300).optional(), visibility: visibility.optional(), sortOrder: z.number().int().min(0).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
}, input => callHost({ action: "ingest", ...input }));
register("update_media_asset", "Update Media Kit metadata or publication state. Include the current revision to avoid overwriting someone else's edits.", {
  id: z.string().uuid(), revision: z.number().int().positive().optional(), category: categories.optional(), title: z.string().min(1).max(180).optional(), description: z.string().max(5000).optional(), altText: z.string().max(500).optional(), language: z.string().max(20).optional(), assetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), issuer: z.string().max(300).optional(), sourceUrl: z.string().url().nullable().optional(), credential: z.string().max(300).optional(), visibility: visibility.optional(), sortOrder: z.number().int().min(0).optional(), metadata: z.record(z.string(), z.unknown()).optional(),
}, input => callHost({ action: "update", ...input }));
register("archive_media_asset", "Archive a Media Kit asset without deleting its immutable file snapshot.", { id: z.string().uuid() }, input => callHost({ action: "archive", ...input }));
register("restore_media_asset", "Restore an archived Media Kit asset to draft state.", { id: z.string().uuid() }, input => callHost({ action: "restore", ...input }));
register("get_media_kit_manifest", "Return the company profile and published Media Kit assets ready to show an advertiser or social-media partner.", { category: categories.optional() }, input => callHost({ action: "manifest", ...input }));
register("create_media_kit_share", "Create a time-limited, read-only Media Kit link. Only published assets appear through the link.", { label: z.string().max(160).optional(), expiresDays: z.number().int().min(1).max(365).nullable().optional() }, input => callHost({ action: "create_share", ...input }));
register("list_media_kit_shares", "List active and revoked Media Kit share links for the current company.", {}, () => callHost({ action: "list_shares" }));
register("revoke_media_kit_share", "Revoke a Media Kit share link immediately.", { id: z.string().uuid() }, input => callHost({ action: "revoke_share", ...input }));
register("get_media_ai_status", "Return Media AI registration status.", {}, () => callHost({ action: "status" }));

await server.connect(new StdioServerTransport());
