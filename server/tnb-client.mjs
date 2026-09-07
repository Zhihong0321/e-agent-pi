// Reverse-engineered myTNB API client — ESM port of E:\000\mytnb-api\lib\tnb-client.js.
// Protocol details: see that repo's docs/API-REFERENCE.md. Kept behaviorally
// identical; only the module system changed (require -> import).
//
// Makes no network calls on construction — nothing runs until login() is called.
import { writeFileSync } from "node:fs";

const LOGIN_URL = "https://www.mytnb.com.my/api/sitecore/Account/Login";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

class CookieJar {
  constructor() {
    this.jar = new Map(); // host -> Map(name -> value)
  }

  setFromResponse(host, response) {
    const setCookies =
      typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (setCookies.length === 0) return;
    if (!this.jar.has(host)) this.jar.set(host, new Map());
    const hostJar = this.jar.get(host);
    for (const sc of setCookies) {
      const pair = sc.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      hostJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  header(host) {
    const hostJar = this.jar.get(host);
    if (!hostJar || hostJar.size === 0) return undefined;
    return [...hostJar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Finds the first <form>...</form> in an HTML page and extracts its action +
// all named <input> fields. Used to forward TNB's SSO auto-submit form without
// hardcoding field names (they're server-generated and may change).
function parseAutoSubmitForm(html) {
  const formMatch = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;
  const [, action, body] = formMatch;
  const fields = {};
  const inputRe = /<input[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(body))) {
    const tag = m[0];
    const nameMatch = tag.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;
    const valueMatch = tag.match(/value="([^"]*)"/i);
    fields[nameMatch[1]] = valueMatch ? decodeHtmlEntities(valueMatch[1]) : "";
  }
  return { action, fields };
}

export class TnbClient {
  constructor() {
    this.jar = new CookieJar();
    this.loggedIn = false;
    this.trace = [];
  }

  async _request(url, opts = {}, redirectCount = 0) {
    if (redirectCount > 10) throw new Error("Too many redirects");
    const u = new URL(url);
    const headers = { "User-Agent": DEFAULT_UA, ...(opts.headers || {}) };
    const cookieHeader = this.jar.header(u.host);
    if (cookieHeader) headers["Cookie"] = cookieHeader;

    const res = await fetch(u.toString(), {
      method: opts.method || "GET",
      headers,
      body: opts.body,
      redirect: "manual",
    });
    const setCookieNames =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie().map((sc) => sc.split(";")[0].split("=")[0])
        : [];
    this.jar.setFromResponse(u.host, res);

    if ([301, 302, 303, 307, 308].includes(res.status) && opts.followRedirects !== false) {
      const location = res.headers.get("location");
      if (location) {
        const nextUrl = new URL(location, u).toString();
        const currentMethod = opts.method || "GET";
        // Match real browser / fetch-spec behavior: a POST redirected via 301/302/303
        // is refetched as a GET (with no body). Only 307/308 preserve method+body.
        const nextMethod = (res.status === 303 || currentMethod === "POST") && res.status !== 307 && res.status !== 308
          ? "GET"
          : currentMethod;
        this.trace.push({
          method: opts.method || "GET",
          url: u.toString(),
          status: res.status,
          cookieNamesSent: cookieHeader ? cookieHeader.split("; ").map((c) => c.split("=")[0]) : [],
          setCookieNames,
          redirectedTo: location,
        });
        return this._request(
          nextUrl,
          { ...opts, method: nextMethod, body: nextMethod === "GET" ? undefined : opts.body },
          redirectCount + 1
        );
      }
    }

    if (opts.responseType === "buffer") {
      const buffer = Buffer.from(await res.arrayBuffer());
      this.trace.push({
        method: opts.method || "GET",
        url: u.toString(),
        status: res.status,
        cookieNamesSent: cookieHeader ? cookieHeader.split("; ").map((c) => c.split("=")[0]) : [],
        setCookieNames,
        bodyLength: buffer.length,
        bodySnippet: "(binary)",
      });
      return { status: res.status, url: u.toString(), headers: res.headers, buffer };
    }

    const text = await res.text();
    this.trace.push({
      method: opts.method || "GET",
      url: u.toString(),
      status: res.status,
      cookieNamesSent: cookieHeader ? cookieHeader.split("; ").map((c) => c.split("=")[0]) : [],
      setCookieNames,
      bodyLength: text.length,
      bodySnippet: text.slice(0, 800),
    });
    return { status: res.status, url: u.toString(), headers: res.headers, text };
  }

  dumpTrace(filePath) {
    writeFileSync(filePath, JSON.stringify(this.trace, null, 2));
  }

  // Logs in via the 2-step SSO handoff. Throws if credentials are rejected or
  // the page structure has changed in a way we can't parse.
  async login(email, password) {
    const step1 = await this._request(LOGIN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ Email: email, Password: password }).toString(),
    });

    const form = parseAutoSubmitForm(step1.text);
    if (!form) {
      if (step1.url.includes("myaccount.mytnb.com.my")) {
        this.loggedIn = true;
        return { ok: true, finalUrl: step1.url };
      }
      throw new Error(
        "Login failed: no SSO form found in response (wrong credentials, or page structure changed). " +
          `Status ${step1.status}, first 500 chars:\n` +
          step1.text.slice(0, 500)
      );
    }

    const actionUrl = new URL(form.action, step1.url).toString();
    await this._request(actionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form.fields).toString(),
    });

    // The SSO handler's own response is itself a JS interstitial ("Signing In...") that, on
    // success, does `window.location.href = "/AccountManagement/IndividualDashboard"`
    // after a delay. The cookie is already set by the SSO handoff, but server-side session
    // state appears to only fully initialize once that navigation actually
    // happens, so replicate it explicitly rather than trusting the cookie alone.
    const step3 = await this._request("https://myaccount.mytnb.com.my/AccountManagement/IndividualDashboard");

    this.loggedIn =
      step3.url.includes("myaccount.mytnb.com.my") && step3.status < 400 && !/id="frm-login"/.test(step3.text);
    return { ok: this.loggedIn, finalUrl: step3.url, status: step3.status };
  }

  async getOwnedAccounts() {
    const res = await this._request(
      `https://myaccount.mytnb.com.my/AccountManagement/OwnedAccount/GetOwnedAccount?page=1&limit=20&_=${Date.now()}`,
      { headers: { "X-Requested-With": "XMLHttpRequest" } }
    );
    return JSON.parse(res.text);
  }

  async getDashboardHtml() {
    const res = await this._request("https://myaccount.mytnb.com.my/AccountManagement/IndividualDashboard");
    return res.text;
  }

  // Extracts the embedded billing-history array from a dashboard HTML page
  // (date, kWh consumed, amount, and the encrypted token needed for the PDF).
  parseBillHistory(dashboardHtml) {
    const m = dashboardHtml.match(/consumptionTrendingData\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) return [];
    return JSON.parse(m[1]);
  }

  // Convenience: owned-account summaries (incl. outstanding TotalPayable) +
  // full bill history in one call.
  async checkBill() {
    const [owned, dashboardHtml] = await Promise.all([this.getOwnedAccounts(), this.getDashboardHtml()]);
    return { accounts: owned.records, billHistory: this.parseBillHistory(dashboardHtml) };
  }

  // InitProtectID returns its token as a JSON string ("base64...="), not raw
  // text — JSON.parse it, don't just trim(), or the literal quote characters
  // end up baked into the URL and PrintPDF2 rejects it.
  async _getBillPdfToken(billingNoEnc) {
    const res = await this._request("https://myaccount.mytnb.com.my/AccountManagement/ViewAccountProfile/InitProtectID", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body: new URLSearchParams({ selectedAccountID: `${billingNoEnc},False` }).toString(),
    });
    try {
      return JSON.parse(res.text);
    } catch {
      return res.text.trim();
    }
  }

  async getBillPdfUrl(billingNoEnc) {
    const token = await this._getBillPdfToken(billingNoEnc);
    return `https://myaccount.mytnb.com.my/AccountManagement/ViewAccountProfile/PrintPDF2?billingNo=${encodeURIComponent(token)}`;
  }

  // Downloads the bill PDF bytes through this client's own session (the URL
  // is session-bound, so it can't be opened in a plain browser/curl without
  // the same cookies). Returns the raw PDF buffer; pass outputPath to also
  // write it to disk.
  async downloadBillPdf(billingNoEnc, outputPath) {
    const pdfUrl = await this.getBillPdfUrl(billingNoEnc);
    const res = await this._request(pdfUrl, { responseType: "buffer" });
    const contentType = res.headers.get("content-type") || "";
    const looksLikePdf = res.buffer.length >= 4 && res.buffer.subarray(0, 4).toString("latin1") === "%PDF";
    if (!looksLikePdf) {
      throw new Error(
        `PrintPDF2 did not return a PDF (content-type: ${contentType}, ${res.buffer.length} bytes). ` +
          `First 300 bytes: ${res.buffer.subarray(0, 300).toString("utf8")}`
      );
    }
    if (outputPath) {
      writeFileSync(outputPath, res.buffer);
    }
    return { buffer: res.buffer, contentType, url: pdfUrl, path: outputPath };
  }

  // 5-step wizard to attach a TNB account number to this user.
  async addAccount({ accountNo, description, isOwner = false, rocNo = "" }) {
    await this._request("https://myaccount.mytnb.com.my/AccountManagement/AddNewAccount");

    // SubmitType 302-redirects to AddDetail; _request auto-follows POST->GET on
    // 302 (matching browser behavior), so this already returns the AddDetail page.
    const addDetail = await this._request("https://myaccount.mytnb.com.my/AccountManagement/AddNewAccount/SubmitType", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ RadioInputName: isOwner ? "Owner" : "Non-Owner", txtROCNo: rocNo }).toString(),
    });
    const tokenMatch = addDetail.text.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/);
    if (!tokenMatch) throw new Error("Could not find __RequestVerificationToken on AddDetail page — session may be invalid.");
    const csrfToken = tokenMatch[1];

    const validate = await this._request(
      "https://myaccount.mytnb.com.my/AccountManagement/AddNewAccount/CreateNewAccount",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: new URLSearchParams({
          "account[AccountType]": "1",
          "account[AccountDescription]": description,
          "account[AccountNo]": accountNo,
          "account[IsOwnedAccount]": isOwner ? "True" : "False",
        }).toString(),
      }
    );
    const validateJson = JSON.parse(validate.text);
    if (validateJson.Error) throw new Error(`Account validation failed: ${validateJson.ErrorMessage}`);

    await this._request("https://myaccount.mytnb.com.my/AccountManagement/AddNewAccount/SubmitDetail", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        IsOwnedAccount: isOwner ? "True" : "False",
        AccountTypeID: "1",
        ParentView: "",
        accountNoPerson: accountNo,
        favNamePerson: description,
        __RequestVerificationToken: csrfToken,
      }).toString(),
    });

    const finalize = await this._request(
      "https://myaccount.mytnb.com.my/AccountManagement/AddNewAccount/ProceedCreateMultipleAccount",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: new URLSearchParams({
          JsonString: JSON.stringify({ OwnerContact: [{ AccountNo: accountNo, AccountDesc: description }] }),
        }).toString(),
      }
    );

    return { ok: finalize.status < 400, consentMessage: validateJson.ErrorMessage };
  }
}
