import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { createSourceStore } from "./temp-sources.mjs";
import { fetchWebSource, publicSourceUrl } from "./web-sources.mjs";

test("full source survives storage, focused reading and reuse without a second fetch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "web-sources-test-"));
  try {
    const store = createSourceStore(path.join(root, "temp"));
    const text = `Invoice\n${"Exact line item\n".repeat(1000)}Terms\nRoof Leaking Warranty\nFINAL TERM MUST SURVIVE`;
    let fetches = 0;
    const deps = { store, validate: async url => url, extract: async () => { fetches++; return { text, title: "Invoice", headings: ["Invoice", "Terms"] }; } };
    const first = await fetchWebSource({ url: "https://example.com/template" }, deps);
    assert.equal(first.storedInFull, true);
    assert.equal(first.chars, text.length);
    assert.equal((await store.read({ id: first.id, limit: 120000 })).text, text);
    assert.match((await store.read({ id: first.id, section: "Terms" })).text, /FINAL TERM MUST SURVIVE$/);
    assert.equal((await store.read({ id: first.id, limit: 100 })).hasMore, true);
    const second = await fetchWebSource({ url: "https://example.com/template" }, deps);
    assert.equal(second.id, first.id); assert.equal(second.reused, true); assert.equal(fetches, 1);
    await store.remove([first.id]);
    const afterCleanup = await fetchWebSource({ url: "https://example.com/template" }, deps);
    assert.notEqual(afterCleanup.id, first.id); assert.equal(fetches, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("temporary cleanup cannot delete workspace files or follow a source symlink", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "source-cleanup-test-"));
  try {
    const store = createSourceStore(path.join(root, "temp"));
    const workspace = path.join(root, "workspace");
    await mkdir(workspace); await writeFile(path.join(workspace, "keep.txt"), "saved document");
    const source = await store.save({ text: "temporary" });
    await assert.rejects(store.remove(["../workspace"]), /Invalid|valid source/);
    const linkedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await symlink(workspace, path.join(root, "temp", linkedId), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(store.remove([linkedId]), /Unsafe/);
    assert.equal((await store.remove([source.id])).removed, 1);
    assert.equal(await readFile(path.join(workspace, "keep.txt"), "utf8"), "saved document");
    await assert.rejects(store.read({ id: source.id }), /ENOENT/);
    assert.equal((await store.list()).sources.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("web source fetch rejects local addresses and embedded credentials", async () => {
  for (const url of ["http://127.0.0.1", "http://[::1]", "http://169.254.169.254", "http://[::ffff:7f00:1]", "file:///etc/passwd", "https://user:pass@example.com"]) await assert.rejects(publicSourceUrl(url));
  await assert.rejects(publicSourceUrl("https://internal.example", async () => [{ address: "10.0.0.1" }]));
  assert.equal(await publicSourceUrl("https://example.com/#heading", async () => [{ address: "93.184.216.34" }]), "https://example.com/");
});
