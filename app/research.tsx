import { useEffect, useState } from "react";
import "./research.css";

type Research = { id: string; name: string; website: string | null; status: string; createdAt: string; hasReport: boolean; durationMs: number | null; coverage: number | null; publicationToken: string | null };
type History = { items: Research[]; total: number; limit: number; offset: number };
const label = (value: string) => value.replace(/_/g, " ");
const duration = (ms: number | null) => ms == null ? "—" : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(Math.round(ms / 1000) / 60)}m ${Math.round(ms / 1000) % 60}s`;

export default function ResearchPage() {
  const [data, setData] = useState<History | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("finished");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setError(""); setUnauthorized(false); } });
    const params = new URLSearchParams({ q: search, status, offset: String(offset), limit: "20" });
    void fetch(`/api/company-research/dossiers?${params}`, { credentials: "include", signal: controller.signal }).then(async response => {
      if (response.status === 401) { setUnauthorized(true); return; }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not load research history");
      setData(result);
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load research history"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, status, offset, refresh]);
  useEffect(() => {
    if (!data?.items.some(item => ["queued", "running"].includes(item.status))) return;
    const timer = window.setInterval(() => setRefresh(value => value + 1), 10000);
    return () => window.clearInterval(timer);
  }, [data]);
  return <main className="research-page">
    <nav className="research-nav" aria-label="Site navigation"><a className="research-brand" href="/">◈ E Agent</a><div><a href="/">Agents</a><a href="/research" aria-current="page">Research</a><a href="/calendar">Calendar</a><a href="/settings">Settings</a></div></nav>
    <header className="research-heading"><span>COMPANY INTELLIGENCE</span><h1>Research library</h1><p>Previous company research, its evidence coverage, and the reports ready to read.</p></header>
    <aside className="research-start"><strong>Start research in Orchestrator</strong><p>Try: “Research Eternalgy Sdn Bhd in Malaysia. Website: https://eternalgy.me/. Run fresh research and publish the HTML report.”</p><a href="/">Open Agents → Orchestrator ↗</a></aside>
    <form className="research-filters" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); setOffset(0); }}>
      <label>Company<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search company names" maxLength={200} /></label>
      <label>Runs<select value={status} onChange={event => { setStatus(event.target.value); setOffset(0); }}><option value="finished">Finished</option><option value="all">All runs</option><option value="active">Queued / running</option><option value="complete">Complete</option><option value="partial">Partial</option><option value="needs_review">Needs identity review</option><option value="failed">Failed</option></select></label>
      <button type="submit">Search</button><button type="button" className="secondary" onClick={() => setRefresh(value => value + 1)}>Refresh</button>
    </form>
    {unauthorized ? <section className="research-empty"><h2>Sign in to view research history</h2><p>Private reports and the research list require your Settings access.</p><a href="/settings">Sign in through Settings ↗</a><button type="button" onClick={() => setRefresh(value => value + 1)}>I’ve signed in — retry</button></section> : <>
      {error && <p role="alert" className="research-error">{error}</p>}
      <div className="research-count" role="status">{loading ? "Loading research…" : `${data?.total || 0} research runs`}</div>
      {!loading && !error && !data?.items.length && <section className="research-empty"><h2>No research found</h2><p>Change the filters or ask Orchestrator to research a company.</p></section>}
      <div className="research-list" aria-busy={loading}>{data?.items.map(item => <article className="research-item" key={item.id}>
        <div><div className="research-item-meta"><span className={`research-status ${item.status}`}>{label(item.status)}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" })} MYT</time></div><h2>{item.name}</h2><p className="research-domain">{item.website || "Website not supplied"}</p><p className="research-metrics">Research time: {duration(item.durationMs)}{item.coverage != null ? ` · Evidence coverage: ${Math.round(item.coverage * 100)}%` : ""}</p></div>
        <div className="research-item-links">{item.publicationToken && <a className="primary" href={`/reports/company/${item.publicationToken}`}>Open published report ↗</a>}{item.hasReport && <a href={`/api/company-research/dossiers/${item.id}/artifact?format=html`}>View private report ↗</a>}{!item.hasReport && <span>{item.status === "failed" ? "No report generated" : "Report pending"}</span>}</div>
      </article>)}</div>
      {!!data?.total && <div className="research-pagination"><button disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous</button><span>{offset + 1}–{Math.min(offset + 20, data.total)} of {data.total}</span><button disabled={offset + 20 >= data.total || loading} onClick={() => setOffset(value => value + 20)}>Next</button></div>}
    </>}
  </main>;
}
