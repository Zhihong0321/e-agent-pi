import { spawn } from "node:child_process";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgyBin } from "./test-agy.mjs";
import { createTurn } from "./pi-stream.mjs";
import { agentWorkspace, isProposalAgent, IMAGEN_SKILL_DIR, SKILLS_DIR } from "./paths.mjs";
import { imagenConfigured, imagenSystemPrompt } from "./imagen.mjs";
import { hostSystemPrompt } from "./ee-html.mjs";
import { proposalSystemPrompt } from "./github.mjs";
import { logEvent } from "./debug.mjs";
import { updateSession } from "./db.mjs";

export const AGY_MODELS = [
  {
    id: "gemini-3.8-flash-high",
    label: "Gemini 3.8 Flash (High)",
    shortLabel: "3.8F",
    provider: "Google AGY (OAuth)",
    model: "gemini-3.8-flash-high",
    available: true,
    engine: "agy",
  },
  {
    id: "gemini-3.8-flash-medium",
    label: "Gemini 3.8 Flash (Medium)",
    shortLabel: "3.8M",
    provider: "Google AGY (OAuth)",
    model: "gemini-3.8-flash-medium",
    available: true,
    engine: "agy",
  },
  {
    id: "gemini-3.7-flash-high",
    label: "Gemini 3.7 Flash (High)",
    shortLabel: "3.7F",
    provider: "Google AGY (OAuth)",
    model: "gemini-3.7-flash-high",
    available: true,
    engine: "agy",
  },
  {
    id: "gemini-3.1-pro-high",
    label: "Gemini 3.1 Pro (High)",
    shortLabel: "3.1P",
    provider: "Google AGY (OAuth)",
    model: "gemini-3.1-pro-high",
    available: true,
    engine: "agy",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6 (Thinking)",
    shortLabel: "S4.6",
    provider: "Google AGY (OAuth)",
    model: "claude-sonnet-4-6",
    available: true,
    engine: "agy",
  },
];

/**
 * Format AGY tool parameters into a compact detail string for UI display.
 * @param {string} name
 * @param {Record<string, unknown> | undefined} params
 * @returns {string}
 */
export function formatAgyToolDetail(name, params) {
  if (!params || typeof params !== "object") return "";
  if (params.CommandLine) return String(params.CommandLine);
  if (params.TargetFile) return String(params.TargetFile);
  if (params.AbsolutePath) return String(params.AbsolutePath);
  if (params.Path) return String(params.Path);
  if (params.DirectoryPath) return String(params.DirectoryPath);
  if (params.Pattern) return String(params.Pattern);
  if (params.Query) return String(params.Query);
  if (params.Url) return String(params.Url);
  if (params.Prompt) {
    const p = String(params.Prompt);
    return p.length > 80 ? `${p.slice(0, 77)}…` : p;
  }
  if (params.Instruction) return String(params.Instruction);
  try {
    const keys = Object.keys(params);
    if (keys.length === 1 && typeof params[keys[0]] === "string") {
      return String(params[keys[0]]);
    }
    const str = JSON.stringify(params);
    return str.length > 80 ? `${str.slice(0, 77)}…` : str;
  } catch {
    return "";
  }
}

/**
 * Materialize instructions and attached skills in the agent's workspace directory
 * so that AGY automatically discovers and obeys them.
 * @param {object} agent
 * @param {{ skills?: object[] }} [opts]
 */
export async function materializeAgyWorkspace(agent, { skills = [] } = {}) {
  const workspace = agentWorkspace(agent);
  await mkdir(workspace, { recursive: true });

  // 1. Build unified role prompt & host/git guidelines
  const role = String(agent.rolePrompt || "").trim();
  const extras = [imagenSystemPrompt()];
  if (agent.id === "website" || agent.slug === "website") extras.push(hostSystemPrompt());
  if (isProposalAgent(agent)) extras.push(proposalSystemPrompt(agent));
  const extraText = extras.filter(Boolean).join("\n\n");
  const fullInstructions = extraText ? `${role}\n\n${extraText}`.trim() + "\n" : `${role}\n`;

  // 2. Write AGENTS.md in the workspace directory (native rule discovery in AGY)
  await writeFile(path.join(workspace, "AGENTS.md"), fullInstructions, "utf8");

  // 3. Keep git clean if this workspace is a Git repository (e.g. Proposal Agent)
  try {
    const gitDir = path.join(workspace, ".git");
    if (existsSync(gitDir)) {
      const gitExclude = path.join(gitDir, "info", "exclude");
      await mkdir(path.join(gitDir, "info"), { recursive: true });
      let currentExclude = "";
      if (existsSync(gitExclude)) {
        currentExclude = await readFile(gitExclude, "utf8");
      }
      const additions = [];
      if (!currentExclude.includes("AGENTS.md")) additions.push("AGENTS.md");
      if (!currentExclude.includes(".agents")) additions.push(".agents");
      if (additions.length) {
        await appendFile(gitExclude, `\n${additions.join("\n")}\n`, "utf8");
      }
    }
  } catch (err) {
    logEvent("warn", `git exclude update skipped: ${err?.message || err}`);
  }

  // 4. Materialize attached skills under <workspace>/.agents/skills/
  const agentSkills = [...(skills.length ? skills : agent.skills || [])];
  if (imagenConfigured()) {
    agentSkills.push({ slug: "imagen", dirPath: IMAGEN_SKILL_DIR });
  }

  if (agentSkills.length) {
    const targetSkillsDir = path.join(workspace, ".agents", "skills");
    await mkdir(targetSkillsDir, { recursive: true });
    for (const skill of agentSkills) {
      if (!skill.dirPath && !skill.slug) continue;
      const srcDir = skill.dirPath || path.join(SKILLS_DIR, skill.slug);
      const skillName = skill.slug || path.basename(srcDir);
      const destDir = path.join(targetSkillsDir, skillName);
      if (existsSync(srcDir) && !existsSync(destDir)) {
        try {
          await cp(srcDir, destDir, { recursive: true });
        } catch (err) {
          logEvent("warn", `failed to copy skill ${skillName}: ${err?.message || err}`);
        }
      }
    }
  }

  return workspace;
}

/**
 * Apply an AGY NDJSON event to the live Turn object and invoke onEvent callback.
 * @param {ReturnType<typeof createTurn>} turn
 * @param {Record<string, any>} ev
 * @param {(event: any, liveTurn: ReturnType<typeof createTurn>) => void} [onEvent]
 */
function applyAgyStreamEvent(turn, ev, onEvent) {
  if (ev.event === "step_update" && ev.step_update) {
    const su = ev.step_update;

    // Stream text delta
    if (su.text_delta) {
      turn.text += su.text_delta;
      let lastBlock = turn.blocks[turn.blocks.length - 1];
      if (!lastBlock || lastBlock.type !== "text") {
        lastBlock = { type: "text", text: "" };
        turn.blocks.push(lastBlock);
      }
      lastBlock.text += su.text_delta;
      onEvent?.({ type: "text", delta: su.text_delta }, turn);
    }

    // Stream thinking / reasoning delta
    const thinkDelta = su.thinking_delta || su.thought_delta;
    if (thinkDelta) {
      let lastBlock = turn.blocks[turn.blocks.length - 1];
      if (!lastBlock || lastBlock.type !== "thinking") {
        lastBlock = { type: "thinking", text: "" };
        turn.blocks.push(lastBlock);
      }
      lastBlock.text += thinkDelta;
      onEvent?.({ type: "thinking", delta: thinkDelta }, turn);
    }

    // Tool execution
    if (su.step_type === "tool" || su.tool_name || su.tool_info) {
      const stepIndex = su.step_index ?? turn.blocks.length;
      const id = `tool-${stepIndex}`;
      const name = su.tool_name || su.tool_info?.name || "tool";
      const detail = formatAgyToolDetail(name, su.tool_info?.parameters);
      const isDone = su.state === "DONE";

      let block = turn.blocks.find((b) => b.type === "tool" && b.id === id);
      if (!block) {
        block = {
          type: "tool",
          id,
          name,
          detail,
          running: !isDone,
          result: isDone ? (su.tool_info?.output ?? "") : undefined,
        };
        turn.blocks.push(block);
      } else {
        block.running = !isDone;
        if (detail) block.detail = detail;
        if (isDone) {
          block.result = su.tool_info?.output ?? block.result ?? "";
        }
      }

      if (isDone) {
        onEvent?.(
          {
            type: "tool",
            phase: "end",
            id,
            name,
            detail: block.detail,
            result: block.result,
            status: "Done",
          },
          turn,
        );
      } else {
        onEvent?.(
          {
            type: "tool",
            phase: "start",
            id,
            name,
            detail,
            status: `${name} ${detail}`.trim(),
          },
          turn,
        );
      }
    }
  } else if (ev.event === "result" && ev.result) {
    if (ev.result.response && !turn.text.trim()) {
      turn.text = ev.result.response.trim();
      let textBlock = turn.blocks.find((b) => b.type === "text");
      if (!textBlock) {
        turn.blocks.push({ type: "text", text: turn.text });
      } else {
        textBlock.text = turn.text;
      }
    }
  }
}

/**
 * Execute a turn using the Antigravity (AGY) CLI engine.
 * @param {{
 *   message: string;
 *   modelId?: string;
 *   session: { id: string; agyConversationId?: string | null };
 *   profile: object;
 *   onEvent?: (event: any, liveTurn: ReturnType<typeof createTurn>) => void;
 *   images?: Array<{ path: string; mimeType?: string }>;
 * }} opts
 * @returns {Promise<ReturnType<typeof createTurn>>}
 */
export async function chatAgy({ message, modelId, session, profile, onEvent, images }) {
  const conversationId = session.agyConversationId || session.id;
  if (!session.agyConversationId) {
    session.agyConversationId = conversationId;
    await updateSession(session.id, { agyConversationId: conversationId }).catch(() => {});
  }

  const workspace = await materializeAgyWorkspace(profile, { skills: profile.skills });
  const model = modelId || "gemini-3.8-flash-high";
  const bin = resolveAgyBin();

  const args = [
    "-p",
    message,
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--conversation",
    conversationId,
  ];

  const turn = createTurn();
  onEvent?.({ type: "status", text: "Working with Antigravity…" }, turn);

  return new Promise((resolve, reject) => {
    let lineBuffer = "";
    let stderrBuffer = "";

    const child = spawn(bin, args, {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: os.homedir(),
        USER: process.env.USER || "root",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          applyAgyStreamEvent(turn, ev, onEvent);
        } catch {
          // Plain non-JSON log line, ignore
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      logEvent("error", `agy process error: ${err.message}`);
      reject(new Error(`Failed to spawn agy CLI: ${err.message}`));
    });

    child.on("close", (code) => {
      if (lineBuffer.trim()) {
        try {
          const ev = JSON.parse(lineBuffer.trim());
          applyAgyStreamEvent(turn, ev, onEvent);
        } catch {
          // ignore
        }
      }

      if (code !== 0 && !turn.text.trim() && !turn.blocks.length) {
        const errText = stderrBuffer.trim() || `agy exited with code ${code}`;
        logEvent("error", `agy turn failed: ${errText}`);
        reject(new Error(errText));
        return;
      }

      // Ensure at least a text block exists if turn.text is present
      if (turn.text.trim() && !turn.blocks.some((b) => b.type === "text")) {
        turn.blocks.push({ type: "text", text: turn.text.trim() });
      }

      if (!turn.text.trim() && !turn.blocks.length) {
        reject(new Error(stderrBuffer.trim() || "No response received from Antigravity agent."));
        return;
      }

      resolve(turn);
    });
  });
}
