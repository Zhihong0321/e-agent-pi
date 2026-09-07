#!/usr/bin/env node
// One-shot installed-app OAuth flow for the Google Ads API.
//
//   node scripts/google-ads-oauth.mjs
//
// Opens your browser, you approve, and it prints a refresh_token. Then it calls
// the API with that token straight away, so the developer token's real access
// level is a fact on screen rather than a guess.
//
// Credentials are read from the vault entry GOOGLE_ADS_OAUTH_CLIENT, so no
// secret is written into this repo. Override with GOOGLE_ADS_CLIENT_ID /
// GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_DEVELOPER_TOKEN to use env instead.
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const VAULT_PATH = process.env.VAULT_PATH || "D:/Tools/my-vault/vault.json";
const VAULT_ENTRY = "GOOGLE_ADS_OAUTH_CLIENT";
const SCOPE = "https://www.googleapis.com/auth/adwords";
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || "v25";
const TIMEOUT_MS = 5 * 60 * 1000;

const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || "464-254-9168").replace(/-/g, "");
const LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");

/** Finds a named row in the vault without assuming which key holds the array. */
function findVaultRow(vault, name) {
  const pools = Array.isArray(vault) ? [vault] : Object.values(vault).filter(Array.isArray);
  for (const pool of pools) {
    const row = pool.find((item) => item && item.name === name);
    if (row) return row;
  }
  return null;
}

async function loadCredentials() {
  let clientId = process.env.GOOGLE_ADS_CLIENT_ID || "";
  let clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET || "";
  let developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";

  if (!clientId || !clientSecret || !developerToken) {
    const raw = await readFile(VAULT_PATH, "utf8").catch(() => null);
    if (!raw) {
      throw new Error(`cannot read the vault at ${VAULT_PATH} — set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET instead`);
    }
    const row = findVaultRow(JSON.parse(raw), VAULT_ENTRY);
    if (!row) throw new Error(`the vault has no entry named ${VAULT_ENTRY}`);
    // baseUrl holds the client_id and secret holds the client_secret, per the entry's own remarks.
    clientId ||= String(row.baseUrl || "").trim();
    clientSecret ||= String(row.secret || "").trim();
    developerToken ||= (String(row.remarks || "").match(/Developer token[^:]*:\s*([A-Za-z0-9_-]+)/) || [])[1] || "";
  }

  if (!clientId || !clientSecret) throw new Error("client_id or client_secret is missing");
  return { clientId, clientSecret, developerToken };
}

function openBrowser(url) {
  try {
    if (process.platform === "win32") {
      // Not `cmd /c start` — cmd treats the & between query parameters as a
      // command separator and truncates the URL. rundll32 takes it verbatim.
      spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // The URL is printed too, so a failure to launch is not fatal.
  }
}

const page = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;padding:3rem;max-width:34rem;margin:auto">` +
  `<h2>${title}</h2><p>${body}</p></body>`;

/** Serves the loopback redirect; resolves with the auth code and the exact redirect_uri used. */
function awaitAuthCode({ clientId, challenge, state }) {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    let settled = false;

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");

      if (error || !code) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(page("Authorisation failed", `Google returned <code>${error || "no code"}</code>. Back to the terminal.`));
        finish(new Error(`authorisation failed: ${error || "no code returned"}`));
      } else if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(page("State mismatch", "The state parameter did not match, so nothing was exchanged."));
        finish(new Error("state mismatch — aborted without exchanging the code"));
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page("Done", "Refresh token issued. Close this tab and return to the terminal."));
        finish(null, { code, redirectUri });
      }
    });

    const timer = setTimeout(() => finish(new Error("timed out after 5 minutes")), TIMEOUT_MS);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(() => server.close(), 250);
      if (err) reject(err);
      else resolve(value);
    }

    server.on("error", finish);
    server.listen(0, "127.0.0.1", () => {
      redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

      const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authUrl.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline", // ask for a refresh token
        prompt: "consent", // force a fresh one even if this app was approved before
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();

      console.log(`\nListening on ${redirectUri}`);
      console.log("Opening your browser. If nothing opens, paste this URL yourself:\n");
      console.log(`  ${authUrl}\n`);
      openBrowser(authUrl.toString());
    });
  });
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri, verifier }) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  if (!body.refresh_token) {
    throw new Error(
      "Google returned no refresh_token. Revoke this app at https://myaccount.google.com/permissions, then re-run.",
    );
  }
  return body;
}

/** Calls the API so the access level is observed rather than assumed. */
async function probe({ accessToken, developerToken }) {
  if (!developerToken) {
    console.log("\nNo developer token found, so skipping the API probe.");
    return;
  }
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "developer-token": developerToken,
    "content-type": "application/json",
  };
  if (LOGIN_CUSTOMER_ID) headers["login-customer-id"] = LOGIN_CUSTOMER_ID;

  console.log("\n--- API probe ---");

  const listRes = await fetch(`https://googleads.googleapis.com/${API_VERSION}/customers:listAccessibleCustomers`, {
    headers,
  });
  console.log(`listAccessibleCustomers -> ${listRes.status}`);
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

  if (searchRes.ok) {
    console.log("\nProduction access works — the token is at Explorer level or better. Phase 1 is unblocked.");
  } else if (/DEVELOPER_TOKEN_NOT_APPROVED/.test(searchBody)) {
    console.log("\nStill Test Account Access only. Production stays blocked until Explorer or Basic is granted.");
  } else if (/USER_PERMISSION_DENIED|CUSTOMER_NOT_FOUND/.test(searchBody)) {
    console.log(
      `\nThe account you signed in as cannot reach customer ${CUSTOMER_ID}, or the call needs a manager context.` +
        "\nRe-run with GOOGLE_ADS_LOGIN_CUSTOMER_ID=<your MCC id> if that account sits under a manager.",
    );
  }
}

async function main() {
  const { clientId, clientSecret, developerToken } = await loadCredentials();
  console.log(`client_id       ${clientId}`);
  console.log(`developer token ${developerToken ? `${developerToken.slice(0, 6)}...` : "(not found)"}`);
  console.log(`target customer ${CUSTOMER_ID}`);

  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  const { code, redirectUri } = await awaitAuthCode({ clientId, challenge, state });
  const tokens = await exchangeCode({ code, clientId, clientSecret, redirectUri, verifier });

  console.log("\n=== refresh_token ===");
  console.log(tokens.refresh_token);
  console.log("=====================");
  console.log(`\nGranted scope: ${tokens.scope}`);
  console.log("\nAdd it to the vault entry GOOGLE_ADS_OAUTH_CLIENT as its own field:");
  console.log(`  "refreshToken": "${tokens.refresh_token}"`);
  console.log(
    "\nIf the GCP consent screen is still in Testing mode, this token expires in 7 days." +
      "\nPublish the app (OAuth consent screen -> Publish app) to get one that does not.",
  );

  await probe({ accessToken: tokens.access_token, developerToken });
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
