// Receipt files for expense claims. The agent only ever names a chat attachment
// ("_inbox/<stamp>-<n>-<name>"); this module is the one place that reads it: it checks the
// path stays in the agent's workspace, the size, and the real file type (from the bytes, not
// the name), then publishes a durable copy to shared storage so the claim keeps working
// after the workspace is cleaned. Publishing is content-addressed, so the same file twice
// is the same link.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DiError } from "./common.mjs";
import { sniffMime } from "./forms.mjs";
import { resolveWorkspaceFile } from "../../server/files.mjs";

export const RECEIPT_LIMITS = { files: 5, mb: 10 };
export const RECEIPT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];

/** "1759400000123-0-lunch.jpg" -> "lunch.jpg" (the inbox stamp is host bookkeeping). */
export const cleanReceiptName = (name) => String(name).replace(/^\d{10,}-\d+-/, "") || "receipt";

/**
 * @param {string[]} paths workspace-relative paths from the agent
 * @param {{ workspace: string, publish: (rel: string) => Promise<{ id: string, name: string, bytes: number, url: string, link: string }> }} io
 * @returns {Promise<Array<{ name: string, mime: string, bytes: number, sha256: string, path: string, url: string, ref: object }>>}
 */
export async function loadReceipts(paths, { workspace, publish }) {
  if (!paths?.length) return [];
  if (!workspace || !publish) throw new DiError("This host has no file storage, so receipts can't be attached");
  if (paths.length > RECEIPT_LIMITS.files) throw new DiError(`Attach at most ${RECEIPT_LIMITS.files} receipts to one claim`);
  const out = [];
  for (const raw of paths) {
    const resolved = typeof raw === "string" ? resolveWorkspaceFile(workspace, raw) : null;
    if (!resolved) throw new DiError(`Receipt "${raw}" is not a file in your workspace. Use the _inbox/... path shown with the attachment.`);
    if (!resolved.rel.startsWith("_inbox/")) throw new DiError("Receipts must be chat attachments (a path under _inbox/).");
    let info;
    try { info = await stat(resolved.full); } catch { throw new DiError(`Receipt ${resolved.rel} was not found. Ask the user to attach it again.`); }
    if (!info.isFile()) throw new DiError(`${resolved.rel} is not a file`);
    if (info.size > RECEIPT_LIMITS.mb * 1024 * 1024) throw new DiError(`${path.basename(resolved.rel)} is larger than ${RECEIPT_LIMITS.mb} MB`);
    const buffer = await readFile(resolved.full);
    const mime = sniffMime(buffer);
    if (!mime || !RECEIPT_TYPES.includes(mime)) {
      throw new DiError(`${path.basename(resolved.rel)} is not a JPEG, PNG, WebP, GIF or PDF file (the file's contents decide, not its name)`);
    }
    const ref = await publish(resolved.rel);
    out.push({
      name: cleanReceiptName(path.basename(resolved.rel)), mime, bytes: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      path: new URL(ref.url, "http://local").pathname, url: ref.url, ref,
    });
  }
  return out;
}
