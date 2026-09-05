import { useEffect, useRef, useState, type ReactNode } from "react";

export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:\?|#|$)/i;
const CHAT_TOKEN_RE =
  /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"'`)\]]+)|`((?:[\w./@-]+)\.(?:png|jpe?g|gif|webp|svg|avif|bmp))`|(^|[\s|([{'"])((?:[\w./@-]+)\.(?:png|jpe?g|gif|webp|svg|avif|bmp))/gi;

const TITLE_COL = /^(package|package_name|name|title|product|item|description)$/i;
const SKIP_TITLE_COL = /^(id|#|no|idx|index|pk)$/i;
const NUMERIC_RE = /^(rm\s*)?-?[\d,]+(\.\d+)?%?$/i;

export type ChatPart =
  | { type: "text"; value: string }
  | { type: "image"; href: string; alt: string }
  | { type: "link"; href: string; label: string };

type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "code"; lang: string; text: string }
  | { type: "hr" };

type MediaCtx = {
  agentId: string;
  onOpen: (src: string, alt?: string) => void;
};

export function stripHrefJunk(href: string) {
  return href.replace(/[.,;:!?)]+$/, "");
}

export function isRemoteSrc(src: string) {
  return /^(https?:\/\/|data:)/i.test(src);
}

export function isImageHref(href: string) {
  if (/^data:image\//i.test(href)) return true;
  return IMAGE_EXT_RE.test((href.split("?")[0] || href).split("#")[0]);
}

export function normalizeWorkspacePath(src: string) {
  let s = src.trim().replace(/\\/g, "/");
  s = s.replace(/^<|>$/g, "");
  s = s.replace(/^file:\/\//i, "");
  s = s.replace(/^\/storage\/workspaces\/[^/]+\//, "");
  s = s.replace(/^\/storage\/workspace\//, "");
  s = s.replace(/^\.\//, "");
  if (!s || s.includes("://")) return "";
  return s;
}

export function workspaceMediaUrl(agentId: string, src: string) {
  if (isRemoteSrc(src)) return src;
  const rel = normalizeWorkspacePath(src);
  if (!rel) return src;
  const query = new URLSearchParams({ path: rel });
  if (agentId) query.set("agent", agentId);
  return `/api/files/raw?${query.toString()}`;
}

export function tokenizeChat(text: string): ChatPart[] {
  const parts: ChatPart[] = [];
  let last = 0;
  CHAT_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CHAT_TOKEN_RE.exec(text))) {
    if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
    if (match[1] != null && match[2]) {
      parts.push({ type: "image", alt: match[1], href: stripHrefJunk(match[2]) });
    } else if (match[3] != null && match[4]) {
      parts.push({ type: "link", label: match[3], href: stripHrefJunk(match[4]) });
    } else if (match[5]) {
      const href = stripHrefJunk(match[5]);
      parts.push({ type: "link", label: href, href });
    } else if (match[6]) {
      parts.push({ type: "link", label: match[6], href: match[6] });
    } else if (match[8]) {
      if (match[7]) parts.push({ type: "text", value: match[7] });
      parts.push({ type: "link", label: match[8], href: match[8] });
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  return parts.length ? parts : [{ type: "text", value: text }];
}

export function collectImageHrefs(...chunks: string[]): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  const add = (raw: string) => {
    const href = stripHrefJunk(raw.trim());
    if (!href || !isImageHref(href)) return;
    const key = href.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(href);
  };
  const blob = chunks.filter(Boolean).join("\n");
  for (const part of tokenizeChat(blob)) {
    if (part.type === "image" || part.type === "link") add(part.href);
  }
  const jsonPath = /"(?:path|out|file|filename|url|src)"\s*:\s*"([^"]+)"/gi;
  let match: RegExpExecArray | null;
  while ((match = jsonPath.exec(blob))) add(match[1]);
  return found;
}

function looksNumeric(value: string) {
  return NUMERIC_RE.test(value.trim());
}

function looksLikeTableRow(line: string) {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("|") && t.includes("|", 1)) return true;
  return (t.match(/\|/g) || []).length >= 2;
}

function splitTableRow(line: string) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

function isSeparatorCells(cells: string[]) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

function isFence(line: string) {
  return /^\s*```/.test(line);
}

function headingOf(line: string) {
  const match = line.match(/^(#{1,6})\s+(.+)$/);
  if (!match) return null;
  return { level: match[1].length, text: match[2].trim() };
}

function isHr(line: string) {
  return /^\s*(?:-\s*){3,}$/.test(line) || /^\s*(?:\*\s*){3,}$/.test(line) || /^\s*(?:_\s*){3,}$/.test(line);
}

function listItemOf(line: string) {
  const match = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
  if (!match) return null;
  if (isHr(line)) return null;
  return { ordered: /^\s*\d/.test(line), text: match[1] };
}

function takeTable(lines: string[], start: number): { block: MdBlock; next: number } | null {
  if (!looksLikeTableRow(lines[start] || "")) return null;
  const raw: string[][] = [];
  let i = start;
  while (i < lines.length && looksLikeTableRow(lines[i])) {
    raw.push(splitTableRow(lines[i]));
    i += 1;
  }
  if (raw.length < 2) return null;
  let headers = raw[0];
  let body = raw.slice(1);
  if (isSeparatorCells(body[0])) body = body.slice(1);
  const width = Math.max(headers.length, ...body.map((row) => row.length), 1);
  headers = Array.from({ length: width }, (_, idx) => headers[idx] || `col ${idx + 1}`);
  const rows = body.map((row) => Array.from({ length: width }, (_, idx) => row[idx] || ""));
  return { block: { type: "table", headers, rows }, next: i };
}

function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (isFence(line)) {
      const lang = line.trim().slice(3).trim();
      const chunk: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) {
        chunk.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: "code", lang, text: chunk.join("\n") });
      continue;
    }
    const heading = headingOf(line);
    if (heading) {
      blocks.push({ type: "heading", ...heading });
      i += 1;
      continue;
    }
    const table = takeTable(lines, i);
    if (table) {
      blocks.push(table.block);
      i = table.next;
      continue;
    }
    if (isHr(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }
    const firstItem = listItemOf(line);
    if (firstItem) {
      const items = [firstItem.text];
      const ordered = firstItem.ordered;
      i += 1;
      while (i < lines.length) {
        if (!lines[i].trim()) break;
        const item = listItemOf(lines[i]);
        if (!item || item.ordered !== ordered) break;
        items.push(item.text);
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const chunk: string[] = [line];
    i += 1;
    while (i < lines.length) {
      const next = lines[i];
      if (!next.trim()) break;
      if (isFence(next) || headingOf(next) || isHr(next) || listItemOf(next) || looksLikeTableRow(next)) break;
      chunk.push(next);
      i += 1;
    }
    blocks.push({ type: "paragraph", text: chunk.join("\n") });
  }
  return blocks;
}

function pickTitleIndex(headers: string[], rows: string[][]) {
  const named = headers.findIndex((header) => TITLE_COL.test(header.trim()));
  if (named >= 0) return named;
  for (let i = 0; i < headers.length; i += 1) {
    if (SKIP_TITLE_COL.test(headers[i].trim())) continue;
    const numeric = rows.length > 0 && rows.every((row) => !row[i] || looksNumeric(row[i]));
    if (!numeric) return i;
  }
  return 0;
}

function numericColumns(headers: string[], rows: string[][]) {
  return headers.map((_, idx) => {
    const values = rows.map((row) => row[idx]).filter(Boolean);
    return values.length > 0 && values.every(looksNumeric);
  });
}

function renderEmphasis(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let n = 0;
  while ((match = re.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] != null) nodes.push(<code key={`${key}-c${n}`}>{match[1]}</code>);
    else if (match[2] != null) nodes.push(<strong key={`${key}-b${n}`}>{match[2]}</strong>);
    else if (match[3] != null) nodes.push(<em key={`${key}-i${n}`}>{match[3]}</em>);
    last = match.index + match[0].length;
    n += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.length ? nodes : [text];
}

function renderInline(text: string, ctx: MediaCtx, key: string): ReactNode[] {
  return tokenizeChat(text).flatMap((part, index) => {
    const partKey = `${key}-${index}`;
    if (part.type === "text") return renderEmphasis(part.value, partKey);
    const src = workspaceMediaUrl(ctx.agentId, part.href);
    if (part.type === "image") {
      return [
        <a
          key={partKey}
          className="chat-figure"
          href={src}
          onClick={(event) => {
            event.preventDefault();
            ctx.onOpen(src, part.alt || part.href);
          }}
        >
          <img
            src={src}
            alt={part.alt || ""}
            onError={(event) => event.currentTarget.closest("a")?.classList.add("is-missing")}
          />
        </a>,
      ];
    }
    if (isImageHref(part.href)) {
      return [
        <a
          key={partKey}
          className="chat-file-link"
          href={src}
          onClick={(event) => {
            event.preventDefault();
            ctx.onOpen(src, part.label);
          }}
        >
          {part.label}
        </a>,
      ];
    }
    return [
      <a key={partKey} href={isRemoteSrc(part.href) ? part.href : src} target="_blank" rel="noreferrer">
        {part.label}
      </a>,
    ];
  });
}

function TableView({
  headers,
  rows,
  ctx,
  k,
}: {
  headers: string[];
  rows: string[][];
  ctx: MediaCtx;
  k: string;
}) {
  if (!rows.length) return null;
  const nums = numericColumns(headers, rows);
  if (headers.length >= 3) {
    const titleAt = pickTitleIndex(headers, rows);
    return (
      <div className="chat-cards">
        {rows.map((row, rowIdx) => (
          <article className="chat-card" key={`${k}-r${rowIdx}`}>
            <div className="chat-card-title">{renderInline(row[titleAt] || "—", ctx, `${k}-${rowIdx}-t`)}</div>
            <dl className="chat-card-kv">
              {headers.map((header, colIdx) => {
                if (colIdx === titleAt) return null;
                const value = row[colIdx];
                if (!value) return null;
                return (
                  <div key={`${k}-${rowIdx}-${colIdx}`}>
                    <dt>{header || `col ${colIdx + 1}`}</dt>
                    <dd className={nums[colIdx] ? "is-num" : undefined}>{renderInline(value, ctx, `${k}-${rowIdx}-c${colIdx}`)}</dd>
                  </div>
                );
              })}
            </dl>
          </article>
        ))}
      </div>
    );
  }
  return (
    <div className="chat-table-wrap">
      <table className="chat-table">
        <thead>
          <tr>
            {headers.map((header, idx) => (
              <th key={idx} className={nums[idx] ? "is-num" : undefined}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              {row.map((cell, colIdx) => (
                <td key={colIdx} className={nums[colIdx] ? "is-num" : undefined}>
                  {renderInline(cell, ctx, `${k}-${rowIdx}-${colIdx}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const REPORT_RESIZE_SCRIPT = `<script>(function(){
  function post(){ parent.postMessage({ type: "chat-report-height", height: document.documentElement.scrollHeight }, "*"); }
  post();
  window.addEventListener("load", post);
  if (window.ResizeObserver) new ResizeObserver(post).observe(document.body);
  else setInterval(post, 500);
})();</script>`;

const COLLAPSED_REPORT_PX = 420;

/**
 * Renders an agent-supplied HTML report (fenced \`\`\`html block) in a sandboxed, auto-height iframe.
 * A full pipeline report measures several thousand pixels, which buries the rest of the thread, so
 * anything past COLLAPSED_REPORT_PX is folded behind a control until the reader asks for it.
 */
function HtmlReportFrame({ html, k }: { html: string; k: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (ref.current && event.source === ref.current.contentWindow && event.data?.type === "chat-report-height") {
        setHeight(Math.max(40, Number(event.data.height) || 60));
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const tall = height > COLLAPSED_REPORT_PX;
  const shown = tall && !open ? COLLAPSED_REPORT_PX : height;
  return (
    <div className={tall && !open ? "chat-report clipped" : "chat-report"}>
      <iframe
        key={k}
        ref={ref}
        className="chat-report-frame"
        style={{ height: shown }}
        srcDoc={html + REPORT_RESIZE_SCRIPT}
        sandbox="allow-scripts"
        title="Report"
      />
      {tall && (
        <button type="button" className="chat-report-toggle" onClick={() => setOpen((prev) => !prev)}>
          {open ? "Collapse report" : `Show full report · ${Math.round(height / 100) / 10}k px`}
        </button>
      )}
    </div>
  );
}

export function ChatCopy({
  text,
  agentId,
  streaming,
  onOpen,
}: {
  text: string;
  agentId: string;
  streaming?: boolean;
  onOpen: (src: string, alt?: string) => void;
}) {
  const ctx = { agentId, onOpen };
  const blocks = parseMarkdown(text);
  return (
    <div className="chat-copy">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        if (block.type === "heading") {
          const Tag = (block.level <= 2 ? "h3" : "h4") as "h3" | "h4";
          return (
            <Tag key={key} className={`chat-h chat-h${Math.min(block.level, 4)}`}>
              {renderInline(block.text, ctx, key)}
            </Tag>
          );
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={key}>
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx}>{renderInline(item, ctx, `${key}-${itemIdx}`)}</li>
              ))}
            </List>
          );
        }
        if (block.type === "table") {
          return <TableView key={key} headers={block.headers} rows={block.rows} ctx={ctx} k={key} />;
        }
        if (block.type === "code") {
          if (/^(html|report)$/i.test(block.lang.trim())) {
            return <HtmlReportFrame key={key} k={key} html={block.text} />;
          }
          return (
            <pre key={key} className="chat-pre">
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === "hr") return <hr key={key} />;
        return <p key={key}>{renderInline(block.text, ctx, key)}</p>;
      })}
      {streaming && <span className="cursor" />}
    </div>
  );
}
