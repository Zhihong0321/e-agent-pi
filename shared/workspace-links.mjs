/** Resolve workspace files without losing an explicit owning agent on relay. */
export function workspaceFileUrl(agentId, src) {
  if (/^(https?:\/\/|data:|\/api\/files\/raw\?)/i.test(src)) return src;
  let rel = src.trim().replace(/\\/g, "/").replace(/^<|>$/g, "");
  rel = rel.replace(/^file:\/\//i, "")
    .replace(/^\/storage\/workspaces\/[^/]+\//, "")
    .replace(/^\/storage\/workspace\//, "")
    .replace(/^\.\//, "");
  if (!rel || rel.includes("://")) return src;
  const query = new URLSearchParams({ path: rel });
  if (agentId) query.set("agent", agentId);
  return `/api/files/raw?${query.toString()}`;
}

export function workspaceArtifact(agentId, filePath, label, publicUrl) {
  const relativeUrl = workspaceFileUrl(agentId, filePath);
  const url = publicUrl ? new URL(relativeUrl, publicUrl).toString() : relativeUrl;
  return { path: filePath, agent: agentId, url, link: `[${label}](${url})` };
}

/** Qualify older specialist Markdown file links before another agent sees them. */
export function qualifyWorkspaceLinks(agentId, text, publicUrl) {
  return String(text || "").split(/(```[\s\S]*?```)/g).map((part, index) => {
    if (index % 2) return part;
    return part.replace(/(!?\[[^\]\n]*\]\()([^\s)]+)(\))/g, (match, prefix, href, suffix) => {
      if (/^(?:[a-z][a-z\d+.-]*:|#|\?|\/\/)/i.test(href)) return match;
      if (href.startsWith("/") && !/^\/storage\/workspaces?\//.test(href)) return match;
      if (!/\.[a-z\d]{1,10}$/i.test(href)) return match;
      const artifact = workspaceArtifact(agentId, href, "", publicUrl);
      return `${prefix}${artifact.url}${suffix}`;
    });
  }).join("");
}
