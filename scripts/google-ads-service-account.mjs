#!/usr/bin/env node
// Tests a service-account + domain-wide-delegation path into the Google Ads API.
//
//   node scripts/google-ads-service-account.mjs [path-to-key.json]
//
// No browser, no consent screen, no refresh token. The service account signs a
// JWT asserting "let me act as <user>", Google returns an access token, and we
// call the Ads API with it.
//
// Env overrides:
//   GOOGLE_ADS_KEY_FILE          path to the service account JSON
//   GOOGLE_ADS_IMPERSONATE       Workspace user to act as (must have Ads access)
//   GOOGLE_ADS_DEVELOPER_TOKEN   defaults to the one in the vault
//   GOOGLE_ADS_CUSTOMER_ID       defaults to 464-254-9168
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID manager account id, if the target sits under one
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

const KEY_FILE =
  process.argv[2] ||
  process.env.GOOGLE_ADS_KEY_FILE ||
  "C:/Users/Eternalgy/Downloads/seventh-server-507907-p0-a9bbf6b51bef.json";
const IMPERSONATE = process.env.GOOGLE_ADS_IMPERSONATE || "nurul@eternalgy.me";
const VAULT_PATH = process.env.VAULT_PATH || "D:/Tools/my-vault/vault.json";
const SCOPE = "https://www.googleapis.com/auth/adwords";
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v25";
const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || "464-254-9168").replace(/-/g, "");
const LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");

const b64url = (input) => Buffer.from(input).toString("base64url");

async function developerToken() {
  if (process.env.GOOGLE_ADS_DEVELOPER_TOKEN) return process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const raw = await readFile(VAULT_PATH, "utf8").catch(() => null);
  if (!raw) return "";
  const vault = JSON.parse(raw);
  const pools = Array.isArray(vault) ? [vault] : Object.values(vault).filter(Array.isArray);
  for (const pool of pools) {
    const row = pool.find((item) => item && item.name === "GOOGLE_ADS_OAUTH_CLIENT");
    if (row) return (String(row.remarks || "").match(/Developer token[^:]*:\s*([A-Za-z0-9_-]+)/) || [])[1] || "";
  }
  return "";
}

/** Builds and signs the JWT that asserts "act as IMPERSONATE with SCOPE". */
function signAssertion(key) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      sub: IMPERSONATE, // the delegation: act as this Workspace user
      scope: SCOPE,
      aud: key.token_uri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = crypto.sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), key.private_key).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

async function fetchAccessToken(key) {
  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signAssertion(key),
    }),
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = `${body.error || res.status}: ${body.error_description || "no detail"}`;
    if (body.error === "unauthorized_client") {
      throw new Error(
        `${err}\n\nDomain-wide delegation is not authorised yet. In admin.google.com go to\n` +
          "  Security -> Access and data control -> API controls -> Domain-wide delegation -> Add new\n" +
          `  Client ID: ${key.client_id}\n` +
          `  Scope:     ${SCOPE}\n` +
          "Then wait a minute or two for it to propagate and re-run.",
      );
    }
    if (body.error === "invalid_grant") {
      throw new Error(
        `${err}\n\nDelegation is probably authorised, but "${IMPERSONATE}" could not be impersonated.\n` +
          "That user must exist in the Workspace domain. Try GOOGLE_ADS_IMPERSONATE=<another @eternalgy.me user>.",
      );
    }
    throw new Error(err);
  }
  return body.access_token;
}

async function probe(accessToken, devToken) {
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "developer-token": devToken,
    "content-type": "application/json",
  };
  if (LOGIN_CUSTOMER_ID) headers["login-customer-id"] = LOGIN_CUSTOMER_ID;

  const listRes = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers:listAccessibleCustomers`, {
    headers,
  });
  console.log(`\nlistAccessibleCustomers -> ${listRes.status}`);
  console.log((await listRes.text()).slice(0, 800));

  const searchRes = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${CUSTOMER_ID}/googleAds:search`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query:
          "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.test_account FROM customer LIMIT 1",
      }),
    },
  );
  const searchBody = await searchRes.text();
  console.log(`\ncustomers/${CUSTOMER_ID} search -> ${searchRes.status}`);
  console.log(searchBody.slice(0, 1200));

  console.log("\n--- verdict ---");
  if (searchRes.ok) {
    console.log("Working end to end. Production access confirmed, no browser needed, nothing expires.");
  } else if (/DEVELOPER_TOKEN_NOT_APPROVED/.test(searchBody)) {
    console.log("Auth works. The developer token is still Test Account Access only, so production is blocked.");
  } else if (/USER_PERMISSION_DENIED|CUSTOMER_NOT_FOUND/.test(searchBody)) {
    console.log(
      `Auth works, but ${IMPERSONATE} cannot reach customer ${CUSTOMER_ID}.\n` +
        "Give that user access in Google Ads, or set GOOGLE_ADS_LOGIN_CUSTOMER_ID if it sits under a manager.",
    );
  } else {
    console.log("Auth works; the Ads call failed for the reason above.");
  }
}

async function main() {
  const key = JSON.parse(await readFile(KEY_FILE, "utf8"));
  const devToken = await developerToken();

  console.log(`key file        ${KEY_FILE}`);
  console.log(`service account ${key.client_email}`);
  console.log(`client id       ${key.client_id}`);
  console.log(`impersonating   ${IMPERSONATE}`);
  console.log(`developer token ${devToken ? `${devToken.slice(0, 6)}...` : "(not found)"}`);
  console.log(`target customer ${CUSTOMER_ID}`);

  const accessToken = await fetchAccessToken(key);
  console.log("\nAccess token obtained — domain-wide delegation is working.");

  if (!devToken) {
    console.log("No developer token, so stopping before the Ads call.");
    return;
  }
  await probe(accessToken, devToken);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  // exitCode rather than exit() — an abrupt exit trips a libuv assertion on Windows.
  process.exitCode = 1;
});
