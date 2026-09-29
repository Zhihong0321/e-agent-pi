// Runs one tool call for one micro-agent: authorise -> validate -> execute in a
// tenant-scoped di_app transaction -> (optionally) render a PDF after commit.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { withContext } from "./db.mjs";
import { DiError } from "./common.mjs";
import { AGENTS, TOOLS, allowed } from "./tools.mjs";
import { renderDocumentHtml, setPdfPath } from "./documents.mjs";

function formatZod(error) {
  return error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, "_");

/**
 * @param {{
 *   db: any,
 *   tenantId: () => Promise<string> | string,
 *   actor?: string,
 *   asRole?: boolean,
 *   workspace?: (agentId: string) => string,
 *   renderPdf?: (html: string, absPath: string) => Promise<void>,
 *   publicUrl?: string,   base for public form links (https://app.example.com)
 * }} deps
 * @param {{ agent: string, tool: string, args?: any }} call
 */
export async function runTool(deps, { agent, tool, args = {} }) {
  if (!AGENTS[agent]) throw new DiError(`Unknown agent ${agent}`);
  if (!TOOLS[tool]) throw new DiError(`Unknown tool ${tool}`);
  if (!allowed(agent, tool)) {
    const owners = TOOLS[tool].agents.map((a) => AGENTS[a].name).join(" or ");
    throw new DiError(`${AGENTS[agent].name} is not allowed to ${tool}; that is a job for ${owners}.`);
  }
  const spec = TOOLS[tool];
  const parsed = z.object(spec.input).safeParse(args ?? {});
  if (!parsed.success) throw new DiError(`Invalid input: ${formatZod(parsed.error)}`);

  const ctx = { tenantId: await deps.tenantId(), actor: deps.actor || "owner", agent, asRole: deps.asRole };
  let result = await withContext(deps.db, ctx, (tx) => spec.run(tx, parsed.data));

  if (spec.pdf) {
    const raw = spec.pdf(result);
    const target = typeof raw === "string" ? { id: raw } : raw;
    const { html, doc } = await withContext(deps.db, ctx, (tx) =>
      renderDocumentHtml(tx, { document: target.id, template_id: target.template_id }),
    );
    const file = `${safeName(doc.number || `DRAFT-${doc.doc_type}-${doc.id.slice(0, 8)}`)}${target.template_id ? "-alt" : ""}.pdf`;
    const rel = `documents/${file}`;
    if (deps.renderPdf && deps.workspace) {
      await deps.renderPdf(html, path.join(deps.workspace(agent), rel));
      if (doc.status !== "draft" && !target.template_id) {
        await withContext(deps.db, ctx, (tx) => setPdfPath(tx, doc.id, rel));
      }
      result = { ...result, pdf: { path: rel, link: `[${file}](${rel})` } };
    } else {
      result = { ...result, pdf: { skipped: "no PDF renderer on this host", html_chars: html.length } };
    }
  }

  if (spec.saveFile) {
    const { rest, path: rel, content } = spec.saveFile(result);
    const file = rel.split("/").pop();
    if (deps.workspace) {
      const abs = path.join(deps.workspace(agent), rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
      result = { ...rest, file: { path: rel, link: `[${file}](${rel})` } };
    } else {
      result = { ...rest, file: { skipped: "no workspace on this host", chars: content.length } };
    }
  }

  if (result?.public_path && deps.publicUrl) {
    result = { ...result, public_url: new URL(result.public_path, deps.publicUrl).toString() };
  }

  if (spec.previewPdf) {
    const { html, ...rest } = result;
    const rel = `previews/${rest.doc_type}-preview-${Date.now()}.pdf`;
    if (deps.renderPdf && deps.workspace) {
      await deps.renderPdf(html, path.join(deps.workspace(agent), rel));
      result = { ...rest, pdf: { path: rel, link: `[preview](${rel})` } };
    } else {
      result = { ...rest, pdf: { skipped: "no PDF renderer on this host", html_chars: html.length } };
    }
  }
  return result;
}

/** Error text an agent can act on; never leaks stack traces. */
export function describeError(error) {
  if (error instanceof DiError) return error.message;
  const msg = error?.message || String(error);
  if (/permission denied/i.test(msg)) return `Refused by the database: ${msg}. This action is not allowed for agents.`;
  if (/Hard delete is disabled/i.test(msg)) return msg;
  return msg.split("\n")[0].slice(0, 500);
}
