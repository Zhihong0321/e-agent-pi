// Desktop shell, served at /web. WhatsApp Web format: a thin icon rail, a list
// sidebar and a conversation pane side by side, with no phone frame.
// All state and streaming behaviour comes from the shared useStudio() engine,
// so /web and the mobile app at / can never drift apart on protocol.
import { useEffect, useRef, type ReactNode } from "react";
import {
  AgentConversation,
  AgentsTab,
  ChatsTab,
  FilesTab,
  IconAgents,
  IconBack,
  IconChats,
  IconCheck,
  IconChevron,
  IconFiles,
  IconLive,
  IconMic,
  IconPlus,
  IconSend,
  IconSettings,
  LiveTab,
  MediaLightbox,
  WorkingOverlay,
} from "../chat-parts";
import { avatarClass, avatarLabel, type Tab } from "../studio";
import { useStudio } from "../use-studio";
import "./web.css";

const RAIL: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "agents", label: "Agents", icon: <IconAgents /> },
  { id: "chats", label: "Chats", icon: <IconChats /> },
  { id: "live", label: "Live", icon: <IconLive /> },
  { id: "files", label: "Files", icon: <IconFiles /> },
];

export default function WebHome() {
  const {
    tab,
    setTab,
    aiReplyDark,
    message,
    setMessage,
    history,
    sessions,
    loading,
    inboxReady,
    error,
    setError,
    models,
    agyModels,
    selectedEngine,
    selectedModelId,
    sheet,
    setSheet,
    host,
    publishOk,
    publishing,
    files,
    pendingFiles,
    setPendingFiles,
    media,
    setMedia,
    fileInput,
    liveStatus,
    pulseRef,
    runningId,
    agents,
    selectedAgentId,
    chatFilter,
    setChatFilter,
    query,
    setQuery,
    selected,
    busyHere,
    activeModel,
    siriSignal,
    liveUrl,
    askCount,
    chatOpen,
    publishHost,
    switchModel,
    switchEngine,
    goTab,
    deleteSessionRow,
    openSession,
    startNewChat,
    send,
    stop,
    pickFiles,
    renameAgentTile,
    closeChat,
  } = useStudio();

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!sheet) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheet(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet, setSheet]);

  // The rail swaps sidebar content only. Unlike mobile's goTab it leaves `view`
  // alone, so browsing to Files never tears down the open conversation.
  const railTab = (next: Tab) => {
    if (next === tab) return;
    setTab(next);
    setError("");
  };

  const tabTitle = tab === "chats" ? "Chats" : tab === "agents" ? "Agents" : tab === "live" ? "Live site" : "Files";
  const showChat = chatOpen && Boolean(selected);

  return (
    <main className={["web-stage", aiReplyDark ? "ai-reply-dark" : ""].filter(Boolean).join(" ")}>
      <div className={showChat ? "web-app in-chat" : "web-app"}>
        <nav className="web-rail" aria-label="Sections">
          <span className="web-rail-brand">
            <img src="/logo-black.png" alt="Studio" />
          </span>
          {RAIL.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? "web-rail-btn on" : "web-rail-btn"}
              onClick={() => railTab(item.id)}
              aria-label={item.label}
              aria-current={tab === item.id ? "page" : undefined}
              title={item.label}
            >
              <span className="web-rail-icon">{item.icon}</span>
              <small>{item.label}</small>
              {item.id === "chats" && askCount ? <span className="web-rail-badge">{askCount}</span> : null}
            </button>
          ))}
          <span className="web-rail-spacer" />
          <a className="web-rail-btn" href="/settings" aria-label="Open settings" title="Settings">
            <span className="web-rail-icon">
              <IconSettings />
            </span>
            <small>Settings</small>
          </a>
          <a className="web-rail-btn" href="/" aria-label="Open mobile version" title="Mobile version">
            <span className="web-rail-icon">
              <IconBack />
            </span>
            <small>Mobile</small>
          </a>
        </nav>

        <aside className="web-side">
          <header className="web-side-head">
            <h1>{tabTitle}</h1>
            {tab === "chats" || tab === "agents" ? (
              <button
                className="icon-btn primary"
                type="button"
                aria-label="New chat"
                title="New chat"
                onClick={() => void startNewChat()}
              >
                <IconPlus />
              </button>
            ) : null}
          </header>
          <div className="web-side-body">
            {error && !showChat && <p className="session-error">{error}</p>}
            {tab === "chats" && (
              <ChatsTab
                sessions={sessions}
                agents={agents}
                ready={inboxReady}
                filter={chatFilter}
                query={query}
                searchOpen
                runningId={runningId}
                askCount={askCount}
                onFilter={setChatFilter}
                onQuery={setQuery}
                onOpen={openSession}
                onDelete={deleteSessionRow}
              />
            )}
            {tab === "agents" && (
              <AgentsTab agents={agents} onOpen={(id) => void startNewChat(id)} onRename={renameAgentTile} />
            )}
            {tab === "live" && (
              <LiveTab host={host} publishing={publishing} onPublish={() => void publishHost()} />
            )}
            {tab === "files" && (
              <FilesTab files={files} agentId={selected.id} onOpen={(src, alt) => setMedia({ src, alt })} />
            )}
          </div>
        </aside>

        <section className="web-main" aria-label="Conversation">
          {showChat ? (
            <>
              <header className="chat-head web-chat-head">
                <button className="agent-hit" type="button" onClick={() => setSheet("agent")}>
                  <span className={avatarClass(avatarLabel(selected.short, selected.name), `sm ${selected.color}`)}>
                    {avatarLabel(selected.short, selected.name)}
                  </span>
                  <div>
                    <strong>{selected.name}</strong>
                    <span
                      className={[
                        "status-line",
                        busyHere ? "working" : "",
                        siriSignal === "complete" ? "complete" : "",
                        siriSignal === "ask" ? "ask" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <i className="status-dot" />
                      {busyHere
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
                  className={["model-chip", selectedEngine === "agy" ? "agy" : ""].filter(Boolean).join(" ")}
                  type="button"
                  onClick={() => setSheet("model")}
                  aria-label="Switch engine and model"
                >
                  <span className="engine-tag">{selectedEngine === "agy" ? "AGY" : "Pi"}</span>
                  <span>{activeModel?.shortLabel ?? "Model"}</span>
                  <IconChevron />
                </button>
                <button className="icon-btn web-close-chat" type="button" onClick={closeChat} aria-label="Close chat" title="Close chat">
                  <IconBack />
                </button>
                {busyHere && (
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

              <div className="composer web-composer">
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
                      ref={inputRef}
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      onKeyDown={(event) => event.key === "Enter" && void send()}
                      placeholder={
                        busyHere ? `${selected.name} is working…` : loading ? "Another chat is still working…" : "Message"
                      }
                      disabled={loading}
                    />
                  </div>
                  {busyHere ? (
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
                      onClick={() => inputRef.current?.focus()}
                    >
                      <IconMic />
                    </button>
                  )}
                </div>
              </div>

              <WorkingOverlay
                active={busyHere}
                agent={selected}
                status={liveStatus}
                message={history.findLast((msg) => msg.role === "assistant" && msg.streaming)}
                error={error}
                engineLabel={selectedEngine === "agy" ? "AGY" : "Pi"}
                modelLabel={activeModel?.shortLabel ?? ""}
                onStop={stop}
                onBack={closeChat}
                onOpenMedia={(src, alt) => setMedia({ src, alt })}
                pulse={pulseRef}
              />
            </>
          ) : (
            <div className="web-empty">
              <img src="/logo-black.png" alt="" />
              <h2>Studio Web</h2>
              <p>Pick a chat from the sidebar, or start a new one with any agent.</p>
              <div className="web-empty-actions">
                <button className="primary" type="button" onClick={() => void startNewChat()}>
                  <IconPlus wide />
                  New chat
                </button>
                <button className="ghost" type="button" onClick={() => goTab("agents")}>
                  Browse agents
                </button>
              </div>
              <div className="web-empty-agents">
                {agents.slice(0, 6).map((agent) => (
                  <button
                    key={agent.id}
                    type="button"
                    className={agent.id === selectedAgentId ? "web-empty-agent on" : "web-empty-agent"}
                    onClick={() => void startNewChat(agent.id)}
                  >
                    <span className={avatarClass(avatarLabel(agent.short, agent.name), `sm ${agent.color}`)}>
                      {avatarLabel(agent.short, agent.name)}
                    </span>
                    <span>
                      <strong>{agent.name}</strong>
                      <small>{agent.headline}</small>
                    </span>
                  </button>
                ))}
              </div>
              <small className="web-empty-note">Each chat is its own session — new chats don&apos;t share memory.</small>
            </div>
          )}
        </section>
      </div>

      <button
        type="button"
        className={sheet ? "web-modal-backdrop on" : "web-modal-backdrop"}
        onClick={() => setSheet(null)}
        aria-label="Close dialog"
        tabIndex={sheet ? 0 : -1}
      />
      <div
        className={sheet === "model" ? "web-modal on" : "web-modal"}
        aria-hidden={sheet !== "model"}
        inert={sheet !== "model" ? true : undefined}
      >
        <div className="sheet-title">
          <strong>Engine &amp; Model</strong>
          <span>Switch anytime</span>
        </div>
        <div className="engine-switch">
          <button
            type="button"
            className={selectedEngine === "pi" ? "engine-tab on" : "engine-tab"}
            onClick={() => void switchEngine("pi")}
          >
            <span>Pi Coding Agent</span>
            <small>Metered API keys</small>
          </button>
          <button
            type="button"
            className={selectedEngine === "agy" ? "engine-tab on agy" : "engine-tab agy"}
            onClick={() => void switchEngine("agy")}
          >
            <span>Antigravity (AGY)</span>
            <small>Gemini Pro (OAuth)</small>
          </button>
        </div>
        <div className="web-modal-scroll">
          {(selectedEngine === "agy" ? (agyModels.length ? agyModels : models) : models).map((model) => {
            const tone =
              selectedEngine === "agy"
                ? "agy"
                : !model.available
                  ? "muted"
                  : /gpt|openai|luna/i.test(model.label)
                    ? "blue"
                    : "";
            return (
              <button
                key={model.id}
                type="button"
                className="model-row"
                disabled={!model.available}
                onClick={() => void switchModel(model.id)}
              >
                <span className={["model-mark", tone].filter(Boolean).join(" ")}>
                  {model.shortLabel.slice(0, 4)}
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
      </div>

      {selected && (
        <div
          className={sheet === "agent" ? "web-modal on" : "web-modal"}
          aria-hidden={sheet !== "agent"}
          inert={sheet !== "agent" ? true : undefined}
        >
          <div className="sheet-hero">
            <span className={avatarClass(avatarLabel(selected.short, selected.name), `lg ${selected.color}`)}>
              {avatarLabel(selected.short, selected.name)}
            </span>
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
    </main>
  );
}
