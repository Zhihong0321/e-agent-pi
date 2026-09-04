import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadCatalog } from "./models.mjs";
import {
  DEFAULT_AGENT_ID,
  OPS_AGENT_ID,
  ROOT,
  RUNTIME_DIR,
  agentWorkspace,
  isProposalAgent,
} from "./paths.mjs";

export const CONTEXT_FILES = ["HOST.md", "PROJECT.md", "CODEMAP.md", "PLAYBOOKS.md", "STATE.md"];
export const AUTO_CONTINUE_PROMPT =
  "Continue. Finish the task and end with a result or one question.";
export const RESTART_CONTINUE_PREFIX =
  "The previous turn was cut off by a host restart. Continue the same task";

const INCOMPLETE_RE = /^(let me|i('| wi)ll|next,? i)/i;
const PATH_IN_CODEMAP_RE =
  /(?:^|[\s`|(,'"])([A-Za-z0-9_./-]+\.(?:html?|js|mjs|cjs|css|md|json|txt|svg|ya?ml))\b/g;

/**
 * @param {{ id?: string; slug?: string } | string | null | undefined} agent
 */
export function contextPackSlug(agent) {
  const id = typeof agent === "string" ? agent : agent?.id || "";
  const slug = typeof agent === "string" ? agent : agent?.slug || "";
  if (id === OPS_AGENT_ID || slug === "ops" || slug === "settings") return "settings";
  if (id === DEFAULT_AGENT_ID || slug === "website") return "website";
  return slug || id || "website";
}

function contextDir(slug) {
  return path.join(ROOT, "agent", "context", slug);
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * @param {string | null | undefined} modelId
 */
export async function modelHasVision(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return false;
  try {
    const catalog = await loadCatalog();
    const entry = catalog.find((row) => row.id === id || row.model === id);
    if (entry && typeof entry.vision === "boolean") return entry.vision;
  } catch {
    // catalog missing in tests
  }
  if (
    /^(gemini-3\.[178]-flash-(high|medium)|gemini-3\.1-pro-high|claude-sonnet-4-6)$/.test(id)
  ) {
    return true;
  }
  if (/kimi|luna/i.test(id)) return false;
  if (/gemini|claude|gpt-4o|gpt-5(?!\.6-luna)/i.test(id)) return true;
  return false;
}

/**
 * @param {string | null | undefined} modelId
 */
export async function visionLine(modelId) {
  const can = await modelHasVision(modelId);
  return can
    ? "- This model can read images you attach."
    : "- This model CANNOT see images. Ask for the text or the values.";
}

/**
 * @param {{ id?: string; slug?: string }} agent
 * @param {{ modelId?: string | null }} [opts]
 */
export async function loadContextPack(agent, { modelId } = {}) {
  const slug = contextPackSlug(agent);
  const parts = [];
  const shared = await readOptional(path.join(ROOT, "agent", "context", "_shared", "HOST-COMMON.md"));
  if (shared.trim()) parts.push(shared.trim());

  for (const name of CONTEXT_FILES) {
    if (name === "STATE.md") {
      const runtimeId = agent?.id || slug;
      const runtime = await readOptional(path.join(RUNTIME_DIR, runtimeId, "STATE.md"));
      if (runtime.trim()) {
        parts.push(runtime.trim());
        continue;
      }
    }
    const text = await readOptional(path.join(contextDir(slug), name));
    if (text.trim()) parts.push(text.trim());
  }

  parts.push(await visionLine(modelId));
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Hash pack files (not runtime STATE) so a pack edit restarts Pi.
 * Runtime journal updates rewrite ROLE.md without forcing a process restart.
 * @param {{ id?: string; slug?: string }} agent
 */
export async function contextPackFingerprint(agent) {
  const slug = contextPackSlug(agent);
  const files = [
    path.join(ROOT, "agent", "context", "_shared", "HOST-COMMON.md"),
    ...CONTEXT_FILES.filter((name) => name !== "STATE.md").map((name) => path.join(contextDir(slug), name)),
    path.join(contextDir(slug), "STATE.md"),
  ];
  const bits = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      bits.push(`${file}:${info.mtimeMs}:${info.size}`);
    } catch {
      bits.push(`${file}:missing`);
    }
  }
  bits.push(`vision-catalog`);
  return createHash("sha1").update(bits.join("|")).digest("hex").slice(0, 12);
}

function extractCodemapPaths(markdown) {
  /** @type {Set<string>} */
  const found = new Set();
  const text = String(markdown || "");
  PATH_IN_CODEMAP_RE.lastIndex = 0;
  let match;
  while ((match = PATH_IN_CODEMAP_RE.exec(text))) {
    const rel = match[1].replace(/^\.\//, "");
    if (rel.startsWith("http") || rel.includes("node_modules")) continue;
    found.add(rel);
  }
  return [...found];
}

/**
 * @param {{ id?: string; slug?: string }} agent
 * @param {{ modelId?: string | null }} [opts]
 */
export async function previewContextPack(agent, { modelId } = {}) {
  const slug = contextPackSlug(agent);
  const dir = contextDir(slug);
  const parts = [];
  /** @type {{ file: string; bytes: number }[]} */
  const listed = [];
  /** @type {string[]} */
  const missingFiles = [];

  async function add(file, label) {
    const text = await readOptional(file);
    if (!text) {
      listed.push({ file: label, bytes: 0 });
      return "";
    }
    listed.push({ file: label, bytes: Buffer.byteLength(text) });
    return text;
  }

  const shared = await add(
    path.join(ROOT, "agent", "context", "_shared", "HOST-COMMON.md"),
    "agent/context/_shared/HOST-COMMON.md",
  );
  const texts = [shared];
  for (const name of CONTEXT_FILES) {
    const runtimeId = agent?.id || slug;
    const file =
      name === "STATE.md"
        ? existsSync(path.join(RUNTIME_DIR, runtimeId, "STATE.md"))
          ? path.join(RUNTIME_DIR, runtimeId, "STATE.md")
          : path.join(dir, name)
        : path.join(dir, name);
    const label =
      name === "STATE.md" && file.startsWith(RUNTIME_DIR)
        ? `runtime/${runtimeId}/STATE.md`
        : `agent/context/${slug}/${name}`;
    texts.push(await add(file, label));
  }
  const vision = await visionLine(modelId);
  texts.push(vision);
  listed.push({ file: "vision", bytes: Buffer.byteLength(vision) });

  const assembled = texts.filter(Boolean).join("\n\n");
  const workspace = agentWorkspace(agent);
  const codemap = texts[1 + CONTEXT_FILES.indexOf("CODEMAP.md")] || (await readOptional(path.join(dir, "CODEMAP.md")));
  for (const rel of extractCodemapPaths(codemap)) {
    const full = path.join(workspace, rel);
    if (!existsSync(full)) missingFiles.push(rel);
  }

  return {
    text: assembled,
    tokensApprox: Math.ceil(assembled.length / 4),
    parts: listed,
    missingFiles,
  };
}

/**
 * @param {{ blocks?: { type?: string }[]; text?: string }} turn
 */
export function needsAutoContinue(turn) {
  const text = String(turn?.text || "").trim();
  const tools = (turn?.blocks || []).filter((block) => block.type === "tool").length;
  if (tools < 1) return false;
  if (!text) return true;
  if (INCOMPLETE_RE.test(text) && !text.endsWith("?")) return true;
  return false;
}

/**
 * @param {{ blocks?: object[]; text?: string }} a
 * @param {{ blocks?: object[]; text?: string }} b
 */
export function mergeTurns(a, b) {
  return {
    blocks: [...(a?.blocks || []), ...(b?.blocks || [])],
    text: String(b?.text || a?.text || "").trim(),
  };
}

/**
 * @param {{ blocks?: { type?: string; name?: string }[]; text?: string }} turn
 * @param {{ autoContinues?: number }} extra
 */
export function turnMetrics(turn, extra = {}) {
  const tools = (turn?.blocks || []).filter((block) => block.type === "tool");
  const firstEdit = tools.findIndex((block) =>
    /edit|write|replace|strreplace|create_file|apply_patch/i.test(String(block.name || "")),
  );
  return {
    toolCalls: tools.length,
    callsBeforeFirstEdit: firstEdit === -1 ? null : firstEdit + 1,
    autoContinues: extra.autoContinues || 0,
    endedWithoutText: !String(turn?.text || "").trim(),
  };
}

export function isRestartContinue(message) {
  return String(message || "").includes(RESTART_CONTINUE_PREFIX);
}

function runCapture(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      out += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(out.trim());
    }, 8_000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
  });
}

async function listRecentFiles(dir) {
  /** @type {{ name: string; mtime: number }[]} */
  const rows = [];
  async function walk(current, depth) {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "_inbox") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      try {
        const info = await stat(full);
        rows.push({ name: path.relative(dir, full).replaceAll("\\", "/"), mtime: info.mtimeMs });
      } catch {
        // skip
      }
    }
  }
  await walk(dir, 0);
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows
    .slice(0, 20)
    .map((row) => row.name)
    .join("\n");
}

/**
 * @param {{ id?: string; slug?: string }} agent
 */
export async function recoveryContext(agent) {
  const dir = agentWorkspace(agent);
  const bits = ["Do not read transcript logs. Recover from the snapshot below and continue the same task."];
  if (existsSync(path.join(dir, ".git"))) {
    const status = await runCapture("git", ["status", "--short"], dir);
    const diff = await runCapture("git", ["diff", "--stat"], dir);
    bits.push("## git status --short\n```\n" + (status || "(clean)") + "\n```");
    bits.push("## git diff --stat\n```\n" + (diff || "(no unstaged diff)") + "\n```");
  } else {
    const listing = await listRecentFiles(dir);
    bits.push("## recent files\n```\n" + (listing || "(empty)") + "\n```");
  }
  const slug = contextPackSlug(agent);
  const runtimeId = agent?.id || slug;
  const state =
    (await readOptional(path.join(RUNTIME_DIR, runtimeId, "STATE.md"))) ||
    (await readOptional(path.join(contextDir(slug), "STATE.md")));
  if (state.trim()) {
    const tail = state.trim().slice(-1800);
    bits.push("## STATE.md (tail)\n" + tail);
  }
  return bits.join("\n\n");
}

export async function enrichRestartPrompt(message, agent) {
  if (!isRestartContinue(message)) return message;
  const extra = await recoveryContext(agent);
  return `${String(message).trim()}\n\n${extra}`;
}

async function filesChangedSince(dir, sinceMs) {
  const names = [];
  async function walk(current, depth) {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "_inbox") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      try {
        const info = await stat(full);
        if (info.mtimeMs >= sinceMs) names.push(path.relative(dir, full).replaceAll("\\", "/"));
      } catch {
        // skip
      }
    }
  }
  await walk(dir, 0);
  return names.slice(0, 30);
}

/**
 * Append one host-owned journal entry. Leaves ## Open issues untouched.
 * @param {{ id?: string; slug?: string }} agent
 * @param {{
 *   sessionId?: string;
 *   text?: string;
 *   host?: { pushed?: boolean; git?: { sha?: string; pushed?: boolean }; url?: string; lastError?: string } | null;
 *   startedAt?: number;
 * }} info
 */
export async function appendStateJournal(agent, info = {}) {
  const slug = contextPackSlug(agent);
  const runtimeId = agent?.id || slug;
  const destDir = path.join(RUNTIME_DIR, runtimeId);
  const dest = path.join(destDir, "STATE.md");
  await mkdir(destDir, { recursive: true });

  let current = await readOptional(dest);
  if (!current.trim()) current = await readOptional(path.join(contextDir(slug), "STATE.md"));
  if (!current.trim()) {
    current = `# ${slug} — STATE\n\n## Open issues\n\n(none)\n\n## Recent changes\n\n`;
  }

  const dir = agentWorkspace(agent);
  let files = "";
  if (existsSync(path.join(dir, ".git"))) {
    files =
      (await runCapture("git", ["diff", "--stat", "HEAD~1"], dir)) ||
      (await runCapture("git", ["diff", "--stat"], dir));
  } else if (info.startedAt) {
    files = (await filesChangedSince(dir, info.startedAt)).join(", ");
  }
  files = String(files || "no file list")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);

  const summary = String(info.text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const sha = info.host?.git?.sha ? String(info.host.git.sha).slice(0, 7) : "";
  const publish =
    info.host?.lastError
      ? `publish error: ${info.host.lastError}`
      : info.host?.pushed || info.host?.git?.pushed
        ? `pushed ${sha}`.trim()
        : isProposalAgent(agent)
          ? `git ${sha || "clean"}`
          : info.host?.url
            ? "published"
            : "";
  const date = new Date().toISOString().slice(0, 10);
  const session = info.sessionId ? `session ${info.sessionId}` : "session";
  const entry = `- ${date} — ${session} — ${files}${publish ? ` — ${publish}` : ""}${summary ? ` — ${summary}` : ""}`;

  const openIdx = current.indexOf("## Open issues");
  const recentIdx = current.indexOf("## Recent changes");
  let head = current;
  let openBlock = "";
  let recentBlock = "";
  if (recentIdx >= 0) {
    head = current.slice(0, recentIdx).trimEnd();
    recentBlock = current.slice(recentIdx + "## Recent changes".length);
  }
  if (openIdx >= 0 && (recentIdx < 0 || openIdx < recentIdx)) {
    // keep Open issues as-is inside head
  } else if (openIdx < 0) {
    head = `${head}\n\n## Open issues\n\n(none)`;
  }

  const items = recentBlock
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("- "));
  items.unshift(entry);
  const kept = items.slice(0, 10).join("\n");
  const next = `${head.trimEnd()}\n\n## Recent changes\n\n${kept}\n`;
  await writeFile(dest, next, "utf8");
  return dest;
}
