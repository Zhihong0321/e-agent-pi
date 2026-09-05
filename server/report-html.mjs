// Small, dependency-free HTML report builder. Every Sales MCP tool renders its
// answer through this module so every report looks the same and none of it
// depends on the calling agent formatting anything.

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

export function fmtMoney(value) {
  const n = Number(value) || 0;
  return `RM ${n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function fmtPct(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${(Number(value) * 100).toFixed(1)}%`;
}

export function fmtInt(value) {
  return Number(value || 0).toLocaleString("en-MY");
}

const TONE_COLORS = {
  green: { bg: "#dff8e8", ink: "#046b3f", line: "#a9e8c4" },
  amber: { bg: "#fef3c7", ink: "#92400e", line: "#fde08a" },
  gray: { bg: "#f1f4f2", ink: "#42544c", line: "#dbe4de" },
  red: { bg: "#fde2e2", ink: "#9f1d1d", line: "#f5b5b5" },
};

export function badge(text, tone = "gray") {
  const c = TONE_COLORS[tone] || TONE_COLORS.gray;
  return `<span class="badge" style="background:${c.bg};color:${c.ink};border:1px solid ${c.line}">${escapeHtml(text)}</span>`;
}

export function note(text, tone = "amber") {
  const c = TONE_COLORS[tone] || TONE_COLORS.amber;
  return `<div class="note" style="background:${c.bg};color:${c.ink};border:1px solid ${c.line}">${escapeHtml(text)}</div>`;
}

/** @param {{label:string, value:string, tone?: string}[]} stats */
export function statGrid(stats) {
  const cells = stats
    .map((s) => {
      const c = TONE_COLORS[s.tone] || null;
      const style = c ? `background:${c.bg};color:${c.ink};border:1px solid ${c.line}` : "";
      return `<div class="stat" style="${style}"><div class="stat-value">${escapeHtml(s.value)}</div><div class="stat-label">${escapeHtml(s.label)}</div></div>`;
    })
    .join("");
  return `<div class="stat-grid">${cells}</div>`;
}

/**
 * Responsive data table: a real <table> on wide viewports, stacked
 * label/value rows on narrow ones (CSS-only, via data-label).
 * @param {string[]} headers
 * @param {(string|number)[][]} rows
 */
export function dataTable(headers, rows) {
  if (!rows.length) return `<div class="empty">No rows.</div>`;
  const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = row
        .map((cell, i) => `<td data-label="${escapeHtml(headers[i] || "")}">${escapeHtml(cell)}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function section(title, bodyHtml) {
  return `<section class="section">${title ? `<h2>${escapeHtml(title)}</h2>` : ""}${bodyHtml}</section>`;
}

const BASE_STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #10211b;
    font-size: 14px;
    line-height: 1.4;
    padding: 12px 14px 14px;
  }
  .report { display: grid; gap: 12px; }
  .report-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .report-head h1 { font-size: 15px; margin: 0; font-weight: 700; color: #16352a; }
  .report-eyebrow { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #687a73; margin: 0 0 2px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
  .note { padding: 8px 10px; border-radius: 10px; font-size: 12.5px; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
  .stat { background: #f1f4f2; border: 1px solid #e7edea; border-radius: 10px; padding: 8px 10px; }
  .stat-value { font-size: 17px; font-weight: 700; color: #16352a; }
  .stat-label { font-size: 11px; color: #687a73; margin-top: 1px; }
  .section h2 { font-size: 12.5px; font-weight: 700; color: #16352a; margin: 0 0 6px; }
  .table-wrap { width: 100%; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: none; }
  tbody tr {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 2px 8px;
    padding: 7px 0;
    border-bottom: 1px solid #e7edea;
  }
  tbody tr:last-child { border-bottom: none; }
  td { display: block; padding: 0; border: 0; }
  td[data-label]::before {
    content: attr(data-label);
    display: block;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: #8a978f;
  }
  td:first-child { grid-column: 1 / 2; }
  .empty { color: #8a978f; font-size: 12.5px; font-style: italic; }
  @media (min-width: 460px) {
    thead { display: table-header-group; }
    thead th {
      text-align: left;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      color: #8a978f;
      padding: 0 8px 6px 0;
      font-weight: 600;
    }
    tbody tr { display: table-row; padding: 0; }
    td { display: table-cell; padding: 6px 8px 6px 0; vertical-align: top; }
    td[data-label]::before { content: none; }
  }
`;

/**
 * Wraps report content into a self-contained HTML fragment (style + markup).
 * The chat frontend drops this straight into a sandboxed iframe.
 * @param {{ title: string; eyebrow?: string; badge?: string; body: string }} opts
 */
export function reportPage({ title, eyebrow, badgeHtml, body }) {
  return `<style>${BASE_STYLE}</style><div class="report"><div class="report-head"><div>${
    eyebrow ? `<p class="report-eyebrow">${escapeHtml(eyebrow)}</p>` : ""
  }<h1>${escapeHtml(title)}</h1></div>${badgeHtml || ""}</div>${body}</div>`;
}

/** Wraps a report fragment in the fenced block the chat renderer detects. */
export function fenceHtml(fragment) {
  return `\`\`\`html\n${fragment}\n\`\`\``;
}
