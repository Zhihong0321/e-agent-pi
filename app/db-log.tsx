import { useEffect, useState } from "react";
import "./db-log.css";

type Entry = { id: string; at: string; actor: string | null; actorUserId: string | null; agent: string | null; action: string; entity: string; entityId: string; reference: string; changes: Record<string, { from: unknown; to: unknown }> };
type History = { entries: Entry[]; nextCursor: string | null };
const entities = ["document", "document_line", "payment", "payment_allocation", "purchase_order", "purchase_order_line", "goods_receipt", "supplier_document", "expense_claim", "expense_receipt", "expense_batch", "expense_setting", "tax_code", "product", "package", "package_item", "supplier"];
const label = (value: string) => value.replaceAll("_", " ");
const actions: Record<string, string> = { insert: "Created", update: "Edited", soft_delete: "Archived", restore: "Restored" };
function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

export default function DbLog() {
  const [data, setData] = useState<History>({ entries: [], nextCursor: null });
  const [entity, setEntity] = useState("");
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  // Filters apply on Search, keeping pagination tied to the exact loaded query.
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
    setBusy(true); setError(""); setData({ entries: [], nextCursor: null });
    fetch(`/api/demo/db-log?limit=50&${query}`, { credentials: "include", cache: "no-store" })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load DB Log");
        if (!cancelled) setData(result);
      }).catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, refresh]);

  const more = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/demo/db-log?limit=50&${query}&before=${data.nextCursor}`, { credentials: "include", cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load DB Log");
      setData(old => ({ entries: [...old.entries, ...result.entries], nextCursor: result.nextCursor }));
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load DB Log"); }
    finally { setBusy(false); }
  };

  return <section className="settings-card activity-card db-log-card">
    <div className="activity-header"><div><h2>DB Log</h2><p className="activity-hint">Financial record history: who created or changed invoices, POs, payments and expenses. Admin access only.</p></div>
      <button disabled={busy} type="button" onClick={() => setRefresh(n => n + 1)}>Refresh</button></div>
    <form className="activity-filters db-log-filters" onSubmit={event => { event.preventDefault(); setQuery(new URLSearchParams({ entity, action, actor, search }).toString()); setRefresh(n => n + 1); }}>
      <label>Record type<select value={entity} onChange={event => setEntity(event.target.value)}><option value="">All financial records</option>{entities.map(item => <option key={item} value={item}>{label(item)}</option>)}</select></label>
      <label>Action<select value={action} onChange={event => setAction(event.target.value)}><option value="">All actions</option>{Object.entries(actions).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
      <label>User<input value={actor} onChange={event => setActor(event.target.value)} placeholder="Username" /></label>
      <label>Record reference<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Invoice / PO number or record ID" /></label>
      <button disabled={busy} type="submit">Search</button>
    </form>
    <p className="activity-hint">Legacy entries labelled “owner” cannot identify the original user. New authenticated operations record the responsible username. Times shown in Malaysia time.</p>
    {error && <p className="activity-error" role="alert">{error}</p>}
    {busy && <p role="status">Loading database history…</p>}
    {!busy && !error && !data.entries.length && <p>No financial changes match these filters.</p>}
    {!!data.entries.length && <div className="usage-log activity-log"><table><thead><tr><th>Time (MY)</th><th>User</th><th>Record</th><th>Action</th><th>Changes</th></tr></thead><tbody>{data.entries.map(entry => <tr key={entry.id}>
      <td>{new Date(entry.at).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "medium" })}</td>
      <td>{entry.actor || "Unknown"}<small className="db-log-agent">{entry.agent || "Database"}</small></td>
      <td>{entry.reference}<small className="db-log-agent">{label(entry.entity)}</small></td><td>{actions[entry.action] || entry.action}</td>
      <td><button type="button" aria-expanded={expanded === entry.id} onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>{Object.keys(entry.changes).length} fields · {expanded === entry.id ? "Hide" : "View"}</button>
        {expanded === entry.id && <div className="db-log-detail"><p>Record ID: {entry.entityId}{entry.actorUserId && <> · User ID: {entry.actorUserId}</>}</p><table><thead><tr><th>Field</th><th>From</th><th>To</th></tr></thead><tbody>{Object.entries(entry.changes).map(([field, change]) => <tr key={field}><td>{label(field)}</td><td><pre>{valueText(change.from)}</pre></td><td><pre>{valueText(change.to)}</pre></td></tr>)}</tbody></table></div>}</td>
    </tr>)}</tbody></table></div>}
    {data.nextCursor && <button disabled={busy} type="button" onClick={() => void more()}>Load older changes</button>}
  </section>;
}
