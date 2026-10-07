import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./signals.css";
import "./research.css";

export type TargetCompany = {
  uid: string;
  ticker: string;
  exchange: string;
  name: string;
  sector: string | null;
  last_researched_at: string | null;
  created_at: string;
  updated_at: string;
  report_count: number;
  completed_count: number;
  latest_report_at: string | null;
  latest_report: {
    id: string;
    sequence: number;
    status: string;
    bias: "bullish" | "bearish" | "neutral" | "high_volatility" | null;
    conviction: number | null;
    trajectory: "accelerating" | "stable" | "deteriorating" | "inflection_point" | "first_report" | null;
    summary: string | null;
    signalsCount: number | null;
    currentPrice: number | null;
    sevenDayChangePercent: number | null;
    createdAt: string;
  } | null;
};

export type CompanyReportItem = {
  id: string;
  company_uid: string;
  version: string;
  sequence: number;
  previous_dossier_id: string | null;
  status: "queued" | "running" | "complete" | "failed";
  seed: {
    company_uid: string;
    ticker: string;
    exchange: string;
    name: string;
    sector?: string;
    lookback_days?: number;
  };
  result?: {
    sequence: number;
    stack_height?: number;
    counts?: { total: number; bullish: number; bearish: number; volatile: number };
    thesis?: {
      bias: "bullish" | "bearish" | "neutral" | "high_volatility";
      conviction: number;
      primary_catalysts?: string[];
      key_risks?: string[];
      summary: string;
    };
    delta_summary?: string;
    trend?: {
      trajectory: "accelerating" | "stable" | "deteriorating" | "inflection_point" | "first_report";
      synthesis: string;
      materialized_catalysts?: string[];
      unresolved_risks?: string[];
      history_timeline?: Array<{
        sequence: number;
        report_id: string;
        date: string;
        bias: string;
        conviction: number;
        summary: string;
        signals_count: number;
        current?: boolean;
      }>;
    };
    market_data?: {
      symbol: string;
      currency: string;
      currentPrice: number;
      sevenDayChange: number;
      sevenDayChangePercent: number;
      sevenDayHigh: number;
      sevenDayLow: number;
    };
    signals?: Array<{
      category: string;
      impact: string;
      timeframe?: string;
      headline: string;
      summary: string;
      event_date: string;
      evidence_id: string;
      quote: string;
      source?: { id: string; url: string; tier: number };
    }>;
    profile?: {
      core_business?: string;
      revenue_segments?: string[];
      primary_battlegrounds?: string[];
    };
  };
  error?: string | null;
  created_at: string;
  updated_at: string;
};

const BIAS_CONFIG = {
  bullish: { label: "看多 · 利好偏向", short: "看多", icon: "📈", className: "sig-bias-bullish" },
  bearish: { label: "看空 · 承压逆风", short: "看空", icon: "📉", className: "sig-bias-bearish" },
  neutral: { label: "中性 · 价值平衡", short: "中性", icon: "⚖️", className: "sig-bias-neutral" },
  high_volatility: { label: "高波动 · 关键拐点", short: "拐点高波", icon: "⚡", className: "sig-bias-volatile" },
};

const TRAJECTORY_LABELS: Record<string, string> = {
  accelerating: "加速上升 (Accelerating)",
  stable: "平稳运行 (Stable)",
  deteriorating: "承压恶化 (Deteriorating)",
  inflection_point: "关键拐点 (Inflection Point)",
  first_report: "首期基准建档 (Initial Baseline)",
};

const formatDate = (iso?: string | null) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso).slice(0, 16);
  }
};

export function SignalReportsPanel({
  onNotice = () => {},
}: {
  user?: { id: string; username: string; display_name: string; role: string };
  onNotice?: (msg: string) => void;
}) {
  const [companies, setCompanies] = useState<TargetCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [biasFilter, setBiasFilter] = useState<string>("all");

  // Selection state
  const [selectedCompanyUid, setSelectedCompanyUid] = useState<string | null>(() => {
    return new URLSearchParams(window.location.search).get("company") || null;
  });
  const [companyDetail, setCompanyDetail] = useState<{ entity: TargetCompany; reports: CompanyReportItem[] } | null>(null);
  const [loadingReports, setLoadingReports] = useState(false);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const [showJsonId, setShowJsonId] = useState<string | null>(null);

  // New Research Modal
  const [showNewModal, setShowNewModal] = useState(false);
  const [newTicker, setNewTicker] = useState("");
  const [newExchange, setNewExchange] = useState("BURSA");
  const [newName, setNewName] = useState("");
  const [newSector, setNewSector] = useState("");
  const [newLookbackDays, setNewLookbackDays] = useState(30);
  const [submittingNew, setSubmittingNew] = useState(false);

  // Sync URL query
  useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedCompanyUid) {
      url.searchParams.set("company", selectedCompanyUid);
    } else {
      url.searchParams.delete("company");
    }
    window.history.replaceState(null, "", url.toString());
  }, [selectedCompanyUid]);

  // Load companies list
  const loadCompanies = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/company-signal-research/companies", {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCompanies(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法加载公司列表");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadCompanies();
  }, []);

  // Load selected company reports
  const loadCompanyReports = async (uid: string) => {
    setLoadingReports(true);
    setCompanyDetail(null);
    try {
      const res = await fetch(`/api/company-signal-research/companies/${encodeURIComponent(uid)}`, {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCompanyDetail(data);
      setSelectedCompanyUid(data.entity.uid);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "无法加载标的研报详情");
    } finally {
      setLoadingReports(false);
    }
  };

  useEffect(() => {
    if (selectedCompanyUid) {
      void loadCompanyReports(selectedCompanyUid);
    } else {
      setCompanyDetail(null);
    }
  }, [selectedCompanyUid]);

  // Filtered companies
  const filteredCompanies = useMemo(() => {
    return companies.filter((c) => {
      const matchesSearch =
        !searchQuery.trim() ||
        c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.ticker.toLowerCase().includes(searchQuery.toLowerCase()) ||
        c.exchange.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (c.sector && c.sector.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesBias =
        biasFilter === "all" ||
        (c.latest_report && c.latest_report.bias === biasFilter);

      return matchesSearch && matchesBias;
    });
  }, [companies, searchQuery, biasFilter]);

  // Trigger new stack report for an existing company
  const handleTriggerUpdate = async (company: TargetCompany) => {
    try {
      const seed = {
        company_uid: company.uid,
        ticker: company.ticker,
        exchange: company.exchange,
        name: company.name,
        sector: company.sector || undefined,
        lookback_days: 30,
      };
      const res = await fetch("/api/company-signal-research/dossiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ seed, options: { force: true } }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onNotice(`已成功排队生成【${company.name}】的增量追踪研报！`);
      // Reload reports
      void loadCompanyReports(company.uid);
      void loadCompanies();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "触发增量研报失败");
    }
  };

  // Submit modal form for new target company
  const handleCreateNew = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTicker.trim() || !newName.trim()) return;
    setSubmittingNew(true);
    try {
      const cleanTicker = newTicker.trim().toUpperCase();
      const cleanExchange = newExchange.trim().toUpperCase();
      const uid = `${cleanTicker}.${cleanExchange}`;
      const seed = {
        company_uid: uid,
        ticker: cleanTicker,
        exchange: cleanExchange,
        name: newName.trim(),
        sector: newSector.trim() || undefined,
        lookback_days: Number(newLookbackDays) || 30,
      };

      const res = await fetch("/api/company-signal-research/dossiers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ seed }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const queued = await res.json();
      setShowNewModal(false);
      setNewTicker("");
      setNewName("");
      setNewSector("");
      onNotice(`已成功加入标的并排队研报：${seed.name} (${uid})`);
      await loadCompanies();
      setSelectedCompanyUid(queued.company_uid || uid);
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "添加标的研报失败");
    } finally {
      setSubmittingNew(false);
    }
  };

  // Stats calculation
  const totalReportsCount = useMemo(() => {
    return companies.reduce((acc, c) => acc + (c.report_count || 0), 0);
  }, [companies]);

  const latestStatusCount = (status: string) => companies.filter((c) => c.latest_report?.status === status).length;
  const biasLabels: Record<string, string> = {
    bullish: "Bullish", bearish: "Bearish", neutral: "Neutral", high_volatility: "High volatility",
  };

  return (
    <div className="res-panel sig-library">
      <header className="res-head">
        <div>
          <div className="demo-panel-kicker"><img className="sig-brand-mark" src="/branding/e-logo.png" alt="E" width={22} height={22} /> COMPANY INTELLIGENCE</div>
          <h2>Company signals <span className="demo-badge">{companies.length} companies</span></h2>
          <p>Evidence-backed market signals, earnings catalysts, and company research across reporting cycles.</p>
        </div>
        <div className="res-head-actions">
          <button type="button" className="res-btn" disabled={loading} onClick={() => {
            void loadCompanies();
            if (selectedCompanyUid) void loadCompanyReports(selectedCompanyUid);
          }}><span aria-hidden="true">↻</span> Refresh</button>
          <button type="button" className="res-btn primary" onClick={() => setShowNewModal(true)}>
            <span aria-hidden="true">＋</span> New research
          </button>
        </div>
      </header>
      <div className="res-stats">
        <div><span>Total companies</span><strong>{companies.length}</strong></div>
        <div><span>Total reports</span><strong>{totalReportsCount}</strong></div>
        <div className="ok"><span>Latest complete</span><strong>{latestStatusCount("complete")}</strong></div>
        <div className="wait"><span>In progress</span><strong>{latestStatusCount("queued") + latestStatusCount("running")}</strong></div>
        <div className={latestStatusCount("failed") ? "no" : ""}><span>Latest failed</span><strong>{latestStatusCount("failed")}</strong></div>
      </div>
      {!selectedCompanyUid ? (
        <div>
          <div className="res-toolbar">
            <div className="res-chips" role="group" aria-label="Filter company signal bias">
              {[['all', 'All companies'], ...Object.entries(biasLabels)].map(([id, label]) => (
                <button type="button" key={id} className={biasFilter === id ? "on" : ""}
                  aria-pressed={biasFilter === id} onClick={() => setBiasFilter(id)}>{label}</button>
              ))}
            </div>
            <div className="res-search">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>
              <input type="search" placeholder="Search company names or tickers…" aria-label="Search companies"
                value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} />
            </div>
          </div>
          <div className="res-table-wrap sig-library-table">
            <table>
              <thead><tr><th>Company</th><th>Status</th><th>Latest bias</th><th>Conviction</th><th>Reports</th><th>Updated</th><th>Report folder</th></tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={7} className="sig-library-state"><span role="status">Loading company signals…</span></td></tr>
                  : error ? <tr><td colSpan={7} className="sig-library-state sig-library-error"><span role="alert">{error}</span></td></tr>
                  : filteredCompanies.length === 0 ? <tr><td colSpan={7} className="sig-library-state">
                    <p>{companies.length ? "No companies match your filters." : "No companies researched yet."}</p>
                    {companies.length === 0 && <button type="button" className="res-btn primary" onClick={() => setShowNewModal(true)}>New research</button>}
                  </td></tr>
                  : filteredCompanies.map((c) => {
                    const latest = c.latest_report;
                    const reportStatus = latest?.status;
                    const conviction = latest?.conviction == null ? null : Math.round(Math.max(0, Math.min(1, latest.conviction)) * 100);
                    return <tr key={c.uid}>
                      <td><div className="res-company-info">
                        <button type="button" className="sig-library-company res-company-name" onClick={() => setSelectedCompanyUid(c.uid)}>{c.name}</button>
                        <span className="sig-library-meta">{c.ticker} · {c.exchange}{c.sector ? ' · ' + c.sector : ''}</span>
                      </div></td>
                      <td><span className={'res-status-badge ' + (reportStatus || '')}>{reportStatus || 'No reports'}</span></td>
                      <td>{latest?.bias ? <span className={'sig-library-bias ' + latest.bias}>{biasLabels[latest.bias]}</span> : <span className="sig-library-meta">—</span>}</td>
                      <td>{conviction == null ? <span className="sig-library-meta">—</span> : <div className="res-coverage-meter">
                        <div className="res-coverage-track" role="meter" aria-label={'Latest conviction for ' + c.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={conviction}>
                          <div className="res-coverage-fill" style={{ width: conviction + '%' }} />
                        </div><span className="res-coverage-val">{conviction}%</span>
                      </div>}</td>
                      <td>{c.report_count}</td>
                      <td className="sig-library-date">{formatDate(c.last_researched_at || c.latest_report_at || c.created_at)}</td>
                      <td><div className="sig-library-report-actions">
                        <button type="button" className="sig-library-history res-link-btn" onClick={() => setSelectedCompanyUid(c.uid)}>Browse all research →</button>
                      </div></td>
                    </tr>;
                  })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* ====================================================================
           VIEW 2: COMPANY DETAIL & ALL REPORTS FOR THIS COMPANY
           ==================================================================== */
        <div className="sig-detail-view">
          {/* Breadcrumb Navigation Bar */}
          <div className="sig-breadcrumb-bar">
            <button
              type="button"
              className="sig-back-btn"
              onClick={() => setSelectedCompanyUid(null)}
            >
              <span>← 返回标的列表 (All Companies)</span>
            </button>
            <div style={{ fontSize: "12px", color: "#64748b" }}>
              标的 UID: <span style={{ fontFamily: "monospace", color: "#38bdf8" }}>{selectedCompanyUid}</span>
            </div>
          </div>

          {/* Company Hero Profile */}
          {companyDetail?.entity && (
            <div className="sig-company-hero">
              <div className="sig-hero-left">
                <h1>
                  <span className="sig-ticker-badge" style={{ fontSize: "18px", padding: "4px 10px" }}>
                    {companyDetail.entity.ticker}
                  </span>
                  <span>{companyDetail.entity.name}</span>
                </h1>
                <div className="sig-hero-meta">
                  <span>🏛️ 交易所: {companyDetail.entity.exchange}</span>
                  <span>·</span>
                  <span>💼 行业: {companyDetail.entity.sector || "综合产业"}</span>
                  <span>·</span>
                  <span>📑 累计生成: {companyDetail.reports.length} 期研报</span>
                  <span>·</span>
                  <span>🕒 首期建档: {formatDate(companyDetail.entity.created_at)}</span>
                </div>
              </div>

              <div className="sig-hero-right">
                <button
                  type="button"
                  className="sig-btn-primary"
                  onClick={() => handleTriggerUpdate(companyDetail.entity)}
                >
                  <span>⚡</span>
                  <span>生成增量追踪研报 (Run New Stack Report)</span>
                </button>
              </div>
            </div>
          )}

          {/* All Reports Timeline */}
          <div>
            <div className="sig-reports-timeline-title">
              <span>📚 本标的历史研报全景 (Longitudinal Stack Reports · 按期次倒序)</span>
              <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 400 }}>
                共 {companyDetail?.reports?.length || 0} 期历史归档
              </span>
            </div>

            {loadingReports ? (
              <div className="sig-loading-state">
                <span>⏳ 正在加载该标的的历史研报归档...</span>
              </div>
            ) : !companyDetail?.reports || companyDetail.reports.length === 0 ? (
              <div className="sig-empty-state">
                <p>该标的暂无已归档的研报记录。</p>
                {companyDetail?.entity && (
                  <button
                    type="button"
                    className="sig-btn-primary"
                    style={{ marginTop: "14px" }}
                    onClick={() => handleTriggerUpdate(companyDetail.entity)}
                  >
                    立即发起首期建档研报
                  </button>
                )}
              </div>
            ) : (
              <div>
                {companyDetail.reports.map((report, idx) => {
                  const isLatest = idx === 0;
                  const res = report.result;
                  const bias = res?.thesis?.bias;
                  const biasConf = bias ? BIAS_CONFIG[bias] : null;
                  const traj = res?.trend?.trajectory;
                  const trajText = traj ? TRAJECTORY_LABELS[traj] : null;
                  const isExpanded = expandedReportId === report.id;
                  const isShowJson = showJsonId === report.id;

                  return (
                    <article
                      key={report.id}
                      className={`sig-report-card ${isLatest ? "is-latest" : ""}`}
                    >
                      {/* Top Header */}
                      <div className="sig-report-card-top">
                        <div className="sig-report-seq-wrap">
                          <span className="sig-seq-badge">
                            研报期次 #{report.sequence}
                          </span>
                          {isLatest && <span className="sig-latest-pill">🟢 当前最新有效</span>}
                          <span className="sig-report-date">
                            📅 {formatDate(report.created_at)}
                          </span>
                          <span style={{ fontSize: "11px", color: "#64748b" }}>
                            状态: <strong style={{ color: report.status === "complete" ? "#10b981" : "#f59e0b" }}>{report.status}</strong>
                          </span>
                        </div>

                        <div className="sig-report-actions">
                          {report.status === "complete" && (
                            <a
                              href={`/reports/signal/${report.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="sig-btn-open-report"
                            >
                              <span>📄 打开终端研报 (HTML)</span>
                              <span>↗</span>
                            </a>
                          )}
                          {res?.signals && res.signals.length > 0 && (
                            <button
                              type="button"
                              className="sig-btn-ghost"
                              onClick={() => setExpandedReportId(isExpanded ? null : report.id)}
                            >
                              {isExpanded ? "收起信号预览 ▲" : `预览核验信号 (${res.signals.length}) ▼`}
                            </button>
                          )}
                          <button
                            type="button"
                            className="sig-btn-ghost"
                            onClick={() => setShowJsonId(isShowJson ? null : report.id)}
                          >
                            {isShowJson ? "收起 JSON" : "原始数据 (JSON)"}
                          </button>
                        </div>
                      </div>

                      {/* Pill Row: Bias, Conviction, Trajectory, Price */}
                      <div className="sig-pill-row">
                        {biasConf && (
                          <span className={`sig-bias-pill ${biasConf.className}`}>
                            <span>{biasConf.icon}</span>
                            <span>{biasConf.label}</span>
                            {res?.thesis?.conviction != null && (
                              <span style={{ opacity: 0.9 }}>
                                ({Math.round(res.thesis.conviction * 100)}% 置信度)
                              </span>
                            )}
                          </span>
                        )}

                        {trajText && (
                          <span className="sig-trajectory-tag">{trajText}</span>
                        )}

                        {res?.market_data?.currentPrice != null && (
                          <span className={`sig-price-tag ${res.market_data.sevenDayChangePercent >= 0 ? "sig-price-up" : "sig-price-down"}`}>
                            标的价格: {res.market_data.currentPrice.toFixed(2)} {res.market_data.currency || ""}
                            <span> ({res.market_data.sevenDayChangePercent >= 0 ? "+" : ""}{res.market_data.sevenDayChangePercent.toFixed(2)}%)</span>
                          </span>
                        )}

                        {res?.counts?.total != null && (
                          <span style={{ fontSize: "11px", color: "#94a3b8" }}>
                            🛡️ {res.counts.total} 项核验信号 ({res.counts.bullish} 利多 / {res.counts.bearish} 利空)
                          </span>
                        )}
                      </div>

                      {/* Synthesis / Delta Summary Box */}
                      {(res?.delta_summary || res?.thesis?.summary) && (
                        <div className="sig-synthesis-box">
                          <strong>💡 研报核心定调与增量研判:</strong>{" "}
                          {res.delta_summary || res.thesis?.summary}
                        </div>
                      )}

                      {/* Catalysts & Risks Grid */}
                      {(res?.thesis?.primary_catalysts?.length || res?.thesis?.key_risks?.length) ? (
                        <div className="sig-drivers-grid">
                          <div className="sig-driver-col">
                            <div className="sig-driver-head" style={{ color: "#10b981" }}>
                              <span>🟢</span>
                              <span>利多催化点 (Primary Catalysts)</span>
                            </div>
                            <ul className="sig-driver-list">
                              {(res.thesis?.primary_catalysts || []).slice(0, 3).map((c, i) => (
                                <li key={i} className="sig-driver-item">{c}</li>
                              ))}
                            </ul>
                          </div>

                          <div className="sig-driver-col">
                            <div className="sig-driver-head" style={{ color: "#f43f5e" }}>
                              <span>🔴</span>
                              <span>核心逆风与风险 (Key Risks)</span>
                            </div>
                            <ul className="sig-driver-list">
                              {(res.thesis?.key_risks || []).slice(0, 3).map((r, i) => (
                                <li key={i} className="sig-driver-item">{r}</li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      ) : null}

                      {/* Inline Expanded Signals Preview */}
                      {isExpanded && res?.signals && (
                        <div className="sig-preview-drawer">
                          <div style={{ fontSize: "12px", fontWeight: 700, color: "#38bdf8" }}>
                            逐字核验市场异动事件证据详情:
                          </div>
                          {res.signals.map((sig, sIdx) => (
                            <div key={sIdx} className="sig-preview-signal">
                              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", fontWeight: 600, color: "#f8fafc" }}>
                                <span>[{sig.impact.toUpperCase()}] {sig.headline}</span>
                                <span style={{ color: "#64748b", fontFamily: "monospace" }}>📅 {sig.event_date}</span>
                              </div>
                              <p style={{ fontSize: "12px", color: "#94a3b8", margin: "4px 0" }}>
                                {sig.summary}
                              </p>
                              <span className="sig-signal-quote">
                                “{sig.quote}”
                              </span>
                              {sig.source?.url && (
                                <div style={{ marginTop: "4px", fontSize: "11px" }}>
                                  <a href={sig.source.url} target="_blank" rel="noopener noreferrer" style={{ color: "#38bdf8", textDecoration: "none" }}>
                                    信源直达: {sig.source.url} ↗
                                  </a>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Raw JSON View */}
                      {isShowJson && (
                        <pre style={{
                          background: "#070b14",
                          border: "1px solid rgba(255,255,255,0.08)",
                          borderRadius: "8px",
                          padding: "14px",
                          fontSize: "11px",
                          fontFamily: "monospace",
                          color: "#94a3b8",
                          maxHeight: "300px",
                          overflow: "auto",
                        }}>
                          {JSON.stringify(report, null, 2)}
                        </pre>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ====================================================================
         MODAL: NEW COMPANY SIGNAL RESEARCH
         ==================================================================== */}
      {showNewModal && (
        <div className="sig-modal-overlay" onClick={() => setShowNewModal(false)}>
          <div className="sig-modal" onClick={(e) => e.stopPropagation()}>
            <h3>新建标的公司市场异动研报</h3>
            <p>输入公开上市公司的代码与交易所，系统将自动发起实时数据抓取、逐字核验与多周期研报建档。</p>

            <form onSubmit={handleCreateNew}>
              <div className="sig-form-group">
                <label>股票代码 (Ticker) *</label>
                <input
                  type="text"
                  className="sig-form-input"
                  placeholder="例如: 5347, TNB, NVDA, 1155, 700"
                  required
                  value={newTicker}
                  onChange={(e) => setNewTicker(e.target.value)}
                />
              </div>

              <div className="sig-form-group">
                <label>交易所 (Exchange) *</label>
                <select
                  className="sig-form-select"
                  value={newExchange}
                  onChange={(e) => setNewExchange(e.target.value)}
                >
                  <option value="BURSA">BURSA (马来西亚证券交易所 KLSE)</option>
                  <option value="NASDAQ">NASDAQ (美股纳斯达克)</option>
                  <option value="NYSE">NYSE (纽约证券交易所)</option>
                  <option value="HKEX">HKEX (香港交易所)</option>
                  <option value="SGX">SGX (新加坡交易所)</option>
                  <option value="LSE">LSE (伦敦证券交易所)</option>
                </select>
              </div>

              <div className="sig-form-group">
                <label>公司名称 (Company Full Name) *</label>
                <input
                  type="text"
                  className="sig-form-input"
                  placeholder="例如: Tenaga Nasional Berhad, Nvidia Corporation"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>

              <div className="sig-form-group">
                <label>所属行业/板块 (Sector · 可选)</label>
                <input
                  type="text"
                  className="sig-form-input"
                  placeholder="例如: Utilities / Power Grid, Semiconductors, Banking"
                  value={newSector}
                  onChange={(e) => setNewSector(e.target.value)}
                />
              </div>

              <div className="sig-form-group">
                <label>资讯回溯天数 (Lookback Days)</label>
                <input
                  type="number"
                  min={7}
                  max={90}
                  className="sig-form-input"
                  value={newLookbackDays}
                  onChange={(e) => setNewLookbackDays(Number(e.target.value))}
                />
              </div>

              <div className="sig-modal-footer">
                <button
                  type="button"
                  className="sig-btn-ghost"
                  onClick={() => setShowNewModal(false)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="sig-btn-primary"
                  disabled={submittingNew}
                >
                  {submittingNew ? "正在排队发起..." : "确认并发起研报"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <footer className="sig-brand-footer" aria-label="E by Eternalgy">
        <img className="sig-footer-e" src="/branding/e-logo.png" alt="E" width={20} height={20} />
        <span>by</span>
        <img className="sig-footer-eternalgy" src="/branding/eternalgy-logo.png" alt="Eternalgy — Eternal Energy" width={112} height={15} />
      </footer>
    </div>
  );
}
