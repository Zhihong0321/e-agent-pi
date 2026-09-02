import { useEffect, useRef, useState } from "react";

type View = "agents" | "menu" | "chats" | "chat" | "tasks" | "approvals" | "library";

const SESSION_KEY = "e-agent-active-session";
const AGENT_KEY = "e-agent-active-agent";

type ModelOption = {
  id: string;
  label: string;
  shortLabel: string;
  provider: string;
  model: string;
  available: boolean;
};

type GitStatus = {
  connected: boolean;
  configured: boolean;
  repo: string | null;
  branch: string;
  sha: string | null;
  dirty: boolean;
  htmlUrl: string | null;
  repoUrl: string | null;
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
  git?: GitStatus;
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
  skills: { id: string; name: string; description: string }[];
  mcp: { id: string; name: string; description: string }[];
};

function agentActions(agent: Agent) {
  return [
    { icon: "✦", title: "Chat to Agent", description: `Talk to ${agent.name}` },
    { icon: "⌁", title: "Open GitHub repo", description: "Open the connected repository" },
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

function parseTranscript(content: string): { text?: string; blocks?: TurnBlock[] } | null {
  if (!content || content[0] !== "{") return null;
  try {
    const data = JSON.parse(content) as { v?: number; text?: string; blocks?: TurnBlock[] };
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
    return { ...msg, content: parsed.text ?? "", blocks: parsed.blocks };
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
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [liveStatus, setLiveStatus] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const historyLoad = useRef(0);
  const selected = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const isChat = view === "chat";
  const activeModel = models.find((model) => model.id === selectedModelId);
  const activeSession = sessions.find((session) => session.id === sessionId);

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
        const health = await api<{ git?: GitStatus }>("/api/health");
        if (health.git && !("error" in health.git)) setGit(health.git);
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
    if (view !== "library") return;
    void (async () => {
      try {
        const data = await api<{ files: WorkspaceFile[] }>("/api/files");
        setFiles(data.files ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load files");
      }
    })();
  }, [view]);

  useEffect(() => {
    if (view !== "approvals") return;
    void (async () => {
      try {
        setGit(await api<GitStatus>("/api/git"));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load git status");
      }
    })();
  }, [view]);

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
      const url = git?.htmlUrl ?? git?.repoUrl;
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
        if (event.type === "git" && event.git) setGit(event.git);
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
    <main className={dark ? "stage dark" : "stage"}>
      <section className="phone sales-os" aria-label="Website dev agent chat">
        <header className="topbar">
          <div className="title-group">
            {view !== "agents" && view !== "tasks" && view !== "approvals" && view !== "library" && (
              <button className="back" onClick={goBack} aria-label="Go back">
                ‹
              </button>
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
            <button className="demo-badge">{git?.connected ? "GIT" : "LIVE"}</button>
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
              git={git}
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
              git={git}
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
              error={error}
              onPrompt={send}
              models={models}
              activeModel={activeModel}
              modelMenuOpen={modelMenuOpen}
              onToggleModelMenu={() => setModelMenuOpen((open) => !open)}
              onSelectModel={(modelId) => void switchModel(modelId)}
            />
          )}
          {view === "tasks" && <TasksScreen git={git} agents={agents} />}
          {view === "approvals" && <GitScreen git={git} />}
          {view === "library" && <LibraryScreen files={files} />}
        </div>

        {isChat && (
          <div className="composer-wrap">
            <button className="attach" aria-label="Attach file">
              ＋
            </button>
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void send()}
              placeholder={loading ? "Agent is working…" : `Message ${selected?.name ?? "agent"}…`}
              disabled={loading}
            />
            <button className="send" onClick={() => void send()} aria-label="Send" disabled={loading}>
              ➤
            </button>
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
              <small>Git</small>
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
  git,
  sessions,
  onOpenSession,
  onNewChat,
}: {
  agents: Agent[];
  onOpen: (id: string) => void;
  git: GitStatus | null;
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
            {git?.configured
              ? `${git.repo} · ${git.branch}${git.sha ? ` · ${git.sha.slice(0, 7)}` : ""}`
              : "GitHub not connected yet — agents still work in the volume workspace."}
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
          <span>{git?.connected ? "On" : "Off"}</span>
          <small>GitHub</small>
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
  git,
}: {
  agent: Agent;
  onOpen: (index: number) => void;
  models: ModelOption[];
  selectedModelId: string;
  modelMenuOpen: boolean;
  onToggleModelMenu: () => void;
  onSelectModel: (modelId: string) => void;
  git: GitStatus | null;
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
            disabled={index === 1 && !git?.repoUrl}
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
            {active?.label ?? "Pick a model"} · {git?.repo ?? "no GitHub repo"}
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
          <small>
            <span /> {liveStatus || "Online · this chat only"}
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
          <p>{introFor(actionIndex)}</p>
          <time>Now</time>
        </div>
      </div>
      {history.length === 0 && (
        <div className="quick-actions">
          <small>QUICK START</small>
          {promptsFor(actionIndex).map((prompt) => (
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

function TasksScreen({ git, agents }: { git: GitStatus | null; agents: Agent[] }) {
  return (
    <>
      <div className="summary-grid">
        <div>
          <strong>{agents.length || 1}</strong>
          <small>Agents</small>
        </div>
        <div>
          <strong>1</strong>
          <small>Workspace</small>
        </div>
        <div>
          <strong>{git?.connected ? "Git" : "Off"}</strong>
          <small>Remote</small>
        </div>
      </div>
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

function GitScreen({ git }: { git: GitStatus | null }) {
  return (
    <>
      <div className="approval-intro">
        <span>⌁</span>
        <div>
          <strong>{git?.repo ?? "No GitHub repo"}</strong>
          <p>
            {git?.branch ?? "main"}
            {git?.sha ? ` · ${git.sha.slice(0, 7)}` : ""}
            {git?.dirty ? " · dirty" : ""}
          </p>
        </div>
      </div>
      <div className="approval-list">
        <div className="approval-item">
          <div>
            <span className="agent-avatar tiny emerald">W</span>
            <small>Workspace git</small>
          </div>
          <h3>{git?.connected ? "Repository connected" : "GitHub disconnected"}</h3>
          <p>{git?.lastError ?? "The host clones, commits, and pushes. The agent only edits files."}</p>
          <div>
            <button
              disabled={!git?.repoUrl}
              onClick={() => git?.repoUrl && window.open(git.repoUrl, "_blank", "noopener,noreferrer")}
            >
              Open repo
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

function introFor(action: number) {
  const copy = [
    "Tell me what website you want. I only edit files in the workspace. GitHub sync is handled by the host.",
    "Ask me to create or update pages in the workspace. I do not publish or deploy.",
    "Ask what files are in the workspace, or tell me what to build next.",
  ];
  return copy[action] ?? copy[0];
}

function promptsFor(action: number) {
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
