import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dbReady, insertGitSync, latestGitSync, setSetting } from "./db.mjs";
import { SEED_INDEX, WORKSPACE } from "./paths.mjs";

const DEFAULT_BRANCH = "main";

async function recordSync(row) {
  if (!dbReady()) return null;
  try {
    return await insertGitSync(row);
  } catch {
    return null;
  }
}

async function saveSetting(key, value) {
  if (!dbReady()) return;
  try {
    await setSetting(key, value);
  } catch {
    // ignore
  }
}
/**
 * @returns {{ token: string; repo: string; branch: string } | null}
 */
export function githubConfig() {
  const token = process.env.GITHUB_TOKEN?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  const branch = process.env.GITHUB_BRANCH?.trim() || DEFAULT_BRANCH;
  if (!token || !repo) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("GITHUB_REPO must be owner/name");
  }
  return { token, repo, branch };
}

function publicUrl(repo, branch, sha) {
  if (!repo) return null;
  if (sha) return `https://github.com/${repo}/commit/${sha}`;
  if (branch) return `https://github.com/${repo}/tree/${branch}`;
  return `https://github.com/${repo}`;
}

function originUrl(repo) {
  return `https://github.com/${repo}.git`;
}

function authHeader(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `Authorization: Basic ${basic}`;
}

function sanitizeGit(text) {
  return String(text || "")
    .replace(/x-access-token:[^@\s]+/gi, "x-access-token:***")
    .replace(/ghp_[A-Za-z0-9]+/g, "ghp_***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***")
    .replace(/Basic [A-Za-z0-9+/=]+/g, "Basic ***");
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {string | null} token
 */
function git(args, cwd, token = null) {
  const fullArgs = token ? ["-c", `http.extraHeader=${authHeader(token)}`, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn("git", fullArgs, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => reject(new Error(sanitizeGit(error.message))));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(sanitizeGit(stderr || stdout || `git ${args[0]} failed`)));
        return;
      }
      resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function pathExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function dirHasFiles(dir) {
  try {
    const entries = await readdir(dir);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function currentSha() {
  try {
    const { stdout } = await git(["rev-parse", "HEAD"], WORKSPACE);
    return stdout || null;
  } catch {
    return null;
  }
}

async function isDirty() {
  try {
    const { stdout } = await git(["status", "--porcelain"], WORKSPACE);
    return Boolean(stdout);
  } catch {
    return false;
  }
}

async function seedWorkspace() {
  await mkdir(WORKSPACE, { recursive: true });
  if (await dirHasFiles(WORKSPACE)) return;
  const source = await readFile(SEED_INDEX, "utf8");
  await writeFile(path.join(WORKSPACE, "index.html"), source);
}

async function configureIdentity() {
  await git(["config", "user.name", "Website Dev Agent"], WORKSPACE);
  await git(["config", "user.email", "agent@workspace.local"], WORKSPACE);
}

/**
 * Clone or update the volume workspace from GitHub. Never wipes a dirty tree.
 */
export async function initWorkspace() {
  await mkdir(WORKSPACE, { recursive: true });

  let config = null;
  try {
    config = githubConfig();
  } catch (error) {
    await seedWorkspace();
    await recordSync({
      status: "error",
      message: error instanceof Error ? error.message : "Invalid GitHub config",
    });
    return getGitStatus();
  }

  if (!config) {
    await seedWorkspace();
    return getGitStatus();
  }

  const gitDir = path.join(WORKSPACE, ".git");
  try {
    if (!(await pathExists(gitDir))) {
      if (await dirHasFiles(WORKSPACE)) {
        await recordSync({
          status: "error",
          message: "Workspace already has files and is not a git clone; leaving it as-is",
        });
        return getGitStatus();
      }

      await git(
        ["clone", "--branch", config.branch, "--single-branch", originUrl(config.repo), "."],
        WORKSPACE,
        config.token,
      );
      await git(["remote", "set-url", "origin", originUrl(config.repo)], WORKSPACE);
      await configureIdentity();
    } else {
      await configureIdentity();
      await git(["remote", "set-url", "origin", originUrl(config.repo)], WORKSPACE);
      await git(["fetch", "origin", config.branch], WORKSPACE, config.token);
      if (!(await isDirty())) {
        await git(["reset", "--hard", `origin/${config.branch}`], WORKSPACE);
      }
    }

    const sha = await currentSha();
    await saveSetting("github_repo", config.repo);
    await saveSetting("github_branch", config.branch);
    if (sha) await saveSetting("last_commit_sha", sha);
    await recordSync({ sha, status: "ok", message: "workspace ready" });
  } catch (error) {
    await seedWorkspace();
    await recordSync({
      status: "error",
      message: error instanceof Error ? error.message : "GitHub sync failed",
    });
  }

  return getGitStatus();
}

/**
 * Commit and push if the workspace has changes.
 */
export async function syncWorkspace(message = "Website Dev Agent: workspace update") {
  const config = githubConfig();
  if (!config) {
    return getGitStatus();
  }
  if (!(await pathExists(path.join(WORKSPACE, ".git")))) {
    await recordSync({ status: "error", message: "Workspace is not a git clone" });
    return getGitStatus();
  }

  try {
    if (!(await isDirty())) {
      return getGitStatus();
    }

    await configureIdentity();
    await git(["add", "-A"], WORKSPACE);
    await git(["commit", "-m", message], WORKSPACE);
    await git(["push", "origin", `HEAD:${config.branch}`], WORKSPACE, config.token);
    const sha = await currentSha();
    if (sha) await saveSetting("last_commit_sha", sha);
    await recordSync({ sha, status: "ok", message: "pushed" });
  } catch (error) {
    await recordSync({
      status: "error",
      message: error instanceof Error ? error.message : "git push failed",
    });
  }

  return getGitStatus();
}

export async function getGitStatus() {
  let config = null;
  try {
    config = githubConfig();
  } catch {
    config = null;
  }

  const connected = Boolean(config && (await pathExists(path.join(WORKSPACE, ".git"))));
  const repo = config?.repo ?? null;
  const branch = config?.branch ?? DEFAULT_BRANCH;
  const sha = connected ? await currentSha() : null;
  const dirty = connected ? await isDirty() : false;
  let last = null;
  try {
    last = dbReady() ? await latestGitSync() : null;
  } catch {
    last = null;
  }

  return {
    connected,
    configured: Boolean(config),
    repo,
    branch,
    sha,
    dirty,
    htmlUrl: publicUrl(repo, branch, sha),
    repoUrl: repo ? `https://github.com/${repo}` : null,
    lastError: last?.status === "error" ? last.message : null,
    lastSync: last
      ? { sha: last.sha, status: last.status, message: last.message, createdAt: last.createdAt }
      : null,
  };
}
