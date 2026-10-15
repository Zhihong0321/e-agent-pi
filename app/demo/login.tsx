import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import "./login.css";

export type Credentials = { company: string; username: string; password: string };

const COMPANY_KEY = "demo-company-code";

function Glyph({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

const glyphs = {
  company: <><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 10h2a2 2 0 0 1 2 2v9M2 21h20"/><path d="M8 7h4M8 11h4M8 15h4"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M6 20v-1a6 6 0 0 1 12 0v1"/></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></>,
  eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
  eyeOff: <><path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.6A16.6 16.6 0 0 0 2 12s3.6 7 10 7a9.8 9.8 0 0 0 4.2-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></>,
  alert: <><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></>,
};

/** The sign-in screen. `onSignIn` does the request and throws a readable message on failure. */
export function LoginScreen({ onSignIn }: { onSignIn: (credentials: Credentials) => Promise<void> }) {
  const [company, setCompany] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const companyRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);

  // The company rarely changes on a given device: remember it and start on the username.
  useEffect(() => {
    const saved = window.localStorage.getItem(COMPANY_KEY) || "";
    setCompany(saved);
    (saved ? usernameRef : companyRef).current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      await onSignIn({ company: company.trim().toLowerCase(), username: username.trim(), password });
      window.localStorage.setItem(COMPANY_KEY, company.trim().toLowerCase());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed");
      setPassword("");
    } finally { setBusy(false); }
  };

  return (
    <main className="login-page">
      <aside className="login-brand" aria-hidden="true">
        <img src="/branding/e-logo.png" alt="" />
        <h2>Your company's AI workspace</h2>
        <p>Documents, expenses, procurement and research, handled by agents that work for your team.</p>
        <ul>
          <li>Each company has its own private workspace</li>
          <li>Agents act only as the person signed in</li>
          <li>Every change is recorded</li>
        </ul>
      </aside>
      <section className="login-panel">
        <form className="login-form" onSubmit={submit}>
          <img className="login-mark" src="/branding/e-logo.png" alt="" />
          <h1>Sign in</h1>
          <p className="login-lead">Use the company code, username and password you were given.</p>

          <label className="login-field">
            <span>Company code</span>
            <div className="login-input"><Glyph>{glyphs.company}</Glyph>
              <input ref={companyRef} name="company" required autoComplete="organization" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder="e.g. acme" value={company} onChange={(event) => setCompany(event.target.value)} /></div>
          </label>

          <label className="login-field">
            <span>Username</span>
            <div className="login-input"><Glyph>{glyphs.user}</Glyph>
              <input ref={usernameRef} name="username" required autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                value={username} onChange={(event) => setUsername(event.target.value)} /></div>
          </label>

          <label className="login-field">
            <span>Password</span>
            <div className="login-input"><Glyph>{glyphs.lock}</Glyph>
              <input name="password" required type={reveal ? "text" : "password"} autoComplete="current-password"
                value={password} onChange={(event) => setPassword(event.target.value)} />
              <button type="button" className="login-reveal" onClick={() => setReveal((value) => !value)}
                aria-label={reveal ? "Hide password" : "Show password"} aria-pressed={reveal}>
                <Glyph>{reveal ? glyphs.eyeOff : glyphs.eye}</Glyph></button></div>
          </label>

          <div className="login-error" role="alert" aria-live="assertive">
            {error && <><Glyph>{glyphs.alert}</Glyph><span>{error}</span></>}
          </div>

          <button className="login-submit" disabled={busy || !company.trim() || !username.trim() || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="login-help">Forgot your company code or password? Ask your company's Superadmin.</p>
        </form>
      </section>
    </main>
  );
}

/** Shown while the existing session is being checked, so the form doesn't flash for signed-in people. */
export function LoginChecking() {
  return <main className="login-page login-checking"><p role="status">Checking your session…</p></main>;
}
