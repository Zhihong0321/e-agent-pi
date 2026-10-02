import { useEffect, useState } from "react";
import "./chat-logs.css";

type Session = { id: string; title: string; agentId?: string; engine: string; userName?: string; updatedAt: string; messageCount: number; parentSessionId?: string };
type Message = { id: number; role: string; content: string; modelId?: string; createdAt: string };
type List = { sessions: Session[]; nextBefore: string | null; nextBeforeId?: string | null };
type Transcript = { session: { id: string; title: string } | null; messages: Message[]; nextAfter: number | null };
async function request<T>(endpoint: string, params: URLSearchParams): Promise<T> {
  const response = await fetch(`${endpoint}?${params}`, { credentials: "include", cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load chat logs");
  return data;
}
const time = (value: string) => new Date(value).toLocaleString();

export default function ChatLogs({ endpoint = "/api/settings/chat-logs" }: { endpoint?: string } = {}) {
  const [search, setSearch] = useState("");
  const [list, setList] = useState<List>({ sessions: [], nextBefore: null });
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get("sessionId"));
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setError("");
      void request<List>(endpoint, new URLSearchParams({ search })).then(data => { if (!cancelled) setList(data); }).catch(err => { if (!cancelled) setError(err.message); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [search, refresh, endpoint]);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void request<Transcript>(endpoint, new URLSearchParams({ sessionId: selected })).then(data => { if (!cancelled) { setTranscript(data); setError(""); } }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [selected, refresh, endpoint]);
  const more = async (messages: boolean) => {
    setBusy(true);
    try {
      if (messages && selected && transcript?.nextAfter) {
        const data = await request<Transcript>(endpoint, new URLSearchParams({ sessionId: selected, after: String(transcript.nextAfter) }));
        if (data.session?.id === transcript.session?.id) setTranscript({ ...data, messages: [...transcript.messages, ...data.messages] });
      } else if (!messages && list.nextBefore) {
        const data = await request<List>(endpoint, new URLSearchParams({ search, before: list.nextBefore, beforeId: list.nextBeforeId || "" }));
        setList({ ...data, sessions: [...list.sessions, ...data.sessions] });
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load logs"); }
    finally { setBusy(false); }
  };
  return <section className="settings-card">
    <div className="chat-log-heading"><div><h2>Chat logs</h2><p>Saved conversations, including delegated agent chats. Select a conversation to read its transcript.</p></div><button type="button" onClick={() => setRefresh(v => v + 1)}>Refresh</button></div>
    <label>Search chats<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Chat title, agent, or user" /></label>
    {error && <p role="alert">{error}</p>}
    <div className="chat-log-layout"><div className="chat-log-sessions">
      {!list.sessions.length && <p>No saved chats found.</p>}
      {list.sessions.map(session => <button type="button" key={session.id} className={selected === session.id ? "selected" : ""} onClick={() => { setTranscript(null); setSelected(session.id); }}><strong>{session.title || "Untitled chat"}</strong><small>{session.userName || "System"} · {session.agentId || session.engine}{session.parentSessionId ? " · delegated" : ""}</small><small>{time(session.updatedAt)} · {session.messageCount} messages</small></button>)}
      {list.nextBefore && <button type="button" disabled={busy} onClick={() => void more(false)}>Older chats</button>}
    </div><div className="chat-log-transcript">
      {!selected ? <p>Select a chat to view its messages.</p> : !transcript ? <p>Loading transcript…</p> : !transcript.session ? <p>Chat no longer exists.</p> : <><h3>{transcript.session.title}</h3><small>{transcript.session.id}</small>
        {!transcript.messages.length && <p>No messages saved in this chat.</p>}
        {transcript.messages.map(message => <article key={message.id}><header><strong>{message.role}</strong><small>{time(message.createdAt)}{message.modelId ? ` · ${message.modelId}` : ""}</small></header><pre>{message.content}</pre></article>)}
        {transcript.nextAfter && <button type="button" disabled={busy} onClick={() => void more(true)}>More messages</button>}</>}
    </div></div>
  </section>;
}
