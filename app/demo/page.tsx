import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChatCopy } from "../chat-markdown";
import { useStudio } from "../use-studio";
import "./style.css";
import "./calendar.css";
import { ExpensesPanel } from "./expenses";
import { ProcurementPanel } from "./procurement";
import { ResearchPanel } from "./research";
import { SignalReportsPanel } from "./signals";
import { ObservabilityPanel } from "./observability";
import { SchedulesPanel } from './schedules';
import "./theme.css";

type Area = "home" | "onboarding" | "people" | "calendar" | "schedules" | "expenses" | "procurement" | "research" | "signals" | "logs" | "usage" | "activity";
const navigation: { area: Area; label: string; icon: string }[] = [
  { area: "home", label: "Home", icon: "home" },
  { area: "onboarding", label: "Company profile", icon: "chat" },
  { area: "people", label: "Company people", icon: "users" },
  { area: "calendar", label: "Company calendar", icon: "calendar" },
  { area: 'schedules', label: 'Schedules', icon: 'clock' },
  { area: "expenses", label: "Expenses", icon: "file" },
  { area: "procurement", label: "Procurement", icon: "database" },
  { area: "research", label: "Research library", icon: "file" },
  { area: "signals", label: "Company signals", icon: "trend" },
];
const insights: { area: Area; label: string; icon: string }[] = [
  { area: "logs", label: "Chat history", icon: "clock" },
  { area: "usage", label: "Usage", icon: "grid" },
  { area: "activity", label: "Activity", icon: "database" },
];
const validAreas = new Set<Area>([...navigation, ...insights].map(item => item.area));
const logHeadings = {
  logs: { title: "Chat logs", description: "Browse saved conversations and delegated agent transcripts." },
  usage: { title: "Usage Dashboard", description: "Track API calls, tokens, and usage by provider and model." },
  activity: { title: "Activity log", description: "Review agent turns, tool calls, results, and failures." },
};
type CalendarEvent = { id: string; kind: string; title: string; start: string; end: string; allDay: boolean; timezone: string; status: string; severity: string; source: { table: string; recordId: string; field: string }; detail: Record<string, unknown>; warnings: string[]; needsReview: boolean };
type Profile = { name: string; legalName: string; registration: string; country: string; businessType: string; businessActivity: string; website: string; email: string; phone: string; headquarters: string; billingAddress: string; currency: string; taxStatus: string; tin: string; paymentTerms: string };
type CompanyMember = { id: string; member_id?: string | null; user_id?: string | null; name: string; position: string; department: string; email: string; phone: string; location: string; username?: string | null; has_login?: boolean; login_active?: boolean; role?: string | null };
type MemberDraft = Omit<CompanyMember, "id" | "user_id" | "has_login" | "login_active"> & { id?: string; user_id?: string | null; has_login?: boolean; login_enabled?: boolean; username?: string; new_password?: string; role?: "admin" | "department_head" | "user" };

const initialProfile: Profile = { name: "", legalName: "", registration: "", country: "MY", businessType: "", businessActivity: "", website: "", email: "", phone: "", headquarters: "", billingAddress: "", currency: "MYR", taxStatus: "", tin: "", paymentTerms: "" };
const emptyMember: MemberDraft = { name: "", position: "", department: "", email: "", phone: "", location: "", login_enabled: false, username: "", new_password: "", role: "user" };
const profileSections: { title: string; description: string; fields: { key: keyof Profile; label: string; hint: string }[] }[] = [
  { title: "Business identity", description: "Who you are and what you do", fields: [
    { key: "name", label: "Company name", hint: "Trading name" }, { key: "legalName", label: "Legal name", hint: "Registered name, if different" },
    { key: "registration", label: "Registration no.", hint: "Business registration ID" }, { key: "country", label: "Country code", hint: "e.g. MY" },
    { key: "businessType", label: "Business type", hint: "Products, services or both" }, { key: "businessActivity", label: "Business activity", hint: "What your company does" },
  ] },
  { title: "Contact & online", description: "How customers can reach you", fields: [
    { key: "website", label: "Website", hint: "https://example.com" }, { key: "email", label: "Business email", hint: "hello@example.com" },
    { key: "phone", label: "Business phone", hint: "+60 ..." },
  ] },
  { title: "Locations", description: "Where your business operates", fields: [
    { key: "headquarters", label: "Headquarters", hint: "Main office address" }, { key: "billingAddress", label: "Billing address", hint: "Printed on invoices" },
  ] },
  { title: "Invoicing", description: "Defaults used on documents", fields: [
    { key: "currency", label: "Currency", hint: "e.g. MYR" }, { key: "taxStatus", label: "Tax status", hint: "Registered, exempt, not registered" },
    { key: "tin", label: "Tax ID / TIN", hint: "If applicable" }, { key: "paymentTerms", label: "Payment terms", hint: "e.g. 30 days" },
  ] },
];
const profileLabels = profileSections.flatMap((section) => section.fields);
const guidedKeys: (keyof Profile)[] = ["name", "businessType", "businessActivity", "email", "billingAddress", "taxStatus"];

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    home: <><path d="m3 10 9-7 9 7v10H3V10Z"/><path d="M9 20v-7h6v7"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    logout: <><path d="M9 3H4v18h5M14 8l5 4-5 4M8 12h11"/></>,
    spark: <><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"/><path d="m19 17 .6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6L19 17Z"/></>,
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-2 2v-7.5A7.5 7.5 0 1 1 20 11.5Z"/><path d="M7 10h9M7 14h6"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    file: <><path d="M6 2h8l5 5v14H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v6h5M8 13h8M8 17h6"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2H3ZM16 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 4 5"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M6 20v-1a6 6 0 0 1 12 0v1"/></>,
    upload: <><path d="M12 16V3m0 0L7 8m5-5 5 5"/><path d="M4 16v4h16v-4"/></>,
    send: <><path d="m3 11 18-8-8 18-2-8-8-2Z"/><path d="M11 13 21 3"/></>,
    check: <path d="m4 12 5 5L20 6"/>,
    plus: <path d="M12 4v16M4 12h16"/>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    close: <path d="M5 5 19 19M19 5 5 19"/>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></>,
    calendar: <><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></>,
    download: <><path d="M12 3v13m0 0-5-5m5 5 5-5M4 18v3h16v-3"/></>,
    trend: <><path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function CalendarPanel() {
  const [cursor, setCursor] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [kind, setKind] = useState("all");
  const [source, setSource] = useState("all");
  const [includeDemo, setIncludeDemo] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const loadVersion = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const monthLabel = cursor.toLocaleDateString("en", { month: "long", year: "numeric" });
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const from = `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const to = `${year}-${String(month + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
  const visible = events.filter((event) => kind === "all" || event.kind === kind);
  const byDay = new Map<string, CalendarEvent[]>();
  visible.forEach((event) => byDay.set(event.start, [...(byDay.get(event.start) || []), event]));
  const cells = Array.from({ length: (first.getDay() + last.getDate() + 6) - ((first.getDay() + last.getDate() + 6) % 7) }, (_, index) => {
    const day = index - first.getDay() + 1;
    return day > 0 && day <= last.getDate() ? `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}` : null;
  });
  const load = async () => {
    const version = ++loadVersion.current;
    setLoading(true); setError(""); setSelectedEventId(null);
    try {
      const query = new URLSearchParams({ from, to, include_demo: String(includeDemo) });
      if (source !== "all") query.set("sources", source);
      const data = await demoJson<{ events: CalendarEvent[]; refreshedAt: string }>(`/api/demo/calendar?${query}`);
      if (version !== loadVersion.current) return;
      setEvents(data.events); setRefreshedAt(data.refreshedAt);
      setSelected((old) => old && data.events.some((event) => event.start === old) ? old : data.events[0]?.start || null);
    } catch (err) { if (version === loadVersion.current) setError(err instanceof Error ? err.message : "Could not load calendar"); }
    finally { if (version === loadVersion.current) setLoading(false); }
  };
  useEffect(() => { void load(); return () => { loadVersion.current += 1; }; }, [from, to, source, includeDemo]);
  const selectedEvents = visible.filter((event) => event.start === selected);
  const selectedEvent = visible.find((event) => event.id === selectedEventId) || null;
  return <section className="calendar-panel" aria-label="Company calendar"><div className="calendar-head"><div><div className="demo-panel-kicker"><Icon name="calendar" size={16}/> COMPANY CALENDAR</div><h2>{monthLabel}</h2><p>Dates from selected company records. Refresh to read the latest deadlines.</p></div><div className="calendar-actions"><button className="calendar-today" disabled={loading} onClick={() => void load()}>Refresh</button><button className="demo-icon-button" onClick={() => setCursor(new Date(year, month - 1, 1))} aria-label="Previous month">←</button><button className="calendar-today" onClick={() => { const now = new Date(); setCursor(new Date(now.getFullYear(), now.getMonth(), 1)); }}>Today</button><button className="demo-icon-button" onClick={() => setCursor(new Date(year, month + 1, 1))} aria-label="Next month">→</button></div></div><div className="calendar-toolbar" style={{ flexWrap: "wrap", gap: 12 }}><span>{loading ? "Reading company records…" : `${visible.length} date${visible.length === 1 ? "" : "s"}`}</span><select aria-label="Calendar sources" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option><option value="sales">Sales deadlines</option><option value="procurement">Procurement deadlines</option><option value="payments">Payment history</option><option value="forms">Form deadlines</option></select><label><input type="checkbox" checked={includeDemo} onChange={(event) => setIncludeDemo(event.target.checked)}/> Include demo records</label><select aria-label="Filter calendar events" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All dates</option><option value="quotation_expiry">Quotation expiry</option><option value="payment_due">Payment due</option><option value="delivery_due">Deliveries due</option><option value="payment_received">Payments received</option><option value="reminder">Reminders</option></select>{refreshedAt && <small>Last refreshed {new Date(refreshedAt).toLocaleTimeString("en-MY")}</small>}</div>{error && <div className="calendar-error" role="alert">{error}</div>}<div className="calendar-layout"><div className="calendar-grid" aria-label={monthLabel}><div className="calendar-weekdays">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-cells">{cells.map((date, index) => { const dayEvents = date ? byDay.get(date) || [] : []; return <button key={`${date || "blank"}-${index}`} className={`calendar-cell${date === selected ? " selected" : ""}${!date ? " blank" : ""}`} disabled={!date} onClick={() => date && setSelected(date)} aria-label={date || "Outside month"}>{date && <><strong>{Number(date.slice(-2))}</strong><div className="calendar-dots">{dayEvents.slice(0, 3).map((event) => <i key={event.id} className={event.kind}/>)}</div>{dayEvents.length > 3 && <small>+{dayEvents.length - 3}</small>}</>}</button>; })}</div></div><aside className="calendar-agenda"><div className="calendar-agenda-head"><span>{selected ? new Date(`${selected}T00:00:00`).toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" }) : "Select a date"}</span><strong>{selectedEvents.length}</strong></div>{selectedEvents.length === 0 && !loading && <div className="calendar-empty">No dates on this day.<br/><small>Use the arrows to explore the next due dates.</small></div>}{selectedEvents.map((event) => <button className="calendar-event" key={event.id} onClick={() => { setSelected(event.start); setSelectedEventId(event.id); }}><span className={`calendar-event-mark ${event.kind}`}/><span><strong>{event.title}</strong><small>{String(event.detail.customer || event.detail.supplier || event.detail.form || event.detail.number || event.detail.label || event.source.field || "Company record")}</small>{event.needsReview && <em>Needs review</em>}</span></button>)}{selectedEvent && <div className="calendar-detail" role="dialog" aria-label="Calendar event details"><div><strong>{selectedEvent.title}</strong><button onClick={() => setSelectedEventId(null)} aria-label="Close event details">×</button></div><dl><dt>Date</dt><dd>{selectedEvent.start}{selectedEvent.detail.sourceDate && selectedEvent.detail.sourceDate !== selectedEvent.start ? ` · source ${String(selectedEvent.detail.sourceDate)}` : ""}</dd><dt>Status</dt><dd>{selectedEvent.status}</dd><dt>Source</dt><dd>{selectedEvent.source.table} · {selectedEvent.source.field}</dd>{Boolean(selectedEvent.detail.customer) && <><dt>Customer</dt><dd>{String(selectedEvent.detail.customer)}</dd></>}{Boolean(selectedEvent.detail.supplier) && <><dt>Supplier</dt><dd>{String(selectedEvent.detail.supplier)}</dd></>}{selectedEvent.detail.balance !== undefined && <><dt>Balance</dt><dd>{String(selectedEvent.detail.balance)}</dd></>}{selectedEvent.warnings.length > 0 && <><dt>Review</dt><dd>{selectedEvent.warnings.join("; ")}</dd></>}</dl></div>}</aside></div></section>;
}


function nextMissing(profile: Profile) {
  return profileLabels.find(({ key }) => guidedKeys.includes(key) && !String(profile[key]).trim());
}

function recordProfile(profile: Profile, input: string): { profile: Profile; recorded: string | null } {
  const value = input.trim().replace(/[.\s]+$/, "");
  const next = { ...profile };
  const email = value.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
  const website = value.match(/https?:\/\/[^\s]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i)?.[0];
  const currency = value.match(/\b(MYR|USD|EUR|GBP|SGD|AUD)\b/i)?.[0];
  const registration = value.match(/(?:registration|reg\.?\s*(?:no\.?|number)?|ssm)\s*(?:is|:|#)?\s*([A-Z0-9-]{5,})/i)?.[1];
  const named = (pattern: RegExp) => value.match(pattern)?.[1]?.trim();
  const branch = named(/(?:branch|outlet)(?:\s+(?:at|in))?\s*(?:is|:)?\s+(.+)/i);
  if (branch) return { profile: next, recorded: `branch:${branch}` };
  const headquarters = named(/(?:headquarters|head office|hq)\s*(?:is|at|:)?\s+(.+)/i);
  if (headquarters) { next.headquarters = headquarters; return { profile: next, recorded: "Headquarters" }; }
  const billing = named(/(?:billing|invoice)\s+address\s*(?:is|:)?\s+(.+)/i);
  if (billing) { next.billingAddress = billing; return { profile: next, recorded: "Billing address" }; }
  if (email) { next.email = email; return { profile: next, recorded: "Business email" }; }
  if (website && /website|site|url|https?:/i.test(value)) { next.website = website.startsWith("http") ? website : `https://${website}`; return { profile: next, recorded: "Website" }; }
  if (registration) { next.registration = registration; return { profile: next, recorded: "Registration number" }; }
  if (currency && /currency|invoice|use|prefer/i.test(value)) { next.currency = currency.toUpperCase(); return { profile: next, recorded: "Currency" }; }
  const phone = named(/(?:phone|telephone|tel)\s*(?:is|:)?\s+([+\d][\d\s()-]{5,})/i);
  if (phone) { next.phone = phone; return { profile: next, recorded: "Business phone" }; }
  const legalName = named(/legal\s+name\s*(?:is|:)?\s+(.+)/i);
  if (legalName) { next.legalName = legalName; return { profile: next, recorded: "Legal name" }; }
  const tax = named(/tax\s+status\s*(?:is|:)?\s+(.+)/i);
  if (tax) { next.taxStatus = tax; return { profile: next, recorded: "Tax status" }; }
  const tin = named(/(?:tax\s+id|tin)\s*(?:is|:)?\s+(.+)/i);
  if (tin) { next.tin = tin; return { profile: next, recorded: "Tax ID" }; }
  const terms = named(/payment\s+terms\s*(?:are|is|:)?\s+(.+)/i);
  if (terms) { next.paymentTerms = terms; return { profile: next, recorded: "Payment terms" }; }
  const businessType = named(/business\s+type\s*(?:is|:)?\s+(.+)/i);
  if (businessType) { next.businessType = businessType; return { profile: next, recorded: "Business type" }; }
  const activity = named(/(?:business\s+activity|we\s+(?:sell|provide|offer))\s*(?:is|:)?\s+(.+)/i);
  if (activity) { next.businessActivity = activity; return { profile: next, recorded: "Business activity" }; }
  if (/^(?:my |our )?(?:company|business|name)\s*(?:is|:)?\s*/i.test(value)) {
    next.name = value.replace(/^(?:my |our )?(?:company|business|name)\s*(?:is|:)?\s*/i, "").trim();
    if (next.name) return { profile: next, recorded: "Company name" };
  }
  if (/^(?:address|we are located at|located at)\s*(?:is|:)?\s*/i.test(value)) {
    next.billingAddress = value.replace(/^(?:address|we are located at|located at)\s*(?:is|:)?\s*/i, "").trim();
    if (next.billingAddress) return { profile: next, recorded: "Billing address" };
  }
  const missing = nextMissing(next);
  if (missing && value.length < 140 && !/[?]/.test(value)) {
    next[missing.key] = value;
    return { profile: next, recorded: missing.label };
  }
  return { profile: next, recorded: null };
}

function recordMember(current: MemberDraft, input: string) {
  const next = { ...current };
  let matched = false;
  for (const piece of input.split(/[;\n]+/)) {
    const field = piece.match(/^\s*(name|position|job title|department|email|phone|location)\s*:\s*(.+?)\s*$/i);
    if (!field) continue;
    const key = ({ "job title": "position" } as Record<string, "name" | "position" | "department" | "email" | "phone" | "location">)[field[1].toLowerCase()] || field[1].toLowerCase() as "name" | "position" | "department" | "email" | "phone" | "location";
    next[key] = field[2].trim();
    matched = true;
  }
  if (!matched) {
    const email = input.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0];
    const phone = input.match(/(?:phone|mobile|tel)\s*(?:is|:)?\s*([+\d][\d\s()-]{5,})/i)?.[1] || input.match(/^\s*(\+?[\d\s()-]{7,})\s*$/)?.[1];
    const labelled = input.match(/^(?:my |our )?(name|position|job title|department|location)\s*(?:is|:)?\s+(.+)$/i);
    if (email) { next.email = email; matched = true; }
    if (phone) { next.phone = phone.trim(); matched = true; }
    if (labelled) {
      const key = labelled[1].toLowerCase() === "job title" ? "position" : labelled[1].toLowerCase() as "name" | "position" | "department" | "location";
      next[key] = labelled[2].trim();
      matched = true;
    }
  }
  if (!matched && input.trim() && !input.includes("?")) {
    const key = (["name", "position", "department"] as const).find((field) => !next[field]);
    if (key) next[key] = input.trim();
  }
  return next;
}

function hasMemberContact(member: Omit<CompanyMember, "id">) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(member.email.trim()) || member.phone.replace(/\D/g, "").length >= 7;
}

function nextMemberQuestion(member: Omit<CompanyMember, "id">) {
  if (!member.name) return "What is their name?";
  if (!member.position) return `What is ${member.name}'s position?`;
  if (!member.department) return `Which department does ${member.name} work in?`;
  if (!hasMemberContact(member)) return `What is ${member.name}'s work email or phone?`;
  return null;
}

function OnboardingPanel({ profile, setProfile, doneCount, essentialCount, onSave, onNavigate }: {
  profile: Profile;
  setProfile: React.Dispatch<React.SetStateAction<Profile>>;
  doneCount: number;
  essentialCount: number;
  onSave: (key: keyof Profile, value: string) => void;
  onNavigate: () => void;
}) {
  return <aside className="demo-side">
    <div className="demo-panel profile-panel">
      <div className="demo-panel-kicker"><Icon name="grid" size={16}/> LIVE PROFILE</div>
      <h2>What we’ve recorded</h2>
      <p>Business details appear here as you chat. Edit any field directly.</p>
      <div className="demo-profile-summary"><div><strong>{doneCount}</strong><span>details recorded</span></div><div><strong>{essentialCount}/8</strong><span>setup essentials</span></div></div>
      <div className="demo-progress-head"><strong>Essential setup</strong><span>{Math.round(essentialCount / 8 * 100)}%</span></div>
      <div className="demo-progress"><div style={{ width: `${essentialCount / 8 * 100}%` }}/></div>
      {profileSections.map((section) => <div className="demo-profile-section" key={section.title}>
        <div className="demo-section-heading"><div><h3>{section.title}</h3><p>{section.description}</p></div><span>{section.fields.filter(({ key }) => String(profile[key]).trim()).length}/{section.fields.length}</span></div>
        <div className="demo-profile-grid">{section.fields.map(({ key, label, hint }) => <label className="demo-profile-field" key={key}>
          <span className="demo-field-icon">{profile[key] ? <Icon name="check" size={13}/> : <span/>}</span>
          <span className="demo-field-text"><strong>{label}</strong>{key === "businessType" || key === "taxStatus" ? <select aria-label={label} value={profile[key]} onChange={(event) => { setProfile((old) => ({ ...old, [key]: event.target.value })); onSave(key, event.target.value); }}><option value="">{hint}</option>{(key === "businessType" ? [["products", "Products"], ["services", "Services"], ["both", "Both"]] : [["not_registered", "Not registered"], ["registered", "Registered"], ["exempt", "Exempt"], ["needs_review", "Needs review"]]).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select> : <input aria-label={label} value={profile[key]} placeholder={hint} onChange={(event) => setProfile((old) => ({ ...old, [key]: event.target.value }))} onBlur={(event) => onSave(key, event.target.value)}/>}</span>
        </label>)}</div>
      </div>)}
    </div>
    <div className="demo-next-card"><span className="demo-next-icon"><Icon name="spark" size={20}/></span><div><strong>{essentialCount === 8 ? "Profile basics are in place" : "Next: company people"}</strong><p>{essentialCount === 8 ? "Now record who works at your company." : "You can finish the profile later. Add a key person next."}</p><button onClick={onNavigate}>Continue to company people <Icon name="arrow" size={15}/></button></div></div>
  </aside>;
}

function PeoplePanel({ members, draft, setDraft, onSave, onNavigate, onNotice, isAdmin }: {
  members: CompanyMember[];
  draft: MemberDraft;
  setDraft: React.Dispatch<React.SetStateAction<MemberDraft>>;
  onSave: (event: FormEvent) => void;
  onNavigate: () => void;
  onNotice: (message: string) => void;
  isAdmin: boolean;
}) {
  const vcardInput = useRef<HTMLInputElement>(null);
  const importVcard = async (file?: File) => {
    if (!file) return;
    const content = await file.text();
    if (!/BEGIN:VCARD/i.test(content)) { onNotice("Choose a .vcf contact card."); return; }
    const read = (key: string) => content.match(new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, "im"))?.[1]?.trim() || "";
    const org = read("ORG").split(";");
    setDraft((old) => ({ ...old, name: read("FN") || old.name, position: read("TITLE") || old.position, department: org[1] || old.department, email: read("EMAIL") || old.email, phone: read("TEL") || old.phone }));
    onNotice("Contact card loaded. Review the details, then save.");
    if (vcardInput.current) vcardInput.current.value = "";
  };
  return <aside className="demo-side">
    <div className="demo-panel people-panel">
      <div className="demo-panel-kicker"><Icon name="users" size={16}/> ONBOARDING · STEP 02</div>
      <div className="demo-people-title"><div><h2>People & access</h2><p>Manage your internal team details in one place. CRM customer contacts stay separate.</p></div><span>{members.length} saved</span></div>
      <div className="demo-person-list">{members.length ? members.map((member) => <div className="demo-person-card" key={member.id}><span className="demo-person-avatar">{member.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</span><div><strong>{member.name}</strong><span>{[member.position, member.department].filter(Boolean).join(" · ")}</span><small>{member.email || member.phone}{member.location ? ` · ${member.location}` : ""}</small><small className="demo-person-access">{member.has_login ? `Login: ${member.username}${member.login_active ? " · active" : " · disabled"}` : "Contact-only · no login"}</small></div><button type="button" className="demo-person-edit" disabled={!isAdmin && !member.member_id} onClick={() => setDraft({ id: member.member_id || undefined, user_id: member.user_id, name: member.name, position: member.position, department: member.department, email: member.email, phone: member.phone, location: member.location, login_enabled: Boolean(member.has_login && member.login_active), username: member.username || "", new_password: "", role: member.role === "admin" || member.role === "department_head" ? member.role : "user" })}>Edit</button></div>) : <div className="demo-person-empty"><Icon name="users" size={23}/><strong>No company people recorded yet</strong><span>Share a contact through chat, the form, or a vCard.</span></div>}</div>
      <div className="demo-person-form-heading"><div><strong>Share a company contact</strong><span>Start with a key person. Add others any time.</span></div><input ref={vcardInput} type="file" accept=".vcf,text/vcard" hidden onChange={(event) => void importVcard(event.target.files?.[0])}/><button type="button" onClick={() => vcardInput.current?.click()}><Icon name="upload" size={14}/> Import .vcf</button></div>
      <form className="demo-person-form" onSubmit={onSave}>
        <label>Full name<input required value={draft.name} onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value }))} placeholder="e.g. Maya Tan"/></label>
        <label>Position<input required value={draft.position} onChange={(event) => setDraft((old) => ({ ...old, position: event.target.value }))} placeholder="e.g. Operations Manager"/></label>
        <label>Department<input required value={draft.department} onChange={(event) => setDraft((old) => ({ ...old, department: event.target.value }))} placeholder="e.g. Operations"/></label>
        <label>Location<input value={draft.location} onChange={(event) => setDraft((old) => ({ ...old, location: event.target.value }))} placeholder="HQ or branch (optional)"/></label>
        <label>Work email<input type="email" value={draft.email} onChange={(event) => setDraft((old) => ({ ...old, email: event.target.value }))} placeholder="maya@company.com"/></label>
        <label>Work phone<input value={draft.phone} onChange={(event) => setDraft((old) => ({ ...old, phone: event.target.value }))} placeholder="+60 ..."/></label>
        <p>Provide at least one work email or phone.</p>
        {isAdmin && <fieldset className="demo-person-access-form"><legend>Workspace login (optional)</legend><label><input type="checkbox" checked={Boolean(draft.login_enabled)} onChange={(event) => setDraft((old) => ({ ...old, login_enabled: event.target.checked }))}/> Enable login for this person</label>{draft.login_enabled && <><label>Username<input autoComplete="username" value={draft.username || ""} onChange={(event) => setDraft((old) => ({ ...old, username: event.target.value }))} placeholder="e.g. maya.tan"/></label><label>New password<input type="password" autoComplete="new-password" value={draft.new_password || ""} onChange={(event) => setDraft((old) => ({ ...old, new_password: event.target.value }))} placeholder={draft.id ? "Leave blank to keep current password" : "At least 4 characters"}/></label><label>Role<select value={draft.role || "user"} onChange={(event) => setDraft((old) => ({ ...old, role: event.target.value as "admin" | "department_head" | "user" }))}><option value="user">User</option><option value="department_head">Department head</option><option value="admin">Superadmin</option></select></label></>}</fieldset>}
        <button className="demo-primary" type="submit"><Icon name="plus" size={16}/> {draft.id ? "Update person" : "Save person"}</button>
      </form>
    </div>
    <div className="demo-next-card"><span className="demo-next-icon"><Icon name="spark" size={20}/></span><div><strong>{members.length ? "Your team is on record" : "Add a key contact"}</strong><p>{members.length ? "Future tasks can refer to the right person and department." : "You can continue and add people later."}</p><button onClick={onNavigate}>Back to Home <Icon name="arrow" size={15}/></button></div></div>
  </aside>;
}

type DemoState = {
  profile: { company: Record<string, unknown>; readiness: { minimum_ready: boolean } };
  members: Array<Record<string, unknown>>;
  people?: Array<Record<string, unknown>>;
  customers: Array<Record<string, unknown>>;
  invoices: Array<Record<string, unknown>>;
};

async function demoJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? { credentials: "include" } : {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || (response.status === 401 ? "Please sign in to use this demo." : "Demo request failed"));
  return data;
}

const profileFields: Record<keyof Profile, string | null> = {
  name: "name", legalName: "legal_name", registration: "reg_no", country: "country", businessType: "business_type",
  businessActivity: "business_activity", website: "website", email: "email", phone: "phone", headquarters: "address",
  billingAddress: "address", currency: "currency", taxStatus: "tax_status", tin: "tin", paymentTerms: "payment_terms_days",
};

function profileFromDb(raw: Record<string, unknown>): Profile {
  const address = raw.address;
  const addressText = typeof address === "string" ? address : address && typeof address === "object"
    ? Object.values(address).filter(Boolean).join(", ") : "";
  return {
    name: String(raw.name || ""), legalName: String(raw.legal_name || ""), registration: String(raw.reg_no || ""),
    country: String(raw.country || ""), businessType: String(raw.business_type || ""), businessActivity: String(raw.business_activity || ""),
    website: String(raw.website || ""), email: String(raw.email || ""), phone: String(raw.phone || ""),
    headquarters: addressText, billingAddress: addressText, currency: String(raw.currency || "MYR"),
    taxStatus: String(raw.tax_status || ""), tin: String(raw.tin || ""), paymentTerms: raw.payment_terms_days == null ? "" : String(raw.payment_terms_days),
  };
}

type DemoUser = { id: string; username: string; display_name: string; role: string; tier: string };

export default function DemoPage({ initialArea = "home" }: { initialArea?: Area } = {}) {
  const requestedArea = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("area") as Area | null : null;
  const resolvedArea = requestedArea && validAreas.has(requestedArea) ? requestedArea : initialArea;
  const [user, setUser] = useState<DemoUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void demoJson<{ user: DemoUser }>("/api/demo/me").then(data => setUser(data.user)).catch(() => {}).finally(() => setChecking(false)); }, []);
  const login = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const data = await demoJson<{ user: DemoUser }>("/api/demo/login", { username, password });
      setPassword(""); setUser(data.user);
      const returnTo = new URLSearchParams(window.location.search).get("returnTo");
      if (returnTo) {
        const destination = new URL(returnTo, window.location.origin);
        if (destination.origin === window.location.origin && ["/", "/mobile", "/mobile/"].includes(destination.pathname)) {
          window.location.assign(destination.href);
        }
      }
    }
    catch (error) { setError(error instanceof Error ? error.message : "Sign in failed"); }
    finally { setBusy(false); }
  };
  if (checking) return <div className="demo-login"><p role="status">Checking login…</p></div>;
  if (!user) return <div className="demo-login"><form onSubmit={login}><img src="/branding/e-logo.png" alt="e"/><h1>Sign in</h1><p>Open your AI workspace.</p><label>Username<input autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)}/></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)}/></label>{error && <p role="alert">{error}</p>}<button className="demo-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button></form></div>;
  return <DemoWorkspace key={user.id} user={user} initialArea={resolvedArea} onLogout={async () => { await demoJson("/api/demo/logout", {}); window.sessionStorage.removeItem(`di-demo-session-${user.id}`); window.location.assign("/demo"); }}/ >;
}

function DemoWorkspace({ user, initialArea = "home", onLogout }: { user: DemoUser; initialArea?: Area; onLogout: () => Promise<void> }) {
  const studio = useStudio({ userId: user.id });
  const [area, setArea] = useState<Area>(initialArea);
  const logArea = area === "logs" || area === "usage" || area === "activity" ? area : null;
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("area", area);
    window.history.replaceState(null, "", url);
  }, [area]);
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [companyMembers, setCompanyMembers] = useState<CompanyMember[]>([]);
  const [memberDraft, setMemberDraft] = useState<MemberDraft>(emptyMember);
  const [ready, setReady] = useState(false);
  const restoredSession = useRef(false);
  const profileRevision = useRef<number>(0);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [notice, setNotice] = useState("");
  const [chatSearch, setChatSearch] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const doneCount = profileLabels.filter(({ key }) => String(profile[key]).trim()).length;
  const essentialCount = [profile.name, profile.country, profile.businessType, profile.businessActivity, profile.email || profile.phone, profile.billingAddress, profile.currency, profile.taxStatus].filter(Boolean).length;

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [studio.history, area]);
  useEffect(() => { if (notice) { const timer = window.setTimeout(() => setNotice(""), 4500); return () => window.clearTimeout(timer); } }, [notice]);

  const loadState = async () => {
    const data = await demoJson<DemoState>("/api/demo/state");
    profileRevision.current = Number(data.profile.company.revision || 0);
    setProfile(profileFromDb(data.profile.company));
    const people = data.people || data.members;
    setCompanyMembers(people.map((member) => ({ id: String(member.id || member.user_id), member_id: member.member_id ? String(member.member_id) : null, user_id: member.user_id ? String(member.user_id) : null, name: String(member.name || member.display_name || ""),
      position: String(member.position || ""), department: String(member.department || ""), email: String(member.email || ""),
      phone: String(member.phone || ""), location: String(member.location || ""), username: member.username ? String(member.username) : null,
      has_login: Boolean(member.has_login), login_active: Boolean(member.login_active), role: member.role ? String(member.role) : null })));
    setReady(true);
  };

  useEffect(() => {
    void loadState().catch((error) => setNotice(error instanceof Error ? error.message : "Document Intelligence is unavailable"));
  }, []);

  useEffect(() => {
    if (!studio.inboxReady || restoredSession.current) return;
    restoredSession.current = true;
    const stored = window.sessionStorage.getItem(`di-demo-session-${user.id}`);
    if (stored && studio.sessions.some((session) => session.id === stored && session.userId === user.id)) studio.openSession(stored);
    else {
      if (stored) window.sessionStorage.removeItem(`di-demo-session-${user.id}`);
      studio.setView("chat");
    }
  }, [studio, user.id]);

  useEffect(() => {
    if (studio.sessionId) window.sessionStorage.setItem(`di-demo-session-${user.id}`, studio.sessionId);
  }, [studio.sessionId, user.id]);

  const saveProfile = async (key: keyof Profile, rawValue: string) => {
    const field = profileFields[key];
    if (!field) return;
    const value = field === "payment_terms_days" ? (rawValue.trim() ? Number(rawValue) : "") : rawValue;
    try {
      await demoJson("/api/demo/action", { action: "profile", key: field, value, revision: profileRevision.current });
      await loadState();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save profile");
      await loadState().catch(() => {});
    }
  };

  const addFiles = (picked: FileList | null) => {
    if (!picked) return;
    const valid = Array.from(picked).filter((file) => file.type === "application/pdf" || file.type.startsWith("image/"));
    if (valid.length !== picked.length) setNotice("Only PDF and image files are accepted.");
    if (valid.some((file) => file.size > 8 * 1024 * 1024)) setNotice("Each file must be under 8 MB.");
    setAttachments((old) => [...old, ...valid.filter((file) => file.size <= 8 * 1024 * 1024)].slice(0, 4));
    if (fileInput.current) fileInput.current.value = "";
  };

  const sendMessage = async (text = draft) => {
    const content = text.trim();
    if (studio.loading || !studio.agents.length || (!content && !attachments.length)) return;
    const files = attachments;
    try {
      const payload = await Promise.all(files.map(async (file) => ({ name: file.name, mime: file.type, data: await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`)); reader.readAsDataURL(file);
      }) })));
      setDraft(""); setAttachments([]);
      await studio.send(content, { files: payload });
      await loadState();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Chat failed");
    }
  };

  const saveCompanyMember = async (event: FormEvent) => {
    event.preventDefault();
    const draft = Object.fromEntries(Object.entries(memberDraft).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])) as MemberDraft;
    if (!hasMemberContact(draft)) { setNotice("Add a valid work email or phone for this person."); return; }
    if (draft.login_enabled && !draft.id && !draft.new_password) { setNotice("Add a password when enabling a new login."); return; }
    try {
      const person = { id: draft.id, name: draft.name, position: draft.position, department: draft.department, email: draft.email, phone: draft.phone, location: draft.location,
        ...(user.role === "admin" ? { username: draft.login_enabled ? draft.username : undefined, password: draft.new_password || undefined, login_enabled: draft.login_enabled, user_id: draft.user_id || undefined, role: draft.role } : {}) };
      await demoJson("/api/demo/action", { action: "person", person, person_id: draft.id });
      setMemberDraft(emptyMember); await loadState(); setNotice(`${draft.name} ${draft.id ? "updated" : "added"} to company people`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save company person"); }
  };

  const displayName = user.display_name || user.username;
  const recentChats = studio.sessions.filter(session => !chatSearch || (session.title || "Chat session").toLowerCase().includes(chatSearch.toLowerCase())).slice(0, 5);
  const sectionTitle = [...navigation, ...insights].find(item => item.area === area)?.label || "Home";
  const newChat = async () => {
    if (studio.loading || !studio.agents.length) return;
    setArea("home"); setDraft(""); setAttachments([]);
    window.sessionStorage.removeItem(`di-demo-session-${user.id}`);
    try { await studio.startNewChat(undefined, undefined, `${displayName} · Chat`); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not start chat"); }
  };
  const logout = async () => {
    setLoggingOut(true);
    try { await onLogout(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not sign out"); setLoggingOut(false); }
  };
  const navButton = ({ area: target, label, icon }: { area: Area; label: string; icon: string }) => <button key={target} className={area === target ? "active" : ""} aria-current={area === target ? "page" : undefined} onClick={() => setArea(target)}><Icon name={icon}/><span>{label}</span></button>;

  return <div className={`di-demo${area === "home" ? " demo-home" : ""}`}>
    <aside className="demo-rail">
      <a className="demo-brand" href="/demo" aria-label="e by Eternalgy"><span className="demo-brand-mark"><img src="/branding/e-logo.png" alt=""/></span><span><strong>e</strong><small>by Eternalgy</small></span></a>
      <label className="demo-sidebar-search"><Icon name="search" size={15}/><input aria-label="Search chats" value={chatSearch} onChange={event => setChatSearch(event.target.value)} placeholder="Search chats"/></label>
      <div className="demo-navigation">
        <nav aria-label="Workspace sections">{navigation.map(navButton)}<button onClick={() => window.location.assign("/media-kit")}><Icon name="spark"/><span>Media Kit</span></button></nav>
        <div className="demo-rail-label demo-insights-label">INSIGHTS</div>
        <nav className="demo-insights-nav" aria-label="Workspace insights">{insights.map(navButton)}</nav>
      </div>
      <div className="demo-recent-chats"><div className="demo-rail-label">RECENT CHATS</div>{recentChats.map(session => <button key={session.id} className={studio.sessionId === session.id ? "active" : ""} disabled={studio.loading} onClick={() => { setArea("home"); studio.openSession(session.id); }}>{session.title || "Chat session"}</button>)}{!recentChats.length && <p>{chatSearch ? "No matching chats" : "Your conversations will appear here."}</p>}</div>
      <div className="demo-rail-bottom"><span className="demo-profile-avatar">{displayName.slice(0, 1).toUpperCase()}</span><div><strong>{displayName}</strong><small>{user.role} · Your workspace</small></div><button aria-label="Sign out" title="Sign out" disabled={loggingOut} onClick={() => void logout()}><Icon name="logout" size={15}/></button></div>
    </aside>

    <main className="demo-main">
      <header className="demo-topbar"><div className="demo-breadcrumb">{area === "home" ? <span className="demo-assistant-pill"><Icon name="spark" size={18}/><strong>e Assistant</strong><span className={`demo-connection${studio.loading ? " working" : ""}`} role="status">{studio.loading ? "Working…" : ready && studio.agents.length ? "Connected" : "Connecting…"}</span></span> : <><span className="demo-workspace-name">Your workspace</span><span>/</span><strong>{sectionTitle}</strong></>}</div><div className="demo-top-actions"><button className="demo-new-chat" disabled={studio.loading || !studio.agents.length} onClick={() => void newChat()}><Icon name="plus" size={14}/> New chat</button><span className="demo-top-avatar" title={displayName}>{displayName.slice(0, 1).toUpperCase()}</span><button className="demo-mobile-logout" aria-label="Sign out" disabled={loggingOut} onClick={() => void logout()}><Icon name="logout" size={16}/></button></div></header>
      <div className="demo-content">
        {area !== "home" && <div className="demo-heading"><div><div className="demo-eyebrow">{area === "schedules" ? "SCHEDULED WORK" : logArea ? "WORKSPACE INSIGHTS" : area === "onboarding" ? "STEP 01 · GETTING STARTED" : area === "people" ? "STEP 02 · KNOW YOUR TEAM" : area === "calendar" ? "LIVE COMPANY SIGNALS" : area === "expenses" ? "RECEIPTS TO REPORT" : area === "procurement" ? "BUY WITH CONFIDENCE" : area === "research" ? "COMPANY INTELLIGENCE" : area === "signals" ? "MARKET SIGNALS & CATALYSTS" : "STEP 03 · EXPLORE CAPABILITIES"}</div><h1>{area === "schedules" ? "Scheduled work" : logArea ? logHeadings[logArea].title : area === "onboarding" ? "Set up your workspace" : area === "people" ? "Meet your company people" : area === "calendar" ? "One calendar for every date" : area === "expenses" ? "Claims, grouped by cut-off" : area === "procurement" ? "Quotes, orders, deliveries, bills" : area === "research" ? "Company research library" : area === "signals" ? "Company Signal Analysis AI" : "Make work happen"}</h1><p>{area === "schedules" ? "Manage AI jobs, reminders, and cron schedules. Check next runs and execution history." : logArea ? logHeadings[logArea].description : area === "onboarding" ? "Tell the assistant about your business and watch your profile take shape." : area === "people" ? "Share a key contact, their position and department, so future work reaches the right person." : area === "calendar" ? "The Calendar AI reads your company records and keeps the important dates together." : area === "expenses" ? "File a receipt, and the Expenses Clerk groups every claim into the month’s submission and prepares the report." : area === "procurement" ? "Record what suppliers send, draft purchase orders, log deliveries, and check every invoice against the order before paying." : area === "research" ? "Evidence-backed company dossiers, web verification, and published intelligence reports." : area === "signals" ? "Longitudinal market signals, earnings catalysts, and layered multi-cycle stock research dossiers." : "Create records and see the invoice database update instantly."}</p></div></div>}
        {logArea ? <ObservabilityPanel area={logArea} isAdmin={user.role === "admin"}/> : area === "schedules" ? <SchedulesPanel user={user}/> : area === "calendar" ? <CalendarPanel/> : area === "expenses" ? <ExpensesPanel user={user} onNotice={setNotice}/> : area === "procurement" ? <ProcurementPanel user={user} onNotice={setNotice}/> : area === "research" ? <ResearchPanel user={user} onNotice={setNotice}/> : area === "signals" ? <SignalReportsPanel user={user} onNotice={setNotice}/> : <div className={`demo-layout${area === "home" ? " demo-home-layout" : ""}`}>
          <section className={`demo-chat-card${studio.history.length === 0 ? " is-empty" : ""}`} aria-label={`${area} chat`}>
            <div className={`demo-card-head${studio.loading ? " is-working" : ""}`}>
              <div className="demo-agent-identity">
                <div className="demo-agent-avatar"><img src="/branding/e-logo.png" alt=""/></div>
                <div className="demo-agent-label">
                  <strong>{"e"}</strong>
                  <span role="status" title={studio.loading ? studio.liveStatus : undefined}><i aria-hidden="true"/> {studio.loading ? "Working…" : ready && studio.agents.length ? "Connected" : "Connecting…"}</span>
                </div>
              </div>
              <div className="demo-session-user-tag" title={`Chat session marked for ${user.display_name || user.username} (${user.role})`}>
                <Icon name="user" size={13}/>
                <span>{user.display_name || user.username}</span>
              </div>
              {studio.sessions.length > 0 && (
                <select
                  className="demo-session-select"
                  value={studio.sessionId || ""}
                  onChange={(event) => {
                    if (event.target.value) studio.openSession(event.target.value);
                  }}
                  aria-label="Switch chat session"
                  title="Switch chat session"
                >
                  <option value="" disabled>Select a chat</option>
                  {studio.sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || "Chat session"}
                    </option>
                  ))}
                </select>
              )}
              <button className="demo-more" aria-label="About this demo" title="Live Document Intelligence" onClick={() => setNotice(`Chat session for ${user.display_name || user.username} (${user.role}). Chat uses ${"e"} through the agent pipeline.`)}>···</button>
            </div>
            <div className="demo-chat-scroll">{studio.history.length === 0 ? <div className="demo-welcome"><div className="demo-welcome-orb" aria-hidden="true"/><h1>Hello, {displayName.split(" ")[0]}<br/>How can I <span>help you today?</span></h1>{area !== "home" && <p>Share a little about your business, or upload a document.</p>}</div> : <div className="demo-chat-date">TODAY</div>}{studio.history.map((message, index) => <div className={`demo-message ${message.role}`} key={message.id ?? index}><div className="demo-message-avatar">{message.role === "assistant" ? <img src="/branding/e-logo.png" alt=""/> : (user.display_name || user.username).slice(0, 1).toUpperCase()}</div><div className="demo-message-body"><div className="demo-message-name">{message.role === "assistant" ? "e" : (user.display_name || user.username)}</div><div className="demo-bubble"><ChatCopy text={message.content || (message.streaming ? studio.liveStatus || "Working…" : "")} agentId={studio.selected.id} streaming={message.streaming} onOpen={(src, alt) => studio.setMedia({ src, alt })}/>{message.role === "assistant" && message.blocks?.filter((block) => block.type === "tool" || block.type === "note").map((block, blockIndex) => <div className="demo-agent-activity" key={blockIndex}>{block.type === "tool" ? `${block.running ? "Running" : "Used"} ${block.name}` : block.text}{block.type === "tool" && block.shared_files?.map((file) => <a href={file.url} key={file.id} target="_blank" rel="noopener noreferrer">{file.name}</a>)}</div>)}</div></div></div>)}{studio.error && <div className="demo-chat-error" role="alert">{studio.error}</div>}<div ref={chatEnd}/></div>
            {area === "onboarding" ? <div className="demo-suggestions"><span>TRY SAYING</span><button onClick={() => sendMessage("My company is Acme Studio")}>My company is Acme Studio</button><button onClick={() => sendMessage("My email is hello@acme.example")}>Add business email</button></div> : area === "people" ? <div className="demo-suggestions"><span>TRY SAYING</span><button onClick={() => sendMessage("Name: Maya Tan; Position: Operations Manager; Department: Operations; Email: maya@acme.example")}>Share example contact</button><button onClick={() => sendMessage("Name: Daniel Lee")}>Start with a name</button></div> : null}
            <div className="demo-composer-wrap">{attachments.length > 0 && <div className="demo-attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><Icon name="file" size={14}/>{file.name}<button aria-label={`Remove ${file.name}`} onClick={() => setAttachments(old => old.filter((_, i) => i !== index))}><Icon name="close" size={12}/></button></span>)}</div>}<form className="demo-composer" onSubmit={event => { event.preventDefault(); void sendMessage(); }}><input ref={fileInput} type="file" accept="application/pdf,image/*" multiple hidden onChange={event => addFiles(event.target.files)}/><div className="demo-composer-input"><Icon name="spark" size={16}/><textarea aria-label="Message" rows={3} disabled={studio.loading} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void sendMessage(); } }} placeholder={area === "onboarding" ? "Tell me about your business…" : area === "people" ? "Share a person's details…" : "Ask a question or give your assistant a task…"}/></div><div className="demo-composer-toolbar"><button type="button" className="demo-attach" disabled={studio.loading} onClick={() => fileInput.current?.click()} aria-label="Attach PDF or image"><Icon name="upload" size={14}/> Attach file</button><span className="demo-composer-file-hint">PDF & images</span><button type="submit" className="demo-send" disabled={studio.loading || !studio.agents.length || (!draft.trim() && !attachments.length)} aria-label="Send message"><Icon name="send" size={15}/></button></div></form><div className="demo-composer-note">{studio.loading ? studio.liveStatus || "Your assistant is working…" : "Enter to send · Shift + Enter for a new line"}</div></div>
            {area === "home" && studio.history.length === 0 && <div className="demo-suggestions"><button onClick={() => setArea("onboarding")}>Set up my company</button><button onClick={() => setArea("research")}>Explore research</button><button onClick={() => setArea("expenses")}>Organize expenses</button></div>}
          </section>

          {area === "onboarding" ? <OnboardingPanel profile={profile} setProfile={setProfile} doneCount={doneCount} essentialCount={essentialCount} onSave={(key, value) => { void saveProfile(key, value); }} onNavigate={() => setArea("people")}/> : area === "people" ? <PeoplePanel members={companyMembers} draft={memberDraft} setDraft={setMemberDraft} onSave={saveCompanyMember} onNavigate={() => setArea("home")} onNotice={setNotice} isAdmin={user.role === "admin"}/> : null}
        </div>}
      </div>
    </main>

    {studio.media && <div className="demo-media-viewer" role="dialog" aria-modal="true" aria-label={studio.media.alt || "Image preview"}><button type="button" aria-label="Close image preview" onClick={() => studio.setMedia(null)}><Icon name="close" size={18}/></button><img src={studio.media.src} alt={studio.media.alt || "Attached image"}/></div>}
    {notice && <div className="demo-toast" role="status"><Icon name="check" size={16}/>{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><Icon name="close" size={13}/></button></div>}
  </div>;
}
