import { useEffect, useState } from "react";

type AgentId = "website";
type View = "agents" | "menu" | "chat" | "tasks" | "approvals" | "library";

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

type ChatMessage = {
  id?: number;
  role: "user" | "assistant";
  content: string;
  modelId?: string | null;
};

type WorkspaceFile = { path: string; size: number };

type Agent = {
  id: AgentId;
  name: string;
  short: string;
  headline: string;
  description: string;
  color: string;
  time: string;
  tools: string;
  actions: { title: string; description: string; icon: string }[];
};

const agents: Agent[] = [
  {
    id: "website",
    name: "Website Dev Agent",
    short: "W",
    color: "emerald",
    time: "Now",
    headline: "Ready to build in the workspace",
    description: "Designs static websites in the GitHub-backed workspace",
    tools: "HTML · CSS · JS · Workspace",
    actions: [
      { icon: "✦", title: "Chat to Agent", description: "Describe the website you want built" },
      { icon: "⌁", title: "Open GitHub repo", description: "Open the connected repository" },
      { icon: "▤", title: "Workspace status", description: "Ask what files exist in the workspace" },
    ],
  },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export default function Home() {
  const [view, setView] = useState<View>("agents");
  const [actionIndex, setActionIndex] = useState(0);
  const [dark, setDark] = useState(false);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const selected = agents[0];
  const isChat = view === "chat";
  const activeModel = models.find((model) => model.id === selectedModelId);

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
    if (view !== "chat") return;
    void (async () => {
      try {
        const data = await api<{ messages: ChatMessage[] }>("/api/messages");
        setHistory(data.messages ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not load messages");
      }
    })();
  }, [view]);

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

  const openAgent = () => {
    setView("menu");
    setError("");
  };
  const openAction = (index: number) => {
    if (index === 1) {
      const url = git?.htmlUrl ?? git?.repoUrl;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    setActionIndex(index);
    setView("chat");
    setError("");
  };

  const send = async (text = message) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setMessage("");
    setError("");
    setLoading(true);
    setHistory((prev) => [...prev, { role: "user", content: trimmed }]);
    try {
      const data = await api<{ reply?: string; git?: GitStatus }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: trimmed, modelId: selectedModelId || undefined }),
      });
      setHistory((prev) => [...prev, { role: "assistant", content: data.reply ?? "" }]);
      if (data.git) setGit(data.git);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Agent request failed");
    } finally {
      setLoading(false);
    }
  };

  const goBack = () => {
    if (view === "chat") setView("menu");
    else setView("agents");
  };
  const goRoot = (next: View) => {
    setView(next);
    setError("");
  };
  const title =
    view === "agents"
      ? "Website Studio"
      : view === "menu"
        ? selected.name.replace(" Agent", "")
        : view === "chat"
          ? selected.actions[actionIndex].title
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
              <h1>{title}</h1>
            </div>
          </div>
          <div className="header-buttons">
            <button className="demo-badge">{git?.connected ? "GIT" : "LIVE"}</button>
            <button className="icon-button" onClick={() => setDark(!dark)} aria-label="Toggle theme">
              {dark ? "☀" : "☾"}
            </button>
          </div>
        </header>

        <div className={isChat ? "content chat-content" : "content"}>
          {view === "agents" && <AgentInbox onOpen={openAgent} git={git} />}
          {view === "menu" && (
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
          {view === "chat" && (
            <AgentConversation
              agent={selected}
              actionIndex={actionIndex}
              history={history}
              loading={loading}
              error={error}
              onPrompt={send}
              models={models}
              activeModel={activeModel}
              modelMenuOpen={modelMenuOpen}
              onToggleModelMenu={() => setModelMenuOpen((open) => !open)}
              onSelectModel={(modelId) => void switchModel(modelId)}
            />
          )}
          {view === "tasks" && <TasksScreen git={git} />}
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
              placeholder={loading ? "Agent is working…" : "Message Website Dev Agent…"}
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

function AgentInbox({ onOpen, git }: { onOpen: () => void; git: GitStatus | null }) {
  return (
    <>
      <div className="briefing-banner">
        <span>✦</span>
        <div>
          <strong>Website workspace is ready</strong>
          <p>
            {git?.configured
              ? `${git.repo} · ${git.branch}${git.sha ? ` · ${git.sha.slice(0, 7)}` : ""}`
              : "GitHub not connected yet — agent still works in the volume workspace."}
          </p>
        </div>
      </div>
      <label className="search">
        <span>⌕</span>
        <input placeholder="Search agents" />
      </label>
      <div className="section-label">
        <span>Your agent</span>
        <small>1 online</small>
      </div>
      <div className="agent-inbox">
        {agents.map((agent) => (
          <button className="agent-row" key={agent.id} onClick={onOpen}>
            <span className={`agent-avatar ${agent.color}`}>
              {agent.short}
              <i />
            </span>
            <span className="row-copy">
              <strong>{agent.name}</strong>
              <small>{agent.headline}</small>
            </span>
            <span className="row-meta">
              <time>{agent.time}</time>
            </span>
          </button>
        ))}
      </div>
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
        <span>What would you like to do?</span>
      </div>
      <div className="submenu">
        {agent.actions.map((action, index) => (
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
        <strong>Website dev only</strong>
        <p>This agent only edits workspace files. The host syncs GitHub. Nothing is published from this service.</p>
      </div>
    </>
  );
}

function AgentConversation({
  agent,
  actionIndex,
  history,
  loading,
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
  error: string;
  onPrompt: (text: string) => void;
  models: ModelOption[];
  activeModel?: ModelOption;
  modelMenuOpen: boolean;
  onToggleModelMenu: () => void;
  onSelectModel: (modelId: string) => void;
}) {
  const action = agent.actions[actionIndex];
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
            <span /> Online · {action.title}
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
              <p style={{ whiteSpace: "pre-wrap" }}>{item.content}</p>
              <time>Now</time>
            </div>
          </div>
        ),
      )}
      {loading && (
        <div className="bubble agent-bubble">
          <span className="mini-agent">✦</span>
          <div>
            <p>Working in workspace…</p>
            <time>Now</time>
          </div>
        </div>
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
    </div>
  );
}

function TasksScreen({ git }: { git: GitStatus | null }) {
  return (
    <>
      <div className="summary-grid">
        <div>
          <strong>1</strong>
          <small>Agent</small>
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
        <span>Workspace</span>
        <small>volume /storage/workspace</small>
      </div>
      <div className="work-list">
        <Work icon="W" color="emerald" title="Website Dev Agent" detail="Pi · HTML/CSS/JS only" progress={100} />
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
            <small>Website Dev Agent</small>
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
