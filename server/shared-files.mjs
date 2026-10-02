// Completed files live on the persistent volume, independently of agents/chats.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveWorkspaceFile } from "./files.mjs";

function companyFolder(root, companyId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(companyId || "") && !/^[0-9a-f-]{36}$/i.test(companyId || "")) throw new Error("Company is required");
  return path.join(root, companyId);
}

function reference(id, name, bytes, publicUrl) {
  const href = `/files/${id}/${encodeURIComponent(name)}`;
  const url = publicUrl ? new URL(href, publicUrl).toString() : href;
  return { id, name, bytes, url, link: `[${name}](${url})` };
}

export async function readSharedFile({ root, companyId, id, name, publicUrl }) {
  if (!/^[a-f0-9]{64}$/.test(id || "") || !name || name !== path.basename(name) || /[\\/\0]/.test(name)) {
    throw new Error("Invalid shared file reference");
  }
  const full = path.join(companyFolder(root, companyId), id, name);
  const info = await stat(full);
  if (!info.isFile()) throw new Error("Shared file not found");
  return { full, file: reference(id, name, info.size, publicUrl) };
}

export async function publishFile({ root, companyId, workspace, source, publicUrl }) {
  const resolved = resolveWorkspaceFile(workspace, source);
  if (!resolved) throw new Error("File must be inside the agent workspace");
  const base = await realpath(workspace);
  const full = await realpath(resolved.full);
  const rel = path.relative(base, full);
  if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel) || rel.split(path.sep).includes(".git")) {
    throw new Error("File must be inside the agent workspace");
  }
  if (!(await stat(full)).isFile()) throw new Error("Only completed files can be shared");
  const name = path.basename(full).replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(-160);
  const folder = companyFolder(root, companyId);
  await mkdir(folder, { recursive: true });
  const temporary = path.join(folder, `.pending-${randomUUID()}`);
  const hash = createHash("sha256").update(`${name}\0`);
  let bytes = 0;
  try {
    await pipeline(createReadStream(full), new Transform({
      transform(chunk, encoding, callback) { hash.update(chunk); bytes += chunk.length; callback(null, chunk); },
    }), createWriteStream(temporary, { flags: "wx" }));
    if (!bytes) throw new Error("Cannot share an empty file");
    const id = hash.digest("hex");
    const target = path.join(folder, id, name);
    await mkdir(path.dirname(target), { recursive: true });
    // Hard-link the finished copy atomically. Existing versions are never replaced.
    try { await link(temporary, target); } catch (error) { if (error.code !== "EEXIST") throw error; }
    return (await readSharedFile({ root, companyId, id, name, publicUrl })).file;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function sharedFileLocation(href) {
  const match = new URL(href, "http://local").pathname.match(/^\/files\/([a-f0-9]{64})\/([^/]+)$/);
  if (!match) return null;
  return { id: match[1], name: decodeURIComponent(match[2]) };
}
