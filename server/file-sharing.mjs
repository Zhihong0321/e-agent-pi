import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { publishFile, readSharedFile, sharedFileLocation } from "./shared-files.mjs";
import { fileMime } from "./files.mjs";

const secret = randomBytes(32);
const tokenFor = (agentId) => createHmac("sha256", secret).update(agentId).digest("hex");

export function fileSharingEnv(agent, port = process.env.PORT || "8080") {
  const id = typeof agent === "string" ? agent : agent?.id || agent?.slug;
  if (!id) return {};
  return { FILE_SHARE_AGENT: id, FILE_SHARE_TOKEN: tokenFor(id), FILE_SHARE_URL: `http://127.0.0.1:${port}` };
}

export const FILE_SHARING_PROMPT = `## Files for the user
Agents create files. The host publishes files. Chat displays the returned file attachment.
When a completed workspace file should be shared, call share_file with its workspace path.
Document Intelligence generators and get_document already return published files; use their pdf.link/file.link.
Use returned /files/ URLs exactly. Never invent a download URL or return file:// or /storage paths to users.
Old file:// or workspace links in history are not shareable URLs. Look up the existing document again or call share_file before reusing them.
Shared files persist across sessions and deployments; new versions get new links.
`;

export async function handleFileSharing(req, res, url, ctx) {
  const internal = url.pathname === "/api/internal/files/share";
  if (!internal && !url.pathname.startsWith("/files/")) return false;
  const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
  try {
    if (internal) {
      if (req.method !== "POST") { json(405, { error: "POST required" }); return true; }
      const body = JSON.parse(await ctx.readBody(req));
      const agent = typeof body.agent === "string" ? body.agent : "";
      const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const expected = tokenFor(agent);
      const left = Buffer.from(got), right = Buffer.from(expected);
      if (!agent || left.length !== right.length || !timingSafeEqual(left, right)) {
        json(401, { error: "Unauthorized" }); return true;
      }
      const workspace = await ctx.workspaceFor(agent);
      if (!workspace) throw new Error("Unknown agent");
      const companyId = await ctx.companyId();
      const file = await publishFile({ root: ctx.root, companyId, workspace, source: body.path, publicUrl: ctx.publicUrl });
      json(200, { shared_files: [file] });
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") { json(405, { error: "GET required" }); return true; }
    if (!ctx.authorized(req)) {
      // Reuse the existing owner sign-in; file storage does not introduce user accounts.
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end('<p>Sign in through <a href="/company-profile/">Company Profile</a>, then open this file again.</p>');
      return true;
    }
    const location = sharedFileLocation(url.pathname);
    if (!location) { json(404, { error: "File not found" }); return true; }
    const companyId = await ctx.companyId();
    const { full, file } = await readSharedFile({ root: ctx.root, companyId, ...location });
    const mime = fileMime(full);
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
  } catch (error) {
    json(error.code === "ENOENT" ? 404 : 400, { error: error.code === "ENOENT" ? "File not found" : error.message });
  }
  return true;
}
