import { useEffect, useMemo, useState, type FormEvent } from "react";
import "./signals.css";

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
    try {
      const res = await fetch(`/api/company-signal-research/companies/${encodeURIComponent(uid)}`, {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCompanyDetail(data);
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
      setShowNewModal(false);
      setNewTicker("");
      setNewName("");
      setNewSector("");
      onNotice(`已成功加入标的并排队研报：${seed.name} (${uid})`);
      await loadCompanies();
      setSelectedCompanyUid(uid);
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

  const bullishCount = useMemo(() => {
    return companies.filter((c) => c.latest_report?.bias === "bullish").length;
  }, [companies]);

  return (
    <div className="sig-panel">
      {/* Top Main Header */}
      <div className="sig-head">
        <div className="sig-head-title-wrap">
          <div className="sig-eyebrow">
            <span>⚡ Institutional Market Intelligence</span>
            <span>·</span>
            <span>纵向多周期异动与催化研报</span>
          </div>
          <h2>
            <span>📈 上市企业异动研报中心 (Company Signal Research)</span>
          </h2>
          <p>
            追踪全球公开发行股票（马来西亚 Bursa、美股 NASDAQ/NYSE、港股 HKEX 等）的逐字核验市场异动、业绩催化剂与长期基本面叙事演进。
          </p>
        </div>
        <div className="sig-head-actions">
          <button
            type="button"
            className="sig-btn-primary"
            onClick={() => setShowNewModal(true)}
          >
            <span>+</span>
            <span>新建标的研报 (New Research)</span>
          </button>
          <button
            type="button"
            className="sig-btn-secondary"
            onClick={() => {
              void loadCompanies();
              if (selectedCompanyUid) void loadCompanyReports(selectedCompanyUid);
            }}
          >
            <span>🔄 刷新</span>
          </button>
        </div>
      </div>

      {/* Macro Stats Grid */}
      <div className="sig-stats">
        <div className="sig-stat-cell">
          <span className="sig-stat-label">已监控标的数</span>
          <span className="sig-stat-value">{companies.length}</span>
          <span className="sig-stat-sub">Targeted Public Companies</span>
        </div>
        <div className="sig-stat-cell">
          <span className="sig-stat-label">累计归档研报</span>
          <span className="sig-stat-value">{totalReportsCount}</span>
          <span className="sig-stat-sub">Stacked Multi-Cycle Reports</span>
        </div>
        <div className="sig-stat-cell">
          <span className="sig-stat-label">利多偏向标的</span>
          <span className="sig-stat-value" style={{ color: "#10b981" }}>{bullishCount}</span>
          <span className="sig-stat-sub">Bullish Stance Count</span>
        </div>
        <div className="sig-stat-cell">
          <span className="sig-stat-label">最新研报活跃</span>
          <span className="sig-stat-value" style={{ color: "#38bdf8", fontSize: "14px" }}>
            {companies[0]?.latest_report_at ? formatDate(companies[0].latest_report_at) : "在线就绪"}
          </span>
          <span className="sig-stat-sub">Most Recent Activity</span>
        </div>
      </div>

      {/* Conditional View: 1. Targeted Companies List OR 2. Company All Reports */}
      {!selectedCompanyUid ? (
        /* ====================================================================
           VIEW 1: TARGETED COMPANIES LIST
           ==================================================================== */
        <div>
          {/* Filters & Search */}
          <div className="sig-filter-bar">
            <div className="sig-search-box">
              <span className="sig-search-icon">🔍</span>
              <input
                type="text"
                className="sig-search-input"
                placeholder="搜索标的代码、公司名称或行业 (如 5347, TNB, BURSA, NVDA)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="sig-bias-tabs">
              <button
                type="button"
                className={`sig-tab-btn ${biasFilter === "all" ? "active" : ""}`}
                onClick={() => setBiasFilter("all")}
              >
                全部标的 ({companies.length})
              </button>
              <button
                type="button"
                className={`sig-tab-btn ${biasFilter === "bullish" ? "active" : ""}`}
                onClick={() => setBiasFilter("bullish")}
              >
                🟢 看多偏向
              </button>
              <button
                type="button"
                className={`sig-tab-btn ${biasFilter === "bearish" ? "active" : ""}`}
                onClick={() => setBiasFilter("bearish")}
              >
                🔴 看空逆风
              </button>
              <button
                type="button"
                className={`sig-tab-btn ${biasFilter === "neutral" ? "active" : ""}`}
                onClick={() => setBiasFilter("neutral")}
              >
                ⚖️ 中性平衡
              </button>
              <button
                type="button"
                className={`sig-tab-btn ${biasFilter === "high_volatility" ? "active" : ""}`}
                onClick={() => setBiasFilter("high_volatility")}
              >
                ⚡ 拐点高波
              </button>
            </div>
          </div>

          {loading ? (
            <div className="sig-loading-state">
              <span>⏳ 正在加载上市标的研报库...</span>
            </div>
          ) : error ? (
            <div className="sig-empty-state" style={{ color: "#f43f5e" }}>
              <span>⚠️ {error}</span>
            </div>
          ) : filteredCompanies.length === 0 ? (
            <div className="sig-empty-state">
              <p>暂无符合筛选条件的标的公司。</p>
              <button
                type="button"
                className="sig-btn-primary"
                style={{ marginTop: "14px" }}
                onClick={() => setShowNewModal(true)}
              >
                立即新建首个标的研报
              </button>
            </div>
          ) : (
            <div className="sig-company-list">
              {filteredCompanies.map((c) => {
                const latest = c.latest_report;
                const biasConf = latest?.bias ? BIAS_CONFIG[latest.bias] : null;
                const trajText = latest?.trajectory ? TRAJECTORY_LABELS[latest.trajectory] : null;

                return (
                  <div
                    key={c.uid}
                    className="sig-company-card"
                    onClick={() => setSelectedCompanyUid(c.uid)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedCompanyUid(c.uid);
                    }}
                  >
                    {/* Left: Ticker, Name, Sector */}
                    <div className="sig-card-left">
                      <div className="sig-symbol-row">
                        <span className="sig-ticker-badge">{c.ticker}</span>
                        <span className="sig-exchange-tag">{c.exchange}</span>
                        {c.uid && <span style={{ fontSize: "11px", color: "#64748b" }}>{c.uid}</span>}
                      </div>
                      <div className="sig-company-name">{c.name}</div>
                      <div className="sig-sector-tag">{c.sector || "综合公用与产业"}</div>
                    </div>

                    {/* Center: Latest Stance, Price, Synthesis */}
                    <div className="sig-card-center">
                      <div className="sig-pill-row">
                        {biasConf ? (
                          <span className={`sig-bias-pill ${biasConf.className}`}>
                            <span>{biasConf.icon}</span>
                            <span>{biasConf.label}</span>
                            {latest?.conviction != null && (
                              <span style={{ opacity: 0.85 }}>({Math.round(latest.conviction * 100)}%)</span>
                            )}
                          </span>
                        ) : (
                          <span className="sig-bias-pill sig-bias-neutral">
                            <span>⏱️ 研报进行中</span>
                          </span>
                        )}

                        {trajText && (
                          <span className="sig-trajectory-tag">{trajText}</span>
                        )}

                        {latest?.currentPrice != null && (
                          <span className={`sig-price-tag ${latest.sevenDayChangePercent != null && latest.sevenDayChangePercent >= 0 ? "sig-price-up" : "sig-price-down"}`}>
                            {latest.currentPrice.toFixed(2)}
                            {latest.sevenDayChangePercent != null && (
                              <span> ({latest.sevenDayChangePercent >= 0 ? "+" : ""}{latest.sevenDayChangePercent.toFixed(2)}%)</span>
                            )}
                          </span>
                        )}
                      </div>

                      <div className="sig-thesis-preview">
                        {latest?.summary || "已建立监控档案，点击查看历史期次研报详情与完整催化事件。"}
                      </div>
                    </div>

                    {/* Right: Stack count & View CTA */}
                    <div className="sig-card-right">
                      <div className="sig-reports-badge">
                        <span>📑 累计 {c.report_count} 份研报</span>
                        {latest?.sequence && <span>(Seq #{latest.sequence})</span>}
                      </div>
                      <div className="sig-updated-time">
                        最近研报: {formatDate(c.last_researched_at || c.latest_report_at || c.created_at)}
                      </div>
                      <div className="sig-view-cta">
                        <span>查看全部研报与催化追踪</span>
                        <span>→</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
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
    </div>
  );
}
