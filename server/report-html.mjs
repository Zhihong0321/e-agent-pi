// Small, dependency-free HTML report builder. Every Sales MCP tool renders its
// answer through this module so every report looks the same and none of it
// depends on the calling agent formatting anything. Reports carry markup only —
// the stylesheet lives in shared/report-style.mjs and is injected by the studio,
// so the agent never has to relay it.

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



/**
 * Wraps report content into an HTML fragment. Markup only — the chat frontend drops this into a
 * sandboxed iframe and supplies REPORT_CSS itself.
 * @param {{ title: string; eyebrow?: string; badge?: string; body: string }} opts
 */
export function reportPage({ title, eyebrow, badgeHtml, body }) {
  return `<div class="report"><div class="report-head"><div>${
    eyebrow ? `<p class="report-eyebrow">${escapeHtml(eyebrow)}</p>` : ""
  }<h1>${escapeHtml(title)}</h1></div>${badgeHtml || ""}</div>${body}</div>`;
}

/** Wraps a report fragment in the fenced block the chat renderer detects. */
export function fenceHtml(fragment) {
  return `\`\`\`html\n${fragment}\n\`\`\``;
}
