import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, lstat, realpath, readdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { DATA_DIR } from "./paths.mjs";

export const TEMP_SOURCE_ROOT = path.join(DATA_DIR, "temp", "web-sources");
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_STORAGE_BYTES = 250 * 1024 * 1024;

export function createSourceStore(root = TEMP_SOURCE_ROOT) {
  let queue = Promise.resolve();
  const exclusive = async (fn) => {
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  };
  const base = async () => {
    await mkdir(root, { recursive: true });
    if ((await lstat(root)).isSymbolicLink()) throw new Error("Temporary storage root must not be a symlink");
    return realpath(root);
  };
  const location = async (id) => {
    if (!ID.test(String(id))) throw new Error("Invalid temporary source ID");
    const parent = await base();
    const folder = path.join(parent, id);
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder) throw new Error("Unsafe temporary source directory");
    return folder;
  };
  const load = async (id) => {
    const folder = await location(id);
    for (const name of ["source.txt", "metadata.json"]) {
      const info = await lstat(path.join(folder, name));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe temporary source file");
    }
    const metadata = JSON.parse(await readFile(path.join(folder, "metadata.json"), "utf8"));
    let bytes = (await lstat(path.join(folder, "source.txt"))).size;
    try {
      const raw = await lstat(path.join(folder, "raw.md"));
      if (!raw.isFile() || raw.isSymbolicLink()) throw new Error("Unsafe scraper output file");
      bytes += raw.size;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { folder, metadata: { ...metadata, id, bytes } };
  };
  const list = async () => {
    const parent = await base();
    const sources = [];
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      try { sources.push((await load(entry.name)).metadata); }
      catch { /* Incomplete or externally altered directories are never read or deleted by cleanup. */ }
    }
    sources.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { sources, bytes: sources.reduce((sum, item) => sum + item.bytes, 0), limitBytes: MAX_STORAGE_BYTES, folder: root };
  };
  const save = async ({ text, url = "", finalUrl = url, title = "", headings = [], extraction = "provided-text", fetchedAt = new Date().toISOString() }) => exclusive(async () => {
    if (typeof text !== "string" || !text.trim()) throw new Error("No page text was extracted; nothing was saved");
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_SOURCE_BYTES) throw new Error("Page exceeds the 5 MB source limit; no truncated copy was saved");
    if ((await list()).bytes + bytes > MAX_STORAGE_BYTES) throw new Error("Temporary storage is full. Clear sources in Settings → Temporary storage.");
    const id = randomUUID();
    const parent = await base();
    const pending = path.join(parent, `.pending-${id}`);
    const sections = [];
    let cursor = 0;
    for (const heading of headings.slice(0, 200)) {
      const start = text.indexOf(heading, cursor);
      if (start < 0) continue;
      sections.push({ title: heading, start });
      cursor = start + heading.length;
    }
    sections.forEach((section, index) => { section.end = sections[index + 1]?.start ?? text.length; });
    const metadata = { id, url, finalUrl, title: String(title).slice(0, 500), bytes, chars: text.length, sha256: createHash("sha256").update(text).digest("hex"), fetchedAt, createdAt: new Date().toISOString(), extraction, sections, storedInFull: true, temporary: true };
    await mkdir(pending);
    try {
      await writeFile(path.join(pending, "source.txt"), text, { flag: "wx" });
      await writeFile(path.join(pending, "metadata.json"), JSON.stringify(metadata), { flag: "wx" });
      await rename(pending, path.join(parent, id));
    } finally { await rm(pending, { recursive: true, force: true }); }
    return metadata;
  });
  const read = async ({ id, offset = 0, limit = 12000, section, find }) => {
    const { folder, metadata } = await load(id);
    if (!metadata.storedInFull) throw new Error("Scraper output is not imported yet; finish import_web_source before reading it");
    const text = await readFile(path.join(folder, "source.txt"), "utf8");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 120000) throw new Error("offset must be non-negative and limit must be 1–120000 characters");
    let end = text.length;
    if (section) {
      const selected = metadata.sections.find(item => item.title.toLowerCase() === String(section).toLowerCase());
      if (!selected) throw new Error("Section not found. Read the source metadata for available sections.");
      offset = selected.start; end = selected.end;
    }
    if (find) {
      const index = text.toLowerCase().indexOf(String(find).toLowerCase(), offset);
      if (index < 0) return { id, found: false, chars: metadata.chars };
      offset = Math.max(0, index - 300);
    }
    const nextOffset = Math.min(offset + limit, end);
    return { id, url: metadata.url, title: metadata.title, chars: metadata.chars, offset, nextOffset, hasMore: nextOffset < end, text: text.slice(offset, nextOffset) };
  };
  const remove = async (ids) => exclusive(async () => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || ids.some(id => !ID.test(String(id)))) throw new Error("Provide 1–1000 valid source IDs");
    const targets = [];
    for (const id of new Set(ids)) {
      try { targets.push(await load(id)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    for (const target of targets) await rm(target.folder, { recursive: true });
    return { removed: targets.length, bytes: targets.reduce((sum, item) => sum + item.metadata.bytes, 0) };
  });
  const allocate = async ({ url = "", title = "Scraper output awaiting import" }) => exclusive(async () => {
    const id = randomUUID();
    const folder = path.join(await base(), id);
    if ((await list()).bytes >= MAX_STORAGE_BYTES) throw new Error("Temporary storage is full");
    await mkdir(folder);
    const metadata = { id, url, finalUrl: url, title, bytes: 0, chars: 0, createdAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), sections: [], storedInFull: false, temporary: true, extraction: "pending-scrape" };
    await writeFile(path.join(folder, "source.txt"), "");
    await writeFile(path.join(folder, "metadata.json"), JSON.stringify(metadata));
    return { ...metadata, outputPath: path.join(folder, "raw.md") };
  });
  const importFile = async ({ id }) => exclusive(async () => {
    const { folder, metadata } = await load(id);
    if (metadata.storedInFull) return { ...metadata, reused: true };
    const rawPath = path.join(folder, "raw.md");
    const info = await lstat(rawPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe scraper output file");
    if (info.size > MAX_SOURCE_BYTES) throw new Error("Scraper output exceeds 5 MB; no truncated copy was imported");
    if ((await list()).bytes > MAX_STORAGE_BYTES) throw new Error("Temporary storage is full. Clear unused sources before importing.");
    const text = await readFile(rawPath, "utf8");
    if (!text.trim()) throw new Error("Scraper produced an empty file");
    const completed = { ...metadata, bytes: Buffer.byteLength(text), chars: text.length, storedInFull: true, extraction: "scraper-file", sha256: createHash("sha256").update(text).digest("hex"), fetchedAt: new Date().toISOString() };
    await writeFile(path.join(folder, "source.txt"), text);
    await writeFile(path.join(folder, "metadata.json"), JSON.stringify(completed));
    await rm(rawPath);
    return completed;
  });
  return { list, save, read, remove, allocate, importFile, metadata: async id => (await load(id)).metadata };
}

export const sourceStore = createSourceStore();
