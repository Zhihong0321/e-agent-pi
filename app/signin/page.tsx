import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

type Signin = {
  slug: string;
  name: string;
  kind: string;
  origin: string;
  loginUrl?: string;
  signedIn: boolean;
  lastAuthAt?: string | null;
  lastError?: string | null;
  managedAt?: string;
};

type SessionInfo = {
  live: boolean;
  headless?: boolean;
  url?: string;
  tabs?: { id: string; url: string; current: boolean }[];
  viewport?: { width: number; height: number };
};

type Caps = {
  chromium: boolean;
  headedAvailable: boolean;
};

type Frame = {
  url?: string;
  image?: string;
  viewport?: { width: number; height: number };
  error?: string;
};

async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export default function SigninPage() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [signins, setSignins] = useState<Signin[]>([]);
  const [sites, setSites] = useState<Signin[]>([]);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [activeSlug, setActiveSlug] = useState("google");
  const [frame, setFrame] = useState<Frame | null>(null);
  const [urlBar, setUrlBar] = useState("");
  const [addName, setAddName] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    const me = await fetch("/api/auth/me", { credentials: "include" });
    const meData = (await me.json()) as { ok?: boolean };
    if (!me.ok || !meData.ok) {
      setAuthed(false);
      return;
    }
    setAuthed(true);
    const data = await authedJson<{
      capabilities: Caps;
      session: SessionInfo;
      signins: Signin[];
      sites: Signin[];
    }>("/api/browser");
    setCaps(data.capabilities);
    setSession(data.session);
    setSignins(data.signins);
    setSites(data.sites);
    if (data.session?.url) setUrlBar(data.session.url);
  }, []);

  /* eslint-disable react-hooks/set-state-in-effect -- initial /api/auth/me */
  useEffect(() => {
    let cancelled = false;
    void load().catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Load failed");
    });
    return () => {
      cancelled = true;
      sourceRef.current?.close();
    };
  }, [load]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const login = async () => {
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Login failed");
      setPassword("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  const stopStream = () => {
    sourceRef.current?.close();
    sourceRef.current = null;
  };

  const startStream = () => {
    stopStream();
    const source = new EventSource("/api/browser/session/stream", { withCredentials: true });
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Frame;
        setFrame(data);
        if (data.url) setUrlBar(data.url);
      } catch {
        // ignore malformed frames
      }
    };
    source.onerror = () => {
      source.close();
    };
    sourceRef.current = source;
  };

  const startSignin = async (row: Signin) => {
    setError("");
    setOk("");
    setBusy(true);
    setActiveSlug(row.slug);
    try {
      const result = await authedJson<SessionInfo & { headed?: boolean; url?: string }>("/api/browser/session", {
        method: "POST",
        body: JSON.stringify({ slug: row.slug }),
      });
      setSession(result);
      if (result.url) setUrlBar(result.url);
      if (result.headed) {
        setOk("A Chromium window opened on this host. Sign in there, then click Done.");
      } else {
        setOk("Live view is on. Click the page, type, then Done when you are signed in.");
        startStream();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start browser");
    } finally {
      setBusy(false);
    }
  };

  const sendInput = async (body: Record<string, unknown>) => {
    try {
      await authedJson("/api/browser/session/input", { method: "POST", body: JSON.stringify(body) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Input failed");
    }
  };

  const onFrameClick = (event: MouseEvent<HTMLButtonElement>) => {
    const img = imgRef.current;
    const vp = frame?.viewport || session?.viewport || { width: 1400, height: 900 };
    if (!img) return;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) / rect.width) * vp.width;
    const y = ((event.clientY - rect.top) / rect.height) * vp.height;
    void sendInput({ type: "click", x, y });
  };

  const goUrl = async () => {
    if (!urlBar.trim()) return;
    setBusy(true);
    try {
      const result = await authedJson<SessionInfo & { url?: string }>("/api/browser/session/navigate", {
        method: "POST",
        body: JSON.stringify({ url: urlBar.trim() }),
      });
      if (result.url) setUrlBar(result.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Navigate failed");
    } finally {
      setBusy(false);
    }
  };

  const markDone = async () => {
    setBusy(true);
    setError("");
    try {
      const data = await authedJson<{ signedIn: boolean; evidence: string; signin?: Signin }>(
        "/api/browser/session/done",
        { method: "POST", body: JSON.stringify({ slug: activeSlug }) },
      );
      setOk(data.signedIn ? `Signed in (${data.evidence}).` : `Not signed in yet: ${data.evidence}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Probe failed");
    } finally {
      setBusy(false);
    }
  };

  const closeLive = async () => {
    stopStream();
    setFrame(null);
    await authedJson("/api/browser/session", { method: "DELETE" }).catch(() => {});
    await load();
  };

  const addSignin = async () => {
    setBusy(true);
    setError("");
    try {
      await authedJson("/api/browser/signins", {
        method: "POST",
        body: JSON.stringify({ name: addName, origin: addUrl, loginUrl: addUrl }),
      });
      setAddName("");
      setAddUrl("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add");
    } finally {
      setBusy(false);
    }
  };

  const removeSignin = async (slug: string) => {
    setBusy(true);
    try {
      await authedJson(`/api/browser/signins/${encodeURIComponent(slug)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="settings-page signin-page">
      <header>
        <div className="settings-brand">
          <img className="brand-logo" src="/logo-black.png" alt="" width={36} height={36} />
          <div>
            <small>Google · OAuth · saved sessions</small>
            <h1>Sign-in</h1>
          </div>
        </div>
        <nav className="signin-links">
          <a href="/settings#sites">Sites</a>
          <a href="/">Studio</a>
        </nav>
      </header>

      {error ? <p className="settings-error">{error}</p> : null}
      {ok ? <p className="settings-ok">{ok}</p> : null}

      {!authed ? (
        <section className="settings-card">
          <p>Unlock with the same access password as Settings. Agents reuse these sessions; they cannot complete Google 2FA themselves.</p>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void login()}
              autoComplete="current-password"
            />
          </label>
          <button type="button" onClick={() => void login()} disabled={busy || !password}>
            Unlock
          </button>
        </section>
      ) : (
        <>
          <section className="settings-card signin-wide">
            <p>
              One shared Chromium profile on this host. Sign into Google once; every agent with the Browser MCP reuses
              it. Cookies stay on the volume. Do not log out from chat.
            </p>
            <small>
              Chromium {caps?.chromium ? "found" : "missing"}
              {caps?.headedAvailable ? " · headed window available" : " · live view (headless host)"}
              {session?.live ? ` · browser live` : ""}
            </small>
            {signins.map((row) => (
              <div className="catalog-item" key={row.slug} style={{ display: "block" }}>
                <div className="signin-row">
                  <div>
                    <strong>{row.name}</strong>
                    <small>
                      {row.origin}
                      {row.signedIn ? " · signed in" : " · signed out"}
                      {row.lastAuthAt ? ` · ${new Date(row.lastAuthAt).toLocaleString()}` : ""}
                      {row.lastError && !row.signedIn ? ` · ${row.lastError}` : ""}
                    </small>
                  </div>
                  <span className={row.signedIn ? "signin-badge on" : "signin-badge"}>{row.signedIn ? "in" : "out"}</span>
                </div>
                <div className="catalog-actions">
                  <button type="button" onClick={() => void startSignin(row)} disabled={busy}>
                    {busy && activeSlug === row.slug ? "Opening…" : "Sign in"}
                  </button>
                  {row.slug !== "google" ? (
                    <button type="button" className="secondary" onClick={() => void removeSignin(row.slug)} disabled={busy}>
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {sites.map((row) => (
              <div className="catalog-item" key={`site-${row.slug}`} style={{ display: "block" }}>
                <div className="signin-row">
                  <div>
                    <strong>{row.name}</strong>
                    <small>
                      {row.origin} · username/password
                      {row.signedIn ? " · last login saved" : ""}
                    </small>
                  </div>
                  <span className={row.signedIn ? "signin-badge on" : "signin-badge"}>{row.signedIn ? "in" : "out"}</span>
                </div>
                <div className="catalog-actions">
                  <a className="signin-link-btn" href={row.managedAt || "/settings#sites"}>
                    Manage on Sites
                  </a>
                </div>
              </div>
            ))}
          </section>

          <section className="settings-card signin-wide">
            <h2>Add another site</h2>
            <p>Opens in the same shared profile. Use this for dashboards that need a human OAuth click.</p>
            <label>
              Name
              <input value={addName} onChange={(event) => setAddName(event.target.value)} placeholder="Ads UI" />
            </label>
            <label>
              Login URL
              <input
                value={addUrl}
                onChange={(event) => setAddUrl(event.target.value)}
                placeholder="https://ads.google.com/"
              />
            </label>
            <button type="button" onClick={() => void addSignin()} disabled={busy || !addName.trim() || !addUrl.trim()}>
              Add
            </button>
          </section>

          {(session?.live || frame) && (
            <section className="settings-card signin-wide signin-live">
              <h2>Live browser</h2>
              <div className="signin-urlbar">
                <input
                  value={urlBar}
                  onChange={(event) => setUrlBar(event.target.value)}
                  onKeyDown={(event) => event.key === "Enter" && void goUrl()}
                />
                <button type="button" className="secondary" onClick={() => void goUrl()} disabled={busy}>
                  Go
                </button>
              </div>
              {frame?.image ? (
                <button
                  type="button"
                  className="signin-frame-btn"
                  onClick={onFrameClick}
                  aria-label="Remote browser view. Click to tap the page."
                >
                  <img
                    ref={imgRef}
                    className="signin-frame"
                    alt=""
                    src={`data:image/jpeg;base64,${frame.image}`}
                  />
                </button>
              ) : (
                <p>Waiting for a frame… {session?.headless === false ? "or use the window on the host." : ""}</p>
              )}
              <label>
                Type into the page
                <input
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const value = event.currentTarget.value;
                      event.currentTarget.value = "";
                      void sendInput({ type: "type", text: value, submit: true });
                    }
                  }}
                  placeholder="Type here, Enter to send"
                />
              </label>
              <div className="catalog-actions">
                <button type="button" onClick={() => void markDone()} disabled={busy}>
                  Done — check signed in
                </button>
                <button type="button" className="secondary" onClick={() => void closeLive()} disabled={busy}>
                  Close browser
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
