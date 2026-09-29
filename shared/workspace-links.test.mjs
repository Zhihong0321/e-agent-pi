import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceArtifact, workspaceFileUrl, qualifyWorkspaceLinks } from "./workspace-links.mjs";

const base = "https://e-agent.up.railway.app";

test("a PDF URL keeps the producing workspace through Orchestrator and chat", () => {
  const pdf = workspaceArtifact("di-documents", "documents/INV-2026-0001.pdf", "Invoice", base);
  const reply = qualifyWorkspaceLinks("di-documents", pdf.link, base);
  assert.equal(reply, pdf.link);
  assert.equal(workspaceFileUrl("orchestrator", pdf.url), pdf.url);
  const url = new URL(pdf.url);
  assert.equal(url.searchParams.get("agent"), "di-documents");
  assert.equal(url.searchParams.get("path"), pdf.path);
});

test("same-origin file URLs are not nested or reassigned by chat", () => {
  const pdf = workspaceArtifact("di-documents", "documents/INV-2026-0001.pdf", "Invoice");
  assert.equal(workspaceFileUrl("orchestrator", pdf.url), pdf.url);
});

test("bare server file paths from old invoice lookups become browser URLs", () => {
  const raw = "file:///storage/workspaces/di-documents/documents/INV-2026-0001.pdf?agent=di-documents";
  const expected = workspaceArtifact("di-documents", "documents/INV-2026-0001.pdf", "", base).url;
  assert.equal(qualifyWorkspaceLinks("di-documents", raw, base), expected);
  assert.equal(qualifyWorkspaceLinks("di-documents", `[Invoice](${raw})`, base), `[Invoice](${expected})`);
});

test("old relative specialist PDFs and images become owned links before relay", () => {
  const text = "[Invoice](documents/INV-2026-0001.pdf) ![Preview](previews/chart.png)";
  const result = qualifyWorkspaceLinks("di-documents", text, base);
  assert.match(result, /agent=di-documents/);
  assert.equal(result, `${workspaceArtifact("di-documents", "documents/INV-2026-0001.pdf", "Invoice", base).link} !${workspaceArtifact("di-documents", "previews/chart.png", "Preview", base).link}`);
});

test("public pages, external links, fragments and fenced examples stay unchanged", () => {
  const text = "[Profile](/company-profile/) [Web](https://example.com/storage/workspaces/demo/file.pdf) https://example.com/storage/workspaces/demo/file.pdf [Public](/forms/example.html) [Section](#intro)\n```md\n[Example](documents/test.pdf)\n```";
  assert.equal(qualifyWorkspaceLinks("di-documents", text, base), text);
});

test("file URLs encode special path characters and keep existing workspace normalization", () => {
  const artifact = workspaceArtifact("di-forms", "previews/客户 & coffee.html", "Form", base);
  const url = new URL(artifact.url);
  assert.equal(url.searchParams.get("path"), artifact.path);
  assert.equal(url.searchParams.get("agent"), "di-forms");
  assert.equal(workspaceFileUrl("di-documents", "/storage/workspaces/di-documents/documents/invoice.pdf"), workspaceFileUrl("di-documents", "documents/invoice.pdf"));
});
