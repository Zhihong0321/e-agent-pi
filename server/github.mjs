import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { dbReady, insertGitSync, latestGitSync, setSetting } from "./db.mjs";
import { secret } from "./secrets.mjs";
import { SEED_INDEX, WORKSPACE } from "./paths.mjs";

const DEFAULT_BRANCH = "main";
const WEBSITE_SYNC_REPO = "host-workspace";

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
  const token = secret("github_token");
  const repo = secret("github_repo");
  const branch = secret("github_branch") || DEFAULT_BRANCH;
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
function assertFixedBranch(args) {
  const cmd = args[0];
  if (cmd === "checkout" && (args.includes("-b") || args.includes("-B"))) {
    throw new Error("Refusing to create a git branch. Railway stays on the configured branch.");
  }
  if (cmd === "switch" && (args.includes("-c") || args.includes("--create") || args.includes("--orphan"))) {
    throw new Error("Refusing to create or switch git branches. Railway stays on the configured branch.");
  }
  if (cmd === "branch") {
    const flags = args.filter((a) => a.startsWith("-"));
    const names = args.slice(1).filter((a) => !a.startsWith("-"));
    const listing = flags.some((f) => f === "-l" || f === "--list" || f === "-a" || f === "-v" || f === "-vv");
    const deleting = flags.some((f) => f === "-d" || f === "-D" || f === "--delete");
    if (names.length && !listing && !deleting) {
      throw new Error("Refusing to create a git branch. Railway stays on the configured branch.");
    }
  }
  if (cmd === "push") {
    const dest = args.find((a) => a.includes(":"));
    if (!dest || !/^HEAD:[A-Za-z0-9._/-]+$/.test(dest)) {
      throw new Error("Push must target the existing configured branch only (git push origin HEAD:<branch>).");
    }
  }
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {string | null} token
 */
function git(args, cwd, token = null) {
  assertFixedBranch(args);
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

async function currentSha(cwd = WORKSPACE) {
  try {
    const { stdout } = await git(["rev-parse", "HEAD"], cwd);
    return stdout || null;
  } catch {
    return null;
  }
}

async function isDirty(cwd = WORKSPACE) {
  try {
    const { stdout } = await git(["status", "--porcelain"], cwd);
    return Boolean(stdout);
  } catch {
    return false;
  }
}

async function commitsAhead(cwd, branch) {
  try {
    const { stdout } = await git(["rev-list", "--count", `origin/${branch}..HEAD`], cwd);
    const n = Number.parseInt(String(stdout).trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    try {
      const { stdout } = await git(["status", "-sb"], cwd);
      const match = String(stdout).match(/ahead\s+(\d+)/i);
      return match ? Number(match[1]) : 0;
    } catch {
      return 0;
    }
  }
}

function explainGitError(error, repo) {
  const text = sanitizeGit(error instanceof Error ? error.message : String(error || "git failed")).trim();
  if (/403|Permission to .+ denied/i.test(text)) {
    return `${text}\nToken can sign in but cannot write https://github.com/${repo}. On Settings, paste a PAT with Contents: Write on ${repo} (classic: repo scope). A fine-grained token limited to another repo will 403 here.`;
  }
  return text;
}

async function currentBranchName(cwd) {
  try {
    const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Stay on the Railway branch. Never create a different one. */
async function ensureOnConfiguredBranch(cwd, branch) {
  const now = await currentBranchName(cwd);
  if (!now || now === branch || now === "HEAD") return;
  try {
    await git(["rev-parse", "--verify", branch], cwd);
  } catch {
    throw new Error(
      `Workspace is on '${now}'. Branch '${branch}' is missing locally. Refusing to create it — Railway deploys '${branch}' only.`,
    );
  }
  await git(["checkout", branch], cwd);
}

async function isAncestor(cwd, maybeAncestor, tip) {
  try {
    await git(["merge-base", "--is-ancestor", maybeAncestor, tip], cwd);
    return true;
  } catch {
    return false;
  }
}

/** Restore a host commit that a hard-reset dropped, if reflog still has it. */
async function recoverUnpushedFromReflog(cwd, branch) {
  try {
    const origin = (await git(["rev-parse", `origin/${branch}`], cwd)).stdout.trim();
    const { stdout } = await git(["reflog", "--format=%H %gs", "-n", "40"], cwd);
    for (const line of stdout.split("\n")) {
      const sha = line.slice(0, 40);
      if (!/^[0-9a-f]{40}$/.test(sha) || sha === origin) continue;
      if (await isAncestor(cwd, sha, `origin/${branch}`)) continue;
      await git(["reset", "--hard", sha], cwd);
      return sha;
    }
  } catch {
    return null;
  }
  return null;
}

async function configureIdentityAt(cwd, name = "Website Dev Agent") {
  await git(["config", "user.name", name], cwd);
  await git(["config", "user.email", "agent@workspace.local"], cwd);
}

async function ignoreInbox(cwd) {
  const exclude = path.join(cwd, ".git", "info", "exclude");
  try {
    await mkdir(path.dirname(exclude), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(exclude, "utf8");
    } catch {
      existing = "";
    }
    if (!existing.includes("_inbox/")) {
      await writeFile(exclude, `${existing.trim()}\n_inbox/\n`.trimStart(), "utf8");
    }
  } catch {
    // ignore
  }
}

async function seedWorkspace() {
  await mkdir(WORKSPACE, { recursive: true });
  if (await dirHasFiles(WORKSPACE)) return;
  const source = await readFile(SEED_INDEX, "utf8");
  await writeFile(path.join(WORKSPACE, "index.html"), source);
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
          repo: WEBSITE_SYNC_REPO,
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
      await configureIdentityAt(WORKSPACE);
    } else {
      await configureIdentityAt(WORKSPACE);
      await git(["remote", "set-url", "origin", originUrl(config.repo)], WORKSPACE);
      await git(["fetch", "origin", config.branch], WORKSPACE, config.token);
      if (!(await isDirty(WORKSPACE))) {
        await git(["reset", "--hard", `origin/${config.branch}`], WORKSPACE);
      }
    }

    const sha = await currentSha(WORKSPACE);
    await saveSetting("github_repo", config.repo);
    await saveSetting("github_branch", config.branch);
    if (sha) await saveSetting("last_commit_sha", sha);
    await recordSync({ repo: WEBSITE_SYNC_REPO, sha, status: "ok", message: "workspace ready" });
  } catch (error) {
    await seedWorkspace();
    await recordSync({
      repo: WEBSITE_SYNC_REPO,
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
    await recordSync({ repo: WEBSITE_SYNC_REPO, status: "error", message: "Workspace is not a git clone" });
    return getGitStatus();
  }

  try {
    if (!(await isDirty(WORKSPACE))) {
      return getGitStatus();
    }

    await configureIdentityAt(WORKSPACE);
    await git(["add", "-A"], WORKSPACE);
    await git(["commit", "-m", message], WORKSPACE);
    await git(["push", "origin", `HEAD:${config.branch}`], WORKSPACE, config.token);
    const sha = await currentSha(WORKSPACE);
    if (sha) await saveSetting("last_commit_sha", sha);
    await recordSync({ repo: WEBSITE_SYNC_REPO, sha, status: "ok", message: "pushed" });
  } catch (error) {
    await recordSync({
      repo: WEBSITE_SYNC_REPO,
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
  const sha = connected ? await currentSha(WORKSPACE) : null;
  const dirty = connected ? await isDirty(WORKSPACE) : false;
  let last = null;
  try {
    last = dbReady() ? await latestGitSync(WEBSITE_SYNC_REPO) : null;
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

/**
 * @param {{ repo?: string | null; branch?: string | null }} [input]
 */
export function repoConfig(input = {}) {
  const repo = String(input.repo || "").trim();
  const branch = String(input.branch || DEFAULT_BRANCH).trim() || DEFAULT_BRANCH;
  if (!repo) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("Repo must be owner/name");
  }
  return { token: secret("github_token") || "", repo, branch };
}

/**
 * Clone or fast-forward a dedicated agent workspace. Never wipes a dirty tree.
 * Public repos can clone without a token; push still needs github_token.
 * @param {{ dir: string; repo: string; branch?: string; identity?: string }} opts
 */
export async function initGitWorkspace(opts) {
  const dir = opts.dir;
  const config = repoConfig({ repo: opts.repo, branch: opts.branch });
  if (!config) {
    return {
      connected: false,
      configured: false,
      canPush: false,
      repo: null,
      branch: DEFAULT_BRANCH,
      sha: null,
      dirty: false,
      lastError: "No repo configured",
    };
  }

  await mkdir(dir, { recursive: true });
  const gitDir = path.join(dir, ".git");
  const token = config.token || null;
  const identity = opts.identity || "Proposal Agent";

  try {
    if (!(await pathExists(gitDir))) {
      if (await dirHasFiles(dir)) {
        await recordSync({
          repo: config.repo,
          status: "error",
          message: `${config.repo}: workspace has files and is not a git clone`,
        });
        return getGitWorkspaceStatus({ dir, repo: config.repo, branch: config.branch });
      }
      await git(["clone", "--branch", config.branch, "--single-branch", originUrl(config.repo), "."], dir, token);
      await git(["remote", "set-url", "origin", originUrl(config.repo)], dir);
    } else {
      await git(["remote", "set-url", "origin", originUrl(config.repo)], dir);
      await git(["fetch", "origin", config.branch], dir, token);
      await ensureOnConfiguredBranch(dir, config.branch);
      const dirty = await isDirty(dir);
      let ahead = await commitsAhead(dir, config.branch);
      if (!dirty && ahead === 0) {
        const recovered = await recoverUnpushedFromReflog(dir, config.branch);
        ahead = recovered ? await commitsAhead(dir, config.branch) : 0;
        if (!recovered) {
          await git(["reset", "--hard", `origin/${config.branch}`], dir);
        }
      }
    }
    await configureIdentityAt(dir, identity);
    await ignoreInbox(dir);
    const sha = await currentSha(dir);
    await recordSync({ repo: config.repo, sha, status: "ok", message: `${config.repo} ready` });
  } catch (error) {
    await recordSync({
      repo: config.repo,
      status: "error",
      message: error instanceof Error ? error.message : "GitHub clone failed",
    });
  }

  return getGitWorkspaceStatus({ dir, repo: config.repo, branch: config.branch });
}

/**
 * Commit and push changes in a dedicated agent workspace.
 * @param {{ dir: string; repo: string; branch?: string; message?: string; identity?: string }} opts
 */
export async function syncGitWorkspace(opts) {
  const dir = opts.dir;
  let config;
  try {
    config = repoConfig({ repo: opts.repo, branch: opts.branch });
  } catch (error) {
    await recordSync({
      repo: opts.repo,
      status: "error",
      message: error instanceof Error ? error.message : "Invalid repo",
    });
    return getGitWorkspaceStatus({ dir, repo: opts.repo, branch: opts.branch });
  }
  if (!config) {
    return getGitWorkspaceStatus({ dir, repo: opts.repo, branch: opts.branch });
  }
  if (!(await pathExists(path.join(dir, ".git")))) {
    await recordSync({
      repo: config.repo,
      status: "error",
      message: `${config.repo}: workspace is not a git clone`,
    });
    return getGitWorkspaceStatus({ dir, repo: config.repo, branch: config.branch });
  }
  if (!config.token) {
    await recordSync({
      repo: config.repo,
      status: "error",
      message: "Add a GitHub token on Settings to push proposal updates.",
    });
    return getGitWorkspaceStatus({ dir, repo: config.repo, branch: config.branch });
  }

  try {
    await configureIdentityAt(dir, opts.identity || "Proposal Agent");
    await ignoreInbox(dir);
    await ensureOnConfiguredBranch(dir, config.branch);
    if (await isDirty(dir)) {
      await git(["add", "-A"], dir);
      if (await isDirty(dir)) {
        await git(["commit", "-m", opts.message || "Proposal Agent: update"], dir);
      }
    }
    try {
      await git(["fetch", "origin", config.branch], dir, config.token);
    } catch {
      // Public fetch can fail with a bad token; still try to push local commits.
    }
    const ahead = await commitsAhead(dir, config.branch);
    if (ahead < 1) {
      return getGitWorkspaceStatus({ dir, repo: config.repo, branch: config.branch, pushed: false });
    }
    await git(["push", "origin", `HEAD:${config.branch}`], dir, config.token);
    const sha = await currentSha(dir);
    await recordSync({ repo: config.repo, sha, status: "ok", message: `${config.repo} pushed` });
    return getGitWorkspaceStatus({ dir, repo: config.repo, branch: config.branch, pushed: true });
  } catch (error) {
    await recordSync({
      repo: config.repo,
      status: "error",
      message: explainGitError(error, config.repo),
    });
    return getGitWorkspaceStatus({ dir, repo: config.repo, branch: config.branch });
  }
}

/**
 * @param {{ dir: string; repo?: string | null; branch?: string | null; pushed?: boolean }} opts
 */
export async function getGitWorkspaceStatus(opts) {
  let config = null;
  try {
    config = repoConfig({ repo: opts.repo, branch: opts.branch });
  } catch {
    config = null;
  }
  const dir = opts.dir;
  const connected = Boolean(config && (await pathExists(path.join(dir, ".git"))));
  const repo = config?.repo ?? opts.repo ?? null;
  const branch = config?.branch ?? opts.branch ?? DEFAULT_BRANCH;
  const sha = connected ? await currentSha(dir) : null;
  const dirty = connected ? await isDirty(dir) : false;
  let last = null;
  try {
    last = dbReady() ? await latestGitSync(repo) : null;
  } catch {
    last = null;
  }
  return {
    connected,
    configured: Boolean(config),
    canPush: Boolean(config?.token),
    repo,
    branch,
    sha,
    dirty,
    pushed: Boolean(opts.pushed),
    htmlUrl: publicUrl(repo, branch, sha),
    repoUrl: repo ? `https://github.com/${repo}` : null,
    lastError: last?.status === "error" ? last.message : null,
    lastSync: last
      ? { sha: last.sha, status: last.status, message: last.message, createdAt: last.createdAt }
      : null,
  };
}

/**
 * Extra system prompt for Proposal Agent: host pushes, agent does not.
 * @param {{ workspaceRepo?: string | null; workspaceBranch?: string | null; liveUrl?: string | null }} [agent]
 */
export function proposalSystemPrompt(agent = {}) {
  const live = agent.liveUrl || "https://ee-proposal-production.up.railway.app/shell.html#proposal";
  const repo = agent.workspaceRepo || "Zhihong0321/ee-proposal";
  const branch = agent.workspaceBranch || "main";
  const tokenSet = Boolean(secret("github_token"));
  if (!tokenSet) {
    return `## GitHub + Railway

GitHub token is missing. Tell the human: studio Settings → paste a token with write access to ${repo} → Save. Do not ask them to paste it in chat.

You never run git. You never create, rename, or switch branches. Railway deploys ${branch} only.
Live URL after a real push: ${live}
`;
  }
  return `## GitHub + Railway

After you edit files, the studio host commits and pushes THIS workspace to https://github.com/${repo} branch ${branch}. Railway deploys that same branch. Live: ${live}

You never run git. You never create, rename, or switch branches. Never checkout, never -b, never a new remote.

If the operator says push: do not lecture, do not explain the rule. One short line: the host pushes ${branch} when this turn ends. Then stop.

Do not claim GitHub or the live site already updated. The host appends the real result (pushed SHA, or the error) to this chat.
`;
}
