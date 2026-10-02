import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import "./research.css";

export type ResearchItem = {
  id: string;
  name: string;
  website: string | null;
  status: "queued" | "running" | "complete" | "partial" | "needs_review" | "failed" | string;
  createdAt: string;
  updatedAt?: string;
  hasReport: boolean;
  durationMs: number | null;
  coverage: number | null;
  version?: string;
  publicationToken: string | null;
};

export type ResearchHistory = {
  items: ResearchItem[];
  total: number;
  limit: number;
  offset: number;
};

export type DossierDetail = {
  id: string;
  status: string;
  result?: {
    summary?: string;
    scores?: { coverage?: number; confidence?: number };
    findings?: {
      facts?: Array<{ field: string; value: string | number; quote?: string }>;
      people?: Array<{ name: string; role: string; contact?: string | null }>;
      clients?: Array<{ name: string; year?: number | null; delivered?: string }>;
      risks?: Array<{ risk: string }>;
      signals?: Array<{ what: string; date?: string }>;
    };
    meta?: { durationMs?: number; searchProviders?: Record<string, unknown>; version?: string };
  };
  error?: string;
  created_at: string;
  updated_at: string;
};

const STATUS_FILTERS = [
  { id: "all", label: "All runs" },
  { id: "finished", label: "Finished" },
  { id: "active", label: "Queued / Running" },
  { id: "complete", label: "Complete" },
  { id: "partial", label: "Partial" },
  { id: "needs_review", label: "Needs review" },
  { id: "failed", label: "Failed" },
];

function ResIcon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    file: <><path d="M6 2h8l5 5v14H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v6h5M8 13h8M8 17h6"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    refresh: <><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M21 21v-5h-5"/></>,
    plus: <path d="M12 4v16M4 12h16"/>,
    external: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14 21 3"/></>,
    close: <path d="M5 5 19 19M19 5 5 19"/>,
    spark: <><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"/></>,
    globe: <><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/></>,
    check: <path d="m4 12 5 5L20 6"/>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

const formatDuration = (ms: number | null) => {
  if (ms == null) return "—";
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
};

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
};

const formatDateTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
};

const statusLabel = (val: string) => val.replace(/_/g, " ");

export function ResearchPanel({
  user,
  onNotice,
  onRequestNew,
}: {
  user?: { id: string; username: string; display_name?: string; role: string };
  onNotice: (message: string) => void;
  onRequestNew?: () => void;
}) {
  const [data, setData] = useState<ResearchHistory | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DossierDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  // New research modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newWebsite, setNewWebsite] = useState("");
  const [newForce, setNewForce] = useState(false);
  const [newBusy, setNewBusy] = useState(false);
  const [newError, setNewError] = useState("");

  const loadVersion = useRef(0);

  // Fetch dossier list
  useEffect(() => {
    const version = ++loadVersion.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");

    const params = new URLSearchParams({
      q: search.trim(),
      status,
      offset: String(offset),
      limit: "20",
    });

    fetch(`/api/company-research/dossiers?${params}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 401) {
          throw new Error("Please sign in to view company research");
        }
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Could not load research library");
        if (version === loadVersion.current) {
          setData(result);
        }
      })
      .catch((reason) => {
        if (!controller.signal.aborted && version === loadVersion.current) {
          setError(reason instanceof Error ? reason.message : "Could not load research library");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && version === loadVersion.current) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [search, status, offset, refresh]);

  // Auto-refresh when any job is queued or running
  useEffect(() => {
    if (!data?.items.some((item) => ["queued", "running"].includes(item.status))) return;
    const timer = window.setInterval(() => setRefresh((v) => v + 1), 6000);
    return () => window.clearInterval(timer);
  }, [data]);

  // Load selected dossier details
  const openDetail = async (item: ResearchItem) => {
    if (selectedId === item.id && detail) return;
    setSelectedId(item.id);
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/company-research/dossiers/${item.id}`, {
        credentials: "include",
      });
      const res = await response.json();
      if (!response.ok) throw new Error(res.error || "Failed to load dossier details");
      setDetail(res);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Could not load dossier details");
    } finally {
      setDetailLoading(false);
    }
  };

  // Close detail view
  const closeDetail = () => {
    setSelectedId(null);
    setDetail(null);
  };

  // Publish report
  const handlePublish = async (id: string) => {
    setActionBusy(true);
    try {
      const res = await fetch(`/api/company-research/dossiers/${id}/publish`, {
        method: "POST",
        credentials: "include",
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed to publish report");
      onNotice("Report published! Shareable link is active.");
      setRefresh((v) => v + 1);
      if (selectedId === id) {
        const refreshed = await fetch(`/api/company-research/dossiers/${id}`, { credentials: "include" });
        if (refreshed.ok) setDetail(await refreshed.json());
      }
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Failed to publish report");
    } finally {
      setActionBusy(false);
    }
  };

  // Unpublish report
  const handleUnpublish = async (id: string) => {
    if (!window.confirm("Unpublish this report? The public link will become inactive.")) return;
    setActionBusy(true);
    try {
      const res = await fetch(`/api/company-research/dossiers/${id}/publish`, {
        method: "DELETE",
        credentials: "include",
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed to unpublish report");
      onNotice("Report unpublished.");
      setRefresh((v) => v + 1);
      if (selectedId === id) {
        const refreshed = await fetch(`/api/company-research/dossiers/${id}`, { credentials: "include" });
        if (refreshed.ok) setDetail(await refreshed.json());
      }
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Failed to unpublish report");
    } finally {
      setActionBusy(false);
    }
  };

  // Replay synthesis
  const handleReplay = async (id: string) => {
    setActionBusy(true);
    try {
      const res = await fetch(`/api/company-research/dossiers/${id}/replay`, {
        method: "POST",
        credentials: "include",
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "Failed to replay synthesis");
      onNotice("Replay complete! Dossier refreshed from saved evidence.");
      setRefresh((v) => v + 1);
      if (selectedId === id) {
        const refreshed = await fetch(`/api/company-research/dossiers/${id}`, { credentials: "include" });
        if (refreshed.ok) setDetail(await refreshed.json());
      }
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Failed to replay synthesis");
    } finally {
      setActionBusy(false);
    }
  };

  // Start new research submission
  const handleStartResearch = async (event: FormEvent) => {
    event.preventDefault();
    if (!newName.trim() || newName.trim().length < 2) {
      setNewError("Company name must be at least 2 characters.");
      return;
    }
    setNewBusy(true);
    setNewError("");
    try {
      let web = newWebsite.trim();
      if (web && !/^https?:\/\//i.test(web)) {
        web = `https://${web}`;
      }
      const response = await fetch("/api/company-research/dossiers", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seed: {
            name: newName.trim(),
            ...(web ? { website: web } : {}),
          },
          options: {
            force: newForce,
          },
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not enqueue research");
      onNotice(`Research queued for ${newName.trim()}`);
      setModalOpen(false);
      setNewName("");
      setNewWebsite("");
      setNewForce(false);
      setRefresh((v) => v + 1);
    } catch (err) {
      setNewError(err instanceof Error ? err.message : "Could not start research");
    } finally {
      setNewBusy(false);
    }
  };

  // Stats calculation
  const stats = useMemo(() => {
    const items = data?.items || [];
    const total = data?.total || 0;
    const complete = items.filter((i) => i.status === "complete").length;
    const active = items.filter((i) => ["queued", "running"].includes(i.status)).length;
    const review = items.filter((i) => ["needs_review", "partial"].includes(i.status)).length;
    const failed = items.filter((i) => i.status === "failed").length;
    const completedItems = items.filter((i) => i.coverage != null && i.status === "complete");
    const avgCoverage = completedItems.length
      ? Math.round((completedItems.reduce((acc, i) => acc + (i.coverage || 0), 0) / completedItems.length) * 100)
      : null;

    return { total, complete, active, review, failed, avgCoverage };
  }, [data]);

  const selectedItem = data?.items.find((i) => i.id === selectedId) || null;

  return (
    <section className="res-panel" aria-label="Company research library">
      {/* Panel Header */}
      <header className="res-head">
        <div>
          <div className="demo-panel-kicker">
            <ResIcon name="spark" size={15} /> COMPANY INTELLIGENCE
          </div>
          <h2>
            Research library
            {data && <span className="demo-badge">{data.total} dossiers</span>}
          </h2>
          <p>
            Evidence-backed company dossiers, web verification, and published intelligence reports.
          </p>
        </div>
        <div className="res-head-actions">
          <button
            className="res-btn"
            disabled={loading}
            onClick={() => setRefresh((v) => v + 1)}
            title="Refresh research list"
          >
            <ResIcon name="refresh" size={14} /> Refresh
          </button>
          <button
            className="res-btn primary"
            onClick={() => {
              setNewError("");
              setModalOpen(true);
            }}
          >
            <ResIcon name="plus" size={15} /> New research
          </button>
        </div>
      </header>

      {/* Stats bar */}
      <div className="res-stats">
        <div>
          <span>Total Dossiers</span>
          <strong>{stats.total}</strong>
        </div>
        <div className="ok">
          <span>Complete</span>
          <strong>{stats.complete}</strong>
        </div>
        <div className="wait">
          <span>In Progress</span>
          <strong>
            {stats.active > 0 && <i className="res-pulse-dot" style={{ marginRight: 6 }} />}
            {stats.active}
          </strong>
        </div>
        <div className="wait">
          <span>Needs Review</span>
          <strong>{stats.review}</strong>
        </div>
        <div className={stats.failed > 0 ? "no" : ""}>
          <span>Failed</span>
          <strong>{stats.failed}</strong>
        </div>
      </div>

      {/* Toolbar */}
      <div className="res-toolbar">
        <div className="res-chips" role="group" aria-label="Filter research status">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              className={status === f.id ? "on" : ""}
              onClick={() => {
                setStatus(f.id);
                setOffset(0);
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <form
          className="res-search"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query.trim());
            setOffset(0);
          }}
        >
          <ResIcon name="search" size={15} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search company names…"
            maxLength={200}
            aria-label="Search companies"
          />
        </form>

        <a
          href="/reports/company/preview"
          target="_blank"
          rel="noopener noreferrer"
          className="res-link-btn"
          title="See preview report layout"
        >
          <ResIcon name="external" size={13} /> Sample report preview ↗
        </a>
      </div>

      {/* Error notification banner */}
      {error && (
        <div className="res-error-banner" role="alert">
          <span>{error}</span>
          <button className="res-btn" onClick={() => setRefresh((v) => v + 1)}>
            Retry
          </button>
        </div>
      )}

      {/* Main Table + Detail Drawer */}
      <div className={`res-body${selectedId ? " has-detail" : ""}`}>
        <div className="res-table-wrap">
          {loading && !data ? (
            <div className="res-empty" role="status">
              <h3>Reading research library…</h3>
              <p>Connecting to company dossiers and evidence cache.</p>
            </div>
          ) : !loading && data?.items.length === 0 ? (
            <div className="res-empty">
              <h3>No company dossiers found</h3>
              <p>
                {search
                  ? `No research matches "${search}". Try another company name.`
                  : "Start fresh research to analyze any company in Malaysia with automated evidence."}
              </p>
              <button className="res-btn primary" onClick={() => setModalOpen(true)}>
                <ResIcon name="plus" size={15} /> Start first research
              </button>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Coverage</th>
                  <th>Duration</th>
                  <th>Created</th>
                  <th>Report</th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((item) => {
                  const isSelected = selectedId === item.id;
                  const isActive = ["queued", "running"].includes(item.status);
                  return (
                    <tr
                      key={item.id}
                      className={isSelected ? "selected" : ""}
                      onClick={() => void openDetail(item)}
                    >
                      <td>
                        <div className="res-company-info">
                          <strong className="res-company-name">{item.name}</strong>
                          {item.website ? (
                            <a
                              href={item.website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="res-company-domain"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ResIcon name="globe" size={12} />
                              {item.website.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "")}
                            </a>
                          ) : (
                            <span style={{ fontSize: 10, color: "#9ca89f" }}>Website not recorded</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <span className={`res-status-badge ${item.status}`}>
                          {isActive && <i className="res-pulse-dot" />}
                          {statusLabel(item.status)}
                        </span>
                      </td>
                      <td>
                        {item.coverage != null ? (
                          <div className="res-coverage-meter" title={`Evidence coverage: ${Math.round(item.coverage * 100)}%`}>
                            <div className="res-coverage-track">
                              <div
                                className="res-coverage-fill"
                                style={{ width: `${Math.min(100, Math.round(item.coverage * 100))}%` }}
                              />
                            </div>
                            <span className="res-coverage-val">{Math.round(item.coverage * 100)}%</span>
                          </div>
                        ) : (
                          <span style={{ color: "#9ca89f" }}>—</span>
                        )}
                      </td>
                      <td>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatDuration(item.durationMs)}</span>
                      </td>
                      <td>
                        <span style={{ fontSize: 11, color: "#6a7d71" }}>{formatDate(item.createdAt)}</span>
                      </td>
                      <td>
                        {item.publicationToken ? (
                          <a
                            className="res-link-btn public"
                            href={`/reports/company/${item.publicationToken}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ResIcon name="external" size={12} /> Published ↗
                          </a>
                        ) : item.hasReport ? (
                          <a
                            className="res-link-btn"
                            href={`/api/company-research/dossiers/${item.id}/artifact?format=html`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ResIcon name="file" size={12} /> HTML report ↗
                          </a>
                        ) : (
                          <span style={{ color: "#9ca89f", fontSize: 11 }}>
                            {item.status === "failed" ? "No report" : "Pending"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Selected Dossier Detail Drawer */}
        {selectedId && (
          <aside className="res-detail" aria-label="Dossier detail">
            <div className="res-detail-head">
              <span className="res-detail-kicker">
                <ResIcon name="file" size={13} /> DOSSIER DETAIL
              </span>
              <button className="res-detail-close" onClick={closeDetail} aria-label="Close detail view">
                <ResIcon name="close" size={14} />
              </button>
            </div>

            {selectedItem && (
              <>
                <h3>{selectedItem.name}</h3>
                {selectedItem.website && (
                  <a
                    href={selectedItem.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="res-detail-domain"
                  >
                    <ResIcon name="globe" size={13} />
                    {selectedItem.website} ↗
                  </a>
                )}

                <div className="res-detail-cards">
                  <div className="res-detail-card">
                    <span>Status</span>
                    <strong style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className={`res-status-badge ${selectedItem.status}`}>
                        {["queued", "running"].includes(selectedItem.status) && <i className="res-pulse-dot" />}
                        {statusLabel(selectedItem.status)}
                      </span>
                    </strong>
                  </div>
                  <div className="res-detail-card">
                    <span>Coverage</span>
                    <strong>{selectedItem.coverage != null ? `${Math.round(selectedItem.coverage * 100)}%` : "—"}</strong>
                  </div>
                  <div className="res-detail-card">
                    <span>Duration</span>
                    <strong>{formatDuration(selectedItem.durationMs)}</strong>
                  </div>
                  <div className="res-detail-card">
                    <span>Recorded</span>
                    <strong style={{ fontSize: 11 }}>{formatDateTime(selectedItem.createdAt)}</strong>
                  </div>
                </div>

                {/* Primary Actions */}
                <div className="res-detail-actions">
                  {selectedItem.publicationToken ? (
                    <>
                      <a
                        className="res-detail-btn-primary"
                        href={`/reports/company/${selectedItem.publicationToken}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ResIcon name="external" size={15} /> Open Published Report ↗
                      </a>
                      <button
                        className="res-detail-btn-secondary"
                        disabled={actionBusy}
                        onClick={() => void handleUnpublish(selectedItem.id)}
                      >
                        Unpublish report
                      </button>
                    </>
                  ) : selectedItem.hasReport ? (
                    <>
                      <a
                        className="res-detail-btn-primary"
                        href={`/api/company-research/dossiers/${selectedItem.id}/artifact?format=html`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ResIcon name="file" size={15} /> View HTML Report ↗
                      </a>
                      <button
                        className="res-detail-btn-secondary"
                        disabled={actionBusy}
                        onClick={() => void handlePublish(selectedItem.id)}
                      >
                        <ResIcon name="spark" size={14} /> Publish Report to Web
                      </button>
                    </>
                  ) : ["queued", "running"].includes(selectedItem.status) ? (
                    <div className="res-summary-box" style={{ background: "#edf4fb", borderColor: "#cce0f5" }}>
                      <strong style={{ color: "#25537d" }}>Research is running…</strong>
                      <p style={{ margin: "4px 0 0", color: "#37628a", fontSize: 11 }}>
                        The specialist is executing search queries, fetching domain evidence, and synthesizing facts. This view updates automatically.
                      </p>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, color: "#8a9a8d" }}>
                      {selectedItem.status === "failed" ? "Job failed without report" : "Report pending synthesis"}
                    </span>
                  )}

                  {selectedItem.hasReport && (
                    <button
                      className="res-detail-btn-secondary"
                      disabled={actionBusy}
                      onClick={() => void handleReplay(selectedItem.id)}
                      title="Replay AI synthesis from saved evidence without spending fresh search queries"
                    >
                      <ResIcon name="refresh" size={13} /> Replay Synthesis (0 search credits)
                    </button>
                  )}
                </div>

                {/* Detailed Findings from API */}
                {detailLoading ? (
                  <p style={{ color: "#8a9a8d", fontSize: 11 }}>Loading evidence details…</p>
                ) : detail?.result ? (
                  <>
                    {detail.result.summary && (
                      <>
                        <div className="res-section-header">Executive Summary</div>
                        <div className="res-summary-box">{detail.result.summary}</div>
                      </>
                    )}

                    {detail.result.findings?.facts && detail.result.findings.facts.length > 0 && (
                      <>
                        <div className="res-section-header">Key Verified Facts</div>
                        <div className="res-facts-table">
                          {detail.result.findings.facts.slice(0, 8).map((fact, idx) => (
                            <div className="res-fact-item" key={idx}>
                              <span className="res-fact-label">{fact.field.replace(/_/g, " ")}</span>
                              <span className="res-fact-value">{String(fact.value)}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    {detail.result.findings?.people && detail.result.findings.people.length > 0 && (
                      <>
                        <div className="res-section-header">Identified Leadership</div>
                        <div className="res-people-chips">
                          {detail.result.findings.people.slice(0, 4).map((person, idx) => (
                            <div className="res-person-chip" key={idx}>
                              <strong>{person.name}</strong>
                              <span>{person.role}{person.contact ? ` · ${person.contact}` : ""}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                ) : null}

                {/* Export Options */}
                {selectedItem.hasReport && (
                  <div className="res-export-row">
                    <a
                      className="res-export-link"
                      href={`/api/company-research/dossiers/${selectedItem.id}/artifact?format=md`}
                      download={`${selectedItem.name.replace(/\s+/g, "-")}-report.md`}
                    >
                      Download Markdown (.md)
                    </a>
                    <a
                      className="res-export-link"
                      href={`/api/company-research/dossiers/${selectedItem.id}/artifact?format=json`}
                      download={`${selectedItem.name.replace(/\s+/g, "-")}-dossier.json`}
                    >
                      Download JSON Dossier
                    </a>
                  </div>
                )}
              </>
            )}
          </aside>
        )}
      </div>

      {/* Pagination Footer */}
      {Boolean(data?.total) && (
        <footer className="res-foot">
          <div>
            Showing <strong>{offset + 1}–{Math.min(offset + 20, data!.total)}</strong> of <strong>{data!.total}</strong> company dossiers
          </div>
          <div className="res-foot-actions">
            <button
              className="res-btn"
              disabled={offset === 0 || loading}
              onClick={() => setOffset((v) => Math.max(0, v - 20))}
            >
              Previous
            </button>
            <button
              className="res-btn"
              disabled={offset + 20 >= data!.total || loading}
              onClick={() => setOffset((v) => v + 20)}
            >
              Next
            </button>
          </div>
        </footer>
      )}

      {/* Start Research Modal */}
      {modalOpen && (
        <div
          className="demo-modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div className="demo-modal" role="dialog" aria-modal="true" aria-label="Start company research">
            <div className="demo-modal-head">
              <span className="demo-modal-icon">
                <ResIcon name="spark" size={22} />
              </span>
              <button onClick={() => setModalOpen(false)} aria-label="Close modal">
                <ResIcon name="close" size={18} />
              </button>
            </div>
            <h2>Start company research</h2>
            <p>
              Runs evidence-backed deep research on any company in Malaysia using search, domain evidence, and multi-lane analysis.
            </p>

            <form onSubmit={handleStartResearch}>
              <label>
                Company name *
                <input
                  required
                  placeholder="e.g. Eternalgy Sdn Bhd"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
              </label>

              <label>
                Official website (optional)
                <input
                  type="text"
                  placeholder="e.g. https://eternalgy.me"
                  value={newWebsite}
                  onChange={(e) => setNewWebsite(e.target.value)}
                />
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontWeight: 500, fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={newForce}
                  onChange={(e) => setNewForce(e.target.checked)}
                  style={{ width: "auto" }}
                />
                Force fresh research (bypass 30-day cache)
              </label>

              {newError && (
                <p role="alert" style={{ color: "#a33d3d", fontSize: 12, margin: "4px 0" }}>
                  {newError}
                </p>
              )}

              <div style={{ background: "#f5f9f6", border: "1px solid #dce8dd", borderRadius: 8, padding: "10px 12px", fontSize: 11, color: "#4c6b57", marginTop: 4 }}>
                <strong>Tip:</strong> You can also chat with Orchestrator:
                <div style={{ fontStyle: "italic", marginTop: 3 }}>
                  “Research Eternalgy Sdn Bhd in Malaysia. Website: https://eternalgy.me. Run fresh research and publish the report.”
                </div>
              </div>

              <button className="demo-primary" type="submit" disabled={newBusy || !newName.trim()} style={{ marginTop: 12 }}>
                {newBusy ? "Starting research…" : "Start deep research"}
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
