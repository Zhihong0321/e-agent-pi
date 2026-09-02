import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  attachAgentResources,
  publicSkill,
  registerSkillDir,
  WEBSITE_AGENT_ID,
} from "./catalog.mjs";
import { SKILLS_DIR } from "./paths.mjs";

export const IMPECCABLE_SLUG = "impeccable";
export const IMPECCABLE_DOCS = "https://impeccable.style/docs/";
const INSTALL_TIMEOUT_MS = 180_000;

export function impeccableSkillDir() {
  return path.join(SKILLS_DIR, IMPECCABLE_SLUG);
}

async function skillMarkdownExists(dir) {
  try {
    await access(path.join(dir, "SKILL.md"), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function findInstalledSkill(root) {
  const candidates = [
    path.join(root, ".pi", "skills", IMPECCABLE_SLUG),
    path.join(root, ".agents", "skills", IMPECCABLE_SLUG),
  ];
  for (const dir of candidates) {
    if (await skillMarkdownExists(dir)) return dir;
  }
  return null;
}

function runImpeccableInstall(cwd) {
  const bin = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["--yes", "impeccable", "install", "--providers=pi", "--scope=project"];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, npm_config_yes: "true", CI: "1" },
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
      reject(new Error(`impeccable install timed out after ${INSTALL_TIMEOUT_MS / 1000}s`));
    }, INSTALL_TIMEOUT_MS);
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
      reject(new Error(`impeccable install exited ${code}${detail ? `: ${detail}` : ""}`));
    });
  });
}

/**
 * Official Pi skill pack into the host library. Never the GitHub workspace:
 * Pi is launched with --no-skills, and the workspace remote would commit the pack.
 *
 * @param {{ force?: boolean }} [opts]
 */
export async function installImpeccableSkill({ force = false } = {}) {
  const dest = impeccableSkillDir();
  if (!force && (await skillMarkdownExists(dest))) {
    return { dest, skipped: true };
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), "impeccable-"));
  try {
    await runImpeccableInstall(tmp);
    const src = await findInstalledSkill(tmp);
    if (!src) {
      throw new Error("impeccable install did not write .pi/skills/impeccable/SKILL.md");
    }
    await mkdir(SKILLS_DIR, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await cp(src, dest, { recursive: true });
    return { dest, skipped: false };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Install (if needed), register in the catalog, attach to Website Dev Agent only.
 *
 * @param {{ force?: boolean }} [opts]
 */
export async function ensureImpeccableForWebsite({ force = false } = {}) {
  const installed = await installImpeccableSkill({ force });
  const skill = await registerSkillDir({
    slug: IMPECCABLE_SLUG,
    source: "impeccable",
    sourceUrl: IMPECCABLE_DOCS,
  });
  const agent = await attachAgentResources(WEBSITE_AGENT_ID, { skills: [IMPECCABLE_SLUG] });
  return {
    skipped: installed.skipped,
    dest: installed.dest,
    skill: publicSkill(skill),
    attachedTo: agent.slug,
    note: "Attached to Website Dev Agent only. Next chat with that agent loads /impeccable. Do not copy the pack into the workspace.",
  };
}
