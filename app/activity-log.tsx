import { useCallback, useEffect, useState } from "react";
import DbLog from "./db-log";

type ActivityEvent = {
  id: string;
  occurredAt: string;
  userId?: string | null;
  userName?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  engine?: string | null;
  modelId?: string | null;
  eventType: string;
  toolName?: string | null;
  toolCallId?: string | null;
  detail?: string | null;
  result?: string | null;
  error?: string | null;
  status?: string | null;
  durationMs?: number | null;
};

type ActivityResponse = { events: ActivityEvent[]; nextCursor: string | null };

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include" });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "medium" });
}

export default function ActivityLog({ endpoint = "/api/activity" }: { endpoint?: string } = {}) {
  const [view, setView] = useState<"db" | "debug">("db");
  return <><div className="activity-log-tabs" aria-label="Log views"><button type="button" aria-pressed={view === "db"} onClick={() => setView("db")}>DB Log</button><button type="button" aria-pressed={view === "debug"} onClick={() => setView("debug")}>Agent activity</button></div>{view === "db" ? <DbLog /> : <AgentActivityLog endpoint={endpoint} />}</>;
}

function AgentActivityLog({ endpoint }: { endpoint: string }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [tool, setTool] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setMessage("");
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (tool.trim()) params.set("toolName", tool.trim());
      if (type) params.set("eventType", type);
      if (status) params.set("status", status);
      const data = await request<ActivityResponse>(`${endpoint}?${params}`);
      setEvents(data.events);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load activity");
    } finally {
      setBusy(false);
    }
  }, [status, tool, type, endpoint]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section className="settings-card activity-card">
      <div className="activity-header">
        <div>
          <h2>Activity log</h2>
          <p className="activity-hint">Agent calls, tool usage, and the user who started each turn.</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void load()}>{busy ? "Refreshing…" : "Refresh"}</button>
      </div>
      <div className="activity-filters">
        <label>Tool<input value={tool} placeholder="Search tool" onChange={(event) => setTool(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} /></label>
        <label>Event<select value={type} onChange={(event) => setType(event.target.value)}><option value="">All events</option><option value="turn_started">Turn started</option><option value="tool_call">Tool started</option><option value="tool_result">Tool result</option><option value="turn_completed">Turn completed</option><option value="turn_failed">Turn failed</option></select></label>
        <label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="running">Running</option><option value="completed">Completed</option><option value="error">Error</option></select></label>
      </div>
      {message && <p className="activity-error" role="status">{message}</p>}
      {!busy && !events.length && !message && <p>No activity recorded yet.</p>}
      {!!events.length && <div className="usage-log activity-log"><table><thead><tr><th>Time</th><th>User</th><th>Agent</th><th>Event</th><th>Tool</th><th>Status</th><th>Session</th></tr></thead><tbody>
        {events.map((event) => {
          const isOpen = expanded === event.id;
          return <tr key={event.id} className={isOpen ? "activity-row-open" : ""}>
            <td><button className="activity-detail-button" type="button" onClick={() => setExpanded(isOpen ? null : event.id)}>{formatTime(event.occurredAt)}</button>{isOpen && <div className="activity-detail"><strong>{event.eventType}</strong>{event.detail && <p><b>Detail:</b> {event.detail}</p>}{event.result && <p><b>Result:</b> {event.result}</p>}{event.error && <p className="activity-error"><b>Error:</b> {event.error}</p>}{event.durationMs != null && <p><b>Duration:</b> {event.durationMs} ms</p>}{event.modelId && <p><b>Model:</b> {event.modelId}</p>}</div>}</td>
            <td>{event.userName || event.userId || "—"}</td><td>{event.agentName || event.agentId || "—"}<small>{event.engine ? ` · ${event.engine}` : ""}</small></td><td>{event.eventType}</td><td>{event.toolName || "—"}</td><td><span className={`activity-status activity-status-${event.status || "unknown"}`}>{event.status || "—"}</span></td><td title={event.sessionId || ""}>{event.sessionId ? event.sessionId.slice(0, 8) : "—"}</td>
          </tr>;
        })}
      </tbody></table></div>}
    </section>
  );
}
