import { useEffect, useRef, useState } from "react";

type View = "agents" | "menu" | "chats" | "chat" | "tasks" | "approvals" | "library";

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

type ResourceSample = {
  ts: string;
  nodeRssMb: number;
  nodeHeapMb: number;
  childrenRssMb: number | null;
  containerMb: number;
  containerLimitMb: number | null;
  nodeCpuPct: number;
  containerCpuPct: number | null;
  childCount: number;
  load1: number | null;
  piAlive: boolean;
};

type MetricsPayload = {
  intervalSec: number;
  retentionHours: number;
  now: ResourceSample | null;
  samples: ResourceSample[];
  stats: {
    sampleCount: number;
    ramPeakMb: number;
    ramAvgMb: number;
    cpuPeakPct: number;
    cpuAvgPct: number;
  };
};

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

function agentLiveUrl(agent?: Agent | null, host?: HostStatus | null) {
  if (agent?.liveUrl) return agent.liveUrl;
  if (host?.url) return host.url;
  if (host?.slug) return `${host.baseUrl}/app/${host.slug}/`;
  return null;
}

function agentActions(agent: Agent) {
  const live = agent.liveUrl
    ? { icon: "⌁", title: "Open live proposal", description: "Open the Railway proposal site" }
    : { icon: "⌁", title: "Open live site", description: "Open the ee-html hosted site" };
  return [
    { icon: "✦", title: "Chat to Agent", description: `Talk to ${agent.name}` },
    live,
    { icon: "▤", title: "Workspace status", description: "Ask what files exist in the workspace" },
  ];
}

function toolsLabel(agent: Agent) {
  const parts = [...(agent.skills ?? []).map((row) => row.name), ...(agent.mcp ?? []).map((row) => row.name)];
  return parts.length ? parts.join(" · ") : "Role only";
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
  const [view, setView] = useState<View>("agents");
  const [actionIndex, setActionIndex] = useState(0);
  const [dark, setDark] = useState(false);
  const [full, setFull] = useState(readFullPreference);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [host, setHost] = useState<HostStatus | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null);
  const [liveStatus, setLiveStatus] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const historyLoad = useRef(0);
  const selected = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];

  const toggleFull = () => {
    setFull((prev) => {
      const next = !prev;
      window.localStorage.setItem(FULLSCREEN_KEY, next ? "1" : "0");
      return next;
    });
  };
  const isChat = view === "chat";
  const activeModel = models.find((model) => model.id === selectedModelId);
  const activeSession = sessions.find((session) => session.id === sessionId);
  const siriSignal = isChat ? classifySiriSignal(history, loading, error) : "idle";
  const pendingStream = !loading && history.some((msg) => msg.role === "assistant" && msg.streaming);

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
    if (view !== "chat" && view !== "menu") return;
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
  }, [view]);

  useEffect(() => {
    if (view !== "chat" && view !== "chats" && view !== "menu" && view !== "agents") return;
    void (async () => {
      try {
        const query =
          view === "agents" || !selectedAgentId ? "" : `?agentId=${encodeURIComponent(selectedAgentId)}`;
        const data = await api<{ sessions: ChatSession[] }>(`/api/sessions${query}`);
        setSessions(data.sessions ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load chats");
      }
    })();
  }, [view, selectedAgentId]);

  useEffect(() => {
    if (view !== "tasks") return;
    let cancelled = false;
    const loadMetrics = async () => {
      try {
        const data = await api<MetricsPayload>("/api/metrics");
        if (!cancelled) setMetrics(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load usage");
      }
    };
    void loadMetrics();
    const id = window.setInterval(() => void loadMetrics(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [view]);

  useEffect(() => {
    if (view !== "library") return;
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
  }, [view, selectedAgentId]);

  useEffect(() => {
    if (view !== "approvals") return;
    void (async () => {
      try {
        setHost(await api<HostStatus>("/api/host"));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load live site status");
      }
    })();
  }, [view]);

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
      setModelMenuOpen(false);
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
      setModelMenuOpen(false);
    }
  };

  const openAgent = (id: string) => {
    setSelectedAgentId(id);
    window.localStorage.setItem(AGENT_KEY, id);
    setView("menu");
    setError("");
  };
  const openChats = (index = 0) => {
    setActionIndex(index);
    setView("chats");
    setError("");
  };
  const openSession = (id: string) => {
    setActionIndex(0);
    setSessionId(id);
    setHistory([]);
    setView("chat");
    setError("");
    window.localStorage.setItem(SESSION_KEY, id);
    const session = sessions.find((row) => row.id === id);
    if (session?.agentId) {
      setSelectedAgentId(session.agentId);
      window.localStorage.setItem(AGENT_KEY, session.agentId);
    }
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
  const openAction = (index: number) => {
    if (index === 1) {
      const url = agentLiveUrl(selected, host);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    openChats(index);
  };

  const startNewChat = async () => {
    setError("");
    try {
      const data = await api<{ session: ChatSession }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ modelId: selectedModelId || undefined, agentId: selected?.id }),
      });
      const created = data.session;
      setSessions((prev) => [created, ...prev.filter((session) => session.id !== created.id)]);
      setHistory([]);
      setSessionId(created.id);
      window.localStorage.setItem(SESSION_KEY, created.id);
      historyLoad.current += 1;
      setView("chat");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a new chat");
    }
  };

  const removeSession = async (id: string) => {
    if (!window.confirm("Delete this chat? The agent will forget this conversation.")) return;
    setError("");
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      const next = sessions.filter((session) => session.id !== id);
      setSessions(next);
      if (sessionId === id) {
        setSessionId("");
        setHistory([]);
        window.localStorage.removeItem(SESSION_KEY);
        setView("chats");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete chat");
    }
  };

  const send = async (text = message) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    historyLoad.current += 1;
    let activeId = sessionId;
    if (!activeId) {
      try {
        const data = await api<{ session: ChatSession }>("/api/sessions", {
          method: "POST",
          body: JSON.stringify({ modelId: selectedModelId || undefined, agentId: selected?.id }),
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
    setMessage("");
    setError("");
    setLoading(true);
    setLiveStatus("Working…");
    setHistory((prev) => [
      ...prev,
      { role: "user", content: trimmed, sessionId: activeId },
      { role: "assistant", content: "", blocks: [], streaming: true, sessionId: activeId },
    ]);
    const patchAssistant = (updater: (msg: ChatMessage) => ChatMessage) => {
      setHistory((prev) => {
        const next = [...prev];
        const index = next.findLastIndex((msg) => msg.role === "assistant" && msg.streaming);
        if (index === -1) return prev;
        next[index] = updater(next[index]);
        return next;
      });
    };
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          message: trimmed,
          modelId: selectedModelId || undefined,
          sessionId: activeId,
          agentId: selected?.id,
        }),
      });
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
          patchAssistant((msg) => ({
            ...msg,
            content: event.reply ?? msg.content,
            blocks: event.blocks ?? msg.blocks,
            streaming: false,
          }));
          if (event.session) {
            setSessions((prev) => {
              const rest = prev.filter((session) => session.id !== event.session!.id);
              return [{ ...event.session!, preview: event.reply || trimmed }, ...rest];
            });
          }
        }
        if (event.type === "host" && event.host) setHost(event.host);
        if (event.type === "error" && event.error) setError(event.error);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent request failed");
    } finally {
      setLoading(false);
      setLiveStatus("");
      setHistory((prev) => prev.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg)));
    }
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
    if (view === "chat") setView("chats");
    else if (view === "chats") setView("menu");
    else setView("agents");
  };
  const goRoot = (next: View) => {
    setView(next);
    setError("");
  };
  const title =
    view === "agents"
      ? "Studio"
      : view === "menu"
        ? selected?.name.replace(" Agent", "") || "Agent"
        : view === "chats"
          ? "Chats"
          : view === "chat"
            ? activeSession?.title || "New chat"
            : view[0].toUpperCase() + view.slice(1);

  return (
    <main className={["stage", dark ? "dark" : "", full ? "full" : ""].filter(Boolean).join(" ")}>
      <section
        className={["phone", "sales-os", siriSignal !== "idle" ? `siri-${siriSignal}` : ""].filter(Boolean).join(" ")}
        aria-label="Website dev agent chat"
      >
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
        <header className="topbar">
          <div className="title-group">
            {view !== "agents" && view !== "tasks" && view !== "approvals" && view !== "library" && (
              <button className="back" onClick={goBack} aria-label="Go back">
                ‹
              </button>
            )}
            {(view === "agents" || view === "tasks" || view === "approvals" || view === "library") && (
              <img
                className="brand-logo"
                src={dark ? "/logo-white.png" : "/logo-black.png"}
                alt=""
                width={32}
                height={32}
              />
            )}
            <div>
              {view === "agents" && <small>Pi-powered workspace</small>}
              {view === "chats" && <small>Each chat is a separate session</small>}
              <h1 className={view === "chat" ? "chat-title" : undefined}>{title}</h1>
            </div>
          </div>
          <div className="header-buttons">
            {(view === "chats" || view === "chat") && (
              <button className="icon-button" onClick={() => void startNewChat()} aria-label="New chat">
                ＋
              </button>
            )}
            <a className="demo-badge" href="/settings#agents">Settings</a>
            {agentLiveUrl(selected, host) ? (
              <a className="demo-badge" href={agentLiveUrl(selected, host)!} target="_blank" rel="noreferrer">
                LIVE
              </a>
            ) : (
              <button className="demo-badge" type="button">
                LIVE
              </button>
            )}
            <button
              className="icon-button"
              onClick={toggleFull}
              aria-label={full ? "Exit fullscreen" : "Enter fullscreen"}
              aria-pressed={full}
            >
              {full ? "⤡" : "⤢"}
            </button>
            <button className="icon-button" onClick={() => setDark(!dark)} aria-label="Toggle theme">
              {dark ? "☀" : "☾"}
            </button>
          </div>
        </header>

        <div className={isChat ? "content chat-content" : "content"}>
          {view === "agents" && (
            <AgentInbox
              agents={agents}
              onOpen={openAgent}
              host={host}
              sessions={sessions}
              onOpenSession={openSession}
              onNewChat={() => void startNewChat()}
            />
          )}
          {view === "menu" && selected && (
            <AgentMenu
              agent={selected}
              onOpen={openAction}
              models={models}
              selectedModelId={selectedModelId}
              modelMenuOpen={modelMenuOpen}
              onToggleModelMenu={() => setModelMenuOpen((open) => !open)}
              onSelectModel={(modelId) => void switchModel(modelId)}
              host={host}
            />
          )}
          {view === "chats" && (
            <ChatList
              sessions={sessions}
              activeId={sessionId}
              error={error}
              onOpen={openSession}
              onNewChat={() => void startNewChat()}
              onDelete={(id) => void removeSession(id)}
            />
          )}
          {view === "chat" && selected && (
            <AgentConversation
              agent={selected}
              actionIndex={actionIndex}
              history={history}
              loading={loading}
              liveStatus={liveStatus}
              siriSignal={siriSignal}
              error={error}
              onPrompt={send}
              models={models}
              activeModel={activeModel}
              modelMenuOpen={modelMenuOpen}
              onToggleModelMenu={() => setModelMenuOpen((open) => !open)}
              onSelectModel={(modelId) => void switchModel(modelId)}
            />
          )}
          {view === "tasks" && <TasksScreen agents={agents} metrics={metrics} />}
          {view === "approvals" && (
            <HostScreen host={host} publishing={publishing} onPublish={() => void publishHost()} />
          )}
          {view === "library" && <LibraryScreen files={files} />}
        </div>

        {isChat && (
          <div className="composer-wrap">
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
                className="attach"
                type="button"
                aria-label="Attach image or PDF"
                disabled={loading}
                onClick={() => fileInput.current?.click()}
              >
                ＋
              </button>
              <input
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && void send()}
                placeholder={
                  loading
                    ? "Agent is working…"
                    : selected?.slug === "proposal"
                      ? "Text, screenshot, or PDF to update the proposal…"
                      : `Message ${selected?.name ?? "agent"}…`
                }
                disabled={loading}
              />
              <button
                className="send"
                onClick={() => void send()}
                aria-label="Send"
                disabled={loading || (!message.trim() && !pendingFiles.length)}
              >
                ➤
              </button>
            </div>
          </div>
        )}
        {!isChat && (
          <nav className="bottom-nav">
            <button className={view === "agents" || view === "menu" ? "active" : ""} onClick={() => goRoot("agents")}>
              <span>⌂</span>
              <small>Agents</small>
            </button>
            <button className={view === "tasks" ? "active" : ""} onClick={() => goRoot("tasks")}>
              <span>◷</span>
              <small>Tasks</small>
            </button>
            <button className={view === "approvals" ? "active" : ""} onClick={() => goRoot("approvals")}>
              <span>{"\u2713"}</span>
              <small>Live</small>
            </button>
            <button className={view === "library" ? "active" : ""} onClick={() => goRoot("library")}>
              <span>▣</span>
              <small>Files</small>
            </button>
          </nav>
        )}
      </section>
    </main>
  );
}

function AgentInbox({
  agents,
  onOpen,
  host,
  sessions,
  onOpenSession,
  onNewChat,
}: {
  agents: Agent[];
  onOpen: (id: string) => void;
  host: HostStatus | null;
  sessions: ChatSession[];
  onOpenSession: (id: string) => void;
  onNewChat: () => void;
}) {
  const recent = sessions.slice(0, 5);
  return (
    <>
      <div className="briefing-banner">
        <span>✦</span>
        <div>
          <strong>{agents.length} agents · role + skills + MCP</strong>
          <p>
            Website Dev Agent publishes to ee-html. Proposal Agent updates the Eternalgy proposal at
            ee-proposal-production after a GitHub push.
          </p>
        </div>
      </div>
      <label className="search">
        <span>⌕</span>
        <input placeholder="Search agents" />
      </label>
      <div className="section-label">
        <span>Your agents</span>
        <small>{agents.length} online</small>
      </div>
      <div className="agent-inbox">
        {agents.map((agent) => (
          <button className="agent-row" key={agent.id} onClick={() => onOpen(agent.id)}>
            <span className={`agent-avatar ${agent.color}`}>
              {agent.short}
              <i />
            </span>
            <span className="row-copy">
              <strong>{agent.name}</strong>
              <small>{agent.headline || toolsLabel(agent)}</small>
            </span>
            <span className="row-meta">
              <time>{(agent.skills?.length ?? 0) + (agent.mcp?.length ?? 0)}</time>
            </span>
          </button>
        ))}
      </div>
      <div className="section-label">
        <span>Recent chats</span>
        <small>{sessions.length ? `${sessions.length}` : "none"}</small>
      </div>
      {recent.length === 0 ? (
        <button className="new-chat-btn" onClick={onNewChat}>
          ＋ New chat
        </button>
      ) : (
        <div className="agent-inbox">
          {recent.map((session) => (
            <button className="agent-row" key={session.id} onClick={() => onOpenSession(session.id)}>
              <span className="agent-avatar emerald">C</span>
              <span className="row-copy">
                <strong>{session.title}</strong>
                <small>{previewText(session.preview) || "Empty chat"}</small>
              </span>
              <span className="row-meta">
                <time>{formatSessionTime(session.updatedAt)}</time>
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="automation-summary">
        <div>
          <span>1</span>
          <small>Workspace</small>
        </div>
        <div>
          <span>{host?.configured ? "On" : "Off"}</span>
          <small>ee-html</small>
        </div>
        <div>
          <span>Live</span>
          <small>Railway</small>
        </div>
      </div>
    </>
  );
}

function ChatList({
  sessions,
  activeId,
  error,
  onOpen,
  onNewChat,
  onDelete,
}: {
  sessions: ChatSession[];
  activeId: string;
  error: string;
  onOpen: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <button className="new-chat-btn" onClick={onNewChat}>
        ＋ New chat
      </button>
      {error && <p className="session-error">{error}</p>}
      <div className="section-label">
        <span>Conversations</span>
        <small>{sessions.length ? `${sessions.length}` : "none yet"}</small>
      </div>
      {sessions.length === 0 ? (
        <p className="empty-chats">Each new chat is a separate agent session. Start one to keep this work isolated.</p>
      ) : (
        <div className="agent-inbox">
          {sessions.map((session) => (
            <div className={session.id === activeId ? "session-row active" : "session-row"} key={session.id}>
              <button className="agent-row" onClick={() => onOpen(session.id)}>
                <span className="agent-avatar emerald">C</span>
                <span className="row-copy">
                  <strong>{session.title}</strong>
                  <small>{previewText(session.preview) || "Empty chat"}</small>
                </span>
                <span className="row-meta">
                  <time>{formatSessionTime(session.updatedAt)}</time>
                  {session.messageCount ? <b>{session.messageCount}</b> : null}
                </span>
              </button>
              <button
                className="delete-session"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(session.id);
                }}
                aria-label={`Delete ${session.title}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function AgentMenu({
  agent,
  onOpen,
  models,
  selectedModelId,
  modelMenuOpen,
  onToggleModelMenu,
  onSelectModel,
  host,
}: {
  agent: Agent;
  onOpen: (index: number) => void;
  models: ModelOption[];
  selectedModelId: string;
  modelMenuOpen: boolean;
  onToggleModelMenu: () => void;
  onSelectModel: (modelId: string) => void;
  host: HostStatus | null;
}) {
  const active = models.find((model) => model.id === selectedModelId);
  return (
    <>
      <div className={`agent-hero hero-${agent.color}`}>
        <span className={`agent-avatar ${agent.color} large`}>
          {agent.short}
          <i />
        </span>
        <div>
          <h2>{agent.name}</h2>
          <p>{agent.description}</p>
        </div>
      </div>
      <ModelPicker
        models={models}
        selectedModelId={selectedModelId}
        open={modelMenuOpen}
        onToggle={onToggleModelMenu}
        onSelect={onSelectModel}
      />
      <div className="section-label">
        <span>Attached</span>
        <small>{toolsLabel(agent)}</small>
      </div>
      <div className="section-label">
        <span>What would you like to do?</span>
      </div>
      <div className="submenu">
        {agentActions(agent).map((action, index) => (
          <button
            key={action.title}
            onClick={() => onOpen(index)}
            disabled={index === 1 && !agentLiveUrl(agent, host)}
          >
            <span className={`menu-icon accent-${index}`}>{action.icon}</span>
            <span className="row-copy">
              <strong>{action.title}</strong>
              <small>{action.description}</small>
            </span>
            <span className="chevron">›</span>
          </button>
        ))}
      </div>
      <div className="agent-status">
        <span className="pulse" />
        <div>
          <strong>Agent is ready</strong>
          <small>
            {active?.label ?? "Pick a model"} · {agentLiveUrl(agent, host) ?? "ee-html"}
          </small>
        </div>
        <span className="scope-pill">Pi</span>
      </div>
      <div className="trust-note">
        <strong>Role + assigned tools only</strong>
        <p>
          This chat uses this agent's prompt, {agent.skills?.length ?? 0} skill
          {(agent.skills?.length ?? 0) === 1 ? "" : "s"}, and {agent.mcp?.length ?? 0} MCP
          {(agent.mcp?.length ?? 0) === 1 ? " server" : " servers"}.{" "}
          <a href="/settings#agents">Manage in Settings</a>.
        </p>
      </div>
    </>
  );
}

function AgentConversation({
  agent,
  actionIndex,
  history,
  loading,
  liveStatus,
  siriSignal,
  error,
  onPrompt,
  models,
  activeModel,
  modelMenuOpen,
  onToggleModelMenu,
  onSelectModel,
}: {
  agent: Agent;
  actionIndex: number;
  history: ChatMessage[];
  loading: boolean;
  liveStatus: string;
  siriSignal: SiriSignal;
  error: string;
  onPrompt: (text: string) => void;
  models: ModelOption[];
  activeModel?: ModelOption;
  modelMenuOpen: boolean;
  onToggleModelMenu: () => void;
  onSelectModel: (modelId: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [history, loading, liveStatus]);

  return (
    <div className="conversation">
      <div className="agent-strip">
        <span className={`agent-avatar ${agent.color}`}>
          {agent.short}
          <i />
        </span>
        <div>
          <strong>{agent.name}</strong>
          <small className={siriSignal !== "idle" ? `siri-dot-${siriSignal}` : undefined}>
            <span />
            {siriSignal === "complete"
              ? "Job complete"
              : siriSignal === "ask"
                ? "Needs your reply"
                : liveStatus || "Online · this chat only"}
          </small>
        </div>
        <button
          type="button"
          className="model-chip"
          onClick={onToggleModelMenu}
          aria-expanded={modelMenuOpen}
          aria-label="Switch model"
        >
          {activeModel?.shortLabel ?? "Model"} ▾
        </button>
      </div>
      {modelMenuOpen && (
        <ModelPicker
          compact
          models={models}
          selectedModelId={activeModel?.id ?? ""}
          open={modelMenuOpen}
          onToggle={onToggleModelMenu}
          onSelect={onSelectModel}
        />
      )}
      <div className="day-pill">Today</div>
      <div className="bubble agent-bubble">
        <span className="mini-agent">✦</span>
        <div>
          <p>{introFor(actionIndex, agent)}</p>
          <time>Now</time>
        </div>
      </div>
      {history.length === 0 && (
        <div className="quick-actions">
          <small>QUICK START</small>
          {promptsFor(actionIndex, agent).map((prompt) => (
            <button key={prompt} onClick={() => void onPrompt(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      )}
      {history.map((item, index) =>
        item.role === "user" ? (
          <div className="bubble user-bubble" key={`u-${index}`}>
            <p>{item.content}</p>
            <time>Now ✓✓</time>
          </div>
        ) : (
          <div className="bubble agent-bubble" key={`a-${index}`}>
            <span className="mini-agent">✦</span>
            <div>
              <TurnBlocks blocks={item.blocks} fallback={item.content} streaming={item.streaming} />
              <time>{item.streaming ? liveStatus || "Now" : "Now"}</time>
            </div>
          </div>
        ),
      )}
      {error && (
        <div className="bubble agent-bubble">
          <span className="mini-agent">✦</span>
          <div>
            <p>{error}</p>
            <time>Now</time>
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function TurnBlocks({
  blocks,
  fallback,
  streaming,
}: {
  blocks?: TurnBlock[];
  fallback: string;
  streaming?: boolean;
}) {
  if (!blocks?.length) {
    if (!fallback && streaming) return <p className="stream-cursor">Working…</p>;
    return fallback ? <p style={{ whiteSpace: "pre-wrap" }}>{fallback}</p> : null;
  }
  return (
    <div className="turn-blocks">
      {blocks.map((block, index) => {
        const live = Boolean(streaming && index === blocks.length - 1);
        if (block.type === "thinking") {
          return (
            <details key={`t-${index}`} className="think-block" open>
              <summary>Thinking</summary>
              <p className={live ? "stream-cursor" : undefined}>{block.text}</p>
            </details>
          );
        }
        if (block.type === "note") {
          return (
            <p className="note-block" key={`n-${index}`}>
              {block.text}
            </p>
          );
        }
        if (block.type === "tool") {
          return (
            <div
              className={["tool-block", block.running ? "running" : "", block.isError ? "error" : ""].join(" ")}
              key={block.id || `tool-${index}`}
            >
              <div className="tool-head">
                <b>{block.name}</b>
                {block.detail ? <span>{block.detail}</span> : null}
                {block.running ? <i>running</i> : null}
              </div>
              {block.result ? <pre>{block.result}</pre> : null}
            </div>
          );
        }
        return (
          <p className={live ? "stream-cursor" : undefined} style={{ whiteSpace: "pre-wrap" }} key={`x-${index}`}>
            {block.text}
          </p>
        );
      })}
    </div>
  );
}

function TasksScreen({ agents, metrics }: { agents: Agent[]; metrics: MetricsPayload | null }) {
  const now = metrics?.now;
  const ram = now?.containerMb;
  const cpu = now?.containerCpuPct ?? now?.nodeCpuPct;
  const samples = metrics?.samples ?? [];
  const spark = samples.length > 80 ? samples.filter((_, i) => i % Math.ceil(samples.length / 80) === 0) : samples;
  return (
    <>
      <div className="summary-grid">
        <div>
          <strong>{agents.length || 1}</strong>
          <small>Agents</small>
        </div>
        <div>
          <strong>{ram == null ? "—" : `${ram.toFixed(0)}`}</strong>
          <small>RAM MB</small>
        </div>
        <div>
          <strong>{cpu == null ? "—" : `${cpu.toFixed(0)}%`}</strong>
          <small>CPU</small>
        </div>
      </div>
      <div className="section-label">
        <span>Usage · 24h</span>
        <small>{metrics?.stats.sampleCount ?? 0} samples</small>
      </div>
      <UsageSpark samples={spark} />
      <p className="usage-hint">
        Peak {metrics?.stats.ramPeakMb?.toFixed(0) ?? "—"} MB RAM · {metrics?.stats.cpuPeakPct?.toFixed(0) ?? "—"}% CPU.
        Older than 24h is deleted.{" "}
        <a href="/settings#usage">Full charts in Settings</a>
      </p>
      {samples.length > 0 && (
        <div className="usage-mini-log">
          {samples
            .slice(-12)
            .slice()
            .reverse()
            .map((row) => (
              <div key={row.ts}>
                <time>
                  {new Date(row.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </time>
                <span>{row.containerMb.toFixed(1)} MB</span>
                <span>{(row.containerCpuPct ?? row.nodeCpuPct).toFixed(1)}%</span>
                <small>{row.piAlive ? "Pi" : "idle"}</small>
              </div>
            ))}
        </div>
      )}
      <div className="section-label">
        <span>Agents</span>
        <small>role + skills + MCP</small>
      </div>
      <div className="work-list">
        {agents.map((agent) => (
          <Work
            key={agent.id}
            icon={agent.short}
            color={agent.color}
            title={agent.name}
            detail={toolsLabel(agent)}
            progress={100}
          />
        ))}
      </div>
    </>
  );
}

function UsageSpark({ samples }: { samples: ResourceSample[] }) {
  const w = 360;
  const h = 72;
  if (samples.length < 2) {
    return <p className="usage-hint">Usage log fills in every 15 seconds after boot.</p>;
  }
  const ram = samples.map((row) => row.containerMb);
  const cpu = samples.map((row) => row.containerCpuPct ?? row.nodeCpuPct);
  const ramMax = Math.max(1, ...ram);
  const cpuMax = Math.max(1, ...cpu);
  const path = (values: number[], max: number) =>
    values
      .map((n, i) => {
        const x = (i / (values.length - 1)) * w;
        const y = h - 4 - (n / max) * (h - 8);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  return (
    <div className="usage-spark">
      <svg viewBox={`0 0 ${w} ${h}`} aria-label="RAM and CPU over 24 hours">
        <path d={path(ram, ramMax)} fill="none" stroke="#008069" strokeWidth="2" />
        <path d={path(cpu, cpuMax)} fill="none" stroke="#d26310" strokeWidth="1.5" />
      </svg>
      <div className="usage-legend compact">
        <span>
          <i style={{ background: "#008069" }} />
          RAM
        </span>
        <span>
          <i style={{ background: "#d26310" }} />
          CPU
        </span>
      </div>
    </div>
  );
}

function Work({
  icon,
  color,
  title,
  detail,
  progress,
}: {
  icon: string;
  color: string;
  title: string;
  detail: string;
  progress: number;
}) {
  return (
    <div className="work-item">
      <span className={`agent-avatar tiny ${color}`}>{icon}</span>
      <div>
        <strong>{title}</strong>
        <small>{detail}</small>
        <i>
          <b style={{ width: `${progress}%` }} />
        </i>
      </div>
      <span>›</span>
    </div>
  );
}

function HostScreen({
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
    <>
      <div className="approval-intro">
        <span>⌁</span>
        <div>
          <strong>{host?.name ?? "HTML host"}</strong>
          <p>{host?.slug ?? "e-agent-site"}</p>
        </div>
      </div>
      <div className="approval-list">
        <div className="approval-item">
          <div>
            <span className="agent-avatar tiny emerald">W</span>
            <small>ee-html.up.railway.app</small>
          </div>
          <h3>{host?.url ? "Live site" : host?.configured ? "Ready to publish" : "API key missing"}</h3>
          <p>
            {host?.lastError ??
              (host?.url
                ? "The host zips the workspace after each Website Dev Agent chat and publishes it here."
                : "Add the HTML host API key on the Settings page. The agent only edits files.")}
          </p>
          <div>
            <button disabled={!url} onClick={() => url && window.open(url, "_blank", "noopener,noreferrer")}>
              Open live site
            </button>
            <button disabled={!host?.configured || publishing} onClick={onPublish}>
              {publishing ? "Publishing…" : "Publish now"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function LibraryScreen({ files }: { files: WorkspaceFile[] }) {
  const list = files.length ? files : [{ path: "index.html", size: 0 }];
  return (
    <>
      <label className="search">
        <span>⌕</span>
        <input placeholder="Workspace files" />
      </label>
      <div className="section-label">
        <span>Workspace files</span>
        <small>/storage/workspace</small>
      </div>
      <div className="library-grid">
        {list.map((file) => (
          <Artifact key={file.path} icon="▤" title={file.path} detail={`${file.size} bytes`} tone="mint" />
        ))}
      </div>
    </>
  );
}

function Artifact({ icon, title, detail, tone }: { icon: string; title: string; detail: string; tone: string }) {
  return (
    <button className="artifact">
      <span className={tone}>{icon}</span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </button>
  );
}

function ModelPicker({
  models,
  selectedModelId,
  open,
  onToggle,
  onSelect,
  compact = false,
}: {
  models: ModelOption[];
  selectedModelId: string;
  open: boolean;
  onToggle: () => void;
  compact?: boolean;
  onSelect: (modelId: string) => void;
}) {
  if (!compact) {
    return (
      <div className="model-panel">
        <div className="section-label">
          <span>Model</span>
          <small>{open ? "Tap to close" : "Tap to switch"}</small>
        </div>
        <div className="model-row">
          {models.map((model) => (
            <button
              key={model.id}
              type="button"
              className={["model-pill", selectedModelId === model.id ? "selected" : "", model.available ? "" : "disabled"]
                .filter(Boolean)
                .join(" ")}
              disabled={!model.available}
              onClick={() => onSelect(model.id)}
            >
              <strong>{model.shortLabel}</strong>
              <small>{model.available ? model.label : "Key missing"}</small>
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (!open) return null;

  return (
    <div className="model-sheet">
      {models.map((model) => (
        <button
          key={model.id}
          type="button"
          className={["model-sheet-item", selectedModelId === model.id ? "selected" : "", model.available ? "" : "disabled"]
            .filter(Boolean)
            .join(" ")}
          disabled={!model.available}
          onClick={() => onSelect(model.id)}
        >
          <span>
            <strong>{model.label}</strong>
            <small>{model.available ? model.provider : "Add API key first"}</small>
          </span>
          {selectedModelId === model.id && <b>{"\u2713"}</b>}
        </button>
      ))}
      <button type="button" className="model-sheet-close" onClick={onToggle}>
        Done
      </button>
    </div>
  );
}

function introFor(action: number, agent?: Agent) {
  if (agent?.slug === "proposal") {
    const copy = [
      "Send a text change, invoice screenshot, or PDF. I will update the Eternalgy proposal; the host pushes to GitHub so Railway deploys it.",
      "Open the live proposal, or ask me to change client, package, quotation, or images.",
      "Ask what files are in the proposal workspace, or what is currently on proposal.html.",
    ];
    return copy[action] ?? copy[0];
  }
  const copy = [
    "Tell me what website you want. I only edit files. The host publishes them to ee-html.",
    "Ask me to create or update pages. The live site is on ee-html, not GitHub.",
    "Ask what files are in the workspace, or tell me what to build next.",
  ];
  return copy[action] ?? copy[0];
}

function promptsFor(action: number, agent?: Agent) {
  if (agent?.slug === "proposal") {
    const primary = [
      "Change the client name on the proposal cover",
      "List the proposal workspace files",
      "Update the package to 36pcs Jinko 650W",
    ];
    return action === 0 ? primary : primary.slice().reverse();
  }
  const primary = [
    "Create a simple landing page with a hero and contact section",
    "List the files in the workspace",
    "Add a dark theme stylesheet to the site",
  ];
  return action === 0 ? primary : primary.slice().reverse();
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
