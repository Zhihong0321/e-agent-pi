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
  IconFiles,
  IconInstall,
  IconLive,
  IconPlus,
  IconSearch,
  IconSettings,
  LiveTab,
  MediaLightbox,
} from "./chat-parts";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import "./mobile.css";
import { avatarClass, avatarLabel } from "./studio";
import { useStudio } from "./use-studio";

export default function Home() {
  const {
    tab,
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
    closeChat,
    setView,
    renameAgentTile,
  } = useStudio();

  const [menuOpen, setMenuOpen] = useState(false);
  const [viewerName, setViewerName] = useState("");
  const [viewport, setViewport] = useState(() => ({ height: window.visualViewport?.height || window.innerHeight, keyboard: false }));
  const messageInput = useRef<HTMLTextAreaElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = messageInput.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
  }, [message]);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/demo/me", { credentials: "include" }).then(response => response.ok ? response.json() : null).then(data => {
      if (!cancelled && data?.user) setViewerName(data.user.display_name || data.user.username || "");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const update = () => {
      const height = window.visualViewport?.height || window.innerHeight;
      setViewport({ height, keyboard: window.innerHeight - height > 120 });
    };
    window.visualViewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const dialog = menu.current;
    dialog?.querySelector<HTMLButtonElement>("button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); }
      if (event.key === "Tab") {
        const items = [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select') || [])].filter(item => item.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);
  useEffect(() => {
    if (!sheet) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>(".mobile-stage .sheet.on");
    dialog?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSheet(null);
      if (event.key === "Tab") {
        const items = [...(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]') || [])];
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previousFocus?.focus(); };
  }, [sheet, setSheet]);
  const dismissMenu = () => { setMenuOpen(false); menuButton.current?.focus(); };
  const home = () => { closeChat(); setMessage(""); setPendingFiles([]); setMenuOpen(false); };
  const newChat = () => { setMessage(""); setPendingFiles([]); setMenuOpen(false); void startNewChat(); };
  const submit = (text = message) => {
    if (loading || !agents.length || (!text.trim() && !pendingFiles.length)) return;
    setView("chat");
    void send(text);
  };
  const greetingName = viewerName ? viewerName.split(" ")[0] : "there";
  const hasConversation = history.length > 0;
  const waiting = busyHere && !history.some(item => item.role === "assistant" && item.streaming && (item.content || item.blocks?.some(block => block.type === "text" && block.text)));
  const recentQuestion = history.findLast(item => item.role === "user")?.content;
  const tabTitle = tab === "chats" ? "Your chats" : tab === "agents" ? "Assistants" : tab === "live" ? "Live site" : "Files";
  const prompts = ["Help me plan my day", "Summarize a document", "Draft a customer email", "Research a company", "Organize my expenses", "Brainstorm something new"];

  return (
    <main className={`stage mobile-stage${viewport.keyboard ? " keyboard-open" : ""}`} style={{ "--mobile-height": `${viewport.height}px` } as CSSProperties}>
      <section className={`phone mobile-phone${hasConversation ? " has-conversation" : ""}`} aria-label="Website studio chat">
        <div className="mobile-main" inert={menuOpen || sheet ? true : undefined}>
          <header className="mobile-header">
            {hasConversation ? <button className="mobile-icon" type="button" onClick={home} aria-label="Back to home"><IconBack/></button> : <button ref={menuButton} className="mobile-icon" type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-expanded={menuOpen} aria-controls="mobile-menu"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 7h16M4 12h12M4 17h16"/></svg></button>}
            {hasConversation ? <button ref={menuButton} className="mobile-icon mobile-more" type="button" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-expanded={menuOpen} aria-controls="mobile-menu"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg></button> : <button className="mobile-avatar" type="button" onClick={() => setSheet("agent")} aria-label="About your assistant"><img src="/branding/e-logo.png" alt=""/></button>}
          </header>
          {!hasConversation ? <div className="mobile-welcome">
            <div className="mobile-greeting"><button type="button" className="mobile-assistant-status" onClick={() => setSheet("agent")}><i/>{agents.length ? selected.name : "Connecting…"}</button><h1>Hello {greetingName},<br/>How can I help?</h1><p>A clear mind. A little help. More room for you.</p></div>
            <div className="mobile-prompts" aria-label="Suggested prompts">{prompts.map(prompt => <button type="button" key={prompt} disabled={loading || !agents.length} onClick={() => { setMessage(prompt); messageInput.current?.focus(); }}>{prompt}</button>)}</div>
            {error && <p className="mobile-error" role="alert">{error}</p>}
          </div> : waiting ? <div className="mobile-waiting" role="status"><span className="mobile-spinner" aria-hidden="true"/><small>{liveStatus || "Just a sec…"}</small><p>“{recentQuestion}”</p></div> : <AgentConversation agent={selected} history={history} loading={loading} error={error} liveUrl={liveUrl} siriSignal={siriSignal} publishOk={publishOk} onPrompt={submit} onOpenMedia={(src, alt) => setMedia({ src, alt })}/>}
          <div className="mobile-composer">
            {pendingFiles.length > 0 && <div className="attach-chips">{pendingFiles.map((file, index) => <button key={`${file.name}-${index}`} type="button" className="attach-chip" onClick={() => setPendingFiles(prev => prev.filter((_, i) => i !== index))} aria-label={`Remove ${file.name}`}>{file.name} ×</button>)}</div>}
            <form className="mobile-composer-row" onSubmit={event => { event.preventDefault(); submit(); }}>
              <input ref={fileInput} type="file" accept="image/*,.pdf,application/pdf,.docx,.xlsx" multiple hidden onChange={event => { void pickFiles(event.target.files); event.target.value = ""; }}/>
              <button className="mobile-attach" type="button" aria-label="Attach a file" disabled={loading} onClick={() => fileInput.current?.click()}><IconPlus/></button>
              <textarea ref={messageInput} aria-label="Message" rows={1} value={message} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} placeholder={loading ? "Your assistant is working…" : "Type your question…"} disabled={loading}/>
              {busyHere ? <button className="mobile-send" type="button" onClick={stop} aria-label="Stop response"><span className="mobile-stop"/></button> : <button className="mobile-send" type="submit" disabled={loading || !agents.length || (!message.trim() && !pendingFiles.length)} aria-label="Send message"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-5 5 5-5 5 5"/></svg></button>}
            </form>
            <p className="mobile-composer-note">A little intelligence, a lot of possibility.</p>
          </div>
        </div>
        {menuOpen && <div className="mobile-menu-backdrop"><button className="mobile-menu-dismiss" type="button" aria-label="Dismiss menu" tabIndex={-1} onClick={dismissMenu}/>
          <div ref={menu} id="mobile-menu" className="mobile-menu" role="dialog" aria-modal="true" aria-label="Workspace menu">
            <header><div><small>YOUR WORKSPACE</small><strong>{tabTitle}</strong></div><button className="mobile-icon" type="button" aria-label="Close menu" onClick={dismissMenu}>×</button></header>
            <div className="mobile-menu-actions"><button type="button" onClick={home}>Home</button><button type="button" disabled={loading || !agents.length} onClick={newChat}><IconPlus/> New chat</button><button type="button" onClick={() => { setMenuOpen(false); setSheet("model"); }} aria-label="Choose model">{activeModel?.shortLabel || "Model"}</button>{installPrompt && !installed && <button type="button" onClick={() => void handleInstall()}><IconInstall/> Install</button>}</div>
            <nav className="mobile-menu-tabs" aria-label="Chat navigation">{[{id:"agents" as const,label:"Assistants",icon:<IconAgents/>},{id:"chats" as const,label:"Chats",icon:<IconChats/>},{id:"live" as const,label:"Live",icon:<IconLive/>},{id:"files" as const,label:"Files",icon:<IconFiles/>}].map(item => <button type="button" key={item.id} className={tab === item.id ? "active" : ""} aria-current={tab === item.id ? "page" : undefined} onClick={() => goTab(item.id)}>{item.icon}<span>{item.label}</span></button>)}</nav>
            <div className="mobile-menu-body">
              {tab === "chats" && <><button className="mobile-search-toggle" type="button" onClick={() => setSearchOpen(open => !open)}><IconSearch/> Search chats</button><ChatsTab sessions={sessions} agents={agents} ready={inboxReady} filter={chatFilter} query={query} searchOpen={searchOpen} runningId={runningId} askCount={askCount} onFilter={setChatFilter} onQuery={setQuery} onDelete={deleteSessionRow} onOpen={id => { openSession(id); setMenuOpen(false); }}/></>}
              {tab === "agents" && <AgentsTab agents={agents} onOpen={id => { setMenuOpen(false); setMessage(""); setPendingFiles([]); void startNewChat(id); }} onRename={renameAgentTile}/>}
              {tab === "live" && <LiveTab host={host} publishing={publishing} onPublish={() => void publishHost()}/>}
              {tab === "files" && <FilesTab files={files} agentId={selected.id} onOpen={(src, alt) => { setMenuOpen(false); setMedia({ src, alt }); }}/>}
            </div>
            <nav className="mobile-workspace-links" aria-label="Workspace pages"><a href="/demo">Company workspace</a><a href="/calendar">Calendar</a><a href="/research">Research library</a><a href="/demo?area=signals">Company signals</a><a href="/settings#logs">Chat logs</a><a href="/settings#usage">Usage</a><a href="/settings"><IconSettings/> Settings</a></nav>
          </div>
        </div>}

        <button type="button" className={sheet ? "sheet-backdrop on" : "sheet-backdrop"} onClick={() => setSheet(null)} aria-label="Close assistant options" aria-hidden={!sheet} tabIndex={sheet ? 0 : -1}/>
        <div
          className={sheet === "model" ? "sheet on" : "sheet"}
          role="dialog" aria-modal="true" aria-label="Choose engine and model"
          aria-hidden={sheet !== "model"}
          inert={sheet !== "model" ? true : undefined}
        >
          <div className="sheet-handle" />
          <div className="sheet-title">
            <strong>Engine & Model</strong>
            <button type="button" className="mobile-icon" aria-label="Close model picker" onClick={() => setSheet(null)}>×</button>
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
            role="dialog" aria-modal="true" aria-label="About your assistant"
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
            <button className="mobile-model-button" type="button" onClick={() => setSheet("model")}>Choose engine & model</button>
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
