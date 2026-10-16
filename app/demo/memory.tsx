import { useCallback, useEffect, useState } from "react";
import "./memory.css";

// Superadmin only: what E's memory lane has picked up from team chats (server/memory-lane.mjs).
// Nothing becomes part of E's memory until the Superadmin approves it here.
type Evidence = { quote: string; who: string; at: string; session_id: string; message_id: number };
type Memory = { id: string; type: string; key: string; body: string; status: string; proposedBody: string | null; evidence: Evidence[]; seen: number; note: string; decidedBy: string | null; decidedAt: string | null; createdAt: string; updatedAt: string };
type Digest = { sessionId: string; title: string | null; userName: string | null; status: string; reason: string; signals: string[]; kept: number; dropped: { key: string; why: string }[]; digestedAt: string };
type Overview = { enabled: boolean; globalOff: boolean; idleMinutes: number; waiting: number; limits: { activePerCompany: number; pendingPerCompany: number }; memories: Memory[]; digests: Digest[] };
type Tab = "review" | "active" | "past" | "log";

const typeLabels: Record<string, string> = { fact: "Fact", mistake: "Mistake", rule_candidate: "Rule idea" };
const statusLabels: Record<string, string> = { candidate: "Waiting for review", active: "Approved", rejected: "Rejected", retired: "Retired", promoted: "Moved to SOP / rule" };
const when = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "";

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Memory request failed");
  return data as T;
}

export function MemoryPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<{ id: string; body: string; type: string } | null>(null);
  const load = useCallback(() => request<Overview>("/api/demo/memory").then(setData).catch(err => setError(err.message)), []);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30000); return () => clearInterval(timer); }, [load]);

  const act = async (label: string, url: string, body: unknown, done: string) => {
    setBusy(label); setError(""); setNotice("");
    try { await request(url, body); setNotice(done); setEditing(null); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Memory request failed"); }
    finally { setBusy(""); }
  };
  const decide = (memory: Memory, action: string, done: string, extra: Record<string, unknown> = {}) => act(`${memory.id}:${action}`, `/api/demo/memory/${encodeURIComponent(memory.id)}`, { action, ...extra }, done);
  const digestNow = async () => {
    setBusy("run"); setError(""); setNotice("");
    try { const result = await request<{ digested: number }>("/api/demo/memory/run", {}); setNotice(result.digested ? `Read ${result.digested} chat${result.digested === 1 ? "" : "s"}. See the lane log for what was kept.` : "No chats with new messages to read."); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : "Digest failed"); }
    finally { setBusy(""); }
  };

  if (!data) return <section className="memory-panel">{error ? <p className="memory-error" role="alert">{error}</p> : <p role="status">Loading memory…</p>}</section>;
  const review = data.memories.filter(m => m.status === "candidate" || (m.status === "active" && m.proposedBody));
  const active = data.memories.filter(m => m.status === "active");
  const past = data.memories.filter(m => ["rejected", "retired", "promoted"].includes(m.status));
  const list = tab === "review" ? review : tab === "active" ? active : past;
  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "review", label: "To review", count: review.length }, { key: "active", label: "Approved", count: active.length },
    { key: "past", label: "Rejected & retired", count: past.length }, { key: "log", label: "Lane log" },
  ];

  const card = (memory: Memory) => {
    const isEditing = editing?.id === memory.id;
    const working = busy.startsWith(`${memory.id}:`);
    const button = (action: string, label: string, done: string, primary = false) => <button className={primary ? "memory-primary" : ""} disabled={working} onClick={() => void decide(memory, action, done)}>{label}</button>;
    return <article className={`memory-card ${memory.status}`} key={memory.id}>
      <div className="memory-card-head"><span className={`memory-type ${memory.type}`}>{typeLabels[memory.type] || memory.type}</span><code>{memory.key}</code><span className={`memory-status ${memory.status}`}>{statusLabels[memory.status] || memory.status}</span></div>
      {isEditing ? <div className="memory-edit">
        <select aria-label="Memory type" value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value })}>{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <textarea aria-label="Memory text" rows={3} maxLength={300} value={editing.body} onChange={e => setEditing({ ...editing, body: e.target.value })}/>
        <small>{editing.body.trim().length}/300</small>
      </div> : <p className="memory-body">{memory.body}</p>}
      {memory.proposedBody && memory.status === "active" && <div className="memory-change"><strong>Suggested change</strong><p>{memory.proposedBody}</p><div className="memory-actions">{button("accept_change", "Use new wording", "Memory updated.", true)}{button("dismiss_change", "Keep current", "Suggestion dismissed.")}</div></div>}
      <ul className="memory-evidence">{memory.evidence.slice(-3).reverse().map((item, index) => <li key={index}>“{item.quote}” <span>{item.who} · {when(item.at)}</span></li>)}</ul>
      <div className="memory-meta">{memory.seen > 1 && <span>Heard {memory.seen} times</span>}{memory.evidence.length > 3 && <span>+{memory.evidence.length - 3} earlier</span>}{memory.decidedBy && <span>{statusLabels[memory.status]} by {memory.decidedBy} · {when(memory.decidedAt)}</span>}{memory.note && <span>{memory.note}</span>}</div>
      <div className="memory-actions">
        {isEditing ? <><button className="memory-primary" disabled={working} onClick={() => void decide(memory, "edit", "Memory saved.", { body: editing.body, type: editing.type })}>Save</button><button onClick={() => setEditing(null)}>Cancel</button></> : <>
          {memory.status === "candidate" && button("approve", "Approve", "Approved. It is now part of E's memory.", true)}
          {["candidate", "active"].includes(memory.status) && <button disabled={working} onClick={() => setEditing({ id: memory.id, body: memory.body, type: memory.type })}>Edit</button>}
          {memory.type === "rule_candidate" && ["candidate", "active"].includes(memory.status) && button("promote", "Moved to SOP / rule", "Marked as moved into an SOP or rule.")}
          {memory.status === "candidate" && button("reject", "Reject", "Rejected. E won't suggest it again.")}
          {memory.status === "active" && button("retire", "Retire", "Retired.")}
          {["rejected", "retired"].includes(memory.status) && button("approve", "Approve instead", "Approved.")}
          {["rejected", "retired", "promoted"].includes(memory.status) && button("delete", "Delete", "Deleted.")}
        </>}
      </div>
    </article>;
  };

  return <section className="memory-panel" aria-label="Memory">
    <div className="memory-toolbar">
      <div><strong>{active.length} of {data.limits.activePerCompany} approved · {review.length} to review</strong><span>E reads finished team chats ({data.idleMinutes} min after the last message) and suggests what is worth remembering. Only you decide what it keeps.</span></div>
      <div className="memory-toolbar-actions">
        <label className="memory-switch"><input type="checkbox" checked={data.enabled} disabled={busy === "settings" || data.globalOff} onChange={e => void act("settings", "/api/demo/memory/settings", { enabled: e.target.checked }, e.target.checked ? "Memory lane is on." : "Memory lane is off. Nothing new will be read.")}/><span>{data.enabled ? "Memory lane on" : "Memory lane off"}</span></label>
        <button disabled={!data.enabled || busy === "run"} onClick={() => void digestNow()}>{busy === "run" ? "Reading chats…" : `Digest now${data.waiting ? ` (${data.waiting})` : ""}`}</button>
        <button onClick={() => void load()}>Refresh</button>
      </div>
    </div>
    {data.globalOff && <p className="memory-banner">The memory lane is switched off on this server (MEMORY_LANE=off).</p>}
    {!data.globalOff && !data.enabled && <p className="memory-banner">The memory lane is off. Turn it on to let E learn from your team's chats. Chat and jobs work the same either way.</p>}
    <p className="memory-note">Phase 1: approved memories are recorded here but agents do not read them yet.</p>
    {error && <p className="memory-error" role="alert">{error}</p>}{notice && <p className="memory-notice" role="status">{notice}</p>}
    <nav className="memory-tabs" aria-label="Memory views">{tabs.map(item => <button key={item.key} className={tab === item.key ? "active" : ""} aria-current={tab === item.key ? "page" : undefined} onClick={() => setTab(item.key)}>{item.label}{item.count !== undefined && <span>{item.count}</span>}</button>)}</nav>
    {tab === "log" ? (data.digests.length ? <div className="memory-log">{data.digests.map(digest => <article key={digest.sessionId}>
      <div className="memory-log-head"><span className={`memory-log-status ${digest.status}`}>{digest.status}</span><strong>{digest.title || digest.sessionId}</strong><span>{digest.userName || ""} · {when(digest.digestedAt)}</span></div>
      <p>{digest.reason}</p>
      {digest.signals.length > 0 && <div className="memory-signals">{digest.signals.map(signal => <span key={signal}>{signal}</span>)}</div>}
      {digest.dropped.length > 0 && <ul>{digest.dropped.map((item, index) => <li key={index}>Dropped <code>{item.key}</code>: {item.why}</li>)}</ul>}
    </article>)}</div> : <div className="memory-empty"><h2>Nothing read yet</h2><p>Once the lane is on, every chat it reads shows here, including the ones it skipped and why.</p></div>)
      : list.length ? <div className="memory-list">{list.map(card)}</div>
      : <div className="memory-empty"><h2>{tab === "review" ? "Nothing to review" : tab === "active" ? "No approved memories yet" : "Nothing here"}</h2><p>{tab === "review" ? "When someone corrects E or states a company rule, the lane suggests a memory here." : tab === "active" ? "Approve suggestions from the review list to build E's memory." : "Rejected, retired and moved items show here."}</p></div>}
  </section>;
}
