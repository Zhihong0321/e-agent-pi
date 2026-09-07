#!/usr/bin/env node
// Runs a GAQL query against the Google Ads API using the stored refresh token.
//
//   node scripts/google-ads-query.mjs <customer-id> "SELECT ... FROM ..."
//
// Client id/secret and the developer token come from the vault entry
// GOOGLE_ADS_OAUTH_CLIENT. The refresh token comes from GOOGLE_ADS_REFRESH_TOKEN
// or from the file named by GOOGLE_ADS_REFRESH_TOKEN_FILE.
//
// This is the throwaway ancestor of server/google-ads.mjs — same auth exchange,
// same call shape, just without the MCP wrapper.
import { readFile } from "node:fs/promises";

const VAULT_PATH = process.env.VAULT_PATH || "D:/Tools/my-vault/vault.json";
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v25";
const LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");

async function loadVaultRow() {
  const raw = await readFile(VAULT_PATH, "utf8");
  const vault = JSON.parse(raw);
  const pools = Array.isArray(vault) ? [vault] : Object.values(vault).filter(Array.isArray);
  for (const pool of pools) {
    const row = pool.find((item) => item && item.name === "GOOGLE_ADS_OAUTH_CLIENT");
    if (row) return row;
  }
  throw new Error("vault has no GOOGLE_ADS_OAUTH_CLIENT entry");
}

async function refreshToken(row) {
  if (process.env.GOOGLE_ADS_REFRESH_TOKEN) return process.env.GOOGLE_ADS_REFRESH_TOKEN.trim();
  if (row.refreshToken) return String(row.refreshToken).trim();
  const file = process.env.GOOGLE_ADS_REFRESH_TOKEN_FILE;
  if (file) return (await readFile(file, "utf8")).trim();
  throw new Error("no refresh token — set GOOGLE_ADS_REFRESH_TOKEN or GOOGLE_ADS_REFRESH_TOKEN_FILE");
}

async function accessToken() {
  const row = await loadVaultRow();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: String(row.baseUrl).trim(),
      client_secret: String(row.secret).trim(),
      refresh_token: await refreshToken(row),
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`refresh failed (${res.status}): ${JSON.stringify(body)}`);
  const devToken =
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN ||
    (String(row.remarks || "").match(/Developer token[^:]*:\s*([A-Za-z0-9_-]+)/) || [])[1] ||
    "";
  return { token: body.access_token, devToken };
}

async function main() {
  const customerId = String(process.argv[2] || "").replace(/-/g, "");
  const query = process.argv[3];
  if (!customerId || (customerId !== "list" && !query)) {
    console.error('usage: node scripts/google-ads-query.mjs <customer-id> "SELECT ... FROM ..."');
    console.error("       node scripts/google-ads-query.mjs list");
    process.exitCode = 1;
    return;
  }

  const { token, devToken } = await accessToken();
  const headers = {
    authorization: `Bearer ${token}`,
    "developer-token": devToken,
    "content-type": "application/json",
  };
  if (LOGIN_CUSTOMER_ID) headers["login-customer-id"] = LOGIN_CUSTOMER_ID;

  if (customerId === "list") {
    const res = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers:listAccessibleCustomers`, {
      headers,
    });
    console.log(`HTTP ${res.status}`);
    console.log(await res.text());
    if (!res.ok) process.exitCode = 1;
    return;
  }

  const res = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
