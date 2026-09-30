import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChatCopy } from "../chat-markdown";
import { type PendingFile } from "../studio";
import { useStudio } from "../use-studio";
import "./style.css";

type Area = "onboarding" | "people" | "workspace";
type Thread = "onboarding" | "workspace";
type Company = Record<string, unknown>;
type ProfileData = { company: Company; fields: { key: string; label: string; section: string }[]; readiness: { minimum_ready: boolean; missing: { label: string }[] } };
type Member = { id: string; name: string; position: string | null; department: string | null; email: string | null; phone: string | null };
type Invoice = { id: string; number: string | null; status: string; total: string | number; currency: string | null; customer: string | null; created_at: string };
type Customer = { id: string; name: string; email: string | null };
type LiveState = { profile: ProfileData; members: Member[]; invoices: Invoice[]; customers: Customer[] };

const guideLines = [
  "Attach your company profile PDF",
  "Tell me your company’s official website",
  "I can quickly understand your company within minutes.",
];
const DEMO_SESSIONS_KEY = "di-demo-shared-sessions";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function fileData(file: File): Promise<PendingFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, mime: file.type, data: String(reader.result || "") });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const shapes: Record<string, React.ReactNode> = {
    spark: <><path d="m12 2 2 7 7 2-7 2-2 7-2-7-7-2 7-2 2-7Z"/></>,
    chat: <><path d="M20 11a8 8 0 0 1-8 8H5l-2 2v-9a8 8 0 1 1 17-1Z"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 4 5"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    upload: <><path d="M12 16V3m0 0L7 8m5-5 5 5M4 16v4h16v-4"/></>,
    send: <><path d="m3 11 18-8-8 18-2-8-8-2Z"/></>,
    arrow: <><path d="M4 12h16m-6-6 6 6-6 6"/></>,
    close: <><path d="M5 5 19 19M19 5 5 19"/></>,
    refresh: <><path d="M20 11a8 8 0 1 1-2.3-5.7M20 3v6h-6"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>;
}

function Guide() {
  const [visible, setVisible] = useState({ line: 0, text: "" });
  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let line = 0;
    let letter = 0;
    let timer: number;
    const type = () => {
      if (reducedMotion) {
        setVisible({ line, text: guideLines[line] });
        line = (line + 1) % guideLines.length;
        timer = window.setTimeout(type, 3500);
        return;
      }
      letter++;
      setVisible({ line, text: guideLines[line].slice(0, letter) });
      if (letter >= guideLines[line].length) {
        timer = window.setTimeout(() => {
          line = (line + 1) % guideLines.length;
          letter = 0;
          setVisible({ line, text: "" });
          timer = window.setTimeout(type, 200);
        }, 1800);
      } else timer = window.setTimeout(type, 34);
    };
    timer = window.setTimeout(type, reducedMotion ? 0 : 300);
    return () => window.clearTimeout(timer);
  }, []);
  return <div className="demo-guide" aria-label={guideLines.join(". ")}><span>{String(visible.line + 1).padStart(2, "0")}</span><strong aria-hidden="true">{visible.text}{visible.text.length < guideLines[visible.line].length && <i className="demo-cursor"/>}</strong></div>;
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") return Object.values(value).filter((part) => typeof part === "string" && part.trim()).join(", ");
  return "";
}

function money(value: string | number, currency: string | null) {
  try { return new Intl.NumberFormat("en-MY", { style: "currency", currency: currency || "MYR" }).format(Number(value)); }
  catch { return `${currency || "MYR"} ${value}`; }
}

export default function DemoPage() {
  const studio = useStudio();
  const [area, setArea] = useState<Area>("onboarding");
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [live, setLive] = useState<LiveState | null>(null);
  const [dataError, setDataError] = useState("");
  const [sessions, setSessions] = useState<Partial<Record<Thread, string>>>(() => {
    try { return JSON.parse(window.sessionStorage.getItem(DEMO_SESSIONS_KEY) || "{}"); }
    catch { return {}; }
  });
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const openedThread = useRef<Thread | null>(null);
  const thread: Thread = area === "workspace" ? "workspace" : "onboarding";

  async function refreshState() {
    try {
      setLive(await json<LiveState>("/api/demo/state"));
      setDataError("");
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "Could not load live records");
    }
  }

  useEffect(() => {
    void json<{ ok: boolean }>("/api/auth/me").then((result) => setAuthed(result.ok)).catch(() => setAuthed(false));
  }, []);
  useEffect(() => {
    if (!authed) return;
    void refreshState();
  }, [authed]);
  useEffect(() => {
    if (!authed || !studio.inboxReady || !studio.agents.length || openedThread.current === thread) return;
    openedThread.current = thread;
    const saved = sessions[thread];
    if (saved && studio.sessions.some((session) => session.id === saved && session.agentId === "orchestrator")) studio.openSession(saved);
    else {
      studio.setSessionId("");
      studio.setHistory([]);
      studio.setView("chat");
      studio.pickAgent("orchestrator");
    }
  }, [authed, thread, studio, sessions]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ block: "end" }); }, [studio.history, area]);

  async function unlock(event: FormEvent) {
    event.preventDefault();
    setAuthError("");
    try {
      await json("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
      window.location.reload();
    } catch (error) { setAuthError(error instanceof Error ? error.message : "Could not unlock"); }
  }

  function addFiles(picked: FileList | null) {
    if (!picked) return;
    const valid = Array.from(picked).filter((file) => (file.type === "application/pdf" || file.type.startsWith("image/")) && file.size <= 8 * 1024 * 1024);
    if (valid.length !== picked.length) setDataError("Use PDF or image files, up to 8 MB each.");
    setAttachments((old) => [...old, ...valid].slice(0, 6));
    if (fileInput.current) fileInput.current.value = "";
  }

  async function sendMessage(text = draft) {
    const content = text.trim();
    if (!authed || studio.loading || studio.selected.id !== "orchestrator" || openedThread.current !== thread || (!content && !attachments.length)) return;
    const key = thread;
    const chosenFiles = attachments;
    try {
      const files = await Promise.all(chosenFiles.map(fileData));
      setDraft("");
      setAttachments([]);
      await studio.send(content, { files, onSession: (id) => {
        setSessions((old) => {
          const next = { ...old, [key]: id };
          window.sessionStorage.setItem(DEMO_SESSIONS_KEY, JSON.stringify(next));
          return next;
        });
      } });
      await refreshState();
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "Could not prepare the attachment.");
    }
  }

  const company = live?.profile.company;
  const highlights = company ? [
    ["Company", valueText(company.name)], ["Website", valueText(company.website)], ["Headquarters", valueText(company.address)],
  ].filter((item) => item[1]) : [];
  const invoices = (live?.invoices || []).filter((invoice) => `${invoice.number || "Draft"} ${invoice.customer || ""}`.toLowerCase().includes(filter.toLowerCase()));

  return <div className="di-demo">
    <aside className="demo-rail">
      <a href="/demo" className="demo-brand"><span className="demo-brand-mark"><Icon name="spark" size={20}/></span><strong>documentiq</strong></a>
      <nav aria-label="Demo sections">
        <button className={area === "onboarding" ? "active" : ""} onClick={() => setArea("onboarding")} disabled={studio.loading}><Icon name="chat"/> Onboarding</button>
        <button className={area === "people" ? "active" : ""} onClick={() => setArea("people")} disabled={studio.loading}><Icon name="users"/> Company people</button>
        <button className={area === "workspace" ? "active" : ""} onClick={() => setArea("workspace")} disabled={studio.loading}><Icon name="grid"/> Function demo</button>
      </nav>
    </aside>

    <main className="demo-main">
      <header className="demo-topbar"><span>Live workspace</span><a href="/">Back to app <Icon name="arrow" size={15}/></a></header>
      <div className="demo-content">
        <h1>{area === "onboarding" ? "Let's get to know your company" : area === "people" ? "Who should I know?" : "Make work happen"}</h1>
        {area === "onboarding" && <Guide/>}
        {authed === null ? <div className="demo-loading">Connecting to your workspace…</div> : !authed ? <form className="demo-unlock" onSubmit={(event) => void unlock(event)}><h2>Unlock your live workspace</h2><p>This demo uses the real agents and saves changes to your company records.</p><label>Settings password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password"/></label><button className="demo-primary" type="submit">Unlock</button>{authError && <p role="alert" className="demo-error">{authError}</p>}</form> : <>
          <div className="demo-live-note"><span className="demo-live-dot"/> Connected to real agents · Changes are saved to your company workspace</div>
          <div className="demo-layout">
            <section className="demo-chat-card" aria-label="Live agent chat">
              <div className={`demo-card-head${studio.loading ? " is-working" : ""}`}><div className="demo-agent-identity"><span className="demo-agent-avatar"><Icon name="spark" size={17}/></span><strong>{studio.selected.name}</strong></div><button type="button" className="demo-new-chat" onClick={() => {
                setSessions((old) => {
                  const next = { ...old };
                  delete next[thread];
                  window.sessionStorage.setItem(DEMO_SESSIONS_KEY, JSON.stringify(next));
                  return next;
                });
                studio.setSessionId(""); studio.setHistory([]); studio.pickAgent("orchestrator");
              }} disabled={studio.loading || !studio.agents.length}>New chat</button><span className="demo-live-label" role="status" title={studio.loading ? studio.liveStatus : undefined}>{studio.loading ? "Working…" : "Live"}</span></div>
              <div className="demo-chat-scroll">{!studio.history.length && <p className="demo-chat-empty">{area === "onboarding" ? "Share your company profile PDF or website to begin." : area === "people" ? "Share a person’s name, position, department and work contact." : "Ask me to create an invoice or CRM record."}</p>}{studio.history.map((message, index) => <div className={`demo-message ${message.role}`} key={message.id ?? index}><div className="demo-bubble"><ChatCopy text={message.content || (message.streaming ? studio.liveStatus || "Working…" : "")} agentId={studio.selected.id} streaming={message.streaming} onOpen={(src, alt) => studio.setMedia({ src, alt })}/>{message.role === "assistant" && message.blocks?.filter((block) => block.type === "tool" || block.type === "note").map((block, blockIndex) => <div className="demo-agent-activity" key={blockIndex}>{block.type === "tool" ? `${block.running ? "Running" : "Used"} ${block.name}` : block.text}{block.type === "tool" && block.shared_files?.map((file) => <a href={file.url} key={file.id} target="_blank" rel="noopener noreferrer">{file.name}</a>)}</div>)}</div></div>)}{studio.error && <p className="demo-error" role="alert">{studio.error}</p>}<div ref={chatEnd}/></div>
              <div className="demo-composer-wrap">{attachments.length > 0 && <div className="demo-attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`}>{file.name}<button type="button" aria-label={`Remove ${file.name}`} onClick={() => setAttachments((old) => old.filter((_, i) => i !== index))}><Icon name="close" size={12}/></button></span>)}</div>}<form className="demo-composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}><input ref={fileInput} type="file" accept="application/pdf,image/*" multiple hidden onChange={(event) => addFiles(event.target.files)}/><button type="button" className="demo-attach" aria-label="Attach PDF or image" onClick={() => fileInput.current?.click()} disabled={studio.loading}><Icon name="upload" size={18}/></button><input aria-label="Message" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={area === "onboarding" ? "Website or company details…" : area === "people" ? "Share a person’s details…" : "What would you like to create?"} disabled={studio.loading}/><button type="submit" className="demo-send" aria-label="Send message" disabled={studio.loading || studio.selected.id !== "orchestrator"}><Icon name="send" size={17}/></button></form></div>
            </section>
            <aside className="demo-side">
              {dataError && <div className="demo-error" role="alert">{dataError}<button type="button" onClick={() => void refreshState()}>Retry</button></div>}
              {area === "onboarding" && <div className="demo-panel"><div className="demo-panel-head"><h2>Company profile</h2><button type="button" onClick={() => void refreshState()} aria-label="Refresh profile"><Icon name="refresh" size={16}/></button></div>{live ? <><div className="demo-record-list">{highlights.length ? highlights.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>) : <p>No company details saved yet.</p>}</div><button className="demo-link-button" onClick={() => setDetailsOpen(true)}>View all details <Icon name="arrow" size={14}/></button><button className="demo-link-button" onClick={() => setArea("people")}>Continue to company people <Icon name="arrow" size={14}/></button></> : <p>Loading live profile…</p>}</div>}
              {area === "people" && <div className="demo-panel"><div className="demo-panel-head"><h2>Company people</h2><button type="button" onClick={() => void refreshState()} aria-label="Refresh company people"><Icon name="refresh" size={16}/></button></div><div className="demo-record-list">{live?.members.length ? live.members.map((member) => <div key={member.id}><strong>{member.name}</strong><span>{[member.position, member.department].filter(Boolean).join(" · ")}</span><small>{member.email || member.phone}</small></div>) : <p>No company people saved yet. Share a contact in chat.</p>}</div><button className="demo-link-button" onClick={() => setArea("workspace")}>Continue to function demo <Icon name="arrow" size={14}/></button></div>}
              {area === "workspace" && <><div className="demo-panel"><div className="demo-panel-head"><h2>Invoices</h2><button type="button" onClick={() => void refreshState()} aria-label="Refresh invoices"><Icon name="refresh" size={16}/></button></div><div className="demo-actions"><button onClick={() => void sendMessage("I want to create a new invoice. Please guide me through the real invoice workflow and ask for what you need.")} disabled={studio.loading || studio.selected.id !== "orchestrator"}>Create invoice</button><button onClick={() => void sendMessage("I want to add a new CRM customer. Please guide me through the real customer workflow.")} disabled={studio.loading || studio.selected.id !== "orchestrator"}>Add CRM entry</button></div><input className="demo-filter" aria-label="Search invoices" placeholder="Search invoices" value={filter} onChange={(event) => setFilter(event.target.value)}/><div className="demo-table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead><tbody>{invoices.map((invoice) => <tr key={invoice.id}><td>{invoice.number || "Draft"}</td><td>{invoice.customer || "—"}</td><td>{money(invoice.total, invoice.currency)}</td><td>{invoice.status}</td></tr>)}</tbody></table>{!invoices.length && <p>No invoices found in your live database.</p>}</div></div><div className="demo-panel"><div className="demo-panel-head"><h2>Recent CRM customers</h2><span>{live?.customers.length || 0}</span></div><div className="demo-record-list">{live?.customers.length ? live.customers.slice(0, 5).map((customer) => <div key={customer.id}><strong>{customer.name}</strong><span>{customer.email}</span></div>) : <p>No customers saved yet.</p>}</div></div></>}
            </aside>
          </div>
        </>}
      </div>
    </main>
    {detailsOpen && live && <div className="demo-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsOpen(false); }}><div className="demo-drawer" role="dialog" aria-modal="true" aria-label="Company profile details"><div className="demo-panel-head"><h2>Company profile</h2><button type="button" aria-label="Close profile details" onClick={() => setDetailsOpen(false)}><Icon name="close" size={18}/></button></div><p>{live.profile.readiness.minimum_ready ? "Minimum setup complete" : `Still needed: ${live.profile.readiness.missing.map((item) => item.label).join(", ")}`}</p><div className="demo-record-list">{live.profile.fields.map((field) => <div key={field.key}><span>{field.label}</span><strong>{valueText(live.profile.company[field.key]) || "—"}</strong></div>)}</div><a href="/company-profile/" className="demo-primary">Edit company profile <Icon name="arrow" size={15}/></a></div></div>}
    {studio.media && <div className="demo-media-viewer" role="dialog" aria-modal="true" aria-label={studio.media.alt || "Image preview"}><button type="button" aria-label="Close image preview" onClick={() => studio.setMedia(null)}><Icon name="close" size={18}/></button><img src={studio.media.src} alt={studio.media.alt || "Attached image"}/></div>}
  </div>;
}
