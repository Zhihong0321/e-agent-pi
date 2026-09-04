/**
 * Classify a NEWPAGES merchant login attempt from page + API observations.
 * Never include the auth token in the returned message.
 */
export function parseNewpagesLoginApi(body) {
  if (!body || typeof body !== "object") {
    return { hasToken: false, otp: false, error: "", redirect: "" };
  }
  const data = body.data && typeof body.data === "object" ? body.data : {};
  const token = typeof data.token === "string" ? data.token : "";
  const otp = data.otp === "1" || data.otp === 1;
  const innerFail = data.error === 1 || data.error === "1";
  const outerFail = body.error !== undefined && String(body.error) !== "0";
  let error = "";
  if (innerFail) {
    error = String(data.error_message || (Array.isArray(data.data) ? data.data.join("; ") : "") || "login refused");
  } else if (outerFail && !token) {
    const detail = Array.isArray(body.data) ? body.data.join("; ") : body.errors || data.error_message || "";
    error = String(detail || "login refused").slice(0, 240);
  }
  return {
    hasToken: Boolean(token),
    otp,
    error: error.slice(0, 240),
    redirect: typeof data.redirect_url === "string" ? data.redirect_url : "",
  };
}

export function diagnoseNewpagesLogin(state) {
  const href = String(state?.href || "");
  const token = String(state?.token || "");
  const companyId = String(state?.companyId || "");
  if (token && companyId) return "";

  if (state?.otpToken || /\/otp\b/i.test(href) || state?.loginApi?.otp) {
    return "NEWPAGES asked for 2FA (OTP). Complete that once for this user, then tap Login now again.";
  }
  if (state?.loginApi?.error) {
    return `NEWPAGES rejected the login: ${state.loginApi.error}`;
  }
  if (state?.authError) {
    return `NEWPAGES rejected the login: ${String(state.authError).replace(/\s+/g, " ").trim().slice(0, 240)}`;
  }
  if (state?.invalidUser || state?.invalidPass) {
    return "The merchant form did not accept the username/password. Check Settings → Sites (the username is the merchant id, not a display name).";
  }
  if (state?.usernameEmpty) {
    return "The username field stayed empty after fill — the Vue login form did not take the saved credentials.";
  }
  if (!state?.loginApi) {
    return "Sign In never reached the NEWPAGES login API. The form may not have submitted (CAPTCHA or a page error).";
  }
  if (state?.loginApi?.hasToken && !companyId) {
    return "Login returned a token but company_id never landed in localStorage (common_settings did not finish).";
  }
  return `Login did not produce a localStorage token on merchant.newpages.com.my. Check username/password, or complete a CAPTCHA/2FA once.`;
}

/** Strip secrets from a site row. Token and password never leave this function. */
export function publicNewpagesSiteView(site) {
  if (!site) return null;
  const session = site.extra && typeof site.extra === "object" ? site.extra.session : null;
  return {
    slug: site.slug,
    username: site.username || "",
    passwordSet: Boolean(site.passwordSet || site.password),
    lastLoginAt: site.lastLoginAt || null,
    lastError: site.lastError || null,
    sessionSaved: Boolean(session?.token),
    companyName: session?.companyName || null,
  };
}
