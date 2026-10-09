import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCompanyProfile } from "../../document_inteligence/core/company.mjs";
import { withContext } from "../../document_inteligence/core/db.mjs";
import { getPool } from "../db.mjs";
import { tenantContext, publicBaseUrl } from "../../document_inteligence/host.mjs";
import { tenantForRequest } from "../tenancy.mjs";
import { agentWorkspace, DATA_DIR, ROOT } from "../paths.mjs";
import { publishFile, readSharedFile } from "../shared-files.mjs";
import { getAgent, createMcpServer, updateMcpServer, getMcpServer, seedSystemAgent, updateAgent } from "../catalog.mjs";
import { MEDIA_AI_AGENT_ID, MEDIA_AI_TOKEN, mediaAiTenantFrom, shareTokenHash } from "./auth.mjs";
import { fileMime, resolveWorkspaceFile } from "../files.mjs";

export const MEDIA_AI_MCP_SLUG = "media-ai";
export const MEDIA_AI_MCP_SERVER = path.join(ROOT, "server", "media-ai", "mcp-server.mjs");
export const MEDIA_CATEGORIES = ["logo", "event_photo", "news", "certification", "qualification", "award"];
export const MEDIA_VISIBILITIES = ["draft", "published", "archived"];
const MAX_TITLE = 180;
const MAX_TEXT = 5000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]);
const DOCUMENT_MIMES = new Set(["application/pdf"]);
const UPLOAD_MIMES = new Set([...IMAGE_MIMES, ...DOCUMENT_MIMES]);
const MAX_JSON_BODY_BYTES = 38 * 1024 * 1024;

let ready = false;

function detectMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  const text = buffer.subarray(0, 2048).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(text)) return "image/svg+xml";
  return null;
}

function readMediaBody(req) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    return Promise.reject(Object.assign(new Error("Media upload request is too large"), { statusCode: 413 }));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= MAX_JSON_BODY_BYTES) chunks.push(chunk);
      else tooLarge = true;
    });
    req.on("end", () => tooLarge ? reject(Object.assign(new Error("Media upload request is too large"), { statusCode: 413 })) : resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanText(value, label, max = MAX_TEXT) {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const text = value.trim();
  if (text.length > max) throw new Error(`${label} is too long`);
  return text;
}

function optionalUrl(value, label) {
  const text = cleanText(value, label, 2000);
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error(`${label} must be an http(s) URL`);
  }
  return text;
}

function validateCategory(value) {
  if (!MEDIA_CATEGORIES.includes(value)) throw new Error(`category must be one of ${MEDIA_CATEGORIES.join(", ")}`);
  return value;
}

function validateVisibility(value = "draft") {
  if (!MEDIA_VISIBILITIES.includes(value)) throw new Error(`visibility must be one of ${MEDIA_VISIBILITIES.join(", ")}`);
  return value;
}

function normalizeMetadata(input) {
  if (input == null) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("metadata must be an object");
  const json = JSON.stringify(input);
  if (json.length > 20000) throw new Error("metadata is too large");
  return input;
}

function assetRow(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    category: row.category,
    title: row.title,
    description: row.description || "",
    altText: row.alt_text || "",
    language: row.language || "en",
    assetDate: row.asset_date ? new Date(row.asset_date).toISOString().slice(0, 10) : null,
    issuer: row.issuer || "",
    sourceUrl: row.source_url || "",
    credential: row.credential || "",
    file: {
      id: row.file_id,
      name: row.file_name,
      bytes: Number(row.file_bytes),
      mime: row.file_mime,
      url: row.file_url,
      link: row.file_link,
    },
    visibility: row.visibility,
    sortOrder: Number(row.sort_order || 0),
    metadata: row.metadata || {},
    revision: Number(row.revision || 1),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

const ASSET_COLUMNS = `id, category, title, description, alt_text, language, asset_date,
  issuer, source_url, credential, file_id, file_name, file_bytes, file_mime, file_url, file_link,
  visibility, sort_order, metadata, revision, created_at, updated_at`;
const ASSET_SELECT = `SELECT ${ASSET_COLUMNS} FROM di.media_kit_asset`;

async function listAssetsTx(tx, filters = {}, { publishedOnly = false } = {}) {
  const values = [];
  const clauses = ["deleted_at IS NULL"];
  if (publishedOnly) clauses.push("visibility = 'published'");
  if (filters.category) { validateCategory(filters.category); values.push(filters.category); clauses.push(`category = $${values.length}`); }
  if (filters.visibility && !publishedOnly) { validateVisibility(filters.visibility); values.push(filters.visibility); clauses.push(`visibility = $${values.length}`); }
  if (filters.query) {
    const query = cleanText(filters.query, "query", 200);
    if (query) { values.push(`%${query}%`); clauses.push(`(title ILIKE $${values.length} OR description ILIKE $${values.length} OR issuer ILIKE $${values.length})`); }
  }
  values.push(Math.min(Math.max(Number(filters.limit) || 100, 1), 500));
  const result = await tx.query(`${ASSET_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY sort_order ASC, asset_date DESC NULLS LAST, created_at DESC LIMIT $${values.length}`, values);
  return result.rows.map(assetRow);
}

async function createAssetTx(tx, input) {
  const category = validateCategory(input.category);
  const title = cleanText(input.title, "title", MAX_TITLE);
  if (!title) throw new Error("title is required");
  const suppliedFile = input.file;
  if (!suppliedFile || typeof suppliedFile !== "object") throw new Error("file is required");
  if (!/^[a-f0-9]{64}$/.test(suppliedFile.id || "") || !suppliedFile.name || suppliedFile.name !== path.basename(suppliedFile.name)) throw new Error("Invalid shared file reference");
  let shared;
  try {
    shared = await readSharedFile({ root: path.join(DATA_DIR, "files"), companyId: input.tenantId, id: suppliedFile.id, name: suppliedFile.name, publicUrl: publicBaseUrl() });
  } catch {
    throw new Error("Shared file not found for this company");
  }
  const file = { ...shared.file, mime: fileMime(shared.full).split(";")[0] };
  const bytes = Number(file.bytes);
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_FILE_BYTES) throw new Error("file size is outside the allowed range");
  const mime = cleanText(file.mime, "file mime", 120).toLowerCase();
  if (!IMAGE_MIMES.has(mime) && !DOCUMENT_MIMES.has(mime)) throw new Error("Only images and PDF files can be added to a Media Kit");
  const visibility = validateVisibility(input.visibility || "draft");
  const assetDate = input.assetDate ? cleanText(input.assetDate, "assetDate", 20) : null;
  if (assetDate && !/^\d{4}-\d{2}-\d{2}$/.test(assetDate)) throw new Error("assetDate must be YYYY-MM-DD");
  const result = await tx.query(`INSERT INTO di.media_kit_asset
    (tenant_id, category, title, description, alt_text, language, asset_date, issuer, source_url, credential,
     file_id, file_name, file_bytes, file_mime, file_url, file_link, visibility, sort_order, metadata)
    VALUES (di.current_tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING ${ASSET_COLUMNS}`,
    [category, title, cleanText(input.description, "description"), cleanText(input.altText, "altText", 500), cleanText(input.language, "language", 20) || "en", assetDate,
      cleanText(input.issuer, "issuer", 300), optionalUrl(input.sourceUrl, "sourceUrl"), cleanText(input.credential, "credential", 300), file.id, path.basename(file.name), bytes, mime,
      cleanText(file.url, "file url", 3000), cleanText(file.link, "file link", 5000), visibility, Number.isInteger(input.sortOrder) ? input.sortOrder : 0, JSON.stringify(normalizeMetadata(input.metadata))]);
  return assetRow(result.rows[0]);
}

async function updateAssetTx(tx, id, input) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("Valid asset id required");
  const current = (await tx.query(`${ASSET_SELECT} WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])).rows[0];
  if (!current) throw new Error("Media asset not found");
  const fields = [];
  const values = [];
  const add = (sql, value) => { values.push(value); fields.push(`${sql} = $${values.length}`); };
  for (const [key, label, max] of [["title", "title", MAX_TITLE], ["description", "description", MAX_TEXT], ["altText", "altText", 500], ["language", "language", 20], ["issuer", "issuer", 300], ["credential", "credential", 300]]) {
    if (input[key] !== undefined) add({ title: "title", description: "description", altText: "alt_text", language: "language", issuer: "issuer", credential: "credential" }[key], cleanText(input[key], label, max));
  }
  if (input.category !== undefined) add("category", validateCategory(input.category));
  if (input.visibility !== undefined) add("visibility", validateVisibility(input.visibility));
  if (input.assetDate !== undefined) { const date = input.assetDate ? cleanText(input.assetDate, "assetDate", 20) : null; if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("assetDate must be YYYY-MM-DD"); add("asset_date", date); }
  if (input.sourceUrl !== undefined) add("source_url", optionalUrl(input.sourceUrl, "sourceUrl"));
  if (input.sortOrder !== undefined) { if (!Number.isInteger(input.sortOrder) || input.sortOrder < 0) throw new Error("sortOrder must be a non-negative integer"); add("sort_order", input.sortOrder); }
  if (input.metadata !== undefined) add("metadata", JSON.stringify(normalizeMetadata(input.metadata)));
  if (input.revision !== undefined && Number(input.revision) !== Number(current.revision)) throw new Error("Media asset changed. Reload it before saving.");
  if (!fields.length) return assetRow(current);
  values.push(id);
  const result = await tx.query(`UPDATE di.media_kit_asset SET ${fields.join(", ")}, revision = revision + 1 WHERE id = $${values.length} RETURNING ${ASSET_COLUMNS}`, values);
  return assetRow(result.rows[0]);
}

async function archiveAssetTx(tx, id, archived = true) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("Valid asset id required");
  const result = await tx.query(`UPDATE di.media_kit_asset SET visibility = $2, revision = revision + 1 WHERE id = $1 AND deleted_at IS NULL RETURNING ${ASSET_COLUMNS}`, [id, archived ? "archived" : "draft"]);
  if (!result.rows[0]) throw new Error("Media asset not found");
  return assetRow(result.rows[0]);
}

async function companyManifestTx(tx, filters = {}) {
  const profile = await getCompanyProfile(tx);
  const assets = await listAssetsTx(tx, filters, { publishedOnly: true });
  return {
    company: {
      name: profile.company.name,
      legalName: profile.company.legal_name || "",
      website: profile.company.website || "",
      email: profile.company.email || "",
      phone: profile.company.phone || "",
      logoUrl: profile.company.logo_url || "",
      address: profile.company.address || {},
    },
    assets,
    generatedAt: new Date().toISOString(),
  };
}

function managementAsset(asset) {
  const url = `/api/media-kit/assets/file/${encodeURIComponent(asset.file.id)}/${encodeURIComponent(asset.file.name)}`;
  return { ...asset, file: { ...asset.file, url, link: `[${asset.file.name}](${url})` } };
}

function shareRow(row) {
  return row ? {
    id: String(row.id),
    label: row.label,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    revokedAt: row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  } : null;
}

async function createShareTx(tx, input = {}) {
  const label = cleanText(input.label, "label", 160) || "Media Kit share";
  const days = input.expiresDays == null || input.expiresDays === "" ? null : Number(input.expiresDays);
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) throw new Error("expiresDays must be between 1 and 365");
  const token = createShareToken();
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86400000).toISOString();
  const result = await tx.query(`INSERT INTO di.media_kit_share (tenant_id, token_hash, label, expires_at)
    VALUES (di.current_tenant(), $1, $2, $3) RETURNING id, label, expires_at, revoked_at, created_at`, [shareTokenHash(token), label, expiresAt]);
  return { ...shareRow(result.rows[0]), token, url: `/media-kit/share/${token}` };
}

async function listSharesTx(tx) {
  const result = await tx.query(`SELECT id, label, expires_at, revoked_at, created_at
    FROM di.media_kit_share WHERE deleted_at IS NULL ORDER BY created_at DESC`);
  return result.rows.map(shareRow);
}

async function revokeShareTx(tx, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw new Error("Valid share id required");
  const result = await tx.query(`UPDATE di.media_kit_share SET revoked_at = COALESCE(revoked_at, NOW())
    WHERE id = $1 AND deleted_at IS NULL RETURNING id, label, expires_at, revoked_at, created_at`, [id]);
  if (!result.rows[0]) throw new Error("Media Kit share not found");
  return shareRow(result.rows[0]);
}

async function tenantForShare(token) {
  const hash = shareTokenHash(token);
  const result = await getPool().query(`SELECT di.media_kit_tenant_for_share($1) AS tenant_id`, [hash]);
  return result.rows[0]?.tenant_id || null;
}

async function sharedManifest(token, filters = {}) {
  const tenantId = await tenantForShare(token);
  if (!tenantId) throw Object.assign(new Error("Media Kit share is invalid or expired"), { statusCode: 404 });
  const ctx = tenantContext(tenantId);
  const manifest = await withContext(ctx.db, { ...ctx, actor: "media-share", agent: "media-share" }, tx => companyManifestTx(tx, filters));
  return {
    ...manifest,
    assets: manifest.assets.map(asset => {
      const url = `/api/media-kit/share/${encodeURIComponent(token)}/file/${asset.file.id}/${encodeURIComponent(asset.file.name)}`;
      return { ...asset, file: { ...asset.file, url, link: `[${asset.file.name}](${url})` } };
    }),
  };
}

async function streamAssetFile(tenantId, id, name, req, res, visibility = null) {
  const ctx = tenantContext(tenantId);
  const allowed = await withContext(ctx.db, { ...ctx, actor: "media-kit", agent: "media-kit" }, async tx => {
    const values = [id, name];
    const extra = visibility ? " AND visibility = $3" : "";
    if (visibility) values.push(visibility);
    const result = await tx.query(`SELECT 1 FROM di.media_kit_asset
      WHERE tenant_id = di.current_tenant() AND file_id = $1 AND file_name = $2
        AND deleted_at IS NULL${extra} LIMIT 1`, values);
    return Boolean(result.rows[0]);
  });
  if (!allowed) return false;
  const { full, file } = await readSharedFile({ root: path.join(DATA_DIR, "files"), companyId: tenantId, id, name, publicUrl: publicBaseUrl() });
  const mime = fileMime(full).split(";")[0];
  const inline = mime === "application/pdf" || (mime !== "image/svg+xml" && /^(image|audio|video)\//.test(mime));
  res.writeHead(200, {
    "Content-Type": mime,
    "Content-Length": file.bytes,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(full).on("error", () => res.destroy()).pipe(res);
  return true;
}

async function streamSharedFile(token, id, name, req, res) {
  const tenantId = await tenantForShare(token);
  if (!tenantId) return false;
  return streamAssetFile(tenantId, id, name, req, res, "published");
}

export async function ensureMediaAi({ log = () => {} } = {}) {
  const rolePrompt = await readFile(path.join(ROOT, "agent", "roles", "media-ai.md"), "utf8").catch(() => "You are Media AI.");
  await seedSystemAgent({ id: MEDIA_AI_AGENT_ID, slug: MEDIA_AI_AGENT_ID, name: "Media AI", short: "MK", headline: "Collects and shares the company media kit", description: "Organizes company logos, event photos, news, certifications, qualifications and awards into a verified, shareable media kit.", color: "emerald", rolePrompt, toolProfile: "assistant", thinkingLevel: "low" });
  const payload = { name: "Media AI", slug: MEDIA_AI_MCP_SLUG, command: process.execPath, args: [MEDIA_AI_MCP_SERVER], description: "Company-scoped Media Kit collection, metadata and sharing tools.", config: { directTools: true, lifecycle: "lazy" } };
  const old = await getMcpServer(payload.slug);
  const mcp = old ? await updateMcpServer(old.id, payload) : await createMcpServer(payload);
  const agent = await getAgent(MEDIA_AI_AGENT_ID);
  await updateAgent(agent.id, { skillIds: [], mcpIds: [mcp.id] });
  ready = true;
  log("info", "media AI agent and media kit MCP ready");
  return { agent: MEDIA_AI_AGENT_ID, mcp: MEDIA_AI_MCP_SLUG, ready };
}

export function mediaAiConfiguration() { return { agent: MEDIA_AI_AGENT_ID, mcp: MEDIA_AI_MCP_SLUG, ready }; }

/** Every Media AI action runs for one company: `tenantId` is required. */
export async function mediaAction({ action, tenantId, ...input }) {
  if (action === "status") return mediaAiConfiguration();
  const ctx = tenantContext(tenantId);
  if (!ready) throw new Error("Media AI is not initialized");
  return withContext(ctx.db, { ...ctx, actor: input.actor || "owner", agent: input.agent || MEDIA_AI_AGENT_ID }, async tx => {
    if (action === "list") return listAssetsTx(tx, input);
    if (action === "manifest") return companyManifestTx(tx, input);
    if (action === "create") return createAssetTx(tx, { ...input, tenantId });
    if (action === "update") return updateAssetTx(tx, input.id, input);
    if (action === "archive") return archiveAssetTx(tx, input.id, true);
    if (action === "restore") return archiveAssetTx(tx, input.id, false);
    if (action === "profile") {
      const profile = await getCompanyProfile(tx);
      return { company: {
        name: profile.company.name,
        legalName: profile.company.legal_name || "",
        website: profile.company.website || "",
        email: profile.company.email || "",
        phone: profile.company.phone || "",
        logoUrl: profile.company.logo_url || "",
        address: profile.company.address || {},
      } };
    }
    if (action === "create_share") return createShareTx(tx, input);
    if (action === "list_shares") return listSharesTx(tx);
    if (action === "revoke_share") return revokeShareTx(tx, input.id);
    throw new Error("Unknown Media AI action");
  });
}

async function ingestFile(input) {
  const ctx = tenantContext(input.tenantId);
  const agent = await getAgent(MEDIA_AI_AGENT_ID);
  if (!agent) throw new Error("Media AI agent is not available");
  const workspace = agentWorkspace(agent, ctx.tenantId);
  const source = cleanText(input.path, "path", 1000);
  const resolved = resolveWorkspaceFile(workspace, source);
  if (!resolved) throw new Error("File must be inside the Media AI workspace");
  const info = await stat(resolved.full);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_FILE_BYTES) throw new Error("Media asset must be a non-empty file up to 25 MB");
  const declaredMime = fileMime(resolved.full).split(";")[0];
  if (!UPLOAD_MIMES.has(declaredMime)) throw new Error("Only images and PDF files can be added to a Media Kit");
  const sample = await readFile(resolved.full);
  const detectedMime = detectMime(sample);
  if (!detectedMime || detectedMime !== declaredMime) throw new Error("File content does not match its extension");
  const mime = detectedMime;
  const published = await publishFile({ root: path.join(DATA_DIR, "files"), companyId: ctx.tenantId, workspace, source, publicUrl: publicBaseUrl() });
  return mediaAction({ action: "create", ...input, file: { ...published, bytes: info.size, mime }, agent: MEDIA_AI_AGENT_ID });
}

async function uploadFile(input) {
  const raw = cleanText(input.data, "data", 40 * 1024 * 1024);
  const match = raw.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) throw new Error("data must be a base64 data URL");
  const declaredMime = match[1].toLowerCase();
  if (!UPLOAD_MIMES.has(declaredMime)) throw new Error("Only images and PDF files can be added to a Media Kit");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(match[2]) || match[2].length % 4 === 1) throw new Error("Invalid base64 file data");
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error("Media asset must be a non-empty file up to 25 MB");
  const detectedMime = detectMime(buffer);
  const mime = declaredMime === "image/svg+xml" ? detectedMime : detectedMime || declaredMime;
  if (!mime || mime !== declaredMime || !UPLOAD_MIMES.has(mime)) throw new Error("File content does not match its declared type");
  const agent = await getAgent(MEDIA_AI_AGENT_ID);
  if (!agent) throw new Error("Media AI agent is not available");
  const extension = mime === "application/pdf" ? ".pdf" : mime === "image/svg+xml" ? ".svg" : mime.split("/")[1] === "jpeg" ? ".jpg" : `.${mime.split("/")[1]}`;
  const requestedName = cleanText(input.fileName, "fileName", 160).replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(-150);
  const stem = (requestedName || `media-${randomUUID()}`).replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const name = `${stem}${extension}`;
  const relative = `_media-inbox/${randomUUID()}-${name}`;
  const workspace = agentWorkspace(agent, tenantContext(input.tenantId).tenantId);
  await mkdir(path.join(workspace, "_media-inbox"), { recursive: true });
  await writeFile(path.join(workspace, relative), buffer, { flag: "wx" });
  try { return await ingestFile({ ...input, path: relative, mime }); }
  finally { await import("node:fs/promises").then(({ unlink }) => unlink(path.join(workspace, relative)).catch(() => {})); }
}

export async function handleMediaAi(req, res, url, { authorized, user = null }) {
  const internal = url.pathname === "/api/internal/media-ai";
  const prefix = "/api/media-kit";
  const sharePrefix = `${prefix}/share/`;
  if (!internal && url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`) ) return false;
  const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(JSON.stringify(body)); };
  const isShare = url.pathname.startsWith(sharePrefix);
  if (isShare) {
    try {
      const tail = url.pathname.slice(sharePrefix.length).split("/").filter(Boolean);
      const token = decodeURIComponent(tail[0] || "");
      if (!token) return json(404, { error: "Media Kit share not found" });
      if (tail[1] === "file" && tail[2] && tail[3] && (req.method === "GET" || req.method === "HEAD")) {
        const served = await streamSharedFile(token, tail[2], decodeURIComponent(tail.slice(3).join("/")), req, res);
        if (!served) json(404, { error: "Media Kit file not found" });
        return true;
      }
      if (tail.length === 1 && req.method === "GET") { json(200, await sharedManifest(token, { category: url.searchParams.get("category") || undefined })); return true; }
      json(404, { error: "Media Kit share route not found" });
    } catch (error) { json(error.statusCode || 400, { error: error instanceof Error ? error.message : String(error) }); }
    return true;
  }
  const managementAuthorized = authorized(req) || Boolean(user);
  if (!internal && !managementAuthorized) { json(401, { error: "Unauthorized" }); return true; }
  try {
    if (internal) {
      if (req.method !== "POST") { json(405, { error: "POST required" }); return true; }
      const body = JSON.parse(await readMediaBody(req) || "{}");
      // The token binds the company: an agent run can only act inside the company it was started for.
      const internalTenant = mediaAiTenantFrom(req, body.tenant);
      if (!internalTenant) { json(401, { error: "Unauthorized" }); return true; }
      const call = { ...body };
      delete call.tenant;
      const result = call.action === "ingest" ? await ingestFile({ ...call, tenantId: internalTenant }) : call.action === "upload" ? await uploadFile({ ...call, tenantId: internalTenant }) : await mediaAction({ ...call, tenantId: internalTenant, actor: user?.id || call.actor });
      json(200, { ok: true, result });
      return true;
    }
    const tenantId = tenantForRequest(req, user);
    const act = (call) => mediaAction({ ...call, tenantId });
    if (url.pathname === prefix && req.method === "GET") { const requestedVisibility = url.searchParams.get("visibility") || "published"; const assets = await act({ action: "list", actor: user?.id || undefined, category: url.searchParams.get("category") || undefined, query: url.searchParams.get("q") || undefined, visibility: requestedVisibility === "all" ? undefined : requestedVisibility }); json(200, assets.map(managementAsset)); return true; }
    if (url.pathname === `${prefix}/profile` && req.method === "GET") { json(200, await act({ action: "profile", actor: user?.id || undefined })); return true; }
    if (url.pathname === `${prefix}/manifest` && req.method === "GET") { const manifest = await act({ action: "manifest", actor: user?.id || undefined }); json(200, { ...manifest, assets: manifest.assets.map(managementAsset) }); return true; }
    if (url.pathname === `${prefix}/shares` && req.method === "GET") { json(200, await act({ action: "list_shares", actor: user?.id || undefined })); return true; }
    if (url.pathname === `${prefix}/shares` && req.method === "POST") { json(201, await act({ action: "create_share", actor: user?.id || undefined, ...(JSON.parse(await readMediaBody(req) || "{}")) })); return true; }
    const fileMatch = url.pathname.slice(`${prefix}/assets/file/`).match(/^([a-f0-9]{64})\/([^/]+)$/i);
    if (url.pathname.startsWith(`${prefix}/assets/file/`) && fileMatch && (req.method === "GET" || req.method === "HEAD")) {
      const served = await streamAssetFile(tenantId, fileMatch[1], decodeURIComponent(fileMatch[2]), req, res);
      if (!served) json(404, { error: "Media Kit file not found" });
      return true;
    }
    const shareMatch = url.pathname.slice(`${prefix}/shares/`.length).match(/^([0-9a-f-]{36})$/i);
    if (shareMatch && req.method === "POST") { json(200, await act({ action: "revoke_share", id: shareMatch[1] })); return true; }
    if (url.pathname === `${prefix}/assets` && req.method === "POST") { json(201, await act({ action: "create", ...(JSON.parse(await readMediaBody(req) || "{}")) })); return true; }
    if (url.pathname === `${prefix}/upload` && req.method === "POST") { json(201, await uploadFile({ ...JSON.parse(await readMediaBody(req) || "{}"), tenantId })); return true; }
    const match = url.pathname.slice(prefix.length).match(/^\/assets\/([0-9a-f-]{36})$/i);
    if (match && ["PATCH", "POST"].includes(req.method)) {
      const body = JSON.parse(await readMediaBody(req) || "{}");
      const action = body.action === "archive" ? "archive" : body.action === "restore" ? "restore" : "update";
      json(200, await act({ action, id: match[1], ...body }));
      return true;
    }
    json(404, { error: "Unknown Media Kit route" });
  } catch (error) {
    json(error?.details?.code === "conflict" ? 409 : 400, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}

export function mediaAiToken() { return MEDIA_AI_TOKEN; }
export function createShareToken() { return randomBytes(24).toString("base64url"); }
export { shareTokenHash };
