import { useEffect, useState } from "react";

type Settings = {
  cavotiApiKeySet: boolean;
  cavotiBaseUrl: string;
  kimiApiKeySet: boolean;
  kimiBaseUrl: string;
  imagenApiKeySet: boolean;
  imagenBaseUrl: string;
  imagenModel: string;
  imagenApi: string;
  githubTokenSet: boolean;
  githubRepo: string;
  githubBranch: string;
  pgProxyTokenSet: boolean;
  eeHtmlApiKeySet: boolean;
  eeHtmlBaseUrl: string;
  eeHtmlSlug: string;
  eeHtmlName: string;
  eeHtmlUrl: string;
  eeHtmlLastError: string;
};

type Tab = "keys" | "agents" | "sites" | "skills" | "mcp" | "usage";
const TABS: Tab[] = ["keys", "agents", "sites", "skills", "mcp", "usage"];

function readTab(): Tab {
  if (typeof window === "undefined") return "keys";
  const hash = window.location.hash.replace(/^#/, "") as Tab;
  if (TABS.includes(hash)) return hash;
  const query = new URLSearchParams(window.location.search).get("tab") as Tab | null;
  if (query && TABS.includes(query)) return query;
  return "keys";
}

type SiteItem = {
  id: string;
  slug: string;
  name: string;
  origin: string;
  loginUrl: string;
  username: string;
  passwordSet: boolean;
  lastLoginAt?: string | null;
  lastError?: string | null;
};
type McpItem = {
  id: string;
  slug: string;
  name: string;
  description: string;
  command?: string | null;
  args?: string[];
  url?: string | null;
  hasEnv?: boolean;
  env?: Record<string, string>;
};
type AgentItem = {
  id: string;
  slug: string;
  name: string;
  short: string;
  headline: string;
  description: string;
  color: string;
  rolePrompt?: string;
  skillIds: string[];
  mcpIds: string[];
  skills: SkillItem[];
  mcp: McpItem[];
};

type ResourceSample = {
  ts: string;
  nodeRssMb: number;
  nodeHeapMb: number;
  childrenRssMb: number | null;
  containerMb: number;
  containerLimitMb: number | null;
  nodeCpuPct: number;
  containerCpuPct: number | null;
  childCount: number;
  load1: number | null;
  piAlive: boolean;
};

type MetricsPayload = {
  intervalSec: number;
  retentionHours: number;
  now: ResourceSample | null;
  samples: ResourceSample[];
  stats: {
    sampleCount: number;
    ramPeakMb: number;
    ramAvgMb: number;
    cpuPeakPct: number;
    cpuAvgPct: number;
  };
};

const emptyAgent = {
  name: "",
  short: "",
  headline: "",
  description: "",
  color: "emerald",
  rolePrompt: "",
  skillIds: [] as string[],
  mcpIds: [] as string[],
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

export default function SettingsPage() {
  const [authed, setAuthed] = useState(false);
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>(readTab);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState({
    cavotiApiKey: "",
    cavotiBaseUrl: "",
    kimiApiKey: "",
    kimiBaseUrl: "",
    imagenApiKey: "",
    imagenBaseUrl: "",
    imagenModel: "",
    imagenApi: "auto",
    githubToken: "",
    githubRepo: "",
    githubBranch: "main",
    pgProxyToken: "",
    eeHtmlApiKey: "",
    eeHtmlBaseUrl: "",
    eeHtmlSlug: "e-agent-site",
    eeHtmlName: "Website Dev Agent",
    settingsPassword: "",
  });
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [mcp, setMcp] = useState<McpItem[]>([]);
  const [sites, setSites] = useState<SiteItem[]>([]);
  const [siteBusy, setSiteBusy] = useState("");
  const [sitePasswords, setSitePasswords] = useState<Record<string, string>>({});
  const [agentForm, setAgentForm] = useState({ ...emptyAgent, id: "" });
  const [skillForm, setSkillForm] = useState({ name: "", description: "", url: "", content: "" });
  const [mcpForm, setMcpForm] = useState({
    id: "",
    name: "",
    description: "",
    command: "",
    args: "",
    url: "",
    env: "",
  });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null);

  const loadKeys = async () => {
    const data = await authedJson<Settings>("/api/settings");
    setSettings(data);
    setForm((prev) => ({
      ...prev,
      cavotiBaseUrl: data.cavotiBaseUrl,
      kimiBaseUrl: data.kimiBaseUrl,
      imagenBaseUrl: data.imagenBaseUrl,
      imagenModel: data.imagenModel,
      imagenApi: data.imagenApi || "auto",
      githubRepo: data.githubRepo,
      githubBranch: data.githubBranch,
      eeHtmlBaseUrl: data.eeHtmlBaseUrl,
      eeHtmlSlug: data.eeHtmlSlug,
      eeHtmlName: data.eeHtmlName,
    }));
  };

  const loadCatalog = async () => {
    const [agentData, skillData, mcpData] = await Promise.all([
      authedJson<{ agents: AgentItem[] }>("/api/agents"),
      authedJson<{ skills: SkillItem[] }>("/api/skills"),
      authedJson<{ servers: McpItem[] }>("/api/mcp"),
    ]);
    setAgents(agentData.agents ?? []);
    setSkills(skillData.skills ?? []);
    setMcp(mcpData.servers ?? []);
  };

  const load = async () => {
    const me = await fetch("/api/auth/me", { credentials: "include" });
    const meData = (await me.json()) as { ok?: boolean };
    if (!me.ok || !meData.ok) {
      setAuthed(false);
      return;
    }
    setAuthed(true);
    await loadKeys();
    await loadCatalog();
    await loadSites();
  };

  const loadSites = async () => {
    const data = await authedJson<{ sites: SiteItem[] }>("/api/sites");
    setSites(data.sites ?? []);
  };

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Load failed"));
  }, []);

  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!authed || tab !== "usage") return;
    let cancelled = false;
    const loadMetrics = async () => {
      try {
        const data = await authedJson<MetricsPayload>("/api/metrics");
        if (!cancelled) setMetrics(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load usage");
      }
    };
    void loadMetrics();
    const id = window.setInterval(() => void loadMetrics(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [authed, tab]);

  const goTab = (item: Tab) => {
    setTab(item);
    const url = `${window.location.pathname}#${item}`;
    window.history.replaceState(null, "", url);
  };

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

  const saveKeys = async () => {
    setError("");
    setSaved("");
    setBusy(true);
    try {
      const data = await authedJson<
        Settings & { proposal?: { lastError?: string | null; pushed?: boolean } }
      >("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          cavoti_api_key: form.cavotiApiKey,
          cavoti_base_url: form.cavotiBaseUrl,
          kimi_api_key: form.kimiApiKey,
          kimi_base_url: form.kimiBaseUrl,
          imagen_api_key: form.imagenApiKey,
          imagen_base_url: form.imagenBaseUrl,
          imagen_model: form.imagenModel,
          imagen_api: form.imagenApi,
          github_token: form.githubToken,
          github_repo: form.githubRepo,
          github_branch: form.githubBranch,
          pg_proxy_token: form.pgProxyToken,
          ee_html_api_key: form.eeHtmlApiKey,
          ee_html_base_url: form.eeHtmlBaseUrl,
          ee_html_slug: form.eeHtmlSlug,
          ee_html_name: form.eeHtmlName,
          settings_password: form.settingsPassword,
        }),
      });
      setSettings(data);
      setForm((prev) => ({ ...prev, cavotiApiKey: "", kimiApiKey: "", imagenApiKey: "", githubToken: "", pgProxyToken: "", eeHtmlApiKey: "", settingsPassword: "" }));
      if (data.proposal?.lastError) {
        setError(data.proposal.lastError);
        setSaved("Saved keys, but GitHub rejected the proposal push.");
      } else if (data.proposal?.pushed) {
        setSaved("Saved. Proposal updates pushed to GitHub.");
      } else if (data.eeHtmlLastError) {
        setError(data.eeHtmlLastError);
        setSaved("");
      } else if (data.eeHtmlUrl) {
        setSaved(`Saved. Live site: ${data.eeHtmlUrl}`);
      } else if (data.eeHtmlApiKeySet) {
        setSaved("Saved. Host will publish once the workspace has index.html.");
      } else {
        setSaved("Saved to Postgres. Add the HTML host API key to publish to ee-html.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  const publishHost = async () => {
    setError("");
    setSaved("");
    setPublishing(true);
    try {
      const host = await authedJson<{
        configured?: boolean;
        url?: string | null;
        lastError?: string | null;
      }>("/api/host", { method: "POST" });
      setSettings((prev) =>
        prev
          ? {
              ...prev,
              eeHtmlUrl: host.url ?? prev.eeHtmlUrl,
              eeHtmlLastError: host.lastError ?? "",
              eeHtmlApiKeySet: host.configured ?? prev.eeHtmlApiKeySet,
            }
          : prev,
      );
      if (host.lastError) setError(host.lastError);
      else if (host.url) setSaved(`Published ${host.url}`);
      else setSaved("Publish skipped — add the API key and an index.html in the workspace.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setPublishing(false);
    }
  };

  const editAgent = async (id: string) => {
    setError("");
    const data = await authedJson<{ agent: AgentItem }>(`/api/agents/${encodeURIComponent(id)}`);
    const agent = data.agent;
    setAgentForm({
      id: agent.id,
      name: agent.name,
      short: agent.short,
      headline: agent.headline,
      description: agent.description,
      color: agent.color,
      rolePrompt: agent.rolePrompt ?? "",
      skillIds: agent.skillIds ?? [],
      mcpIds: agent.mcpIds ?? [],
    });
    setTab("agents");
    window.history.replaceState(null, "", `${window.location.pathname}#agents`);
  };

  const saveAgent = async () => {
    setError("");
    setSaved("");
    setBusy(true);
    try {
      const body = {
        name: agentForm.name,
        short: agentForm.short,
        headline: agentForm.headline,
        description: agentForm.description,
        color: agentForm.color,
        rolePrompt: agentForm.rolePrompt,
        skillIds: agentForm.skillIds,
        mcpIds: agentForm.mcpIds,
      };
      if (agentForm.id) {
        await authedJson(`/api/agents/${encodeURIComponent(agentForm.id)}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        setSaved("Agent saved. Next chat with this agent loads its role, skills, and MCP.");
      } else {
        await authedJson("/api/agents", { method: "POST", body: JSON.stringify(body) });
        setAgentForm({ ...emptyAgent, id: "" });
        setSaved("Agent created.");
      }
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save agent");
    } finally {
      setBusy(false);
    }
  };

  const removeAgent = async (id: string) => {
    if (!window.confirm("Delete this agent? Its chats move to Website Dev Agent.")) return;
    setError("");
    try {
      await authedJson(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (agentForm.id === id) setAgentForm({ ...emptyAgent, id: "" });
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete agent");
    }
  };

  const installSkillSubmit = async () => {
    setError("");
    setSaved("");
    setBusy(true);
    try {
      await authedJson("/api/skills", {
        method: "POST",
        body: JSON.stringify({
          name: skillForm.name || undefined,
          description: skillForm.description || undefined,
          url: skillForm.url || undefined,
          content: skillForm.content || undefined,
        }),
      });
      setSkillForm({ name: "", description: "", url: "", content: "" });
      setSaved("Skill installed in the host library. Attach it to an agent on the Agents tab.");
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not install skill");
    } finally {
      setBusy(false);
    }
  };

  const saveMcpSubmit = async () => {
    setError("");
    setSaved("");
    setBusy(true);
    let env: Record<string, string> = {};
    if (mcpForm.env.trim()) {
      try {
        env = JSON.parse(mcpForm.env) as Record<string, string>;
      } catch {
        setError("MCP env must be JSON, e.g. {\"TOKEN\":\"…\"}");
        setBusy(false);
        return;
      }
    }
    try {
      const body = {
        name: mcpForm.name,
        description: mcpForm.description,
        command: mcpForm.command,
        args: mcpForm.args,
        url: mcpForm.url,
        env,
      };
      if (mcpForm.id) {
        await authedJson(`/api/mcp/${encodeURIComponent(mcpForm.id)}`, { method: "PATCH", body: JSON.stringify(body) });
        setSaved("MCP server updated. Re-attach if needed, then start a new chat with that agent.");
      } else {
        await authedJson("/api/mcp", { method: "POST", body: JSON.stringify(body) });
        setSaved("MCP server saved in the library. Attach it to an agent on the Agents tab.");
      }
      setMcpForm({ id: "", name: "", description: "", command: "", args: "", url: "", env: "" });
      await loadCatalog();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save MCP");
    } finally {
      setBusy(false);
    }
  };

  const saveSite = async (site: SiteItem) => {
    setError("");
    setSaved("");
    setSiteBusy(site.id);
    try {
      await authedJson(`/api/sites/${encodeURIComponent(site.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: site.name,
          origin: site.origin,
          loginUrl: site.loginUrl,
          username: site.username,
          password: sitePasswords[site.id] || undefined,
        }),
      });
      setSitePasswords((prev) => ({ ...prev, [site.id]: "" }));
      setSaved(`Saved ${site.name}. Click Login now to store the session in the headless profile.`);
      await loadSites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save site");
    } finally {
      setSiteBusy("");
    }
  };

  const loginSite = async (site: SiteItem) => {
    setError("");
    setSaved("");
    setSiteBusy(site.id);
    try {
      if (sitePasswords[site.id] || site.username !== undefined) {
        await authedJson(`/api/sites/${encodeURIComponent(site.id)}`, {
          method: "PATCH",
          body: JSON.stringify({
            username: site.username,
            password: sitePasswords[site.id] || undefined,
          }),
        });
      }
      const data = await authedJson<{ ok?: boolean; detail?: string; error?: string }>(
        `/api/sites/${encodeURIComponent(site.id)}/login`,
        { method: "POST" },
      );
      setSaved(data.detail || `${site.name} signed in. Session stays on this server.`);
      await loadSites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSiteBusy("");
    }
  };

  const toggleId = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

  return (
    <main className="settings-page">
      <header>
        <div className="settings-brand">
          <img className="brand-logo" src="/logo-black.png" alt="" width={36} height={36} />
          <div>
            <small>Keys · Agents · Sites · Skills · MCP · Usage</small>
            <h1>Settings</h1>
          </div>
        </div>
        <a href="/">Back to studio</a>
      </header>

      {!authed ? (
        <section className="settings-card">
          <p>Enter the access password to manage keys, agents, site logins, skills, and MCP.</p>
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
          <nav className="settings-tabs">
            {TABS.map((item) => (
              <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => goTab(item)}>
                {item === "mcp" ? "MCP" : item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
          </nav>

          {tab === "keys" && (
            <section className="settings-card">
              <p>
                Keys are stored in Postgres, not Railway variables. Leave a secret blank to keep the current value.
                The Imagen model is host-wide: every Pi agent is told about it after you save.
              </p>

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

              <h2>Imagen / image generation</h2>
              <p>
                Saved here for every Pi agent. They generate with{" "}
                <code>node "$CLOUD_PI_IMAGEN" generate --prompt "…" --out assets/hero.png</code>. Google retired classic
                Imagen IDs in Aug 2026 — use <code>gemini-3.1-flash-image</code> or any proxy / OpenAI-compatible image
                model.
              </p>
              <label>
                API key {settings?.imagenApiKeySet ? <em>saved</em> : <em>missing</em>}
                <input
                  type="password"
                  value={form.imagenApiKey}
                  onChange={(event) => setForm({ ...form, imagenApiKey: event.target.value })}
                  placeholder={settings?.imagenApiKeySet ? "••••••••  (unchanged)" : "Paste key"}
                />
              </label>
              <label>
                Model ID
                <input
                  value={form.imagenModel}
                  onChange={(event) => setForm({ ...form, imagenModel: event.target.value })}
                  placeholder="gemini-3.1-flash-image"
                />
              </label>
              <label>
                API
                <select value={form.imagenApi} onChange={(event) => setForm({ ...form, imagenApi: event.target.value })}>
                  <option value="auto">Auto-detect</option>
                  <option value="google">Google Gemini / Imagen</option>
                  <option value="openai">OpenAI-compatible (/v1/images/generations)</option>
                </select>
              </label>
              <label>
                Base URL
                <input
                  value={form.imagenBaseUrl}
                  onChange={(event) => setForm({ ...form, imagenBaseUrl: event.target.value })}
                  placeholder="https://generativelanguage.googleapis.com/v1beta"
                />
              </label>

              <h2>HTML host (ee-html)</h2>
              <p>
                Website Dev Agent only edits files. This studio zips the workspace and publishes to{" "}
                <a href="https://ee-html.up.railway.app/" target="_blank" rel="noreferrer">
                  ee-html.up.railway.app
                </a>
                . Paste the host API key here (or set <code>EE_HTML_API_KEY</code> on Railway).
              </p>
              <label>
                API key {settings?.eeHtmlApiKeySet ? <em>saved</em> : <em>missing</em>}
                <input
                  type="password"
                  value={form.eeHtmlApiKey}
                  onChange={(event) => setForm({ ...form, eeHtmlApiKey: event.target.value })}
                  placeholder={settings?.eeHtmlApiKeySet ? "••••••••  (unchanged)" : "Host engine API key"}
                />
              </label>
              <label>
                Base URL
                <input
                  value={form.eeHtmlBaseUrl}
                  onChange={(event) => setForm({ ...form, eeHtmlBaseUrl: event.target.value })}
                  placeholder="https://ee-html.up.railway.app"
                />
              </label>
              <label>
                Slug
                <input
                  value={form.eeHtmlSlug}
                  onChange={(event) => setForm({ ...form, eeHtmlSlug: event.target.value })}
                  placeholder="e-agent-site"
                />
              </label>
              <label>
                Display name
                <input
                  value={form.eeHtmlName}
                  onChange={(event) => setForm({ ...form, eeHtmlName: event.target.value })}
                />
              </label>
              {settings?.eeHtmlUrl ? (
                <p>
                  Live:{" "}
                  <a href={settings.eeHtmlUrl} target="_blank" rel="noreferrer">
                    {settings.eeHtmlUrl}
                  </a>
                </p>
              ) : null}
              <button type="button" disabled={busy || publishing || !settings?.eeHtmlApiKeySet} onClick={() => void publishHost()}>
                {publishing ? "Publishing…" : "Publish workspace now"}
              </button>

              <h2>Postgres proxy</h2>
              <p>
                Package Updater uses this token for <code>prod_main</code> via the pg-proxy. Paste the JWT only (no{" "}
                <code>Bearer</code> prefix). Leave blank to keep the saved value. Do not paste the token in chat.
              </p>
              <label>
                Token {settings?.pgProxyTokenSet ? <em>saved</em> : <em>missing</em>}
                <input
                  type="password"
                  value={form.pgProxyToken}
                  onChange={(event) => setForm({ ...form, pgProxyToken: event.target.value })}
                  placeholder={settings?.pgProxyTokenSet ? "••••••••  (unchanged)" : "eyJ…"}
                />
              </label>

              <h2>GitHub</h2>
              <p>
                Proposal Agent uses this token to push <code>Zhihong0321/ee-proposal</code>. It needs{" "}
                <strong>Contents: Write</strong> on that repo (classic PAT: <code>repo</code> scope). A token that only
                covers <code>e-agent-pi</code> can clone the public proposal repo and still get HTTP 403 on push.
                Website Dev Agent still must not commit or push; it publishes through ee-html.
              </p>
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

              <button type="button" onClick={() => void saveKeys()} disabled={busy}>
                Save to Postgres
              </button>
            </section>
          )}

          {tab === "agents" && (
            <section className="settings-card">
              <p>
                An agent is Role + Skills + MCP. Tick <code>spawn-subagents</code> on Website Dev Agent to
                allow in-process child agents. Or ask Settings Agent in studio chat to install and attach.
              </p>
              <div className="catalog-list">
                {agents.map((agent) => (
                  <div className="catalog-item" key={agent.id}>
                    <div>
                      <strong>{agent.name}</strong>
                      <small>
                        {(agent.skills ?? []).map((row) => row.name).join(", ") || "no skills"}
                        {" · "}
                        {(agent.mcp ?? []).map((row) => row.name).join(", ") || "no MCP"}
                      </small>
                    </div>
                    <div className="catalog-actions">
                      <button type="button" className="secondary" onClick={() => void editAgent(agent.id)}>
                        Edit
                      </button>
                      {agent.slug !== "website" && (
                        <button type="button" className="secondary" onClick={() => void removeAgent(agent.id)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <h2>{agentForm.id ? "Edit agent" : "New agent"}</h2>
              <label>
                Name
                <input value={agentForm.name} onChange={(event) => setAgentForm({ ...agentForm, name: event.target.value })} />
              </label>
              <div className="settings-two">
                <label>
                  Tile label
                  <input
                    value={agentForm.short}
                    maxLength={4}
                    placeholder="Up to 4 characters"
                    onChange={(event) => setAgentForm({ ...agentForm, short: event.target.value })}
                  />
                </label>
                <label>
                  Color
                  <input
                    value={agentForm.color}
                    onChange={(event) => setAgentForm({ ...agentForm, color: event.target.value })}
                    placeholder="emerald, violet, blue"
                  />
                </label>
              </div>
              <label>
                Headline
                <input
                  value={agentForm.headline}
                  onChange={(event) => setAgentForm({ ...agentForm, headline: event.target.value })}
                />
              </label>
              <label>
                Description
                <input
                  value={agentForm.description}
                  onChange={(event) => setAgentForm({ ...agentForm, description: event.target.value })}
                />
              </label>
              <label>
                Role prompt
                <textarea
                  value={agentForm.rolePrompt}
                  onChange={(event) => setAgentForm({ ...agentForm, rolePrompt: event.target.value })}
                  rows={10}
                />
              </label>
              <h2>Skills for this agent</h2>
              {skills.length === 0 ? (
                <p>No skills in the library yet.</p>
              ) : (
                <div className="check-grid">
                  {skills.map((skill) => (
                    <label key={skill.id} className="check-row">
                      <input
                        type="checkbox"
                        checked={agentForm.skillIds.includes(skill.id)}
                        onChange={() => setAgentForm({ ...agentForm, skillIds: toggleId(agentForm.skillIds, skill.id) })}
                      />
                      <span>
                        <strong>{skill.name}</strong>
                        <small>{skill.description}</small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <h2>MCP for this agent</h2>
              {mcp.length === 0 ? (
                <p>No MCP servers in the library yet.</p>
              ) : (
                <div className="check-grid">
                  {mcp.map((server) => (
                    <label key={server.id} className="check-row">
                      <input
                        type="checkbox"
                        checked={agentForm.mcpIds.includes(server.id)}
                        onChange={() => setAgentForm({ ...agentForm, mcpIds: toggleId(agentForm.mcpIds, server.id) })}
                      />
                      <span>
                        <strong>{server.name}</strong>
                        <small>{server.description || server.command || server.url}</small>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="catalog-actions">
                <button type="button" onClick={() => void saveAgent()} disabled={busy || !agentForm.name.trim()}>
                  {agentForm.id ? "Save agent" : "Create agent"}
                </button>
                {agentForm.id ? (
                  <button type="button" className="secondary" onClick={() => setAgentForm({ ...emptyAgent, id: "" })}>
                    New agent
                  </button>
                ) : null}
              </div>
            </section>
          )}

          {tab === "skills" && (
            <section className="settings-card">
              <p>
                Skills install into <code>/storage/library/skills</code>. They are not visible to Pi until you attach
                them on the Agents tab.
              </p>
              <div className="catalog-list">
                {skills.map((skill) => (
                  <div className="catalog-item" key={skill.id}>
                    <div>
                      <strong>{skill.name}</strong>
                      <small>{skill.description}</small>
                    </div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        if (!window.confirm(`Remove ${skill.name} from the library?`)) return;
                        void authedJson(`/api/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" })
                          .then(loadCatalog)
                          .catch((err) => setError(err instanceof Error ? err.message : "Delete failed"));
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ))}
              </div>
              <h2>Install skill</h2>
              <label>
                Slug / name
                <input
                  value={skillForm.name}
                  onChange={(event) => setSkillForm({ ...skillForm, name: event.target.value })}
                  placeholder="pdf-tools"
                />
              </label>
              <label>
                Description
                <input
                  value={skillForm.description}
                  onChange={(event) => setSkillForm({ ...skillForm, description: event.target.value })}
                />
              </label>
              <label>
                SKILL.md URL (optional)
                <input
                  value={skillForm.url}
                  onChange={(event) => setSkillForm({ ...skillForm, url: event.target.value })}
                  placeholder="https://raw.githubusercontent.com/…/SKILL.md"
                />
              </label>
              <label>
                SKILL.md content
                <textarea
                  value={skillForm.content}
                  onChange={(event) => setSkillForm({ ...skillForm, content: event.target.value })}
                  rows={8}
                  placeholder={"---\nname: my-skill\ndescription: When to use it.\n---\n\n# Instructions"}
                />
              </label>
              <button type="button" onClick={() => void installSkillSubmit()} disabled={busy || (!skillForm.content && !skillForm.url)}>
                Install to library
              </button>
            </section>
          )}

          {tab === "sites" && (
            <section className="settings-card">
              <p>
                Share a username and password for a site Pi should operate. Chromium is headless on this host. Login
                once; the profile (cookies and localStorage) stays on the volume. Do not paste site passwords into
                chat.
              </p>
              {sites.length === 0 ? <p>No sites seeded yet. Restart the host to create the NEWPAGES row.</p> : null}
              {sites.map((site) => (
                <div className="catalog-item" key={site.id} style={{ display: "block" }}>
                  <h2>{site.name}</h2>
                  <small>
                    {site.origin}
                    {site.passwordSet ? " · password saved" : " · no password yet"}
                    {site.lastLoginAt ? ` · last login ${new Date(site.lastLoginAt).toLocaleString()}` : ""}
                    {site.lastError ? ` · last error: ${site.lastError}` : ""}
                  </small>
                  <label>
                    Username
                    <input
                      value={site.username}
                      onChange={(event) =>
                        setSites((rows) =>
                          rows.map((row) => (row.id === site.id ? { ...row, username: event.target.value } : row)),
                        )
                      }
                      autoComplete="username"
                    />
                  </label>
                  <label>
                    Password
                    <input
                      type="password"
                      value={sitePasswords[site.id] ?? ""}
                      onChange={(event) => setSitePasswords((prev) => ({ ...prev, [site.id]: event.target.value }))}
                      placeholder={site.passwordSet ? "••••••••  (unchanged)" : "Merchant password"}
                      autoComplete="new-password"
                    />
                  </label>
                  <label>
                    Login URL
                    <input
                      value={site.loginUrl}
                      onChange={(event) =>
                        setSites((rows) =>
                          rows.map((row) => (row.id === site.id ? { ...row, loginUrl: event.target.value } : row)),
                        )
                      }
                    />
                  </label>
                  <div className="catalog-actions">
                    <button type="button" onClick={() => void saveSite(site)} disabled={Boolean(siteBusy)}>
                      Save
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void loginSite(site)}
                      disabled={Boolean(siteBusy) || (!site.passwordSet && !sitePasswords[site.id])}
                    >
                      {siteBusy === site.id ? "Working…" : "Login now"}
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {tab === "mcp" && (
            <section className="settings-card">
              <p>
                MCP servers are stored on the host, then attached per agent. Pi loads them through{" "}
                <code>pi-mcp-adapter</code> only for agents that have them ticked.
              </p>
              <div className="catalog-list">
                {mcp.map((server) => (
                  <div className="catalog-item" key={server.id}>
                    <div>
                      <strong>{server.name}</strong>
                      <small>{server.command || server.url}</small>
                    </div>
                    <div className="catalog-actions">
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          setMcpForm({
                            id: server.id,
                            name: server.name,
                            description: server.description,
                            command: server.command ?? "",
                            args: (server.args ?? []).join(" "),
                            url: server.url ?? "",
                            env: server.env ? JSON.stringify(server.env) : "",
                          })
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          if (!window.confirm(`Remove ${server.name}?`)) return;
                          void authedJson(`/api/mcp/${encodeURIComponent(server.id)}`, { method: "DELETE" })
                            .then(() => {
                              if (mcpForm.id === server.id) {
                                setMcpForm({ id: "", name: "", description: "", command: "", args: "", url: "", env: "" });
                              }
                              return loadCatalog();
                            })
                            .catch((err) => setError(err instanceof Error ? err.message : "Delete failed"));
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <h2>{mcpForm.id ? "Edit MCP" : "Add MCP"}</h2>
              <label>
                Name
                <input value={mcpForm.name} onChange={(event) => setMcpForm({ ...mcpForm, name: event.target.value })} />
              </label>
              <label>
                Description
                <input
                  value={mcpForm.description}
                  onChange={(event) => setMcpForm({ ...mcpForm, description: event.target.value })}
                />
              </label>
              <label>
                Command
                <input
                  value={mcpForm.command}
                  onChange={(event) => setMcpForm({ ...mcpForm, command: event.target.value })}
                  placeholder="npx"
                />
              </label>
              <label>
                Args
                <input
                  value={mcpForm.args}
                  onChange={(event) => setMcpForm({ ...mcpForm, args: event.target.value })}
                  placeholder="-y @modelcontextprotocol/server-github"
                />
              </label>
              <label>
                URL (HTTP transport)
                <input value={mcpForm.url} onChange={(event) => setMcpForm({ ...mcpForm, url: event.target.value })} />
              </label>
              <label>
                Env JSON
                <textarea
                  value={mcpForm.env}
                  onChange={(event) => setMcpForm({ ...mcpForm, env: event.target.value })}
                  rows={4}
                  placeholder='{"GITHUB_TOKEN":"…"}'
                />
              </label>
              <div className="catalog-actions">
                <button type="button" onClick={() => void saveMcpSubmit()} disabled={busy || !mcpForm.name.trim()}>
                  {mcpForm.id ? "Save MCP" : "Add MCP"}
                </button>
                {mcpForm.id ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setMcpForm({ id: "", name: "", description: "", command: "", args: "", url: "", env: "" })}
                  >
                    New MCP
                  </button>
                ) : null}
              </div>
            </section>
          )}

          {tab === "usage" && <UsagePanel data={metrics} />}
        </>
      )}

      {error && <p className="settings-error">{error}</p>}
      {saved && <p className="settings-ok">{saved}</p>}
    </main>
  );
}

function formatMb(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)} MB`;
}

function formatPct(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toFixed(1)}%`;
}

function formatClock(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function downsample<T>(rows: T[], max = 240): T[] {
  if (rows.length <= max) return rows;
  const step = rows.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.min(rows.length - 1, Math.floor(i * step))]);
  return out;
}

function UsagePanel({ data }: { data: MetricsPayload | null }) {
  const now = data?.now;
  const samples = data?.samples ?? [];
  const stats = data?.stats;
  const log = samples.slice(-48).slice().reverse();
  const ramLimit = now?.containerLimitMb;
  const ramPct = now && ramLimit ? Math.min(100, (now.containerMb / ramLimit) * 100) : null;

  return (
    <section className="settings-card usage-card">
      <p>
        Sampled every {data?.intervalSec ?? 15}s. Rows older than {data?.retentionHours ?? 24} hours are deleted.
        Overhead is a /proc read plus one small Postgres insert — not a profiler.
      </p>
      <div className="usage-grid">
        <UsageStat label="Replica RAM" value={formatMb(now?.containerMb)} hint={ramLimit ? `${formatPct(ramPct)} of ${formatMb(ramLimit)}` : "Node + children"} />
        <UsageStat label="Node RSS" value={formatMb(now?.nodeRssMb)} hint={`heap ${formatMb(now?.nodeHeapMb)}`} />
        <UsageStat label="Pi / children" value={formatMb(now?.childrenRssMb)} hint={now?.piAlive ? `${now.childCount} procs · Pi up` : `${now?.childCount ?? 0} procs · Pi idle`} />
        <UsageStat label="CPU" value={formatPct(now?.containerCpuPct ?? now?.nodeCpuPct)} hint={`Node ${formatPct(now?.nodeCpuPct)} · 1 core = 100%`} />
      </div>
      <div className="usage-grid usage-grid-4">
        <UsageStat label="24h RAM peak" value={formatMb(stats?.ramPeakMb)} hint={`avg ${formatMb(stats?.ramAvgMb)}`} />
        <UsageStat label="24h CPU peak" value={formatPct(stats?.cpuPeakPct)} hint={`avg ${formatPct(stats?.cpuAvgPct)}`} />
        <UsageStat label="Samples" value={String(stats?.sampleCount ?? 0)} hint="kept for 24h" />
        <UsageStat label="Load 1m" value={now?.load1 == null ? "—" : now.load1.toFixed(2)} hint="host load average" />
      </div>
      <h2>RAM · last 24 hours</h2>
      <UsageChart
        samples={downsample(samples)}
        series={[
          { key: "container", color: "#008069", label: "Replica" },
          { key: "node", color: "#3b82f6", label: "Node" },
          { key: "children", color: "#8b5cf6", label: "Children" },
        ]}
        valueOf={(row, key) => (key === "node" ? row.nodeRssMb : key === "children" ? row.childrenRssMb : row.containerMb)}
        unit="MB"
      />
      <h2>CPU · last 24 hours</h2>
      <UsageChart
        samples={downsample(samples)}
        series={[
          { key: "container", color: "#d26310", label: "Replica" },
          { key: "node", color: "#008069", label: "Node" },
        ]}
        valueOf={(row, key) => (key === "node" ? row.nodeCpuPct : row.containerCpuPct ?? row.nodeCpuPct)}
        unit="%"
      />
      <h2>Recent log</h2>
      {log.length === 0 ? (
        <p>No samples yet. The first point is written at boot, then every 15 seconds.</p>
      ) : (
        <div className="usage-log">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>RAM</th>
                <th>Node</th>
                <th>Children</th>
                <th>CPU</th>
                <th>Pi</th>
              </tr>
            </thead>
            <tbody>
              {log.map((row) => (
                <tr key={row.ts}>
                  <td>{formatClock(row.ts)}</td>
                  <td>{formatMb(row.containerMb)}</td>
                  <td>{formatMb(row.nodeRssMb)}</td>
                  <td>{formatMb(row.childrenRssMb)}</td>
                  <td>{formatPct(row.containerCpuPct ?? row.nodeCpuPct)}</td>
                  <td>{row.piAlive ? "up" : "idle"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UsageStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="usage-stat">
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{hint}</span>
    </div>
  );
}

function UsageChart({
  samples,
  series,
  valueOf,
  unit,
}: {
  samples: ResourceSample[];
  series: { key: string; color: string; label: string }[];
  valueOf: (row: ResourceSample, key: string) => number | null | undefined;
  unit: string;
}) {
  const w = 640;
  const h = 168;
  const pad = { t: 10, r: 12, b: 24, l: 40 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const values = samples.flatMap((row) => series.map((item) => valueOf(row, item.key) ?? 0));
  const max = Math.max(1, ...values) * 1.15;
  const xAt = (i: number) => pad.l + (samples.length < 2 ? innerW / 2 : (i / (samples.length - 1)) * innerW);
  const yAt = (n: number) => pad.t + innerH - (n / max) * innerH;
  const first = samples[0];
  const last = samples[samples.length - 1];

  return (
    <div className="usage-chart">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${series.map((item) => item.label).join(", ")} ${unit}`}>
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + innerH} stroke="currentColor" strokeOpacity="0.18" />
        <line x1={pad.l} y1={pad.t + innerH} x2={pad.l + innerW} y2={pad.t + innerH} stroke="currentColor" strokeOpacity="0.18" />
        <text x={4} y={pad.t + 4} className="usage-axis">
          {max.toFixed(0)}
          {unit}
        </text>
        <text x={4} y={pad.t + innerH} className="usage-axis">
          0
        </text>
        {samples.length === 0 ? (
          <text x={w / 2} y={h / 2} textAnchor="middle" className="usage-axis">
            Waiting for samples
          </text>
        ) : (
          series.map((item) => {
            const pts = samples
              .map((row, i) => `${xAt(i)},${yAt(valueOf(row, item.key) ?? 0)}`)
              .join(" ");
            return <polyline key={item.key} fill="none" stroke={item.color} strokeWidth="2" points={pts} />;
          })
        )}
        {first && last && (
          <>
            <text x={pad.l} y={h - 6} className="usage-axis">
              {formatClock(first.ts)}
            </text>
            <text x={pad.l + innerW} y={h - 6} textAnchor="end" className="usage-axis">
              {formatClock(last.ts)}
            </text>
          </>
        )}
      </svg>
      <div className="usage-legend">
        {series.map((item) => (
          <span key={item.key}>
            <i style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}
