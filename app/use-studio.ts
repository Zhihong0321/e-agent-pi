// The Studio state machine: sessions, agents, models, uploads and the streaming turn lifecycle.
// Shared by the mobile shell (app/page.tsx) and the desktop shell (app/web/page.tsx) so both
// drive exactly the same SSE protocol, retry/resume behaviour and session bookkeeping.
import { useEffect, useRef, useState } from "react";
import { setTurnBusy } from "../src/sw-refresh";
import {
  AGENT_KEY,
  CONTINUE_PROMPT,
  FALLBACK_AGENT,
  SESSION_KEY,
  agentLiveUrl,
  api,
  applyStreamEvent,
  classifySession,
  classifySiriSignal,
  hydrateMessages,
  prefersStandalone,
  readAiReplyDarkPreference,
  readFullPreference,
  readSse,
  sleep,
  userVisibleContent,
  type Agent,
  type BeforeInstallPromptEvent,
  type ChatFilter,
  type ChatMessage,
  type ChatSession,
  type HostStatus,
  type ModelOption,
  type PendingFile,
  type Sheet,
  type Tab,
  type View,
  type WorkspaceFile,
} from "./studio";

export function useStudio() {
  const [view, setView] = useState<View>("agents");
  const [tab, setTab] = useState<Tab>("agents");
  const [full] = useState(readFullPreference);
  const [aiReplyDark] = useState(readAiReplyDarkPreference);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [inboxReady, setInboxReady] = useState(false);
  // A new build waits for the turn to finish before it reloads the page out from under the reader.
  setTurnBusy(loading);
  const [error, setError] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [agyModels, setAgyModels] = useState<ModelOption[]>([]);
  const [selectedEngine, setSelectedEngine] = useState<"pi" | "agy">("pi");
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
  // When the turn's socket last delivered anything (data or a heartbeat); read by WorkingOverlay's connection readout.
  const pulseRef = useRef(0);
  const [runningId, setRunningId] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [chatFilter, setChatFilter] = useState<ChatFilter>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const historyLoad = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const resumeAttempt = useRef(0);
  /** Mirrors sessionId for callbacks that outlive a render (the streaming loop). */
  const sessionIdRef = useRef("");
  /** True while the running turn's live transcript is not the history on screen (user opened another chat). */
  const detachedRef = useRef(false);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const selected = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0] ?? FALLBACK_AGENT;

  const inChat = view === "chat";
  const busyHere = loading && sessionId === runningId;
  const currentModels = selectedEngine === "agy" ? agyModels : models;
  const activeModel =
    currentModels.find((model) => model.id === selectedModelId) ??
    (selectedEngine === "agy" ? agyModels[0] : models.find((model) => model.id === selectedModelId));
  const siriSignal = inChat ? classifySiriSignal(history, loading, error) : "idle";
  const pendingStream = !loading && history.some((msg) => msg.role === "assistant" && msg.streaming);
  const liveUrl = agentLiveUrl(selected, host);

  useEffect(() => {
    if (prefersStandalone()) setInstalled(true);
    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setInstallPrompt(null);
  };

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
        const data = await api<{ models?: ModelOption[]; agyModels?: ModelOption[]; activeModelId?: string }>(
          "/api/models",
        );
        setModels(data.models ?? []);
        setAgyModels(data.agyModels ?? []);
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
    setSelectedModelId(modelId);
    setSheet(null);
    if (sessionId) {
      void api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ modelId }),
      }).catch(() => {});
    }
    if (selectedEngine === "agy") return;
    void api("/api/model", { method: "POST", body: JSON.stringify({ modelId }) }).catch((err) => {
      setError(err instanceof Error ? err.message : "Model switch failed");
    });
  };

  const switchEngine = async (engine: "pi" | "agy") => {
    setSelectedEngine(engine);
    const availableModels = engine === "agy" ? agyModels : models;
    const defaultModel =
      availableModels.find((m) => m.available)?.id ??
      availableModels[0]?.id ??
      (engine === "agy" ? "gemini-3.8-flash-high" : "");
    if (defaultModel) setSelectedModelId(defaultModel);
    if (sessionId) {
      try {
        const data = await api<{ session: ChatSession }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          body: JSON.stringify({ engine, modelId: defaultModel }),
        });
        if (data.session) {
          setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, ...data.session } : s)));
        }
      } catch {
        // ignore patch error
      }
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

  const deleteSessionRow = async (id: string) => {
    try {
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete chat");
      return;
    }
    setSessions((prev) => prev.filter((session) => session.id !== id));
    if (sessionId === id) {
      setSessionId("");
      setHistory([]);
      window.localStorage.removeItem(SESSION_KEY);
      setTab("chats");
      setView("chats");
    }
  };

  const loadHistory = (id: string) => {
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

  const openSession = (id: string) => {
    setSessionId(id);
    setView("chat");
    setSheet(null);
    setError("");
    window.localStorage.setItem(SESSION_KEY, id);
    const session = sessions.find((row) => row.id === id);
    if (session?.agentId) pickAgent(session.agentId);
    if (session?.engine === "agy" || session?.engine === "pi") {
      setSelectedEngine(session.engine);
    }
    if (session?.modelId) setSelectedModelId(session.modelId);
    // Rejoining the chat that is still working: keep the live transcript instead of reloading over it.
    const rejoin = loading && id === runningId;
    if (rejoin && history.some((msg) => msg.streaming && msg.sessionId === id)) {
      detachedRef.current = false;
      return;
    }
    detachedRef.current = loading;
    setHistory([]);
    loadHistory(id);
  };

  const startNewChat = async (agentId?: string, engine?: "pi" | "agy") => {
    const agent = agents.find((row) => row.id === agentId) ?? (selected.id ? selected : undefined);
    if (agent) pickAgent(agent.id);
    const chosenEngine = engine || (agent?.engine === "agy" ? "agy" : selectedEngine);
    setSelectedEngine(chosenEngine);
    setError("");
    if (loading) detachedRef.current = true;
    setHistory([]);
    setSessionId("");
    setView("chat");
    setSheet(null);
    if (!agent?.id) return;
    try {
      const defaultModel =
        chosenEngine === "agy"
          ? (agyModels[0]?.id || "gemini-3.8-flash-high")
          : selectedModelId || undefined;
      const data = await api<{ session: ChatSession }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({
          modelId: defaultModel,
          agentId: agent.id,
          engine: chosenEngine,
        }),
      });
      const created = data.session;
      setSessions((prev) => [created, ...prev.filter((session) => session.id !== created.id)]);
      setSessionId(created.id);
      if (created.modelId) setSelectedModelId(created.modelId);
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
        const defaultModel =
          selectedEngine === "agy"
            ? (agyModels[0]?.id || "gemini-3.8-flash-high")
            : selectedModelId || undefined;
        const data = await api<{ session: ChatSession }>("/api/sessions", {
          method: "POST",
          body: JSON.stringify({
            modelId: defaultModel,
            agentId: agent?.id,
            engine: selectedEngine,
          }),
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
      setRunningId(activeId);
      detachedRef.current = false;
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
      setRunningId("");
      setLiveStatus("");
      setHistory((prev) => prev.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg)));
      // The user left and came back while the turn ran: the screen holds a stale copy, so fetch the finished transcript.
      if (detachedRef.current && sessionIdRef.current === activeId) {
        detachedRef.current = false;
        loadHistory(activeId);
      }
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
          engine: selectedEngine,
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
          if (event.type === "session" && event.session) {
            if (event.session.engine === "agy" || event.session.engine === "pi") {
              setSelectedEngine(event.session.engine);
            }
          }
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
              if (event.session.engine === "agy" || event.session.engine === "pi") {
                setSelectedEngine(event.session.engine);
              }
            }
          }
          if (event.type === "host" && event.host) {
            setHost(event.host);
            const failed = Boolean(event.host.lastError);
            const pushed = event.host.pushed ?? event.host.git?.pushed;
            setPublishOk(!failed && (pushed === true || (event.host.git == null && !failed)));
          }
          if (event.type === "error" && event.error) setError(event.error);
        }, () => {
          pulseRef.current = Date.now();
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

  const askCount = sessions.filter((session) => classifySession(session, session.id === runningId) === "ask").length;
  const renameAgentTile = async (id: string, short: string, password?: string) => {
    if (password) await api("/api/auth/login", { method: "POST", body: JSON.stringify({ password }) });
    const data = await api<{ agent: Agent }>(`/api/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ short }),
    });
    setAgents((list) => list.map((row) => (row.id === id ? { ...row, ...data.agent } : row)));
  };

  /** A conversation is on screen once a session exists or a fresh turn has started. */
  const chatOpen = Boolean(sessionId) || history.length > 0;

  /** Desktop: drop back to the list without deleting anything. */
  const closeChat = () => {
    setSheet(null);
    setError("");
    setSessionId("");
    setHistory([]);
    setView(tab);
  };

  return {
    view,
    setView,
    tab,
    setTab,
    full,
    aiReplyDark,
    message,
    setMessage,
    history,
    setHistory,
    sessions,
    setSessions,
    sessionId,
    setSessionId,
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
    searchOpen,
    setSearchOpen,
    query,
    setQuery,
    installPrompt,
    installed,
    selected,
    inChat,
    busyHere,
    currentModels,
    activeModel,
    siriSignal,
    pendingStream,
    liveUrl,
    askCount,
    handleInstall,
    publishHost,
    switchModel,
    switchEngine,
    pickAgent,
    goTab,
    deleteSessionRow,
    loadHistory,
    openSession,
    startNewChat,
    send,
    stop,
    pickFiles,
    goBack,
    renameAgentTile,
    chatOpen,
    closeChat,
  };
}

export type Studio = ReturnType<typeof useStudio>;
