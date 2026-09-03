import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachAgentResources,
  createMcpServer,
  getMcpServer,
  publicMcp,
  publicSkill,
  registerSkillDir,
  updateMcpServer,
  WEBSITE_AGENT_ID,
} from "./catalog.mjs";
import { SKILLS_DIR } from "./paths.mjs";

export const SCRAPLING_SKILL_SLUG = "scrapling-official";
export const SCRAPLING_MCP_SLUG = "scrapling";
export const SCRAPLING_DOCS = "https://scrapling.readthedocs.io/en/latest/ai/agent-skill.html";
export const SCRAPLING_ZIP_URL =
  "https://github.com/D4Vinci/Scrapling/raw/refs/heads/main/agent-skill/Scrapling-Skill.zip";
export const SCRAPLING_VENV = "/opt/scrapling";
export const SCRAPLING_BIN_DEFAULT = path.join(SCRAPLING_VENV, "bin", "scrapling");

const INSTALL_TIMEOUT_MS = 180_000;
const HOST_MARK_START = "<!-- cloud-pi-host:start -->";
const HOST_MARK_END = "<!-- cloud-pi-host:end -->";

export function scraplingSkillDir() {
  return path.join(SKILLS_DIR, SCRAPLING_SKILL_SLUG);
}

export function scraplingBinPath() {
  return process.env.SCRAPLING_BIN?.trim() || SCRAPLING_BIN_DEFAULT;
}

export async function scraplingBinExists(bin = scraplingBinPath()) {
  try {
    await access(bin, fsConstants.X_OK);
    return true;
  } catch {
    try {
      await access(bin, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export async function scraplingPublic() {
  const bin = scraplingBinPath();
  const present = await scraplingBinExists(bin);
  return {
    bin,
    present,
    skillSlug: SCRAPLING_SKILL_SLUG,
    mcpSlug: SCRAPLING_MCP_SLUG,
  };
}

async function skillMarkdownExists(dir) {
  try {
    await access(path.join(dir, "SKILL.md"), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command, args, { cwd, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = (stderr || stdout).trim().slice(-2000);
      reject(new Error(`${command} exited ${code}${detail ? `: ${detail}` : ""}`));
    });
  });
}

async function findSkillDir(root, depth = 4) {
  if (await skillMarkdownExists(root)) return root;
  if (depth <= 0) return null;
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findSkillDir(path.join(root, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

function hostOverlay() {
  const bin = scraplingBinPath();
  const python = path.join(SCRAPLING_VENV, "bin", "python");
  return `${HOST_MARK_START}

## Cloud Pi host (read this first)

Scrapling is already installed on this Railway host. Do **not** create a venv, \`pip install\`, \`scrapling install\`, or \`docker pull\`.

- CLI: \`${bin}\` (also \`scrapling\` on \`PATH\`)
- Python: \`${python}\` — not system \`python3\`
- MCP server slug \`scrapling\` is attached. Prefer MCP tools for one-off page fetches.
- Always pass \`--ai-targeted\` on \`scrapling extract …\` CLI commands.
- Escalate: \`extract get\` → \`extract fetch\` → \`extract stealthy-fetch --solve-cloudflare\`.
- Write scrape output under \`/tmp\`, then copy into the website workspace only what belongs on the live site. Do not leave Python spiders in the site bundle.
- This container runs as root: if a browser fetch fails on sandbox/\`/dev/shm\`, retry headless with Chromium \`--no-sandbox\` and \`--disable-dev-shm-usage\` if the API/CLI allows extra flags.

${HOST_MARK_END}
`;
}

function withHostOverlay(markdown) {
  const overlay = hostOverlay();
  const stripped = String(markdown || "").replace(
    new RegExp(`${HOST_MARK_START}[\\s\\S]*?${HOST_MARK_END}\\n*`, "g"),
    "",
  );
  const match = stripped.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)/);
  if (match) return `${match[1]}\n${overlay}${stripped.slice(match[1].length)}`;
  return `${overlay}${stripped}`;
}

async function extractZip(zipPath, dest) {
  const attempts = [
    ["python3", ["-m", "zipfile", "-e", zipPath, dest]],
    ["python", ["-m", "zipfile", "-e", zipPath, dest]],
    ["unzip", ["-q", "-o", zipPath, "-d", dest]],
  ];
  /** @type {Error | null} */
  let last = null;
  for (const [command, args] of attempts) {
    try {
      await run(command, args);
      return;
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw last || new Error("Could not extract skill zip");
}

/**
 * Official Scrapling Agent Skill pack into the host library. Never the GitHub workspace.
 *
 * @param {{ force?: boolean }} [opts]
 */
export async function installScraplingSkill({ force = false } = {}) {
  const dest = scraplingSkillDir();
  if (!force && (await skillMarkdownExists(dest))) {
    const current = await readFile(path.join(dest, "SKILL.md"), "utf8");
    if (!current.includes(HOST_MARK_START)) {
      await writeFile(path.join(dest, "SKILL.md"), withHostOverlay(current), "utf8");
    }
    return { dest, skipped: true };
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "scrapling-skill-"));
  try {
    const zipPath = path.join(tmp, "Scrapling-Skill.zip");
    const res = await fetch(SCRAPLING_ZIP_URL);
    if (!res.ok) throw new Error(`Could not download Scrapling skill zip (${res.status}).`);
    await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));
    const unpack = path.join(tmp, "unpack");
    await mkdir(unpack, { recursive: true });
    await extractZip(zipPath, unpack);
    const src = await findSkillDir(unpack);
    if (!src) throw new Error("Scrapling zip did not contain SKILL.md");
    await mkdir(SKILLS_DIR, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest, { recursive: true });
    const markdown = await readFile(path.join(dest, "SKILL.md"), "utf8");
    await writeFile(path.join(dest, "SKILL.md"), withHostOverlay(markdown), "utf8");
    return { dest, skipped: false };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function ensureScraplingMcp() {
  const bin = scraplingBinPath();
  if (!(await scraplingBinExists(bin))) {
    return { attached: false, reason: `scrapling binary not found at ${bin}` };
  }
  const payload = {
    name: "Scrapling",
    slug: SCRAPLING_MCP_SLUG,
    command: bin,
    args: ["mcp"],
    description: "Fetch and extract live pages (HTTP, headless Chromium, stealth / Cloudflare).",
  };
  const existing = await getMcpServer(SCRAPLING_MCP_SLUG);
  const server = existing ? await updateMcpServer(existing.id, payload) : await createMcpServer(payload);
  await attachAgentResources(WEBSITE_AGENT_ID, { mcp: [SCRAPLING_MCP_SLUG] });
  return { attached: true, server: publicMcp(server) };
}

/**
 * Install the skill pack, register it, attach skill + MCP to Website Dev Agent.
 *
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureScraplingForWebsite({ force = false } = {}) {
  const installed = await installScraplingSkill({ force });
  const skill = await registerSkillDir({
    slug: SCRAPLING_SKILL_SLUG,
    source: "scrapling",
    sourceUrl: SCRAPLING_DOCS,
  });
  const agent = await attachAgentResources(WEBSITE_AGENT_ID, { skills: [SCRAPLING_SKILL_SLUG] });
  const mcp = await ensureScraplingMcp();
  return {
    skipped: installed.skipped,
    dest: installed.dest,
    skill: publicSkill(skill),
    mcp,
    attachedTo: agent.slug,
    bin: scraplingBinPath(),
    binPresent: await scraplingBinExists(),
    note: "Attached to Website Dev Agent. Next chat with that agent loads Scrapling. Do not copy the pack into the workspace.",
  };
}
