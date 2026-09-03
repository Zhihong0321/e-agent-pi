const RESULT_LIMIT = 4000;

/**
 * @typedef {{ type: "thinking"; text: string }
 *   | { type: "text"; text: string }
 *   | { type: "tool"; id: string; name: string; detail: string; result?: string; isError?: boolean; running?: boolean }
 *   | { type: "note"; text: string }} TurnBlock
 */

export function createTurn() {
  return {
    /** @type {TurnBlock[]} */
    blocks: [],
    text: "",
  };
}

export function parseTranscript(content) {
  if (!content || content[0] !== "{") return null;
  try {
    const data = JSON.parse(content);
    if (data?.v === 1 && Array.isArray(data.blocks)) return data;
  } catch {
    return null;
  }
  return null;
}

export function extractReply(content) {
  const parsed = parseTranscript(content);
  if (!parsed) return content ?? "";
  if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text.trim();
  const lastTool = [...parsed.blocks].reverse().find((block) => block.type === "tool");
  if (lastTool) return `${lastTool.name} ${lastTool.detail || ""}`.trim();
  const think = parsed.blocks.find((block) => block.type === "thinking" && block.text);
  if (think) return think.text.slice(0, 80);
  return "Agent reply";
}

export function serializeTurn(turn, extra = {}) {
  const blocks = turn.blocks.map((block) => {
    if (block.type !== "tool") return { ...block };
    return {
      type: "tool",
      id: block.id,
      name: block.name,
      detail: block.detail,
      result: block.result,
      isError: block.isError,
    };
  });
  return JSON.stringify({
    v: 1,
    text: turn.text,
    blocks,
    streaming: Boolean(extra.streaming),
  });
}

/**
 * Apply a Pi RPC event to the live turn and return a UI event, or null to skip.
 * @param {ReturnType<typeof createTurn>} turn
 * @param {Record<string, unknown>} event
 */
export function applyPiEvent(turn, event) {
  const type = event?.type;
  if (type === "agent_start") {
    return { type: "status", text: "Working…" };
  }
  if (type === "compaction_start") {
    pushNote(turn, "Compacting conversation…");
    return { type: "note", text: "Compacting conversation…" };
  }
  if (type === "auto_retry_start") {
    pushNote(turn, "Retrying…");
    return { type: "note", text: "Retrying…" };
  }
  if (type === "extension_error") {
    const text = String(event.error ?? event.message ?? "Extension error");
    pushNote(turn, text);
    return { type: "note", text };
  }
  if (type === "message_update") {
    return applyAssistantDelta(turn, event.assistantMessageEvent);
  }
  if (type === "tool_execution_start") {
    const id = String(event.toolCallId ?? event.id ?? `tool-${turn.blocks.length}`);
    const name = String(event.toolName ?? "tool");
    const detail = toolDetail(name, event.args);
    upsertTool(turn, id, { name, detail, running: true });
    return { type: "tool", phase: "start", id, name, detail, status: statusForTool(name, detail) };
  }
  if (type === "tool_execution_update") {
    const id = String(event.toolCallId ?? event.id ?? "");
    const name = String(event.toolName ?? "tool");
    const detail = toolDetail(name, event.args);
    const result = clip(resultText(event.partialResult));
    upsertTool(turn, id || name, { name, detail, result, running: true });
    return { type: "tool", phase: "update", id, name, detail, result, status: statusForTool(name, detail) };
  }
  if (type === "tool_execution_end") {
    const id = String(event.toolCallId ?? event.id ?? "");
    const name = String(event.toolName ?? "tool");
    const detail = toolDetail(name, event.args);
    const result = clip(resultText(event.result));
    const isError = Boolean(event.isError);
    upsertTool(turn, id || name, { name, detail, result, isError, running: false });
    return { type: "tool", phase: "end", id, name, detail, result, isError };
  }
  if (type === "message_end" && event.message && typeof event.message === "object") {
    const message = /** @type {Record<string, unknown>} */ (event.message);
    if (message.role === "assistant") {
      const text = textFromMessage(message);
      if (text) turn.text = text;
      if (typeof message.errorMessage === "string" && message.errorMessage) {
        return { type: "error", error: message.errorMessage };
      }
    }
  }
  return null;
}

/**
 * @param {ReturnType<typeof createTurn>} turn
 * @param {Record<string, unknown> | undefined} delta
 */
function applyAssistantDelta(turn, delta) {
  if (!delta || typeof delta !== "object") return null;
  const kind = delta.type;
  if (kind === "thinking_delta" && typeof delta.delta === "string") {
    appendBlock(turn, "thinking", delta.delta);
    return { type: "thinking", delta: delta.delta, status: "Thinking…" };
  }
  if (kind === "text_delta" && typeof delta.delta === "string") {
    appendBlock(turn, "text", delta.delta);
    turn.text += delta.delta;
    return { type: "text", delta: delta.delta };
  }
  if (kind === "toolcall_start") {
    const id = String(delta.id ?? `call-${turn.blocks.length}`);
    const name = String(delta.toolName ?? "tool");
    upsertTool(turn, id, { name, detail: "", running: true });
    return { type: "tool", phase: "start", id, name, detail: "", status: `Calling ${name}…` };
  }
  if (kind === "toolcall_end" && delta.toolCall && typeof delta.toolCall === "object") {
    const call = /** @type {Record<string, unknown>} */ (delta.toolCall);
    const id = String(call.id ?? delta.id ?? "");
    const name = String(call.name ?? call.toolName ?? delta.toolName ?? "tool");
    const args = call.arguments ?? call.args;
    const detail = toolDetail(name, args);
    upsertTool(turn, id || name, { name, detail, running: true });
    return { type: "tool", phase: "start", id, name, detail, status: statusForTool(name, detail) };
  }
  return null;
}

/**
 * @param {ReturnType<typeof createTurn>} turn
 * @param {"thinking" | "text"} type
 * @param {string} delta
 */
function appendBlock(turn, type, delta) {
  const last = turn.blocks[turn.blocks.length - 1];
  if (last?.type === type) {
    last.text += delta;
    return;
  }
  turn.blocks.push({ type, text: delta });
}

/**
 * @param {ReturnType<typeof createTurn>} turn
 * @param {string} text
 */
function pushNote(turn, text) {
  turn.blocks.push({ type: "note", text });
}

/**
 * @param {ReturnType<typeof createTurn>} turn
 * @param {string} id
 * @param {Partial<Extract<TurnBlock, { type: "tool" }>>} patch
 */
function upsertTool(turn, id, patch) {
  const existing = turn.blocks.find((block) => block.type === "tool" && block.id === id);
  if (existing && existing.type === "tool") {
    if (patch.name) existing.name = patch.name;
    if (patch.detail) existing.detail = patch.detail;
    if (patch.result !== undefined) existing.result = patch.result;
    if (patch.isError !== undefined) existing.isError = patch.isError;
    if (patch.running !== undefined) existing.running = patch.running;
    return existing;
  }
  /** @type {Extract<TurnBlock, { type: "tool" }>} */
  const block = {
    type: "tool",
    id,
    name: patch.name || "tool",
    detail: patch.detail || "",
    result: patch.result,
    isError: patch.isError,
    running: patch.running ?? true,
  };
  turn.blocks.push(block);
  return block;
}

function statusForTool(name, detail) {
  return detail ? `${name} ${detail}` : name;
}

function toolDetail(name, args) {
  if (!args) return "";
  if (typeof args === "string") return clip(args, 160);
  if (typeof args !== "object") return String(args);
  const record = /** @type {Record<string, unknown>} */ (args);
  const keys = ["path", "file_path", "filePath", "command", "pattern", "query", "glob", "url", "description", "prompt", "agent", "id"];
  for (const key of keys) {
    if (record[key] != null) return clip(String(record[key]), 160);
  }
  const first = Object.values(record).find((value) => value != null && typeof value !== "object");
  return first == null ? "" : clip(String(first), 160);
}

function resultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const record = /** @type {Record<string, unknown>} */ (result);
  if (typeof record.text === "string") return record.text;
  if (Array.isArray(record.content)) {
    return record.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String(part.text ?? "");
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  if (record.details && typeof record.details === "object") {
    const details = /** @type {Record<string, unknown>} */ (record.details);
    if (typeof details.output === "string") return details.output;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function textFromMessage(message) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" || typeof part.text === "string") return String(part.text ?? "");
      return "";
    })
    .join("");
}

function clip(text, limit = RESULT_LIMIT) {
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
