import { useEffect, useRef, useState, type SVGProps } from "react";
import {
  ChatCopy,
  IMAGE_EXT_RE,
  collectImageHrefs,
  isImageHref,
  normalizeWorkspacePath,
  tokenizeChat,
  workspaceMediaUrl,
  type ChatPart,
} from "./chat-markdown";

type Tab = "chats" | "agents" | "live" | "files";
type View = Tab | "chat";
type Sheet = null | "model" | "agent";
type ChatFilter = "all" | "ask" | "done";

const SESSION_KEY = "e-agent-active-session";
const AGENT_KEY = "e-agent-active-agent";
const FULLSCREEN_KEY = "e-agent-fullscreen";

function prefersStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches ||
    Boolean((navigator as { standalone?: boolean }).standalone)
  );
}

function readFullPreference() {
  if (prefersStandalone()) return true;
  try {
    return window.localStorage.getItem(FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

type ModelOption = {
  id: string;
  label: string;
  shortLabel: string;
  provider: string;
  model: string;
  available: boolean;
};

type HostStatus = {
  configured: boolean;
  baseUrl: string;
  slug: string;
  name: string;
  url: string | null;
  lastError: string | null;
  pushed?: boolean;
  git?: { pushed?: boolean; sha?: string | null; lastError?: string | null };
};

type TurnBlock =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; detail: string; result?: string; isError?: boolean; running?: boolean }
  | { type: "note"; text: string };

type ChatMessage = {
  id?: number;
  role: "user" | "assistant";
  content: string;
  modelId?: string | null;
  sessionId?: string | null;
  blocks?: TurnBlock[];
  streaming?: boolean;
};

type ChatSession = {
  id: string;
  title: string;
  modelId?: string | null;
  agentId?: string | null;
  preview?: string | null;
  messageCount?: number;
  createdAt: string;
  updatedAt: string;
};

type StreamEvent = {
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

type WorkspaceFile = { path: string; size: number };

type Agent = {
  id: string;
  slug: string;
  name: string;
  short: string;
  headline: string;
  description: string;
  color: string;
  liveUrl?: string | null;
  workspaceRepo?: string | null;
  skills: { id: string; name: string; description: string }[];
  mcp: { id: string; name: string; description: string }[];
};

type PendingFile = { name: string; mime: string; data: string };
type SessionFlag = "ask" | "done" | "run" | "";

const FALLBACK_AGENT: Agent = {
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

function agentLiveUrl(agent?: Agent | null, host?: HostStatus | null) {
  if (agent?.liveUrl) return agent.liveUrl;
  if (host?.url) return host.url;
  if (host?.slug) return `${host.baseUrl}/app/${host.slug}/`;
  return null;
}

function toolsLabel(agent: Agent) {
  const parts = [...(agent.skills ?? []).map((row) => row.name), ...(agent.mcp ?? []).map((row) => row.name)];
  return parts.length ? parts.join(" · ") : "Role only";
}

function toolCount(agent: Agent) {
  const n = (agent.skills?.length ?? 0) + (agent.mcp?.length ?? 0);
  return n ? `${n} tool${n === 1 ? "" : "s"}` : "Role only";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

const CONTINUE_PROMPT =
  "The previous turn was cut off by a host restart. Continue the same task immediately from where you left off. Do not wait. Do not ask the user to confirm.";

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function parseTranscript(content: string): { text?: string; blocks?: TurnBlock[]; streaming?: boolean } | null {
  if (!content || content[0] !== "{") return null;
  try {
    const data = JSON.parse(content) as { v?: number; text?: string; blocks?: TurnBlock[]; streaming?: boolean };
    if (data?.v === 1 && Array.isArray(data.blocks)) return data;
  } catch {
    return null;
  }
  return null;
}

function hydrateMessages(messages: ChatMessage[]): ChatMessage[] {
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

function applyStreamEvent(blocks: TurnBlock[], event: StreamEvent): TurnBlock[] {
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

type SiriSignal = "idle" | "complete" | "ask";

function assistantPlainText(msg: ChatMessage): string {
  const fromBlocks = (msg.blocks ?? [])
    .filter((block): block is Extract<TurnBlock, { type: "text" | "note" }> => block.type === "text" || block.type === "note")
    .map((block) => block.text)
    .join("\n");
  return (fromBlocks || msg.content || "").replace(/https?:\/\/\S+/g, " ").trim();
}

function hadFinishedTools(msg: ChatMessage): boolean {
  return (msg.blocks ?? []).some((block) => block.type === "tool" && !block.running);
}

const ASK_RE =
  /\b(which (one|option|approach|layout|color|style)|what (should|would|do) you|where should|how (should|would) you like|do you want|would you like|can you (confirm|choose|pick|tell)|could you|please (confirm|choose|pick|tell|let me know)|let me know|need you to|waiting (for|on) (your|you)|should i)\b/i;

function looksLikeQuestion(text: string): boolean {
  if (!text) return false;
  const tail = text.slice(-900);
  const lastLines = tail.split(/\n/).slice(-4).join("\n").trim();
  if (/\?\s*$/.test(lastLines)) return true;
  const lastPara = tail.split(/\n{2,}/).pop() ?? tail;
  if (/\?/.test(lastPara) && lastPara.length < 600) return true;
  return ASK_RE.test(tail);
}

function looksLikeCompletion(text: string, tools: boolean): boolean {
  if (tools) return true;
  return /\b(done|completed|finished|published|i('ve| have) (updated|created|added|changed|fixed|published|built)|live (url|at|site)|all set|ready to (view|open))\b/i.test(
    text,
  );
}

function classifySiriSignal(history: ChatMessage[], loading: boolean, error: string): SiriSignal {
  if (loading) return "idle";
  if (error) return "ask";
  const last = history[history.length - 1];
  if (!last || last.role !== "assistant" || last.streaming) return "idle";
  const text = assistantPlainText(last);
  if (!text && !hadFinishedTools(last)) return "idle";
  if (looksLikeQuestion(text)) return "ask";
  if (looksLikeCompletion(text, hadFinishedTools(last))) return "complete";
  return "idle";
}

function classifySession(session: ChatSession, running: boolean): SessionFlag {
  if (running) return "run";
  const text = session.preview || "";
  if (!text) return "";
  if (looksLikeQuestion(text)) return "ask";
  if (looksLikeCompletion(text, true)) return "done";
  return session.messageCount ? "done" : "";
}

function dayGroup(value: string): string {
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

function hostHost(url: string | null | undefined) {
  if (!url) return "";
  try {
    return new URL(url).host + new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

function userVisibleContent(text: string, files: PendingFile[]) {
  const bits: string[] = [];
  if (text) bits.push(text);
  for (const file of files) {
    const image = file.mime.startsWith("image/") || IMAGE_EXT_RE.test(file.name);
    bits.push(image ? `![${file.name}](${file.data})` : `[${file.name}](${file.data})`);
  }
  return bits.join("\n\n");
}

async function readSse(res: Response, onEvent: (event: StreamEvent) => void) {
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

export default function Home() {
  const [view, setView] = useState<View>("chats");
  const [tab, setTab] = useState<Tab>("chats");
  const [full] = useState(readFullPreference);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [inboxReady, setInboxReady] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [host, setHost] = useState<HostStatus | null>(null);
  const [publishOk, setPublishOk] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [media, setMedia] = useState<{ src: string; alt?: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const historyLoad = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const resumeAttempt = useRef(0);
  const selected = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? FALLBACK_AGENT;

  const inChat = view === "chat";
  const activeModel = models.find((model) => model.id === selectedModelId);
  const siriSignal = inChat ? classifySiriSignal(history, loading, error) : "idle";
  const pendingStream = !loading && history.some((msg) => msg.role === "assistant" && msg.streaming);
  const liveUrl = agentLiveUrl(selected, host);

  useEffect(() => {
    if (view !== "chat" || !sessionId || !pendingStream) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await api<{ messages: ChatMessage[] }>(
          `/api/messages?sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!cancelled) setHistory(hydrateMessages(data.messages ?? []));
      } catch {
        /* keep last hydrated history */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [view, sessionId, pendingStream]);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ agents: Agent[] }>("/api/agents");
        const list = data.agents ?? [];
        setAgents(list);
        const stored = window.localStorage.getItem(AGENT_KEY);
        const next = list.find((agent) => agent.id === stored)?.id ?? list[0]?.id ?? "";
        setSelectedAgentId(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load agents");
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const health = await api<{ host?: HostStatus }>("/api/health");
        if (health.host) setHost(health.host);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Health check failed");
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ models?: ModelOption[]; activeModelId?: string }>("/api/models");
        setModels(data.models ?? []);
        if (data.activeModelId) setSelectedModelId(data.activeModelId);
        else if (data.models?.length) {
          const first = data.models.find((model) => model.available) ?? data.models[0];
          setSelectedModelId(first.id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load models");
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const data = await api<{ sessions: ChatSession[] }>("/api/sessions");
        setSessions(data.sessions ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load chats");
      } finally {
        setInboxReady(true);
      }
    })();
  }, [view, selectedAgentId]);

  useEffect(() => {
    if (!media) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMedia(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [media]);

  useEffect(() => {
    if (tab !== "files" && view !== "files") return;
    void (async () => {
      try {
        const data = await api<{ files: WorkspaceFile[] }>(
          `/api/files${selectedAgentId ? `?agent=${encodeURIComponent(selectedAgentId)}` : ""}`,
        );
        setFiles(data.files ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load files");
      }
    })();
  }, [tab, view, selectedAgentId]);

  useEffect(() => {
    if (tab !== "live" && view !== "live") return;
    void (async () => {
      try {
        setHost(await api<HostStatus>("/api/host"));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load live site status");
      }
    })();
  }, [tab, view]);

  const publishHost = async () => {
    setError("");
    setPublishing(true);
    try {
      setHost(await api<HostStatus>("/api/host", { method: "POST" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  };

  const switchModel = async (modelId: string) => {
    if (!modelId || modelId === selectedModelId) {
      setSheet(null);
      return;
    }
    setError("");
    try {
      const data = await api<{ activeModelId?: string }>("/api/model", {
        method: "POST",
        body: JSON.stringify({ modelId }),
      });
      setSelectedModelId(data.activeModelId ?? modelId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Model switch failed");
    } finally {
      setSheet(null);
    }
  };

  const pickAgent = (id: string) => {
    setSelectedAgentId(id);
    window.localStorage.setItem(AGENT_KEY, id);
  };

  const goTab = (next: Tab) => {
    setTab(next);
    setView(next);
    setSheet(null);
    setError("");
    setSearchOpen(false);
  };

  const openSession = (id: string) => {
    setSessionId(id);
    setHistory([]);
    setView("chat");
    setSheet(null);
    setError("");
    window.localStorage.setItem(SESSION_KEY, id);
    const session = sessions.find((row) => row.id === id);
    if (session?.agentId) pickAgent(session.agentId);
    const loadId = ++historyLoad.current;
    void (async () => {
      try {
        const data = await api<{ messages: ChatMessage[] }>(`/api/messages?sessionId=${encodeURIComponent(id)}`);
        if (loadId !== historyLoad.current) return;
        setHistory(hydrateMessages(data.messages ?? []));
      } catch (err) {
        if (loadId !== historyLoad.current) return;
        setError(err instanceof Error ? err.message : "Could not load messages");
      }
    })();
  };

  const startNewChat = async (agentId?: string) => {
    const agent = agents.find((row) => row.id === agentId) ?? (selected.id ? selected : undefined);
    if (agent) pickAgent(agent.id);
    setError("");
    setHistory([]);
    setSessionId("");
    setView("chat");
    setSheet(null);
    if (!agent?.id) return;
    try {
      const data = await api<{ session: ChatSession }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ modelId: selectedModelId || undefined, agentId: agent.id }),
      });
      const created = data.session;
      setSessions((prev) => [created, ...prev.filter((session) => session.id !== created.id)]);
      setSessionId(created.id);
      window.localStorage.setItem(SESSION_KEY, created.id);
      historyLoad.current += 1;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a new chat");
    }
  };

  const send = async (text = message, opts?: { resume?: boolean; sessionId?: string }) => {
    const resume = Boolean(opts?.resume);
    const trimmed = text.trim();
    const files = resume ? [] : pendingFiles;
    if (!resume && ((!trimmed && !files.length) || loading)) return;
    if (resume && abortRef.current?.signal.aborted) return;
    if (!resume) {
      resumeAttempt.current = 0;
      historyLoad.current += 1;
    }
    let activeId = opts?.sessionId || sessionId;
    const agent = selected;
    if (!activeId) {
      try {
        const data = await api<{ session: ChatSession }>("/api/sessions", {
          method: "POST",
          body: JSON.stringify({ modelId: selectedModelId || undefined, agentId: agent?.id }),
        });
        activeId = data.session.id;
        setSessionId(activeId);
        setSessions((prev) => [data.session, ...prev.filter((session) => session.id !== activeId)]);
        window.localStorage.setItem(SESSION_KEY, activeId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not start a new chat");
        return;
      }
    }
    const ac =
      resume && abortRef.current && !abortRef.current.signal.aborted ? abortRef.current : new AbortController();
    if (!resume) {
      abortRef.current?.abort();
      abortRef.current = ac;
      setMessage("");
      setPendingFiles([]);
      setError("");
      setPublishOk(false);
      setLoading(true);
      setLiveStatus("Working…");
      setHistory((prev) => [
        ...prev,
        { role: "user", content: userVisibleContent(trimmed, files), sessionId: activeId },
        { role: "assistant", content: "", blocks: [], streaming: true, sessionId: activeId },
      ]);
    }
    const patchAssistant = (updater: (msg: ChatMessage) => ChatMessage) => {
      setHistory((prev) => {
        const next = [...prev];
        const index = next.findLastIndex((msg) => msg.role === "assistant" && msg.streaming);
        if (index === -1) return prev;
        next[index] = updater(next[index]);
        return next;
      });
    };
    const finishStopped = () => {
      patchAssistant((msg) => ({
        ...msg,
        streaming: false,
        content: msg.content || "Stopped.",
        blocks: (msg.blocks ?? []).map((block) => (block.type === "tool" ? { ...block, running: false } : block)),
      }));
    };
    const finishIdle = () => {
      if (abortRef.current === ac) abortRef.current = null;
      setLoading(false);
      setLiveStatus("");
      setHistory((prev) => prev.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg)));
    };
    let gotDone = false;
    let retry = false;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          message: trimmed,
          modelId: selectedModelId || undefined,
          sessionId: activeId,
          agentId: agent?.id,
          attachments: files,
        }),
        signal: ac.signal,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status >= 500 || res.status === 408 || res.status === 429) retry = true;
        else throw new Error(data.error ?? "Request failed");
      } else {
        await readSse(res, (event) => {
          if (event.status) setLiveStatus(event.status);
          if (event.type === "thinking" || event.type === "text" || event.type === "tool" || event.type === "note") {
            patchAssistant((msg) => ({
              ...msg,
              blocks: applyStreamEvent(msg.blocks ?? [], event),
              content: event.type === "text" ? msg.content + (event.delta ?? "") : msg.content,
            }));
          }
          if (event.type === "done") {
            gotDone = true;
            patchAssistant((msg) => ({
              ...msg,
              content: resume && event.reply ? `${msg.content}\n\n${event.reply}`.trim() : (event.reply ?? msg.content),
              blocks: resume && event.blocks ? [...(msg.blocks ?? []), ...event.blocks] : (event.blocks ?? msg.blocks),
              streaming: false,
            }));
            if (event.session) {
              setSessions((prev) => {
                const rest = prev.filter((session) => session.id !== event.session!.id);
                return [{ ...event.session!, preview: event.reply || trimmed }, ...rest];
              });
            }
          }
          if (event.type === "host" && event.host) {
            setHost(event.host);
            const failed = Boolean(event.host.lastError);
            const pushed = event.host.pushed ?? event.host.git?.pushed;
            setPublishOk(!failed && (pushed === true || (event.host.git == null && !failed)));
          }
          if (event.type === "error" && event.error) setError(event.error);
        });
        if (!gotDone && !ac.signal.aborted) retry = true;
      }
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") {
        finishStopped();
        finishIdle();
        return;
      }
      retry = true;
      if (!resume) setError(err instanceof Error ? err.message : "Agent request failed");
    }
    if (retry && !ac.signal.aborted && resumeAttempt.current < 8) {
      resumeAttempt.current += 1;
      setError("");
      setLiveStatus("Host dropped the turn — continuing…");
      setLoading(true);
      patchAssistant((msg) => {
        const note = "Host restarted mid-turn. Continuing…";
        const blocks = msg.blocks ?? [];
        if (blocks.some((block) => block.type === "note" && block.text === note)) return msg;
        return { ...msg, streaming: true, blocks: [...blocks, { type: "note", text: note }] };
      });
      await sleep(Math.min(12_000, 1500 * resumeAttempt.current + 1500));
      if (ac.signal.aborted) {
        finishStopped();
        finishIdle();
        return;
      }
      return send(CONTINUE_PROMPT, { resume: true, sessionId: activeId });
    }
    if (retry && !ac.signal.aborted) {
      setError("Host kept dropping the turn. Send another message to resume.");
    }
    finishIdle();
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const pickFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const next: PendingFile[] = [];
    for (const file of Array.from(list).slice(0, 6)) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Could not read file"));
        reader.readAsDataURL(file);
      });
      next.push({ name: file.name, mime: file.type || "", data });
    }
    setPendingFiles((prev) => [...prev, ...next].slice(0, 6));
  };

  const goBack = () => {
    setSheet(null);
    setError("");
    setView(tab);
  };

  const askCount = sessions.filter((session) => classifySession(session, loading && session.id === sessionId) === "ask")
    .length;
  const tabTitle = tab === "chats" ? "Chats" : tab === "agents" ? "Agents" : tab === "live" ? "Live site" : "Files";
  const phoneClass = ["phone", inChat ? "in-chat" : "", siriSignal !== "idle" ? `siri-${siriSignal}` : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <main className={["stage", full ? "full" : ""].filter(Boolean).join(" ")}>
      <section className={phoneClass} aria-label="Website studio chat">
        <div className="siri-glow" aria-hidden="true">
          <span className="siri-glow-bloom">
            <i />
          </span>
          <span className="siri-glow-rim">
            <i />
          </span>
        </div>
        <p className="siri-live" role="status">
          {siriSignal === "complete" ? "Job complete" : siriSignal === "ask" ? "Agent is asking a question" : ""}
        </p>

        <div className="inbox" inert={inChat ? true : undefined}>
          <div className="inbox-head">
            <div className="inbox-brand">
              <img src="/logo-black.png" alt="" />
              <h1>{tabTitle}</h1>
            </div>
            <div className="inbox-actions">
              <a className="icon-btn" href="/settings" aria-label="Open settings">
                <IconSettings />
              </a>
              {tab === "chats" && (
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="Search chats"
                  onClick={() => setSearchOpen((open) => !open)}
                >
                  <IconSearch />
                </button>
              )}
              <button className="icon-btn primary" type="button" aria-label="New chat" onClick={() => void startNewChat()}>
                <IconPlus />
              </button>
            </div>
          </div>
          <div className="inbox-body">
            {error && !inChat && <p className="session-error">{error}</p>}
            {tab === "chats" && (
              <ChatsTab
                sessions={sessions}
                agents={agents}
                ready={inboxReady}
                filter={chatFilter}
                query={query}
                searchOpen={searchOpen}
                runningId={loading ? sessionId : ""}
                askCount={askCount}
                onFilter={setChatFilter}
                onQuery={setQuery}
                onOpen={openSession}
              />
            )}
            {tab === "agents" && (
              <AgentsTab agents={agents} onOpen={(id) => void startNewChat(id)} />
            )}
            {tab === "live" && (
              <LiveTab host={host} publishing={publishing} onPublish={() => void publishHost()} />
            )}
            {tab === "files" && (
              <FilesTab files={files} agentId={selected.id} onOpen={(src, alt) => setMedia({ src, alt })} />
            )}
          </div>
          <nav className="bottom-nav">
            {(
              [
                { id: "chats" as const, label: "Chats", badge: askCount, icon: <IconChats /> },
                { id: "agents" as const, label: "Agents", badge: 0, icon: <IconAgents /> },
                { id: "live" as const, label: "Live", badge: 0, icon: <IconLive /> },
                { id: "files" as const, label: "Files", badge: 0, icon: <IconFiles /> },
              ] as const
            ).map((item) => (
              <button
                key={item.id}
                type="button"
                className={tab === item.id ? "nav-btn on" : "nav-btn"}
                onClick={() => goTab(item.id)}
              >
                <span className="nav-pill">{item.icon}</span>
                <small>{item.label}</small>
                {item.badge ? <span className="badge">{item.badge}</span> : null}
              </button>
            ))}
          </nav>
        </div>

        <div className="chat-pane" inert={inChat ? undefined : true}>
          {selected && (
            <>
              <header className="chat-head">
                <button className="back-btn" type="button" onClick={goBack} aria-label="Back">
                  <IconBack />
                </button>
                <button className="agent-hit" type="button" onClick={() => setSheet("agent")}>
                  <span className={`avatar sm ${selected.color}`}>{selected.short}</span>
                  <div>
                    <strong>{selected.name}</strong>
                    <span
                      className={[
                        "status-line",
                        loading ? "working" : "",
                        siriSignal === "complete" ? "complete" : "",
                        siriSignal === "ask" ? "ask" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <i className="status-dot" />
                      {loading
                        ? liveStatus || "Working…"
                        : siriSignal === "complete"
                          ? "Job complete"
                          : siriSignal === "ask"
                            ? "Needs your reply"
                            : "Online · this chat only"}
                    </span>
                  </div>
                </button>
                <button
                  className="model-chip"
                  type="button"
                  onClick={() => setSheet("model")}
                  aria-label="Switch model"
                >
                  {activeModel?.shortLabel ?? "Model"}
                  <IconChevron />
                </button>
                {loading && (
                  <div className="work-bar">
                    <i />
                  </div>
                )}
              </header>
              <AgentConversation
                agent={selected}
                history={history}
                loading={loading}
                error={error}
                liveUrl={liveUrl}
                siriSignal={siriSignal}
                publishOk={publishOk}
                onPrompt={(text) => void send(text)}
                onOpenMedia={(src, alt) => setMedia({ src, alt })}
              />
              <div className="composer">
                {pendingFiles.length > 0 && (
                  <div className="attach-chips">
                    {pendingFiles.map((file, index) => (
                      <button
                        key={`${file.name}-${index}`}
                        type="button"
                        className="attach-chip"
                        onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== index))}
                        aria-label={`Remove ${file.name}`}
                      >
                        {file.name} ×
                      </button>
                    ))}
                  </div>
                )}
                <div className="composer-row">
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*,.pdf,application/pdf"
                    multiple
                    hidden
                    onChange={(event) => {
                      void pickFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <button
                    className="composer-circle attach"
                    type="button"
                    aria-label="Attach image or PDF"
                    disabled={loading}
                    onClick={() => fileInput.current?.click()}
                  >
                    <IconPlus wide />
                  </button>
                  <div className="composer-field">
                    <input
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && void send()}
                      placeholder={loading ? `${selected.name} is working…` : "Message"}
                      disabled={loading}
                    />
                  </div>
                  {loading ? (
                    <button className="composer-circle stop" type="button" onClick={stop} aria-label="Stop">
                      <i />
                    </button>
                  ) : message.trim() || pendingFiles.length ? (
                    <button className="composer-circle send" type="button" onClick={() => void send()} aria-label="Send">
                      <IconSend />
                    </button>
                  ) : (
                    <button
                      className="composer-circle mic"
                      type="button"
                      aria-label="Focus message"
                      onClick={() => document.querySelector<HTMLInputElement>(".composer-field input")?.focus()}
                    >
                      <IconMic />
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div
          className={sheet ? "sheet-backdrop on" : "sheet-backdrop"}
          onClick={() => setSheet(null)}
          aria-hidden={!sheet}
        />
        <div
          className={sheet === "model" ? "sheet on" : "sheet"}
          aria-hidden={sheet !== "model"}
          inert={sheet !== "model" ? true : undefined}
        >
          <div className="sheet-handle" />
          <div className="sheet-title">
            <strong>Model for this chat</strong>
            <span>Switch anytime</span>
          </div>
          {models.map((model) => {
            const tone = !model.available ? "muted" : /gpt|openai|luna/i.test(model.label) ? "blue" : "";
            return (
              <button
                key={model.id}
                type="button"
                className="model-row"
                disabled={!model.available}
                onClick={() => void switchModel(model.id)}
              >
                <span className={["model-mark", tone].filter(Boolean).join(" ")}>
                  {model.shortLabel.slice(0, 3)}
                </span>
                <span>
                  <strong>{model.label}</strong>
                  <small>{model.available ? model.provider : "No API key · add in Settings"}</small>
                </span>
                {selectedModelId === model.id && (
                  <span className="check-dot">
                    <IconCheck />
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {selected && (
          <div
            className={sheet === "agent" ? "sheet on" : "sheet"}
            aria-hidden={sheet !== "agent"}
            inert={sheet !== "agent" ? true : undefined}
          >
            <div className="sheet-handle" />
            <div className="sheet-hero">
              <span className={`avatar lg ${selected.color}`}>{selected.short}</span>
              <div>
                <strong>{selected.name}</strong>
                <span>{selected.description}</span>
              </div>
            </div>
            <div className="group-label" style={{ paddingLeft: 12 }}>
              Attached to this agent
            </div>
            <div className="chip-wrap">
              {(selected.skills ?? []).map((skill) => (
                <span className="kind-chip skill" key={`s-${skill.id}`}>
                  {skill.name}
                  <b>SKILL</b>
                </span>
              ))}
              {(selected.mcp ?? []).map((server) => (
                <span className="kind-chip mcp" key={`m-${server.id}`}>
                  {server.name}
                  <b>MCP</b>
                </span>
              ))}
              {!selected.skills?.length && !selected.mcp?.length && (
                <span className="kind-chip skill">
                  Role only
                  <b>PROMPT</b>
                </span>
              )}
            </div>
            <div className="trust-card">
              <i />
              Only this role and its attached tools are used. Each chat is its own session — new chats don&apos;t share
              memory.
            </div>
            <div className="sheet-actions">
              <button className="ghost" type="button" onClick={() => setSheet(null)}>
                Close
              </button>
              <a className="primary" href="/settings#agents">
                Manage in Settings
              </a>
            </div>
          </div>
        )}
        {media && <MediaLightbox src={media.src} alt={media.alt} onClose={() => setMedia(null)} />}
      </section>
    </main>
  );
}

function ChatsTab({
  sessions,
  agents,
  ready,
  filter,
  query,
  searchOpen,
  runningId,
  askCount,
  onFilter,
  onQuery,
  onOpen,
}: {
  sessions: ChatSession[];
  agents: Agent[];
  ready: boolean;
  filter: ChatFilter;
  query: string;
  searchOpen: boolean;
  runningId: string;
  askCount: number;
  onFilter: (filter: ChatFilter) => void;
  onQuery: (query: string) => void;
  onOpen: (id: string) => void;
}) {
  const filtered = sessions.filter((session) => {
    const flag = classifySession(session, session.id === runningId);
    if (filter === "ask" && flag !== "ask") return false;
    if (filter === "done" && flag !== "done") return false;
    if (query.trim()) {
      const hay = `${session.title} ${session.preview ?? ""}`.toLowerCase();
      if (!hay.includes(query.trim().toLowerCase())) return false;
    }
    return true;
  });
  const groups = groupSessions(filtered);
  const filters: { id: ChatFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: 0 },
    { id: "ask", label: "Needs reply", count: askCount },
    { id: "done", label: "Done", count: 0 },
  ];

  return (
    <>
      {searchOpen && (
        <label className="search-bar">
          <IconSearch />
          <input
            autoFocus
            placeholder="Search chats"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
        </label>
      )}
      <div className="filter-row">
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            className={filter === item.id ? "filter-chip on" : "filter-chip"}
            onClick={() => onFilter(item.id)}
          >
            {item.label}
            {item.count ? <b>{item.count}</b> : null}
          </button>
        ))}
      </div>
      {!ready && (
        <div>
          {[1, 2, 3, 4, 5].map((key) => (
            <div className="skeleton-row" key={key}>
              <i />
              <div>
                <b />
                <s />
              </div>
            </div>
          ))}
        </div>
      )}
      {ready &&
        groups.map((group) => (
          <div key={group.label}>
            <div className="group-label">{group.label}</div>
            {group.items.map((session) => {
              const agent = agents.find((row) => row.id === session.agentId);
              const flag = classifySession(session, session.id === runningId);
              return (
                <button
                  key={session.id}
                  type="button"
                  className="session-btn"
                  onClick={() => onOpen(session.id)}
                >
                  <span className={`avatar ${agent?.color || "emerald"}`}>
                    {agent?.short || "C"}
                    {flag === "run" && (
                      <span className="spin-badge">
                        <i className="spin" />
                      </span>
                    )}
                  </span>
                  <span className="row-main">
                    <span className="row-top">
                      <strong>{session.title}</strong>
                      <time className={flag === "ask" ? "unread" : undefined}>{formatSessionTime(session.updatedAt)}</time>
                    </span>
                    <span className="row-sub">
                      <span className="preview">
                        {flag === "done" && <IconTicks />}
                        {flag === "ask" && <span className="ask-dot">?</span>}
                        {flag === "run" && <span className="working">Working</span>}
                        <span>{previewText(session.preview) || "New chat"}</span>
                      </span>
                      {flag === "ask" && <span className="unread-badge">1</span>}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      {ready && groups.length === 0 && (
        <div className="empty-pane">
          <div className="empty-icon">
            <IconChats />
          </div>
          <strong>Nothing here yet</strong>
          <p>Chats that match this filter will show up as agents finish or ask you something.</p>
        </div>
      )}
    </>
  );
}

function AgentsTab({
  agents,
  onOpen,
}: {
  agents: Agent[];
  onOpen: (id: string) => void;
}) {
  return (
    <>
      <div className="section-row">
        <span>Your agents</span>
        <small>{agents.length} online</small>
      </div>
      {agents.map((agent) => (
        <button key={agent.id} type="button" className="agent-btn" onClick={() => onOpen(agent.id)}>
          <span className={`avatar ${agent.color}`}>
            {agent.short}
            <i className="online" />
          </span>
          <span className="row-main">
            <strong>{agent.name}</strong>
            <span className="preview">
              <span>{agent.headline || toolsLabel(agent)}</span>
            </span>
          </span>
          <span className="tool-count">{toolCount(agent)}</span>
        </button>
      ))}
    </>
  );
}

function LiveTab({
  host,
  publishing,
  onPublish,
}: {
  host: HostStatus | null;
  publishing: boolean;
  onPublish: () => void;
}) {
  const url = host?.url ?? (host?.slug ? `${host.baseUrl}/app/${host.slug}/` : null);
  return (
    <div className="live-panel">
      <div className="live-banner" style={{ margin: 0 }}>
        <span>
          <IconLive />
        </span>
        <div>
          <strong>{host?.name ?? "HTML host"}</strong>
          <small>{host?.slug ?? "e-agent-site"}</small>
        </div>
      </div>
      <div className="live-card">
        <h3>{url ? "Live site" : host?.configured ? "Ready to publish" : "API key missing"}</h3>
        <p>
          {host?.lastError ??
            (url
              ? "The host publishes the workspace to ee-html after each Website Dev Agent chat."
              : "Add the HTML host API key on the Settings page. The agent only edits files.")}
        </p>
        <div className="live-actions">
          <button type="button" disabled={!url} onClick={() => url && window.open(url, "_blank", "noopener,noreferrer")}>
            Open live site
          </button>
          <button className="secondary" type="button" disabled={!host?.configured || publishing} onClick={onPublish}>
            {publishing ? "Publishing…" : "Publish now"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilesTab({
  files,
  agentId,
  onOpen,
}: {
  files: WorkspaceFile[];
  agentId: string;
  onOpen: (src: string, alt?: string) => void;
}) {
  if (!files.length) {
    return (
      <div className="empty-pane tall">
        <div className="empty-icon muted">
          <IconFiles />
        </div>
        <strong>Workspace files</strong>
        <p>Files the agent edits live in /storage/workspace and appear here.</p>
      </div>
    );
  }
  return (
    <>
      <div className="section-row">
        <span>Workspace files</span>
        <small>/storage/workspace</small>
      </div>
      {files.map((file) => {
        const src = workspaceMediaUrl(agentId, file.path);
        const image = isImageHref(file.path);
        return image ? (
          <button className="file-row" key={file.path} type="button" onClick={() => onOpen(src, file.path)}>
            <span>
              <IconFiles />
            </span>
            <div>
              <strong>{file.path}</strong>
              <small>{file.size} bytes · tap to view</small>
            </div>
          </button>
        ) : (
          <a className="file-row" key={file.path} href={src} target="_blank" rel="noreferrer">
            <span>
              <IconFiles />
            </span>
            <div>
              <strong>{file.path}</strong>
              <small>{file.size} bytes</small>
            </div>
          </a>
        );
      })}
    </>
  );
}

function AgentConversation({
  agent,
  history,
  loading,
  error,
  liveUrl,
  siriSignal,
  publishOk,
  onPrompt,
  onOpenMedia,
}: {
  agent: Agent;
  history: ChatMessage[];
  loading: boolean;
  error: string;
  liveUrl: string | null;
  siriSignal: SiriSignal;
  publishOk: boolean;
  onPrompt: (text: string) => void;
  onOpenMedia: (src: string, alt?: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [history, loading]);

  const last = history[history.length - 1];
  const showCard =
    last?.role === "assistant" && !last.streaming && siriSignal === "complete" && Boolean(liveUrl) && publishOk;

  return (
    <div className="chat-scroll">
      <div className="day-pill">Today</div>
      {history.length === 0 && (
        <div className="ready-card">
          <header>
            <span>✦</span>
            <div>
              <strong>{agent.name} is ready</strong>
              <small>
                Role + {toolCount(agent)} · this chat only
              </small>
            </div>
          </header>
          <div className="ready-label">Quick start</div>
          {promptsFor(agent).map((prompt) => (
            <button key={prompt} type="button" className="quick-btn" onClick={() => onPrompt(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      )}
      {history.map((item, index) =>
        item.role === "user" ? (
          <div className="bubble-user" key={`u-${index}`}>
            <ChatCopy text={item.content} agentId={agent.id} onOpen={onOpenMedia} />
            <div className="meta-row">
              <span>Now</span>
              <IconTicks color="#53bdeb" />
            </div>
          </div>
        ) : (
          <AssistantTurn
            key={`a-${index}`}
            item={item}
            agentId={agent.id}
            showCard={showCard && index === history.length - 1}
            liveUrl={liveUrl}
            onOpenMedia={onOpenMedia}
          />
        ),
      )}
      {error && (
        <div className="bubble-agent">
          <p>{error}</p>
          <div className="meta-row">
            <span>Now</span>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function AssistantTurn({
  item,
  agentId,
  showCard,
  liveUrl,
  onOpenMedia,
}: {
  item: ChatMessage;
  agentId: string;
  showCard: boolean;
  liveUrl: string | null;
  onOpenMedia: (src: string, alt?: string) => void;
}) {
  const blocks = item.blocks ?? [];
  const textBlocks = blocks.filter((block) => block.type === "text" || block.type === "note");
  const workBlocks = blocks.filter((block) => block.type === "thinking" || block.type === "tool");
  const text = textBlocks.map((block) => block.text).join("\n") || item.content;
  const showTyping = Boolean(item.streaming && !workBlocks.length && !text);
  const hostLabel = hostHost(liveUrl);
  const toolText = workBlocks
    .filter((block): block is Extract<TurnBlock, { type: "tool" }> => block.type === "tool")
    .map((block) => `${block.detail}\n${block.result || ""}`)
    .join("\n");
  const inlineHrefs = new Set(
    tokenizeChat(text)
      .filter((part): part is Extract<ChatPart, { type: "image" }> => part.type === "image")
      .map((part) => part.href),
  );
  const gallery = collectImageHrefs(text, toolText).filter((href) => !inlineHrefs.has(href));

  return (
    <div className="bubble-agent">
      {showTyping && (
        <div className="typing">
          <i />
          <i />
          <i />
        </div>
      )}
      {workBlocks.length > 0 && (
        <TurnBlocks blocks={workBlocks} streaming={item.streaming} agentId={agentId} onOpen={onOpenMedia} />
      )}
      {text ? <ChatCopy text={text} agentId={agentId} streaming={item.streaming} onOpen={onOpenMedia} /> : null}
      {gallery.length > 0 && !item.streaming && (
        <div className={gallery.length === 1 ? "chat-gallery one" : "chat-gallery"}>
          {gallery.map((href) => {
            const src = workspaceMediaUrl(agentId, href);
            const label = normalizeWorkspacePath(href) || href;
            return (
              <a
                key={href}
                className="chat-thumb"
                href={src}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenMedia(src, label);
                }}
              >
              <img
                src={src}
                alt={label}
                onError={(event) => event.currentTarget.closest("a")?.classList.add("is-missing")}
              />
                <small>{label}</small>
              </a>
            );
          })}
        </div>
      )}
      {showCard && liveUrl && (
        <a className="site-card" href={liveUrl} target="_blank" rel="noreferrer">
          <span>
            <IconLive />
          </span>
          <span>
            <strong>Pushed to GitHub</strong>
            <small>{hostLabel}</small>
          </span>
          <b>Open</b>
        </a>
      )}
      {!item.streaming && (
        <div className="meta-row">
          <span>Now</span>
        </div>
      )}
    </div>
  );
}

function MediaLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
  return (
    <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={alt || "Image"} onClick={onClose}>
      <button className="media-close" type="button" onClick={onClose} aria-label="Close">
        Close
      </button>
      <img
        src={src}
        alt={alt || ""}
        onClick={(event) => event.stopPropagation()}
      />
      {alt ? <p>{alt}</p> : null}
      <a href={src} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>
        Open original
      </a>
    </div>
  );
}

function TurnBlocks({
  blocks,
  streaming,
  agentId,
  onOpen,
}: {
  blocks: TurnBlock[];
  streaming?: boolean;
  agentId: string;
  onOpen: (src: string, alt?: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <div className="turn-stack">
      {blocks.map((block, index) => {
        const key = block.type === "tool" ? block.id || `tool-${index}` : `t-${index}`;
        if (block.type === "thinking") {
          const done = !streaming || index < blocks.length - 1;
          const expanded = open[key] ?? !done;
          return (
            <div key={key}>
              <button
                type="button"
                className="turn-row"
                onClick={() => setOpen((prev) => ({ ...prev, [key]: !expanded }))}
              >
                {done ? (
                  <span className="turn-icon think">
                    <IconCheck tiny />
                  </span>
                ) : (
                  <i className="spin" />
                )}
                <span className="turn-copy">
                  <strong style={{ color: done ? "#10211b" : "#008069" }}>
                    {done ? "Thought" : "Thinking"}
                  </strong>
                </span>
                <IconChevron rotated={expanded} />
              </button>
              {expanded && block.text ? <p className="turn-text">{block.text}</p> : null}
            </div>
          );
        }
        if (block.type !== "tool") return null;
        const running = Boolean(block.running);
        return (
          <div key={key}>
            <div className="turn-row" style={{ cursor: "default" }}>
              {running ? (
                <i className="spin" />
              ) : (
                <span className="turn-icon">
                  <IconCheck tiny />
                </span>
              )}
              <span className="turn-copy">
                <strong style={{ color: running ? "#008069" : "#10211b" }}>{block.name}</strong>
                {block.detail ? <span>{block.detail}</span> : null}
              </span>
              <span className="turn-meta">{running ? "" : block.isError ? "error" : ""}</span>
            </div>
            {block.result ? (
              <div className="turn-text">
                <ChatCopy text={block.result} agentId={agentId} onOpen={onOpen} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function groupSessions(sessions: ChatSession[]) {
  const map = new Map<string, ChatSession[]>();
  for (const session of sessions) {
    const label = dayGroup(session.updatedAt);
    const list = map.get(label) ?? [];
    list.push(session);
    map.set(label, list);
  }
  return [...map.entries()].map(([label, items]) => ({ label, items }));
}

function promptsFor(agent?: Agent) {
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
  return [
    "Update the hero headline to \"Build faster with Pi\"",
    "Add a WhatsApp contact button to the footer",
    "What files are in the workspace?",
  ];
}

function previewText(text?: string | null) {
  if (!text) return "";
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 72 ? `${compact.slice(0, 71)}…` : compact;
}

function formatSessionTime(value: string) {
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

type IconProps = SVGProps<SVGSVGElement> & { wide?: boolean; tiny?: boolean; rotated?: boolean; color?: string };

function svgProps(rest: SVGProps<SVGSVGElement>, size = 22): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    ...rest,
  };
}

function IconSearch(props: IconProps) {
  return (
    <svg {...svgProps(props, 18)} strokeWidth={2.2}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}
function IconSettings(props: IconProps) {
  return (
    <svg {...svgProps(props, 18)} strokeWidth={2}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function IconPlus({ wide, ...props }: IconProps) {
  return (
    <svg {...svgProps(props, wide ? 22 : 18)} strokeWidth={wide ? 2.2 : 2.4}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function IconBack(props: IconProps) {
  return (
    <svg {...svgProps(props, 24)} strokeWidth={2.4}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}
function IconChevron({ rotated, ...props }: IconProps) {
  return (
    <svg
      {...svgProps(props, 12)}
      strokeWidth={3}
      style={{ transform: rotated ? "rotate(180deg)" : undefined, transition: "transform .2s", flex: "none" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
function IconSend(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M3 11.5L21 3l-4 18-5.5-6.5z" />
    </svg>
  );
}
function IconMic(props: IconProps) {
  return (
    <svg {...svgProps(props, 20)} strokeWidth={2.2}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
function IconCheck({ tiny, ...props }: IconProps) {
  return (
    <svg {...svgProps(props, tiny ? 10 : 12)} strokeWidth={tiny ? 3.5 : 3.5}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
function IconTicks({ color, ...props }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color || "#53bdeb"} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }} {...props}>
      <path d="M2 13l4 4L14 9" />
      <path d="M10 17l8-8" />
    </svg>
  );
}
function IconChats(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4 12a8 8 0 1 1 3 6.2L4 20l1.2-3.4A8 8 0 0 1 4 12z" />
    </svg>
  );
}
function IconAgents(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </svg>
  );
}
function IconLive(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
function IconFiles(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
