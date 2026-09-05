// The report stylesheet, shared by the server that builds reports and the studio
// that renders them. It lives apart from both so it is defined exactly once: tool
// results carry only markup, and app/chat-markdown.tsx injects these rules into
// the sandboxed iframe. Keeping it inline in the payload made the agent retype
// ~2.4KB of unchanging CSS into every reply.

export const REPORT_CSS = `
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
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  .stat { background: #f1f4f2; border: 1px solid #e7edea; border-radius: 10px; padding: 8px 10px; min-width: 0; }
  /* Money runs long (RM 42,843,578.96); let it wrap and shrink rather than run off a phone. */
  .stat-value { font-size: 17px; font-weight: 700; color: #16352a; overflow-wrap: anywhere; }
  @media (max-width: 380px) { .stat-value { font-size: 15px; } }
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
