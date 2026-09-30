import assert from "node:assert/strict";
import { test } from "node:test";
import {
  googleSignedInFromCookies,
  originSignedInFromCookies,
  ensureSession,
  RESERVED_PROFILE_SLUGS,
} from "./browser-session.mjs";

test("googleSignedInFromCookies requires a SID-family cookie on google.com", () => {
  assert.equal(googleSignedInFromCookies([]), false);
  assert.equal(googleSignedInFromCookies([{ name: "NID", domain: ".google.com" }]), false);
  assert.equal(googleSignedInFromCookies([{ name: "SID", domain: ".google.com" }]), true);
  assert.equal(googleSignedInFromCookies([{ name: "__Secure-1PSID", domain: ".google.com" }]), true);
  assert.equal(googleSignedInFromCookies([{ name: "SID", domain: "example.com" }]), false);
});

test("originSignedInFromCookies routes google hosts to the google probe", () => {
  const cookies = [{ name: "SID", domain: ".google.com" }];
  assert.equal(originSignedInFromCookies(cookies, "https://accounts.google.com"), true);
  assert.equal(originSignedInFromCookies(cookies, "https://mail.google.com"), true);
  assert.equal(originSignedInFromCookies([{ name: "session", domain: "merchant.example" }], "https://merchant.example"), true);
  assert.equal(originSignedInFromCookies([{ name: "session", domain: "other.example" }], "https://merchant.example"), false);
});

test("ensureSession refuses the reserved newpages profile", async () => {
  assert.equal(RESERVED_PROFILE_SLUGS.has("newpages"), true);
  await assert.rejects(() => ensureSession("newpages"), /reserved/);
});
