import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnoseNewpagesLogin, parseNewpagesLoginApi, publicNewpagesSiteView } from "./newpages/login-diagnose.mjs";

test("parseNewpagesLoginApi reads success token without exposing it in error", () => {
  const parsed = parseNewpagesLoginApi({
    error: "0",
    data: { token: "abc".repeat(14), otp: "0", company_id: "26783" },
  });
  assert.equal(parsed.hasToken, true);
  assert.equal(parsed.otp, false);
  assert.equal(parsed.error, "");
});

test("parseNewpagesLoginApi reads inner error_message", () => {
  const parsed = parseNewpagesLoginApi({
    error: "0",
    data: { error: 1, error_message: "Invalid username or password" },
  });
  assert.equal(parsed.hasToken, false);
  assert.match(parsed.error, /Invalid username/);
});

test("diagnoseNewpagesLogin prefers OTP, then API error, then form validation", () => {
  assert.match(diagnoseNewpagesLogin({ href: "https://merchant.newpages.com.my/otp", otpToken: "x" }), /2FA/);
  assert.match(
    diagnoseNewpagesLogin({ loginApi: { error: "Invalid username or password" } }),
    /rejected the login: Invalid username/,
  );
  assert.match(diagnoseNewpagesLogin({ invalidUser: true }), /merchant id/);
  assert.match(diagnoseNewpagesLogin({}), /never reached/);
  assert.equal(diagnoseNewpagesLogin({ token: "t", companyId: "26783" }), "");
});

test("publicNewpagesSiteView never echoes password or token", () => {
  const view = publicNewpagesSiteView({
    slug: "newpages",
    username: "merchant",
    password: "secret-password",
    passwordSet: true,
    lastLoginAt: "2026-09-04T00:00:00.000Z",
    lastError: "nope",
    extra: { kind: "newpages", session: { token: "tok_secret", companyId: "26783", companyName: "Eternalgy Sdn Bhd" } },
  });
  const blob = JSON.stringify(view);
  assert.equal(view.passwordSet, true);
  assert.equal(view.sessionSaved, true);
  assert.equal(view.companyName, "Eternalgy Sdn Bhd");
  assert.equal(blob.includes("secret-password"), false);
  assert.equal(blob.includes("tok_secret"), false);
  assert.equal("password" in view, false);
  assert.equal("token" in view, false);
});
