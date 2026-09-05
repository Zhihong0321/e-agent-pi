import * as Type from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/typebox.mjs";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const TYPES = ["scout", "researcher", "worker", "reviewer"] as const;
type AgentKind = (typeof TYPES)[number];

const TOOLS: Record<AgentKind, string[]> = {
  scout: ["read", "grep", "find", "ls"],
  researcher: ["read", "grep", "find", "ls", "bash"],
  worker: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  reviewer: ["read", "grep", "find", "ls"],
};

const SHARED_RULES = `You are a focused sub-agent on this Cloud Pi host.

Rules:
- Work only inside the current working directory (the agent workspace).
- Never run git. Never git add/commit/push/init/clone. The host publishes or pushes.
- Never call host APIs, never zip-and-upload, never curl /api/apps.
- Use relative asset paths in HTML/CSS/JS.
- Stay on the assigned task. Return a concise result: what you found or changed, and file paths.
- Do not spawn further sub-agents. You do not have that tool.`;

const TYPE_PROMPT: Record<AgentKind, string> = {
  scout: `${SHARED_RULES}

You are scout: read-only recon. Map relevant files, entry points, and risks. Do not edit files.`,
  researcher: `${SHARED_RULES}

You are researcher: gather facts from the workspace and, if needed, fetch live pages with the scrapling CLI (\`scrapling extract get|fetch URL --ai-targeted\`). Write scrape output under /tmp. Do not edit site files unless the prompt explicitly says to copy a small asset in.`,
  worker: `${SHARED_RULES}

You are worker: implement the assigned change. Edit files, keep the design consistent, then summarize what changed.`,
  reviewer: `${SHARED_RULES}

You are reviewer: read-only review. Check correctness, accessibility, mobile layout, and simplicity. List concrete issues with file paths. Do not edit files.`,
};

const SPAWN_TOOLS = ["spawn_subagent", "subagent_status", "stop_subagent"];
const MAX_RUNNING = Math.max(1, Number(process.env.CLOUD_PI_SUBAGENT_MAX || 2) || 2);
const MAX_TURNS = Math.max(4, Number(process.env.CLOUD_PI_SUBAGENT_MAX_TURNS || 24) || 24);
const TIMEOUT_MS = Math.max(30_000, Number(process.env.CLOUD_PI_SUBAGENT_TIMEOUT_MS || 8 * 60_000) || 8 * 60_000);
const RESULT_CHARS = 8000;

type JobStatus = "queued" | "running" | "done" | "error" | "stopped";

type Job = {
  id: string;
  label: string;
  kind: AgentKind;
  status: JobStatus;
  startedAt: number;
  result?: string;
  abort: AbortController;
  session?: { abort: () => Promise<void>; dispose: () => void };
};

const jobs = new Map<string, Job>();
let running = 0;
const waiters: Array<() => void> = [];

function nextId() {
  return `sa-${Math.random().toString(16).slice(2, 6)}`;
}

function clip(text: string, limit = RESULT_CHARS) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…(truncated)`;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
      return "";
    })
    .join("");
}

function lastAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | undefined;
    if (msg?.role !== "assistant") continue;
    const text = flattenContent(msg.content).trim();
    if (text) return text;
  }
  return "";
}

function isKind(value: unknown): value is AgentKind {
  return TYPES.includes(value as AgentKind);
}

async function withSlot<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  while (running >= MAX_RUNNING) {
    if (signal?.aborted) throw new Error("aborted while queued");
    await new Promise<void>((resolve) => {
      const wake = () => {
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      waiters.push(wake);
      signal?.addEventListener("abort", wake, { once: true });
    });
  }
  if (signal?.aborted) throw new Error("aborted while queued");
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiters.shift()?.();
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    for (const job of jobs.values()) {
      job.abort.abort();
      await job.session?.abort().catch(() => {});
      job.session?.dispose();
      if (job.status === "queued" || job.status === "running") job.status = "stopped";
    }
    jobs.clear();
    running = 0;
    while (waiters.length) waiters.shift()?.();
  });

  pi.registerTool({
    name: "spawn_subagent",
    label: "Spawn sub-agent",
    description:
      "Run a focused child agent in an isolated session (same workspace). Use for independent parallel work: recon, research, implementation, or review. Children cannot spawn further agents.",
    promptSnippet: "Delegate independent work to an isolated scout/researcher/worker/reviewer sub-agent",
    promptGuidelines: [
      "Use spawn_subagent when the task splits into independent pieces that can run in parallel (several pages, recon then implement, implement then review).",
      "Prefer run_in_background true for two or more independent jobs; do not poll — a completion message arrives when each child finishes.",
      "Give each child a self-contained prompt with file paths and acceptance criteria. Do not spawn a sub-agent for a tiny one-file tweak you can do yourself.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the child. Include paths and done-when." }),
      description: Type.Optional(Type.String({ description: "Short 3-8 word label shown in the UI." })),
      agent: Type.Optional(
        Type.String({
          description: "scout (read-only recon), researcher (docs/live pages), worker (edits), reviewer (read-only review). Default worker.",
        }),
      ),
      run_in_background: Type.Optional(Type.Boolean({ description: "Return immediately and notify when done. Default false." })),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const kind: AgentKind = isKind(params.agent) ? params.agent : "worker";
      const prompt = String(params.prompt || "").trim();
      if (!prompt) {
        return { content: [{ type: "text" as const, text: "prompt is required" }], details: { error: "missing_prompt" } };
      }
      const label = String(params.description || prompt.split("\n")[0] || kind).trim().slice(0, 80);
      const background = Boolean(params.run_in_background);
      const id = nextId();
      const abort = new AbortController();
      const job: Job = { id, label, kind, status: "queued", startedAt: Date.now(), abort };
      jobs.set(id, job);

      const run = () => runChild(pi, ctx, job, prompt, signal, onUpdate, background);

      if (background) {
        void run().catch((error) => {
          if (job.status !== "error" && job.status !== "stopped") {
            job.status = "error";
            job.result = error instanceof Error ? error.message : String(error);
          }
          notifyParent(pi, job);
        });
        onUpdate?.({ content: [{ type: "text", text: `queued ${id} ${kind}: ${label}` }] });
        return {
          content: [
            {
              type: "text" as const,
              text: `Started ${id} (${kind}, background). ${label}\nDo not poll. A completion message arrives when it finishes. Use stop_subagent to cancel.`,
            },
          ],
          details: { id, agent: kind, background: true, label },
        };
      }

      const result = await run();
      return {
        content: [{ type: "text" as const, text: result }],
        details: { id, agent: kind, background: false, label, status: job.status },
      };
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Sub-agent status",
    description: "List running and recent sub-agents.",
    promptSnippet: "List spawned sub-agents and their status",
    parameters: Type.Object({}),
    async execute() {
      const lines = [...jobs.values()].map(
        (job) => `${job.id} ${job.status} ${job.kind} ${job.label}${job.result ? ` — ${job.result.slice(0, 120)}` : ""}`,
      );
      const text = lines.length ? lines.join("\n") : "No sub-agents in this session.";
      return { content: [{ type: "text" as const, text }], details: { count: jobs.size, running } };
    },
  });

  pi.registerTool({
    name: "stop_subagent",
    label: "Stop sub-agent",
    description: "Stop a queued or running sub-agent by id from spawn_subagent or subagent_status.",
    parameters: Type.Object({
      id: Type.String({ description: "Sub-agent id (sa-xxxx)." }),
    }),
    async execute(_toolCallId, params) {
      const job = jobs.get(String(params.id || ""));
      if (!job) {
        return { content: [{ type: "text" as const, text: `Unknown id ${params.id}` }], details: { error: "not_found" } };
      }
      job.abort.abort();
      await job.session?.abort().catch(() => {});
      if (job.status === "queued" || job.status === "running") job.status = "stopped";
      return { content: [{ type: "text" as const, text: `Stopped ${job.id} (${job.kind})` }], details: { id: job.id, status: job.status } };
    },
  });
}

async function runChild(
  pi: ExtensionAPI,
  ctx: { cwd: string; model?: unknown; thinkingLevel?: unknown },
  job: Job,
  prompt: string,
  parentSignal: AbortSignal | undefined,
  onUpdate: ((update: { content: Array<{ type: "text"; text: string }> }) => void) | undefined,
  background: boolean,
) {
  const combined = AbortSignal.any([job.abort.signal, parentSignal].filter((value): value is AbortSignal => Boolean(value)));
  return withSlot(combined, async () => {
    if (combined.aborted) {
      job.status = "stopped";
      throw new Error("aborted");
    }
    job.status = "running";
    onUpdate?.({ content: [{ type: "text", text: `running ${job.id} ${job.kind}: ${job.label}` }] });

    const agentDir = process.env.PI_CODING_AGENT_DIR || ctx.cwd;
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: TYPE_PROMPT[job.kind],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      ...(ctx.model ? { model: ctx.model as never } : {}),
      ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel as never } : {}),
      tools: TOOLS[job.kind],
      excludeTools: SPAWN_TOOLS,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(ctx.cwd),
    });
    job.session = session;

    let turns = 0;
    const unsub = session.subscribe((event) => {
      if (event.type === "agent_end") {
        turns += 1;
        if (turns >= MAX_TURNS) void session.abort();
      }
    });

    const timer = setTimeout(() => {
      job.abort.abort();
      void session.abort();
    }, TIMEOUT_MS);

    try {
      combined.addEventListener("abort", () => void session.abort(), { once: true });
      await session.prompt(
        `${prompt}\n\nWhen finished, reply with a short summary. Include file paths for anything you changed or inspected.`,
      );
      const text = clip(lastAssistantText(session.messages as unknown[])) || "(no text from sub-agent)";
      job.status = combined.aborted ? "stopped" : "done";
      job.result = text;
      return `${job.id} ${job.status} (${job.kind})\n${text}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.status = combined.aborted ? "stopped" : "error";
      job.result = clip(message);
      throw error;
    } finally {
      clearTimeout(timer);
      unsub();
      try {
        session.dispose();
      } catch {
        /* ignore */
      }
      job.session = undefined;
    }
  }).then((text) => {
    if (background) notifyParent(pi, job);
    return text;
  });
}

function notifyParent(pi: ExtensionAPI, job: Job) {
  const body = `${job.id} ${job.status} (${job.kind}) ${job.label}\n${job.result || ""}`;
  pi.sendMessage(
    {
      customType: "subagent-result",
      content: clip(`Sub-agent finished.\n${body}`, RESULT_CHARS + 200),
      display: true,
      details: { id: job.id, status: job.status, agent: job.kind, label: job.label },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}
