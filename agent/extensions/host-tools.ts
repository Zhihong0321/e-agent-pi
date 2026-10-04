// Registers the host-issued manifest as native named tools, plus finish_run.
// The manifest (and only the manifest) decides which tools exist; business
// calls go to the host bridge with the attempt-scoped worker token, and the
// host resolves identity, company and authorization — never this process.
import * as Type from "../../node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/typebox.mjs";
import { readFileSync } from "node:fs";

type ManifestTool = {
  id: string;
  description: string;
  kind: string;
  inputSchema: Record<string, unknown>;
};

type Manifest = {
  profileId: string;
  revision: string;
  toolIds: string[];
  tools: ManifestTool[];
};

const WORKER_URL = (process.env.EXECUTION_WORKER_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const WORKER_TOKEN = process.env.EXECUTION_WORKER_TOKEN || "";

function loadManifest(): Manifest {
  const file = process.env.EXECUTION_MANIFEST_FILE;
  if (!file) {
    // Not an execution run (or misconfigured): register nothing so stale
    // tool names can never widen what this process can do.
    return { profileId: "", revision: "0000000000000000", toolIds: [], tools: [] };
  }
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Manifest;
  } catch {
    return { profileId: "", revision: "0000000000000000", toolIds: [], tools: [] };
  }
}

const FINISH_RUN_SCHEMA = Type.Object({
  status: Type.Union([Type.Literal("done"), Type.Literal("blocked"), Type.Literal("failed")], {
    description: "done when the requested outcome is confirmed; blocked when input or permission is missing; failed when execution went wrong",
  }),
  summary: Type.String({ description: "What happened, for the user: outcome, evidence and exact artifact links" }),
  outputs: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Structured result fields for dependent tasks" })),
  sourceCallIds: Type.Optional(Type.Array(Type.String(), { description: "Ids of your successful host tool calls that back this completion" })),
  receiptIds: Type.Optional(Type.Array(Type.String(), { description: "Host-issued receipt ids backing this completion" })),
  artifactIds: Type.Optional(Type.Array(Type.String(), { description: "Published artifact ids" })),
  reasonCode: Type.Optional(Type.String({ description: "For blocked/failed: a short stable reason code such as MISSING_INPUT" })),
  missing: Type.Optional(Type.String({ description: "For blocked: the concrete missing input or next action" })),
});

async function callBridge(toolId: string, callId: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${WORKER_URL}/api/internal/execution/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WORKER_TOKEN}` },
    body: JSON.stringify({ callId, toolId, manifestRevision: MANIFEST.revision, args: args ?? {} }),
    signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data !== "object") {
    return { ok: false, error: { code: "EXECUTION_FAILED", message: `Host bridge returned HTTP ${res.status}` } };
  }
  return data;
}

const MANIFEST: Manifest = loadManifest();

export default function hostToolsExtension(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI) {
  for (const tool of MANIFEST.tools) {
    pi.registerTool({
      name: tool.id,
      label: tool.id.replace(/_/g, " "),
      description: tool.description,
      parameters: Type.Unsafe(tool.inputSchema as never),
      async execute(toolCallId: string, args: unknown, signal?: AbortSignal) {
        const result = await callBridge(tool.id, toolCallId, args, signal);
        const text = JSON.stringify(result);
        return {
          content: [{ type: "text" as const, text }],
          details: result,
          ...(result && typeof result === "object" && (result as { ok?: boolean }).ok === false
            ? { isError: true }
            : {}),
        };
      },
    });
  }

  pi.registerTool({
    name: "finish_run",
    label: "Finish run",
    description:
      "Submit the typed completion for this run. Ordinary assistant text is presentation only — this call is what records the outcome, releases dependent work and reports to the user. Call it exactly once, when the requested outcome is confirmed (done), missing input or permission (blocked), or execution failed (failed).",
    parameters: FINISH_RUN_SCHEMA,
    async execute(toolCallId: string, args: unknown, signal?: AbortSignal) {
      const result = await callBridge("finish_run", toolCallId, args, signal);
      const accepted = (result as { ok?: boolean; data?: { accepted?: boolean } })?.ok
        && (result as { data?: { accepted?: boolean } }).data?.accepted;
      return {
        content: [{
          type: "text" as const,
          text: accepted
            ? "Completion accepted. Stop now: do not call more tools and do not repeat work."
            : JSON.stringify(result),
        }],
        details: result,
        ...(accepted ? {} : { isError: true }),
      };
    },
  });
}
