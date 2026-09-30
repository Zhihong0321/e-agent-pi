// Structured references, never filenames inferred from assistant prose.
export function sharedFilesFromResult(value) {
  const found = new Map();
  const visit = (item, depth = 0) => {
    if (depth > 12 || item == null) return;
    if (typeof item === "string") {
      try { visit(JSON.parse(item), depth + 1); } catch { /* prose is not a file reference */ }
      return;
    }
    if (typeof item !== "object") return;
    if (Array.isArray(item.shared_files)) {
      for (const file of item.shared_files) {
        if (!file || !/^[a-f0-9]{64}$/.test(file.id || "") || typeof file.name !== "string" || typeof file.url !== "string") continue;
        try {
          const url = new URL(file.url, "http://local");
          if (url.pathname !== `/files/${file.id}/${encodeURIComponent(file.name)}`) continue;
          found.set(file.id, { id: file.id, name: file.name, bytes: file.bytes, url: url.pathname });
        } catch { /* malformed reference */ }
      }
    }
    for (const nested of Object.values(item)) visit(nested, depth + 1);
  };
  visit(value);
  return [...found.values()];
}

export function filesFromBlocks(blocks = []) {
  return sharedFilesFromResult({ shared_files: blocks.flatMap((block) => block.shared_files || []) });
}
