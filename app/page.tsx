// Mobile shell: renders the studio state machine inside the phone frame.
// Desktop equivalent lives in app/web/page.tsx; shared logic in use-studio.ts.
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
  IconInstall,
  IconLive,
  IconMic,
  IconPlus,
  IconSearch,
  IconSend,
  IconSettings,
  LiveTab,
  MediaLightbox,
  WorkingOverlay,
} from "./chat-parts";
import { avatarClass, avatarLabel } from "./studio";
import { useStudio } from "./use-studio";

export default function Home() {
  const {
    tab,
    full,
    aiReplyDark,
    message,
    setMessage,
    history,
    sessions,
    loading,
    inboxReady,
    error,
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
    chatFilter,
    setChatFilter,
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    installPrompt,
    installed,
    selected,
    inChat,
    busyHere,
    activeModel,
    siriSignal,
    liveUrl,
    askCount,
    handleInstall,
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
    goBack,
    renameAgentTile,
  } = useStudio();

  const tabTitle = tab === "chats" ? "Chats" : tab === "agents" ? "Agents" : tab === "live" ? "Live site" : "Files";
  const phoneClass = ["phone", inChat ? "in-chat" : "", siriSignal !== "idle" ? `siri-${siriSignal}` : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <main className={["stage", full ? "full" : "", aiReplyDark ? "ai-reply-dark" : ""].filter(Boolean).join(" ")}>
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
          {siriSignal === "working"
            ? "Agent is working"
            : siriSignal === "ask"
              ? "Agent is asking a question"
              : ""}
        </p>

        <div className="inbox" inert={inChat ? true : undefined}>
          <div className="inbox-head">
            <div className="inbox-brand">
              <img src="/logo-black.png" alt="" />
              <h1>{tabTitle}</h1>
            </div>
            <div className="inbox-actions">
              {installPrompt && !installed && (
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="Install app"
                  onClick={() => void handleInstall()}
                >
                  <IconInstall />
                </button>
              )}
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
                runningId={runningId}
                askCount={askCount}
                onFilter={setChatFilter}
                onQuery={setQuery}
                onDelete={deleteSessionRow}
                onOpen={openSession}
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
          <nav className="bottom-nav">
            {(
              [
                { id: "agents" as const, label: "Agents", badge: 0, icon: <IconAgents /> },
                { id: "chats" as const, label: "Chats", badge: askCount, icon: <IconChats /> },
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
                      onClick={() => document.querySelector<HTMLInputElement>(".composer-field input")?.focus()}
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
                onBack={goBack}
                onOpenMedia={(src, alt) => setMedia({ src, alt })}
                pulse={pulseRef}
              />
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
            <strong>Engine & Model</strong>
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
        {selected && (
          <div
            className={sheet === "agent" ? "sheet on" : "sheet"}
            aria-hidden={sheet !== "agent"}
            inert={sheet !== "agent" ? true : undefined}
          >
            <div className="sheet-handle" />
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
      </section>
    </main>
  );
}
