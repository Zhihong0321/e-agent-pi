import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { WORKSPACE } from "./paths.mjs";

/**
 * @param {string} [dir]
 * @param {string} [base]
 * @returns {Promise<{ path: string; size: number }[]>}
 */
export async function listWorkspaceFiles(dir = WORKSPACE, base = WORKSPACE) {
  /** @type {{ path: string; size: number }[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name === ".git") continue;
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
