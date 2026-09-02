import { useEffect, useState } from "react";

type Settings = {
  cavotiApiKeySet: boolean;
  cavotiBaseUrl: string;
  kimiApiKeySet: boolean;
  kimiBaseUrl: string;
  githubTokenSet: boolean;
  githubRepo: string;
  githubBranch: string;
};

export default function SettingsPage() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState({
    cavotiApiKey: "",
    cavotiBaseUrl: "",
    kimiApiKey: "",
    kimiBaseUrl: "",
    githubToken: "",
    githubRepo: "",
    githubBranch: "main",
    settingsPassword: "",
  });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const me = await fetch("/api/auth/me", { credentials: "include" });
    const meData = (await me.json()) as { ok?: boolean };
    if (!me.ok || !meData.ok) {
      setAuthed(false);
      return;
    }
    setAuthed(true);
    const res = await fetch("/api/settings", { credentials: "include" });
    const data = (await res.json()) as Settings & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Could not load settings");
    setSettings(data);
    setForm((prev) => ({
      ...prev,
      cavotiBaseUrl: data.cavotiBaseUrl,
      kimiBaseUrl: data.kimiBaseUrl,
      githubRepo: data.githubRepo,
      githubBranch: data.githubBranch,
    }));
  };

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Load failed"));
  }, []);

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

  const save = async () => {
    setError("");
    setSaved("");
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cavoti_api_key: form.cavotiApiKey,
          cavoti_base_url: form.cavotiBaseUrl,
          kimi_api_key: form.kimiApiKey,
          kimi_base_url: form.kimiBaseUrl,
          github_token: form.githubToken,
          github_repo: form.githubRepo,
          github_branch: form.githubBranch,
          settings_password: form.settingsPassword,
        }),
      });
      const data = (await res.json()) as Settings & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setSettings(data);
      setForm((prev) => ({ ...prev, cavotiApiKey: "", kimiApiKey: "", githubToken: "", settingsPassword: "" }));
      setSaved("Saved to Postgres. Models and GitHub will use these keys.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="settings-page">
      <header>
        <div>
          <small>E Agent</small>
          <h1>Settings</h1>
        </div>
        <a href="/">Back to studio</a>
      </header>

      {!authed ? (
        <section className="settings-card">
          <p>Enter the access password to manage API keys stored in Postgres.</p>
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
        <section className="settings-card">
          <p>Keys are stored in Postgres, not Railway variables. Leave a secret blank to keep the current value.</p>

          <h2>Cavoti / Luna</h2>
          <label>
            API key {settings?.cavotiApiKeySet ? <em>saved</em> : <em>missing</em>}
            <input
              type="password"
              value={form.cavotiApiKey}
              onChange={(event) => setForm({ ...form, cavotiApiKey: event.target.value })}
              placeholder={settings?.cavotiApiKeySet ? "••••••••  (unchanged)" : "Paste key"}
            />
          </label>
          <label>
            Base URL
            <input
              value={form.cavotiBaseUrl}
              onChange={(event) => setForm({ ...form, cavotiBaseUrl: event.target.value })}
            />
          </label>

          <h2>Kimi K3</h2>
          <label>
            API key {settings?.kimiApiKeySet ? <em>saved</em> : <em>missing</em>}
            <input
              type="password"
              value={form.kimiApiKey}
              onChange={(event) => setForm({ ...form, kimiApiKey: event.target.value })}
              placeholder={settings?.kimiApiKeySet ? "••••••••  (unchanged)" : "Paste key"}
            />
          </label>
          <label>
            Base URL
            <input
              value={form.kimiBaseUrl}
              onChange={(event) => setForm({ ...form, kimiBaseUrl: event.target.value })}
            />
          </label>

          <h2>GitHub workspace</h2>
          <label>
            Token {settings?.githubTokenSet ? <em>saved</em> : <em>missing</em>}
            <input
              type="password"
              value={form.githubToken}
              onChange={(event) => setForm({ ...form, githubToken: event.target.value })}
              placeholder={settings?.githubTokenSet ? "••••••••  (unchanged)" : "ghp_…"}
            />
          </label>
          <label>
            Repo (owner/name)
            <input
              value={form.githubRepo}
              onChange={(event) => setForm({ ...form, githubRepo: event.target.value })}
              placeholder="Zhihong0321/site-workspace"
            />
          </label>
          <label>
            Branch
            <input
              value={form.githubBranch}
              onChange={(event) => setForm({ ...form, githubBranch: event.target.value })}
            />
          </label>

          <h2>Access password</h2>
          <label>
            New password
            <input
              type="password"
              value={form.settingsPassword}
              onChange={(event) => setForm({ ...form, settingsPassword: event.target.value })}
              placeholder="Leave blank to keep current"
            />
          </label>

          <button type="button" onClick={() => void save()} disabled={busy}>
            Save to Postgres
          </button>
        </section>
      )}

      {error && <p className="settings-error">{error}</p>}
      {saved && <p className="settings-ok">{saved}</p>}
    </main>
  );
}
