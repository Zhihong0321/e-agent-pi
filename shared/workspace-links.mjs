/** Legacy workspace links only. Published /files/ URLs always pass through. */
export function workspaceFileUrl(agentId, src) {
  if (/^(https?:\/\/|data:|\/files\/|\/api\/files\/raw\?)/i.test(src)) return src;
  let rel = src.trim().replace(/\\/g, "/").replace(/^<|>$/g, "");
  rel = rel.replace(/^file:\/\//i, "");
  const owned = rel.match(/^\/storage\/workspaces\/([^/]+)\/(.+)$/);
  if (owned) { agentId = owned[1]; rel = owned[2]; }
  // Older file:// replies incorrectly put agent= in the filesystem path.
  rel = rel.split(/[?#]/)[0]
    .replace(/^\/storage\/workspace\//, "")
    .replace(/^\.\//, "");
  if (!rel || rel.includes("://")) return src;
  const query = new URLSearchParams({ path: rel });
  if (agentId) query.set("agent", agentId);
  return `/api/files/raw?${query.toString()}`;
}
