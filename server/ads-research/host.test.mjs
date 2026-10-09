import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdsResearchStore } from "./store.mjs";
import { defaultPortableRoot, normalizeAdsInput, adsResearchAction } from "./host.mjs";

test("uses the vendored portable runtime by default", () => {
  assert.equal(defaultPortableRoot(), path.join(process.cwd(), "server", "ads-research", "portable"));
});

test("normalizes country, keyword and deterministic topic", () => {
  const a = normalizeAdsInput({ country: "Malaysia", keyword: "solar panels" });
  const b = normalizeAdsInput({ country: "Malaysia", keyword: "solar panels" });
  assert.equal(a.region, "MY");
  assert.equal(a.country, "Malaysia");
  assert.equal(a.topic, b.topic);
  assert.match(a.topic, /^ads-malaysia-solar-panels-[a-f0-9]{12}$/);
});

test("rejects unsafe or unsupported inputs", () => {
  assert.throws(() => normalizeAdsInput({ country: "../../tmp", keyword: "solar" }), /country/);
  assert.throws(() => normalizeAdsInput({ country: "Malaysia", keyword: "" }), /keyword/);
  assert.throws(() => normalizeAdsInput({ country: "Atlantis", keyword: "solar" }), /two-letter/);
});

test("stores and returns a queued job", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ads-research-"));
  try {
    const store = new AdsResearchStore(root);
    const row = await adsResearchAction({ action: "start", country: "Singapore", keyword: "solar", companyId: "company-a" }, store);
    assert.equal(row.status, "queued");
    const fetched = await adsResearchAction({ action: "get", id: row.id, companyId: "company-a" }, store);
    assert.equal(fetched.id, row.id);
    assert.equal(fetched.report_url, null);
    // Another company neither sees the job nor reuses it, and gets its own output folder.
    await assert.rejects(adsResearchAction({ action: "get", id: row.id, companyId: "company-b" }, store), /not found/);
    await assert.rejects(adsResearchAction({ action: "get", id: row.id }, store), /Company tenant is required/);
    const theirs = await adsResearchAction({ action: "start", country: "Singapore", keyword: "solar", companyId: "company-b" }, store);
    assert.notEqual(theirs.id, row.id);
    assert.equal(theirs.cached, false);
    assert.notEqual(theirs.topic, row.topic);
    assert.equal((await adsResearchAction({ action: "start", country: "Singapore", keyword: "solar", companyId: "company-a" }, store)).id, row.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});
