import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { WORKSPACE } from "./paths.mjs";

export const FILE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/**
 * Resolve a chat/workspace path to a file inside `workspace`. Rejects traversal.
 * @param {string} workspace
 * @param {string} rel
 * @returns {{ full: string; rel: string } | null}
 */
export function resolveWorkspaceFile(workspace, rel) {
  const raw = String(rel || "").trim();
  if (!raw || raw.includes("\0")) return null;
  const root = path.resolve(workspace);
  let candidate = raw.replace(/\\/g, "/").replace(/^file:\/\//i, "");
  candidate = candidate.replace(/^\/storage\/workspaces\/[^/]+\//, "");
  candidate = candidate.replace(/^\/storage\/workspace\//, "");
  candidate = candidate.replace(/^\.\//, "");

  const absTry = path.resolve(candidate);
  const relativeTry = path.resolve(root, candidate);
  const full = isInside(root, absTry) ? absTry : relativeTry;
  if (!isInside(root, full)) return null;

  const posix = path.relative(root, full).replaceAll("\\", "/");
  if (!posix || posix === ".git" || posix.startsWith(".git/") || posix.includes("/.git/")) return null;
  return { full, rel: posix };
}

/**
 * @param {string} filePath
 */
export function fileMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return FILE_MIME[ext] || "application/octet-stream";
}

function isInside(root, full) {
  return full === root || full.startsWith(root + path.sep);
}

/**
 * @param {string} [dir]
 * @param {string} [base]
 * @returns {Promise<{ path: string; size: number }[]>}
 */
export async function listWorkspaceFiles(dir = WORKSPACE, base = dir) {
  /** @type {{ path: string; size: number }[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "_inbox" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listWorkspaceFiles(full, base)));
      continue;
    }
    const info = await stat(full);
    out.push({
      path: path.relative(base, full).replaceAll("\\", "/"),
      size: info.size,
    });
  }

  return out.sort((a, b) => a.path.localeCompare(b.path));
}
