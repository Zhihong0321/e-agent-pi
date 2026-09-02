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

type Tab = "keys" | "agents" | "skills" | "mcp";
const TABS: Tab[] = ["keys", "agents", "skills", "mcp"];

function readTab(): Tab {
  if (typeof window === "undefined") return "keys";
  const hash = window.location.hash.replace(/^#/, "") as Tab;
  if (TABS.includes(hash)) return hash;
  const query = new URLSearchParams(window.location.search).get("tab") as Tab | null;
  if (query && TABS.includes(query)) return query;
  return "keys";
}

type SkillItem = { id: string; slug: string; name: string; description: string; source?: string };
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
    githubToken: "",
    githubRepo: "",
    githubBranch: "main",
    settingsPassword: "",
  });
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [mcp, setMcp] = useState<McpItem[]>([]);
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

  const loadKeys = async () => {
    const data = await authedJson<Settings>("/api/settings");
    setSettings(data);
    setForm((prev) => ({
      ...prev,
      cavotiBaseUrl: data.cavotiBaseUrl,
      kimiBaseUrl: data.kimiBaseUrl,
      githubRepo: data.githubRepo,
      githubBranch: data.githubBranch,
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
  };

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Load failed"));
  }, []);

  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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
      const data = await authedJson<Settings>("/api/settings", {
        method: "PUT",
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
      setSettings(data);
      setForm((prev) => ({ ...prev, cavotiApiKey: "", kimiApiKey: "", githubToken: "", settingsPassword: "" }));
      setSaved("Saved to Postgres. Models and GitHub will use these keys.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
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

  const toggleId = (list: string[], id: string) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

  return (
    <main className="settings-page">
      <header>
        <div>
          <small>Keys · Agents · Skills · MCP</small>
          <h1>Settings</h1>
        </div>
        <a href="/">Back to studio</a>
      </header>

      {!authed ? (
        <section className="settings-card">
          <p>Enter the access password to manage keys, agents, skills, and MCP.</p>
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

              <button type="button" onClick={() => void saveKeys()} disabled={busy}>
                Save to Postgres
              </button>
            </section>
          )}

          {tab === "agents" && (
            <section className="settings-card">
              <p>
                An agent is Role + Skills + MCP. Installing a skill does not give it to every agent. Tick only what this
                agent should see.
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
                  Short
                  <input
                    value={agentForm.short}
                    maxLength={2}
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
        </>
      )}

      {error && <p className="settings-error">{error}</p>}
      {saved && <p className="settings-ok">{saved}</p>}
    </main>
  );
}
