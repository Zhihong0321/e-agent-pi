// Shared domain types, constants and pure helpers for the Studio chat UI.
// Imported by use-studio.ts (state machine), chat-parts.tsx (components) and both shells.
import { IMAGE_EXT_RE } from "./chat-markdown";

export type Tab = "chats" | "agents" | "live" | "files";
export type View = Tab | "chat";
export type Sheet = null | "model" | "agent";
export type ChatFilter = "all" | "ask" | "done";
export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export const SESSION_KEY = "e-agent-active-session";
export const AGENT_KEY = "e-agent-active-agent";
export const FULLSCREEN_KEY = "e-agent-fullscreen";
export const AI_REPLY_DARK_KEY = "e-agent-ai-reply-dark";

export function prefersStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    Boolean((navigator as { standalone?: boolean }).standalone)
  );
}

export function readFullPreference() {
  if (prefersStandalone()) return true;
  try {
    return window.localStorage.getItem(FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function readAiReplyDarkPreference() {
  try {
    return window.localStorage.getItem(AI_REPLY_DARK_KEY) === "1";
  } catch {
    return false;
  }
}

export type ModelOption = {
  id: string;
  label: string;
  shortLabel: string;
  provider: string;
  model: string;
  available: boolean;
  engine?: "pi" | "agy" | string;
};

export type HostStatus = {
  configured: boolean;
  baseUrl: string;
  slug: string;
  name: string;
  url: string | null;
  lastError: string | null;
  pushed?: boolean;
  git?: { pushed?: boolean; sha?: string | null; lastError?: string | null };
};

export type TurnBlock =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; detail: string; result?: string; isError?: boolean; running?: boolean }
  | { type: "note"; text: string };

export type ChatMessage = {
  id?: number;
  role: "user" | "assistant";
  content: string;
  modelId?: string | null;
  sessionId?: string | null;
  blocks?: TurnBlock[];
  streaming?: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  engine?: "pi" | "agy" | string;
  agyConversationId?: string | null;
  modelId?: string | null;
  agentId?: string | null;
  preview?: string | null;
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
};

export type StreamEvent = {
  type: string;
  delta?: string;
  text?: string;
  id?: string;
  name?: string;
  detail?: string;
  result?: string;
  isError?: boolean;
  phase?: string;
  error?: string;
  status?: string;
  reply?: string;
  blocks?: TurnBlock[];
  host?: HostStatus;
  session?: ChatSession;
  sessionId?: string;
};

export type WorkspaceFile = { path: string; size: number };

export type Agent = {
  id: string;
  slug: string;
  name: string;
  short: string;
  headline: string;
  description: string;
  color: string;
  engine?: "pi" | "agy" | string;
  liveUrl?: string | null;
  workspaceRepo?: string | null;
  skills: { id: string; name: string; description: string }[];
  mcp: { id: string; name: string; description: string }[];
};

export type PendingFile = { name: string; mime: string; data: string };
export type SessionFlag = "ask" | "done" | "run" | "";

export const FALLBACK_AGENT: Agent = {
  id: "",
  slug: "website",
  name: "Website Dev Agent",
  short: "W",
  headline: "Builds and publishes your site",
  description: "Edits the workspace and publishes to ee-html. Never touches git.",
  color: "emerald",
  skills: [],
  mcp: [],
};

export function agentLiveUrl(agent?: Agent | null, host?: HostStatus | null) {
  if (agent?.liveUrl) return agent.liveUrl;
  if (host?.url) return host.url;
  if (host?.slug) return `${host.baseUrl}/app/${host.slug}/`;
  return null;
}

export function toolsLabel(agent: Agent) {
  const parts = [...(agent.skills ?? []).map((row) => row.name), ...(agent.mcp ?? []).map((row) => row.name)];
  return parts.length ? parts.join(" · ") : "Role only";
}

export const SHORT_MAX = 16;

/** The text drawn inside the avatar tile. Falls back to the first letter of the name. */
export function avatarLabel(short?: string | null, name?: string | null) {
  const text = (short ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, SHORT_MAX);
  const first = (name ?? "").trim().charAt(0);
  return (first || "A").toUpperCase();
}

/** Avatar classes, with a length step so longer labels shrink and wrap to fit the tile (up to 2 lines, ~8 chars each). */
export function avatarClass(label: string, extra = "") {
  const len = [...label].length;
  const step = len > 8 ? "len-16" : len > 4 ? "len-8" : len === 4 ? "len-4" : len === 3 ? "len-3" : "";
  return ["avatar", extra, step].filter(Boolean).join(" ");
}

export function toolCount(agent: Agent) {
  const n = (agent.skills?.length ?? 0) + (agent.mcp?.length ?? 0);
  return n ? `${n} tool${n === 1 ? "" : "s"}` : "Role only";
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? "Request failed", res.status);
  return data;
}

export const CONTINUE_PROMPT =
  "The previous turn was cut off by a host restart. Continue the same task immediately from where you left off. Do not wait. Do not ask the user to confirm.";

export function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function parseTranscript(content: string): { text?: string; blocks?: TurnBlock[]; streaming?: boolean } | null {
  if (!content || content[0] !== "{") return null;
  try {
    const data = JSON.parse(content) as { v?: number; text?: string; blocks?: TurnBlock[]; streaming?: boolean };
    if (data?.v === 1 && Array.isArray(data.blocks)) return data;
  } catch {
    return null;
  }
  return null;
}

export function hydrateMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role !== "assistant") return msg;
    const parsed = parseTranscript(msg.content);
    if (!parsed) return msg;
    return {
      ...msg,
      content: parsed.text ?? "",
      blocks: parsed.blocks,
      streaming: Boolean(parsed.streaming),
    };
  });
}

export function applyStreamEvent(blocks: TurnBlock[], event: StreamEvent): TurnBlock[] {
  if (event.type === "thinking" && event.delta) {
    const last = blocks[blocks.length - 1];
    if (last?.type === "thinking") {
      return [...blocks.slice(0, -1), { ...last, text: last.text + event.delta }];
    }
    return [...blocks, { type: "thinking", text: event.delta }];
  }
  if (event.type === "text" && event.delta) {
    const last = blocks[blocks.length - 1];
    if (last?.type === "text") {
      return [...blocks.slice(0, -1), { ...last, text: last.text + event.delta }];
    }
    return [...blocks, { type: "text", text: event.delta }];
  }
  if (event.type === "note" && event.text) {
    return [...blocks, { type: "note", text: event.text }];
  }
  if (event.type === "tool") {
    const id = event.id || `tool-${blocks.length}`;
    const index = blocks.findIndex((block) => block.type === "tool" && block.id === id);
    const next: TurnBlock = {
      type: "tool",
      id,
      name: event.name || "tool",
      detail: event.detail || "",
      result: event.result,
      isError: event.isError,
      running: event.phase !== "end",
    };
    if (index === -1) return [...blocks, next];
    const copy = [...blocks];
    const prev = copy[index];
    if (prev.type === "tool") {
      copy[index] = {
        ...prev,
        ...next,
        name: next.name || prev.name,
        detail: next.detail || prev.detail,
        result: next.result ?? prev.result,
      };
    }
    return copy;
  }
  return blocks;
}

export type SiriSignal = "idle" | "working" | "complete" | "ask";

export function assistantPlainText(msg: ChatMessage): string {
  const fromBlocks = (msg.blocks ?? [])
    .filter((block): block is Extract<TurnBlock, { type: "text" | "note" }> => block.type === "text" || block.type === "note")
    .map((block) => block.text)
    .join("\n");
  return (fromBlocks || msg.content || "").replace(/https?:\/\/\S+/g, " ").trim();
}

export function hadFinishedTools(msg: ChatMessage): boolean {
  return (msg.blocks ?? []).some((block) => block.type === "tool" && !block.running);
}

export const ASK_RE =
  /\b(which (one|option|approach|layout|color|style)|what (should|would|do) you|where should|how (should|would) you like|do you want|would you like|can you (confirm|choose|pick|tell)|could you|please (confirm|choose|pick|tell|let me know)|let me know|need you to|waiting (for|on) (your|you)|should i)\b/i;

export function looksLikeQuestion(text: string): boolean {
  if (!text) return false;
  const tail = text.slice(-900);
  const lastLines = tail.split(/\n/).slice(-4).join("\n").trim();
  if (/\?\s*$/.test(lastLines)) return true;
  const lastPara = tail.split(/\n{2,}/).pop() ?? tail;
  if (/\?/.test(lastPara) && lastPara.length < 600) return true;
  return ASK_RE.test(tail);
}

export function looksLikeCompletion(text: string, tools: boolean): boolean {
  if (tools) return true;
  return /\b(done|completed|finished|published|i('ve| have) (updated|created|added|changed|fixed|published|built)|live (url|at|site)|all set|ready to (view|open))\b/i.test(
    text,
  );
}

export function classifySiriSignal(history: ChatMessage[], loading: boolean, error: string): SiriSignal {
  if (loading) return "working";
  if (error) return "ask";
  const last = history[history.length - 1];
  if (!last || last.role !== "assistant" || last.streaming) return "idle";
  const text = assistantPlainText(last);
  if (!text && !hadFinishedTools(last)) return "idle";
  if (looksLikeQuestion(text)) return "ask";
  if (looksLikeCompletion(text, hadFinishedTools(last))) return "complete";
  return "idle";
}

export function classifySession(session: ChatSession, running: boolean): SessionFlag {
  if (running) return "run";
  const text = session.preview || "";
  if (!text) return "";
  if (looksLikeQuestion(text)) return "ask";
  if (looksLikeCompletion(text, true)) return "done";
  return session.messageCount ? "done" : "";
}

export function dayGroup(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThat = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = (startToday - startThat) / 86400000;
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function hostHost(url: string | null | undefined) {
  if (!url) return "";
  try {
    return new URL(url).host + new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

export function userVisibleContent(text: string, files: PendingFile[]) {
  const bits: string[] = [];
  if (text) bits.push(text);
  for (const file of files) {
    const image = file.mime.startsWith("image/") || IMAGE_EXT_RE.test(file.name);
    bits.push(image ? `![${file.name}](${file.data})` : `[${file.name}](${file.data})`);
  }
  return bits.join("\n\n");
}

/** `onPulse` fires on every chunk the socket delivers, heartbeat comments included; it is the liveness signal for the connection readout. */
export async function readSse(res: Response, onEvent: (event: StreamEvent) => void, onPulse?: () => void) {
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/event-stream")) {
    const data = (await res.json()) as { error?: string };
    throw new Error(data.error ?? "Request failed");
  }
  if (!res.body) throw new Error("No stream from agent.");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onPulse?.();
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let sep = buf.indexOf("\n\n");
    while (sep !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of raw.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        onEvent(JSON.parse(payload) as StreamEvent);
      }
      sep = buf.indexOf("\n\n");
    }
  }
}

export function groupSessions(sessions: ChatSession[]) {
  const map = new Map<string, ChatSession[]>();
  for (const session of sessions) {
    const label = dayGroup(session.updatedAt);
    const list = map.get(label) ?? [];
    list.push(session);
    map.set(label, list);
  }
  return [...map.entries()].map(([label, items]) => ({ label, items }));
}

export function promptsFor(agent?: Agent) {
  if (agent?.slug === "proposal") {
    return [
      "Change the client name on the proposal cover",
      "List the proposal workspace files",
      "Update the package to 36pcs Jinko 650W",
    ];
  }
  if (agent?.slug === "package") {
    return [
      "List active Residential packages for 8–12 panels",
      "Show the BOM for [1P] STRING SAJ JINKO 8 PCS 650W",
      "What would change if we add a 660W Jinko panel?",
    ];
  }
  if (agent?.slug === "settings" || /settings/i.test(agent?.name ?? "")) {
    return ["Install the Impeccable skill", "Attach Scrapling MCP to Website Dev Agent", "List installed MCP servers"];
  }
  if (/scrap/i.test(agent?.name ?? "") || /scrap/i.test(agent?.slug ?? "")) {
    return [
      "Fetch https://example.com and summarise it",
      "Get all product links from a page",
      "Check if a page has changed since yesterday",
    ];
  }
  if (agent?.slug === "sales") {
    return [
      "How much have we collected this month?",
      "How much is still outstanding?",
      "Which models are running low on stock?",
    ];
  }
  if (!agent || agent.slug === "website") {
    return [
      "Update the hero headline to \"Build faster with Pi\"",
      "Add a WhatsApp contact button to the footer",
      "What files are in the workspace?",
    ];
  }
  // Any other agent (system or custom) without a curated list above: build
  // prompts from its own role data instead of borrowing Website Dev Agent's.
  const toolNames = [...(agent.skills ?? []), ...(agent.mcp ?? [])].map((row) => row.name).filter(Boolean);
  return [
    agent.description ? `Help me with: ${agent.description}` : `What can you help me with as ${agent.name}?`,
    toolNames.length ? `What can you do with ${toolNames[0]}?` : "What tools do you have access to?",
    "What files are in the workspace?",
  ];
}

export function previewText(text?: string | null) {
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 71)}…` : compact;
}

export function formatSessionTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
