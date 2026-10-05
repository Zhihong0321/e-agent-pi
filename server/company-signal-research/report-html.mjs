const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const label = value => String(value || 'unknown').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const safeUrl = value => { try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) ? u.href : null; } catch { return null; } };

export function renderSignalReportHtml(d) {
  const biasColors = {
    bullish: { bg: '#e6f4ea', text: '#137333', border: '#ceead6' },
    bearish: { bg: '#fce8e6', text: '#c5221f', border: '#fad2cf' },
    neutral: { bg: '#f1f3f4', text: '#5f6368', border: '#dadce0' },
    high_volatility: { bg: '#fef7e0', text: '#b06000', border: '#feefc3' },
  };
  const currentBias = d.thesis?.bias || 'neutral';
  const biasStyle = biasColors[currentBias] || biasColors.neutral;

  const signalsHtml = (d.signals || []).map((s, idx) => {
    const sStyle = biasColors[s.impact] || biasColors.neutral;
    return `
      <article class="signal-card" style="border-left: 4px solid ${sStyle.text};">
        <div class="signal-meta">
          <span class="badge" style="background:${sStyle.bg}; color:${sStyle.text}; border:1px solid ${sStyle.border};">
            ${escape(s.impact.toUpperCase())}
          </span>
          <span class="badge category">${escape(label(s.category))}</span>
          <span class="date">${escape(s.event_date)}</span>
        </div>
        <h3 class="signal-title">${escape(s.headline)}</h3>
        <p class="signal-summary">${escape(s.summary)}</p>
        <blockquote class="signal-quote">
          <span class="quote-mark">“</span>${escape(s.quote)}<span class="quote-mark">”</span>
        </blockquote>
        ${s.source ? `<div class="signal-source"><a href="${escape(s.source.url)}" target="_blank" rel="noopener noreferrer">Source: ${escape(new URL(s.source.url).hostname)} (Tier ${s.source.tier}) ↗</a></div>` : ''}
      </article>
    `;
  }).join('') || '<p class="empty">No confirmed market-moving signals found in this window.</p>';

  const timelineHtml = (d.trend?.history_timeline || []).map(h => {
    const hStyle = biasColors[h.bias] || biasColors.neutral;
    return `
      <div class="timeline-item ${h.current ? 'current-item' : ''}">
        <div class="timeline-dot" style="background:${hStyle.text};"></div>
        <div class="timeline-content">
          <div class="timeline-header">
            <strong>Report #${h.sequence}</strong>
            <span class="date">${escape(String(h.date).slice(0, 10))}</span>
            <span class="badge" style="background:${hStyle.bg}; color:${hStyle.text};">${escape(h.bias.toUpperCase())}</span>
            <span class="conviction">${Math.round((h.conviction || 0) * 100)}% conv</span>
          </div>
          <p class="timeline-summary">${escape(h.summary)}</p>
        </div>
      </div>
    `;
  }).join('');

  const questionsHtml = d.profile?.custom_research_questions?.map((q, i) => `
    <li><strong>Q${i + 1}:</strong> ${escape(q)}</li>
  `).join('') || '';

  const battlegroundsHtml = d.profile?.primary_battlegrounds?.map(b => `
    <li class="battleground-tag">${escape(b)}</li>
  `).join('') || '';

  const bullishList = (d.thesis?.primary_catalysts || []).map(c => `<li>🟢 ${escape(c)}</li>`).join('') || '<li>None identified.</li>';
  const bearishList = (d.thesis?.key_risks || []).map(r => `<li>🔴 ${escape(r)}</li>`).join('') || '<li>None identified.</li>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(d.name)} (${escape(d.company_uid)}) — Market Signal Report #${d.sequence}</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --primary: #0284c7;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font); background: var(--bg); color: var(--text); line-height: 1.6; padding: 24px; }
    .container { max-width: 1040px; margin: 0 auto; }
    .header-card {
      background: var(--card-bg); border-radius: 12px; border: 1px solid var(--border);
      padding: 32px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .header-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; }
    h1 { font-size: 28px; font-weight: 700; color: #0284c7; }
    .ticker { font-size: 16px; font-weight: 600; color: var(--text-muted); background: #f1f5f9; padding: 4px 10px; border-radius: 6px; }
    .badge { display: inline-block; padding: 4px 10px; font-size: 12px; font-weight: 700; border-radius: 6px; text-transform: uppercase; }
    .badge.category { background: #f1f5f9; color: #475569; }
    .stack-badge { background: #0f172a; color: #ffffff; font-size: 13px; font-weight: 600; padding: 4px 12px; border-radius: 20px; }
    .thesis-box {
      background: ${biasStyle.bg}; border: 1px solid ${biasStyle.border}; border-radius: 8px;
      padding: 16px 20px; margin-top: 16px;
    }
    .thesis-title { font-weight: 700; color: ${biasStyle.text}; font-size: 14px; text-transform: uppercase; margin-bottom: 4px; }
    .thesis-text { font-size: 16px; color: #1e293b; font-weight: 500; }
    .section {
      background: var(--card-bg); border-radius: 12px; border: 1px solid var(--border);
      padding: 28px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .section-title { font-size: 20px; font-weight: 700; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
    .profile-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 20px; }
    .profile-block { background: #f8fafc; padding: 16px; border-radius: 8px; border: 1px solid var(--border); }
    .profile-label { font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; }
    .questions-list { list-style: none; padding-left: 0; }
    .questions-list li { padding: 8px 0; border-bottom: 1px dashed var(--border); font-size: 14px; }
    .battlegrounds-list { list-style: none; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .battleground-tag { background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; }
    .signals-grid { display: flex; flex-direction: column; gap: 16px; }
    .signal-card { background: #ffffff; border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
    .signal-meta { display: flex; gap: 10px; align-items: center; margin-bottom: 10px; font-size: 12px; color: var(--text-muted); }
    .signal-title { font-size: 17px; font-weight: 700; margin-bottom: 8px; color: #0f172a; }
    .signal-summary { font-size: 14px; color: #334155; margin-bottom: 12px; }
    .signal-quote { background: #f8fafc; border-left: 3px solid #cbd5e1; padding: 10px 14px; font-style: italic; font-size: 13px; color: #475569; border-radius: 4px; margin-bottom: 10px; }
    .signal-source a { font-size: 12px; color: #0284c7; text-decoration: none; font-weight: 600; }
    .signal-source a:hover { text-decoration: underline; }
    .catalysts-risks { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .catalyst-col, .risk-col { padding: 16px; border-radius: 8px; }
    .catalyst-col { background: #f0fdf4; border: 1px solid #bbf7d0; }
    .risk-col { background: #fef2f2; border: 1px solid #fecaca; }
    .col-title { font-size: 15px; font-weight: 700; margin-bottom: 10px; }
    .bullet-list { list-style: none; }
    .bullet-list li { margin-bottom: 8px; font-size: 14px; }
    .timeline { border-left: 2px solid #cbd5e1; margin-left: 10px; padding-left: 20px; display: flex; flex-direction: column; gap: 18px; }
    .timeline-item { position: relative; }
    .timeline-dot { width: 12px; height: 12px; border-radius: 50%; position: absolute; left: -27px; top: 4px; border: 2px solid #ffffff; }
    .timeline-header { display: flex; gap: 10px; align-items: center; margin-bottom: 4px; font-size: 13px; }
    .timeline-summary { font-size: 14px; color: #334155; }
    .current-item { font-weight: 600; }
    @media (max-width: 768px) {
      .catalysts-risks { grid-template-columns: 1fr; }
      body { padding: 12px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header-card">
      <div class="header-top">
        <div>
          <h1>${escape(d.name)}</h1>
          <span class="ticker">${escape(d.company_uid)} · ${escape(d.sector || 'Listed Equities')}</span>
        </div>
        <div style="display:flex; gap:10px; align-items:center;">
          <span class="stack-badge">Stack Report #${d.sequence}</span>
          <span class="badge" style="background:${biasStyle.bg}; color:${biasStyle.text}; font-size:14px; padding:6px 14px;">
            ${escape(currentBias.toUpperCase())} (${Math.round((d.thesis?.conviction || 0) * 100)}%)
          </span>
        </div>
      </div>
      <div class="thesis-box">
        <div class="thesis-title">Executive Market Thesis & Catalysts</div>
        <div class="thesis-text">${escape(d.thesis?.summary || 'Thesis not synthesized.')}</div>
      </div>
    </header>

    ${d.profile ? `
    <section class="section">
      <div class="section-title">
        <span>0. Company Business Model & Valuation Battlegrounds</span>
      </div>
      <div class="profile-grid">
        <div class="profile-block">
          <div class="profile-label">Core Business & Revenue Model</div>
          <p style="font-size:14px; margin-bottom:10px;">${escape(d.profile.core_business)}</p>
          <div class="profile-label">Revenue Segments</div>
          <ul style="font-size:13px; padding-left:18px;">
            ${d.profile.revenue_segments.map(s => `<li>${escape(s)}</li>`).join('')}
          </ul>
        </div>
        <div class="profile-block">
          <div class="profile-label">Critical Valuation & Unit Economic KPIs</div>
          <ul style="font-size:13px; padding-left:18px; margin-bottom:12px;">
            ${d.profile.unit_economics_kpis.map(k => `<li>${escape(k)}</li>`).join('')}
          </ul>
          <div class="profile-label">Stock Battlegrounds</div>
          <ul class="battlegrounds-list">
            ${battlegroundsHtml}
          </ul>
        </div>
      </div>
      <div class="profile-block" style="background:#fff; border-color:#cbd5e1;">
        <div class="profile-label" style="color:#0284c7;">Company-Specific Research Questions (Dynamic Thinking Formulation)</div>
        <ul class="questions-list">
          ${questionsHtml}
        </ul>
      </div>
    </section>
    ` : ''}

    <section class="section">
      <div class="section-title">
        <span>1. Multi-Report Trend Evolution</span>
        <span class="badge" style="background:#e0f2fe; color:#0369a1;">
          Trajectory: ${escape((d.trend?.trajectory || 'FIRST_REPORT').toUpperCase())}
        </span>
      </div>
      <p style="font-size:15px; margin-bottom:20px; color:#1e293b;">${escape(d.trend?.synthesis || '')}</p>
      <div class="timeline">
        ${timelineHtml}
      </div>
    </section>

    <section class="section">
      <div class="section-title">
        <span>2. Verified Market-Moving Catalysts (${d.signals?.length || 0})</span>
      </div>
      <div class="signals-grid">
        ${signalsHtml}
      </div>
    </section>

    <section class="section">
      <div class="section-title">
        <span>3. Primary Catalysts & Key Risks</span>
      </div>
      <div class="catalysts-risks">
        <div class="catalyst-col">
          <div class="col-title" style="color:#15803d;">Key Bullish Catalysts</div>
          <ul class="bullet-list">
            ${bullishList}
          </ul>
        </div>
        <div class="risk-col">
          <div class="col-title" style="color:#b91c1c;">Key Headwinds & Risks</div>
          <ul class="bullet-list">
            ${bearishList}
          </ul>
        </div>
      </div>
    </section>
  </div>
</body>
</html>`;
}
