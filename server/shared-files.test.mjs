import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { publishFile, readSharedFile } from "./shared-files.mjs";
import { fileSharingEnv, handleFileSharing } from "./file-sharing.mjs";
import { applyPiEvent, createTurn, parseTranscript, serializeTurn } from "./pi-stream.mjs";
import { filesFromBlocks, sharedFilesFromResult } from "../shared/shared-files.mjs";
import { buildPiArgs, buildRoleText } from "./runtime.mjs";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shared-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "files");
  const workspace = path.join(dir, "agent-a");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "invoice.pdf"), "%PDF-1.7\noriginal invoice");
  return { dir, root, workspace, companyId: "company-a", source: "invoice.pdf", publicUrl: "https://example.com" };
}

test("published snapshots survive source replacement/removal and retain stable links", async (t) => {
  const opts = await setup(t);
  const original = await publishFile(opts);
  const repeated = await publishFile(opts);
  assert.deepEqual(original, repeated);
  await writeFile(path.join(opts.workspace, opts.source), "%PDF-1.7\nnew invoice");
  const next = await publishFile(opts);
  assert.notEqual(next.id, original.id);
  await unlink(path.join(opts.workspace, opts.source));
  // A fresh reader has no session, agent, cache or process-local registry.
  const stored = await readSharedFile({ root: opts.root, companyId: opts.companyId, id: original.id, name: original.name });
  assert.equal(await readFile(stored.full, "utf8"), "%PDF-1.7\noriginal invoice");
  assert.equal(new URL(original.url).search, "");
  assert.deepEqual(filesFromBlocks([{ shared_files: [original] }]), [{ id: original.id, name: original.name, bytes: original.bytes, url: new URL(original.url).pathname }]);
});

test("publishing is confined to the caller workspace and downloads to the company", async (t) => {
  const opts = await setup(t);
  const file = await publishFile(opts);
  await assert.rejects(readSharedFile({ ...opts, companyId: "company-b", id: file.id, name: file.name }), { code: "ENOENT" });
  await assert.rejects(publishFile({ ...opts, source: "../outside.pdf" }), /inside the agent workspace/);
  await assert.rejects(publishFile({ ...opts, source: ".git/config" }), /inside the agent workspace/);
  await writeFile(path.join(opts.workspace, "empty.txt"), "");
  await assert.rejects(publishFile({ ...opts, source: "empty.txt" }), /empty file/);
  const outside = path.join(opts.dir, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "private");
  await symlink(outside, path.join(opts.workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(publishFile({ ...opts, source: "escape/secret.txt" }), /inside the agent workspace/);
});

test("share_file authenticates the agent; download authenticates owner and company", async (t) => {
  const opts = await setup(t);
  let companyId = opts.companyId;
  const server = createServer(async (req, res) => {
    await handleFileSharing(req, res, new URL(req.url, "http://local"), {
      ...opts,
      companyId: () => companyId,
      workspaceFor: async (id) => id === "agent-a" ? opts.workspace : null,
      authorized: (request) => request.headers.cookie === "owner=yes",
      readBody: async (request) => { let body = ""; for await (const chunk of request) body += chunk; return body; },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = fileSharingEnv("agent-a");
  const share = (agent) => fetch(`${base}/api/internal/files/share`, {
    method: "POST", headers: { Authorization: `Bearer ${env.FILE_SHARE_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agent, path: "invoice.pdf", companyId: "company-b" }),
  });
  assert.equal((await share("agent-b")).status, 401);
  const originalEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env, { FILE_SHARE_URL: base });
  let toolResult;
  try {
    const extensions = await loadExtensions([path.resolve("agent/extensions/share-file.ts")], process.cwd());
    assert.deepEqual(extensions.errors, []);
    const tool = extensions.extensions[0].tools.get("share_file").definition;
    toolResult = await tool.execute("test-share", { path: "invoice.pdf" }, new AbortController().signal);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(sharedFilesFromResult(toolResult).length, 1);
  const response = await share("agent-a");
  assert.equal(response.status, 200);
  const file = (await response.json()).shared_files[0];
  const fileUrl = base + new URL(file.url).pathname;
  assert.equal((await fetch(fileUrl)).status, 401);
  const download = await fetch(fileUrl, { headers: { Cookie: "owner=yes" } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "application/pdf");
  assert.equal(await download.text(), "%PDF-1.7\noriginal invoice");
  assert.match(download.headers.get("content-disposition"), /^inline/);
  assert.equal((await fetch(fileUrl, { method: "HEAD", headers: { Cookie: "owner=yes" } })).status, 200);
  await writeFile(path.join(opts.workspace, "preview.html"), "<h1>Preview</h1>");
  const html = await publishFile({ ...opts, source: "preview.html" });
  const htmlDownload = await fetch(base + new URL(html.url).pathname, { headers: { Cookie: "owner=yes" } });
  assert.match(htmlDownload.headers.get("content-disposition"), /^attachment/);
  companyId = "company-b";
  assert.equal((await fetch(fileUrl, { headers: { Cookie: "owner=yes" } })).status, 404);
});

test("attachments cross MCP and Orchestrator envelopes and persist outside clipped tool text", async (t) => {
  const file = await publishFile(await setup(t));
  const envelope = { content: [{ type: "text", text: JSON.stringify({ task: { result: "x".repeat(9000), shared_files: [file] } }) }] };
  const turn = createTurn();
  const event = applyPiEvent(turn, { type: "tool_execution_end", toolCallId: "dispatch", toolName: "mcp", result: envelope });
  assert.equal(event.shared_files.length, 1);
  assert.equal(turn.blocks[0].shared_files[0].id, file.id);
  assert.ok(turn.blocks[0].result.length < 9000);
  const restored = parseTranscript(serializeTurn(turn));
  assert.deepEqual(filesFromBlocks(restored.blocks), event.shared_files);
  assert.equal(sharedFilesFromResult({ shared_files: [{ ...file, url: "https://bad.example/elsewhere" }] }).length, 0);
  assert.equal(sharedFilesFromResult({ shared_files: [{ ...file, url: `https://bad.example/files/${file.id}/${file.name}` }] })[0].url, new URL(file.url).pathname);
});

test("every Pi tool profile receives share_file and the shared-file rules", async () => {
  for (const toolProfile of ["coding", "ops", "assistant"]) {
    const args = buildPiArgs({ agent: { name: "Test" }, runtimeDir: "/runtime", provider: "test", model: "test", toolProfile });
    assert.ok(args.some((arg) => arg.endsWith(path.join("extensions", "share-file.ts"))));
  }
  const role = await buildRoleText({ id: "orchestrator", rolePrompt: "Test", skills: [] });
  assert.match(role, /Old file:\/\//);
  assert.match(role, /call share_file/);
});
