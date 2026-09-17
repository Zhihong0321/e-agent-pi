// Presentational components shared by the mobile (/) and desktop (/web) shells.
// Pure props-in/JSX-out: no data fetching, no session state.
import { useEffect, useRef, useState, type SVGProps } from "react";
import {
  ChatCopy,
  collectImageHrefs,
  isImageHref,
  normalizeWorkspacePath,
  tokenizeChat,
  workspaceMediaUrl,
  type ChatPart,
} from "./chat-markdown";
import {
  ApiError,
  SHORT_MAX,
  avatarClass,
  avatarLabel,
  classifySession,
  formatSessionTime,
  groupSessions,
  hostHost,
  previewText,
  promptsFor,
  toolCount,
  toolsLabel,
  type Agent,
  type ChatFilter,
  type ChatMessage,
  type ChatSession,
  type HostStatus,
  type SiriSignal,
  type TurnBlock,
  type WorkspaceFile,
} from "./studio";

export function ChatsTab({
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
  onDelete,
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
  onDelete: (id: string) => void;
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
                <div key={session.id} className="session-row">
                  <button
                    type="button"
                    className="session-btn"
                    onClick={() => onOpen(session.id)}
                  >
                    <span
                      className={avatarClass(avatarLabel(agent?.short, agent?.name || "Chat"), agent?.color || "emerald")}
                    >
                      {avatarLabel(agent?.short, agent?.name || "Chat")}
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
                          {session.engine === "agy" && <span className="tag-agy">AGY</span>}
                          <span>{previewText(session.preview) || "New chat"}</span>
                        </span>
                        {flag === "ask" && <span className="unread-badge">1</span>}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="session-delete"
                    aria-label={`Delete chat "${session.title || "New chat"}"`}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (window.confirm(`Delete "${session.title || "this chat"}"? This can't be undone.`)) {
                        onDelete(session.id);
                      }
                    }}
                  >
                    <IconTrash />
                  </button>
                </div>
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

export function AgentsTab({
  agents,
  onOpen,
  onRename,
}: {
  agents: Agent[];
  onOpen: (id: string) => void;
  onRename: (id: string, short: string, password?: string) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [renameError, setRenameError] = useState("");

  const resetEdit = () => {
    setEditingId("");
    setDraft("");
    setPassword("");
    setNeedsPassword(false);
    setSaving(false);
    setRenameError("");
  };

  const startEdit = (agent: Agent) => {
    resetEdit();
    setEditingId(agent.id);
    setDraft(avatarLabel(agent.short, agent.name));
  };

  const save = async (agent: Agent) => {
    const next = draft.replace(/\s+/g, " ").trim();
    if (!next) {
      setRenameError("The tile needs at least one character.");
      return;
    }
    setSaving(true);
    setRenameError("");
    try {
      await onRename(agent.id, next, needsPassword ? password : undefined);
      resetEdit();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setNeedsPassword(true);
        setRenameError(password ? "Wrong password." : "Enter the access password to save this tile.");
        setPassword("");
      } else {
        setRenameError(err instanceof Error ? err.message : "Rename failed");
      }
      setSaving(false);
    }
  };

  return (
    <>
      <div className="section-row">
        <span>Your agents</span>
        <small>{agents.length} online</small>
      </div>
      {agents.map((agent) => {
        const editing = editingId === agent.id;
        const label = editing ? draft.trim() || "?" : avatarLabel(agent.short, agent.name);
        return (
          <div className={editing ? "agent-row editing" : "agent-row"} key={agent.id}>
            <div className="agent-row-top">
              <button
                type="button"
                className="agent-btn"
                onClick={() => {
                  if (!editing) onOpen(agent.id);
                }}
              >
                <span className={avatarClass(label, agent.color)}>
                  {label}
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
              <button
                type="button"
                className={editing ? "tile-edit on" : "tile-edit"}
                aria-label={editing ? `Stop renaming ${agent.name}` : `Rename the ${agent.name} tile`}
                onClick={() => (editing ? resetEdit() : startEdit(agent))}
              >
                <IconPencil />
              </button>
            </div>
            {editing && (
              <form
                className="tile-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(agent);
                }}
              >
                <label>
                  Tile label
                  <input
                    value={draft}
                    maxLength={SHORT_MAX}
                    autoFocus
                    spellCheck={false}
                    placeholder={avatarLabel(agent.short, agent.name)}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") resetEdit();
                    }}
                  />
                </label>
                {needsPassword && (
                  <label>
                    Access password
                    <input
                      type="password"
                      value={password}
                      autoComplete="current-password"
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                )}
                <div className="tile-form-actions">
                  <small>Up to {SHORT_MAX} characters inside the square.</small>
                  <button type="button" className="ghost" onClick={resetEdit}>
                    Cancel
                  </button>
                  <button type="submit" disabled={saving || !draft.trim()}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
                {renameError && <p className="tile-error">{renameError}</p>}
              </form>
            )}
          </div>
        );
      })}
    </>
  );
}

export function LiveTab({
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

export function FilesTab({
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

export function AgentConversation({
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
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 160) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [history, loading]);

  const last = history[history.length - 1];
  const showCard =
    last?.role === "assistant" && !last.streaming && siriSignal === "complete" && Boolean(liveUrl) && publishOk;
  const isAsking = siriSignal === "ask" && last?.role === "assistant" && !last.streaming;

  return (
    <div className="chat-scroll" ref={scrollRef}>
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
            asking={isAsking && index === history.length - 1}
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
      {siriSignal === "complete" && last?.role === "assistant" && !last.streaming && (
        <div className="task-complete-pill" role="status">
          Task completed
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

export function AssistantTurn({
  item,
  agentId,
  showCard,
  asking,
  liveUrl,
  onOpenMedia,
}: {
  item: ChatMessage;
  agentId: string;
  showCard: boolean;
  asking: boolean;
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
    <div className={asking ? "bubble-agent asking" : "bubble-agent"}>
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
        <div className={asking ? "meta-row asking-row" : "meta-row"}>
          {asking && <span className="asking-label">Open question</span>}
          <span>Now</span>
        </div>
      )}
    </div>
  );
}

export type WorkPhase = "on" | "done" | "off";

/**
 * How long the dark "Eter Agent CLI initializing…" beat holds before the window morphs to the light
 * theme. The engine needs 3-5s to produce a first token; this covers the front of that wait with
 * something deliberate instead of an empty card. It is also the hard floor for the whole presentation:
 * a turn that ends (or errors) inside the beat keeps the live window until the beat completes, and the
 * streamed transcript is not mounted beneath it. Nothing cancels it early — a full beat is the point.
 * Keep in sync with the boot timings in globals.css.
 */
export const BOOT_MS = 2440;
/** Done beat (0.72s) plus the sink/fade exit; matches `.working-layer.done` in globals.css. */
export const EXIT_MS = 1260;

/**
 * Whose wait is it? Shown once a turn has gone quiet, so a slow reply is never mistaken for a broken app.
 * - agent: the socket is alive (5s heartbeats landing) but the model has not produced anything for a while.
 * - network: the socket has stalled and a tiny round trip to the host is failing or slow too.
 * - host: the socket has stalled but the host answers quickly, so the turn's process is the one that went quiet.
 * - offline: the browser reports no network at all.
 */
export type NetVerdict = { kind: "agent" | "network" | "host" | "offline"; rtt?: number };
/** Agent silence before the readout appears. */
export const QUIET_MS = 8000;
/** No bytes at all (heartbeat is 5s) before the pipe counts as stalled. */
export const STALL_MS = 12000;
/** A round trip slower than this is reported as a slow connection. */
export const SLOW_RTT_MS = 1500;

/** One cheap GET against the health route; `null` when it fails or takes longer than 4s. */
export async function probeRtt(): Promise<number | null> {
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), 4000);
  const at = performance.now();
  try {
    const res = await fetch(`/api/health?probe=${Date.now()}`, { cache: "no-store", signal: ac.signal });
    return res.ok ? Math.round(performance.now() - at) : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

export function netText(net: NetVerdict) {
  const rtt = net.rtt == null ? "" : net.rtt >= 1000 ? `${(net.rtt / 1000).toFixed(1)} s` : `${net.rtt} ms`;
  switch (net.kind) {
    case "agent":
      return `Your connection is fine${rtt ? ` (${rtt})` : ""}. The agent is still thinking; the wait is on our side.`;
    case "network":
      return rtt
        ? `Your connection is slow (${rtt} round trip). The agent keeps working; the reply is stuck in transit.`
        : "Your connection dropped. The agent keeps working; we will reconnect.";
    case "host":
      return "Your connection is fine, but the host went quiet. It may be restarting; we will reconnect.";
    case "offline":
      return "You are offline. The agent keeps working; reconnect to catch up.";
  }
}

export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Full-pane "agent is working" presentation: dims the chat 60%, floats a window that carries the
 * complete live turn (the same Thinking/tool rows and streamed text the chat renders, scrollable and
 * auto-following), and exposes only a Stop button. Holds a short Done/Stopped beat before fading out.
 */
export function WorkingOverlay({
  active,
  agent,
  status,
  message,
  error,
  engineLabel,
  modelLabel,
  onStop,
  onBack,
  onOpenMedia,
  pulse,
}: {
  active: boolean;
  agent: Agent;
  status: string;
  message?: ChatMessage;
  error: string;
  engineLabel: string;
  modelLabel: string;
  onStop: () => void;
  onBack: () => void;
  onOpenMedia: (src: string, alt?: string) => void;
  pulse: { current: number };
}) {
  const [phase, setPhase] = useState<WorkPhase>(active ? "on" : "off");
  const [seenActive, setSeenActive] = useState(active);
  const [elapsed, setElapsed] = useState(0);
  const [stopped, setStopped] = useState(false);
  // Only a turn that starts while we are watching boots; reopening a chat mid-turn shows the live window at once.
  const [boot, setBoot] = useState(false);
  // False until the window has painted once; the flight starts on the frame after (see `.working-layer.pre`).
  const [entered, setEntered] = useState(false);
  const [net, setNet] = useState<NetVerdict | null>(null);
  const startRef = useRef(0);
  const lastContentRef = useRef(0);
  const probeRef = useRef({ busy: false, at: 0 });
  const windowRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Adjust state during render when the turn starts or ends (React's sanctioned alternative to a setState effect).
  if (active !== seenActive) {
    setSeenActive(active);
    if (active) {
      setElapsed(0);
      setStopped(false);
      setBoot(true);
      setEntered(false);
      setNet(null);
      setPhase("on");
    } else if (phase === "on") {
      setPhase("done");
    }
  }

  // The boot timer owns the beat: a flickering `active` re-affirms the same `true` and React bails out.
  useEffect(() => {
    if (!boot) return undefined;
    const timer = window.setTimeout(() => setBoot(false), BOOT_MS);
    return () => window.clearTimeout(timer);
  }, [boot]);

  // Stage the entrance: let the expensive first frame paint at rest, then start the flight two frames
  // later so a slow rasterization cannot eat the travel (it did — see `.working-layer.pre` in globals.css).
  useEffect(() => {
    if (phase !== "on" || entered) return undefined;
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [phase, entered]);

  useEffect(() => {
    if (phase !== "on") return undefined;
    windowRef.current?.focus({ preventScroll: true });
    const at = Date.now();
    startRef.current = at;
    lastContentRef.current = at;
    const timer = window.setInterval(() => setElapsed(Date.now() - at), 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  // A turn that ends inside the boot beat still gets its outcome shown: the exit clock starts when boot ends.
  useEffect(() => {
    if (phase !== "done" || boot) return undefined;
    const timer = window.setTimeout(() => setPhase("off"), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [phase, boot]);

  const blocks = message?.blocks ?? [];
  const workBlocks = blocks.filter((block) => block.type === "thinking" || block.type === "tool");
  const text = blocks
    .filter((block) => block.type === "text" || block.type === "note")
    .map((block) => block.text)
    .join("\n");
  const stepCount = workBlocks.length;
  const doneCount = workBlocks.filter((block, index) =>
    block.type === "tool" ? !block.running : index < workBlocks.length - 1 || Boolean(text),
  ).length;

  // Follow the live transcript unless the reader has scrolled up to inspect something.
  const contentSize = blocks.length + text.length;
  useEffect(() => {
    lastContentRef.current = Date.now();
    const body = bodyRef.current;
    if (!body) return;
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    if (distance < 160) body.scrollTop = body.scrollHeight;
  }, [contentSize]);

  // The connection readout: once a second, decide whose wait this is. The round-trip probe runs only
  // while the turn is already slow, at most every 8s when the pipe is stalled and every 20s otherwise.
  const diagnosing = phase === "on" && !boot;
  useEffect(() => {
    if (!diagnosing) return undefined;
    const tick = () => {
      const now = Date.now();
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setNet({ kind: "offline" });
        return;
      }
      // A pulse older than this turn's start belongs to the previous turn.
      const lastByte = () => Math.max(pulse.current, startRef.current);
      const stalled = now - lastByte() > STALL_MS;
      const quiet = now - lastContentRef.current > QUIET_MS;
      if (!stalled && !quiet) {
        setNet(null);
        return;
      }
      const probe = probeRef.current;
      if (probe.busy || now - probe.at < (stalled ? 8000 : 20000)) return;
      probe.busy = true;
      probe.at = now;
      void probeRtt().then((rtt) => {
        probe.busy = false;
        const stalledNow = Date.now() - lastByte() > STALL_MS;
        if (rtt == null || rtt > SLOW_RTT_MS) setNet({ kind: "network", rtt: rtt ?? undefined });
        else setNet(stalledNow ? { kind: "host", rtt } : { kind: "agent", rtt });
      });
    };
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [diagnosing, pulse]);

  if (phase === "off") return null;

  // The boot beat is the floor: a turn that finished inside it is still presented as live until it ends.
  const shownPhase: WorkPhase = boot && phase === "done" ? "on" : phase;
  const live = shownPhase === "on";
  // The transcript stays out of the tree during boot: it is hidden under the boot layer anyway, and
  // rendering streamed blocks mid-animation would jank the beat and stretch the card beneath it.
  const showBody = !boot && (workBlocks.length > 0 || Boolean(text));
  const label = avatarLabel(agent.short, agent.name);
  const outcome = stopped ? "Stopped" : error ? "Ended with an error" : "Done";
  const silent = live && !blocks.length;
  const headline = !live
    ? outcome
    : status || (silent ? `Waiting for ${engineLabel} ${modelLabel} to respond… ${formatElapsed(elapsed)}` : "Working…");

  return (
    <div
      className={["working-layer", shownPhase, entered ? "" : "pre"].filter(Boolean).join(" ")}
      role="dialog"
      aria-modal="true"
      aria-label={boot ? `Starting ${agent.name}` : live ? `${agent.name} is working` : outcome}
    >
      <div
        className={boot ? "working-window booting" : "working-window"}
        ref={windowRef}
        tabIndex={-1}
      >
        {boot && (
          <div className="working-boot">
            <span className="working-boot-aurora" aria-hidden="true" />
            <span className="working-boot-scan" aria-hidden="true" />
            <span className="working-boot-mark" aria-hidden="true">
              <i className="working-boot-ring" />
              <span className={avatarClass(label, `sm ${agent.color}`)}>{label}</span>
            </span>
            <p className="working-boot-title">Eter Agent CLI</p>
            <p className="working-boot-sub">
              initializing
              <i />
              <i />
              <i />
            </p>
            <ul className="working-boot-log" aria-hidden="true">
              <li>linking runtime</li>
              <li>mounting toolbox</li>
              <li>
                waking {engineLabel} {modelLabel}
              </li>
            </ul>
            <span className="working-boot-rail" aria-hidden="true">
              <i />
            </span>
          </div>
        )}
        <div className="working-bar" aria-hidden="true">
          <i />
        </div>
        <header className="working-head">
          <span className={avatarClass(label, `sm ${agent.color}`)}>{label}</span>
          <div>
            <strong>{agent.name}</strong>
            <span className="working-sub">
              <i className="status-dot" />
              {live ? "Working" : outcome} · {engineLabel} {modelLabel}
              {stepCount ? ` · ${doneCount}/${stepCount} steps` : ""}
            </span>
          </div>
          <time>{formatElapsed(elapsed)}</time>
        </header>
        <div className={silent ? "working-status silent" : "working-status"} role="status" aria-live="polite">
          {live ? (
            <i className="spin" />
          ) : (
            <span className="turn-icon">
              <IconCheck tiny />
            </span>
          )}
          <span>{headline}</span>
        </div>
        {live && !boot && net && (
          <p className={`working-net ${net.kind}`} role="status" aria-live="polite">
            <i />
            <span>{netText(net)}</span>
          </p>
        )}
        {showBody && (
          <div className="working-body" ref={bodyRef}>
            {workBlocks.length > 0 && (
              <TurnBlocks blocks={workBlocks} streaming={live} agentId={agent.id} onOpen={onOpenMedia} />
            )}
            {text ? (
              <div className="working-text">
                <ChatCopy text={text} agentId={agent.id} streaming={live} onOpen={onOpenMedia} />
              </div>
            ) : null}
          </div>
        )}
        <div className="working-actions">
          <button
            type="button"
            className="working-stop"
            disabled={!live}
            onClick={() => {
              setStopped(true);
              onStop();
            }}
          >
            <i />
            Stop
          </button>
          <button type="button" className="working-back" disabled={!live} onClick={onBack}>
            <IconBack />
            Back to chats
          </button>
        </div>
        {live && (
          <p className="working-hint">{agent.name} keeps working while you are away. Reopen this chat any time.</p>
        )}
      </div>
    </div>
  );
}

export function MediaLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
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

export function TurnBlocks({
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
  const live = Boolean(streaming);
  const [revealed, setRevealed] = useState(live);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setRevealed(live);
  }, [live]);

  const showDetails = live || revealed;
  const steps = blocks.length;
  const stepLabel = `${steps} ${steps === 1 ? "step" : "steps"}`;

  return (
    <div className="turn-stack">
      {!live && (
        <button
          type="button"
          className="turn-row"
          aria-expanded={revealed}
          onClick={() => setRevealed((prev) => !prev)}
        >
          <span className="turn-icon">
            <IconCheck tiny />
          </span>
          <span className="turn-copy">
            <strong>Thought process</strong>
            <span>{stepLabel}</span>
          </span>
          <IconChevron rotated={revealed} />
        </button>
      )}
      {showDetails && (
        <div className={live ? undefined : "turn-work"}>
          {blocks.map((block, index) => {
            const key = block.type === "tool" ? block.id || `tool-${index}` : `t-${index}`;
            if (block.type === "thinking") {
              const done = !live || index < blocks.length - 1;
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
            const expanded = open[key] ?? live;
            const hasResult = Boolean(block.result);
            return (
              <div key={key}>
                <button
                  type="button"
                  className="turn-row"
                  disabled={!hasResult}
                  onClick={() => setOpen((prev) => ({ ...prev, [key]: !expanded }))}
                >
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
                  {hasResult ? <IconChevron rotated={expanded} /> : <span className="turn-meta">{running ? "" : block.isError ? "error" : ""}</span>}
                </button>
                {expanded && block.result ? (
                  <div className="turn-text">
                    <ChatCopy text={block.result} agentId={agentId} onOpen={onOpen} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export type IconProps = SVGProps<SVGSVGElement> & { wide?: boolean; tiny?: boolean; rotated?: boolean; color?: string };

export function svgProps(rest: SVGProps<SVGSVGElement>, size = 22): SVGProps<SVGSVGElement> {
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

export function IconSearch(props: IconProps) {
  return (
    <svg {...svgProps(props, 18)} strokeWidth={2.2}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}
export function IconSettings(props: IconProps) {
  return (
    <svg {...svgProps(props, 18)} strokeWidth={2}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
export function IconInstall(props: IconProps) {
  return (
    <svg {...svgProps(props, 18)} strokeWidth={2}>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 19h16" />
    </svg>
  );
}
export function IconPencil(props: IconProps) {
  return (
    <svg {...svgProps(props, 16)} strokeWidth={2}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}
export function IconPlus({ wide, ...props }: IconProps) {
  return (
    <svg {...svgProps(props, wide ? 22 : 18)} strokeWidth={wide ? 2.2 : 2.4}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
export function IconBack(props: IconProps) {
  return (
    <svg {...svgProps(props, 24)} strokeWidth={2.4}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}
export function IconChevron({ rotated, ...props }: IconProps) {
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
export function IconSend(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M3 11.5L21 3l-4 18-5.5-6.5z" />
    </svg>
  );
}
export function IconMic(props: IconProps) {
  return (
    <svg {...svgProps(props, 20)} strokeWidth={2.2}>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
export function IconCheck({ tiny, ...props }: IconProps) {
  return (
    <svg {...svgProps(props, tiny ? 10 : 12)} strokeWidth={tiny ? 3.5 : 3.5}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
export function IconTicks({ color, ...props }: IconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color || "#53bdeb"} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }} {...props}>
      <path d="M2 13l4 4L14 9" />
      <path d="M10 17l8-8" />
    </svg>
  );
}
export function IconChats(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4 12a8 8 0 1 1 3 6.2L4 20l1.2-3.4A8 8 0 0 1 4 12z" />
    </svg>
  );
}
export function IconAgents(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20a8 8 0 0 1 16 0" />
    </svg>
  );
}
export function IconLive(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
export function IconTrash(props: IconProps) {
  return (
    <svg {...svgProps(props, 18)} strokeWidth={2}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
export function IconFiles(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
