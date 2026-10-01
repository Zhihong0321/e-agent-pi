import { useEffect, useRef, useState, type FormEvent } from "react";
import { ChatCopy } from "../chat-markdown";
import { useStudio } from "../use-studio";
import "./style.css";
import "./calendar.css";

type Area = "onboarding" | "people" | "workspace" | "calendar";
type CalendarEvent = { id: string; kind: string; title: string; start: string; end: string; allDay: boolean; timezone: string; status: string; severity: string; source: { table: string; recordId: string; field: string }; detail: Record<string, unknown>; warnings: string[]; needsReview: boolean };
type Profile = { name: string; legalName: string; registration: string; country: string; businessType: string; businessActivity: string; website: string; email: string; phone: string; headquarters: string; billingAddress: string; currency: string; taxStatus: string; tin: string; paymentTerms: string };
type CompanyMember = { id: string; name: string; position: string; department: string; email: string; phone: string; location: string };
type Customer = { id: string; name: string; email: string; contact: string };
type Invoice = { id: string; number: string; customer: string; description: string; amount: number; due: string; status: "Draft" | "Issued" | "Paid"; created: string };

const initialProfile: Profile = { name: "", legalName: "", registration: "", country: "MY", businessType: "", businessActivity: "", website: "", email: "", phone: "", headquarters: "", billingAddress: "", currency: "MYR", taxStatus: "", tin: "", paymentTerms: "" };
const emptyMember: Omit<CompanyMember, "id"> = { name: "", position: "", department: "", email: "", phone: "", location: "" };
const initialCustomers: Customer[] = [];
const initialInvoices: Invoice[] = [];
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
    spark: <><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z"/><path d="m19 17 .6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6L19 17Z"/></>,
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-2 2v-7.5A7.5 7.5 0 1 1 20 11.5Z"/><path d="M7 10h9M7 14h6"/></>,
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    file: <><path d="M6 2h8l5 5v14H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v6h5M8 13h8M8 17h6"/></>,
    users: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2H3ZM16 5a3 3 0 0 1 0 6m1 4a5 5 0 0 1 4 5"/></>,
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
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function CalendarPanel() {
  const [cursor, setCursor] = useState(() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), 1); });
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [kind, setKind] = useState("all");
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
    setLoading(true); setError("");
    try { const data = await demoJson<{ events: CalendarEvent[] }>(`/api/demo/calendar?from=${from}&to=${to}`); setEvents(data.events); setSelected((old) => old && data.events.some((event) => event.start === old) ? old : data.events[0]?.start || null); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load calendar"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [from, to]);
  const selectedEvents = visible.filter((event) => event.start === selected);
  const selectedEvent = visible.find((event) => event.id === selectedEventId) || null;
  return <section className="calendar-panel" aria-label="Company calendar"><div className="calendar-head"><div><div className="demo-panel-kicker"><Icon name="calendar" size={16}/> COMPANY CALENDAR</div><h2>{monthLabel}</h2><p>AI-organized dates from your company records. Read-only and source-linked.</p></div><div className="calendar-actions"><button className="demo-icon-button" onClick={() => setCursor(new Date(year, month - 1, 1))} aria-label="Previous month">←</button><button className="calendar-today" onClick={() => { const now = new Date(); setCursor(new Date(now.getFullYear(), now.getMonth(), 1)); }}>Today</button><button className="demo-icon-button" onClick={() => setCursor(new Date(year, month + 1, 1))} aria-label="Next month">→</button></div></div><div className="calendar-toolbar"><span>{loading ? "Reading company records…" : `${visible.length} date${visible.length === 1 ? "" : "s"}`}</span><select aria-label="Filter calendar events" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All dates</option><option value="quotation_expiry">Quotation expiry</option><option value="payment_due">Payment due</option><option value="payment_received">Payments received</option><option value="reminder">Reminders</option></select></div>{error && <div className="calendar-error" role="alert">{error}</div>}<div className="calendar-layout"><div className="calendar-grid" aria-label={monthLabel}><div className="calendar-weekdays">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-cells">{cells.map((date, index) => { const dayEvents = date ? byDay.get(date) || [] : []; return <button key={`${date || "blank"}-${index}`} className={`calendar-cell${date === selected ? " selected" : ""}${!date ? " blank" : ""}`} disabled={!date} onClick={() => date && setSelected(date)} aria-label={date || "Outside month"}>{date && <><strong>{Number(date.slice(-2))}</strong><div className="calendar-dots">{dayEvents.slice(0, 3).map((event) => <i key={event.id} className={event.kind}/>)}</div>{dayEvents.length > 3 && <small>+{dayEvents.length - 3}</small>}</>}</button>; })}</div></div><aside className="calendar-agenda"><div className="calendar-agenda-head"><span>{selected ? new Date(`${selected}T00:00:00`).toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" }) : "Select a date"}</span><strong>{selectedEvents.length}</strong></div>{selectedEvents.length === 0 && !loading && <div className="calendar-empty">No dates on this day.<br/><small>Use the arrows to explore the next due dates.</small></div>}{selectedEvents.map((event) => <button className="calendar-event" key={event.id} onClick={() => { setSelected(event.start); setSelectedEventId(event.id); }}><span className={`calendar-event-mark ${event.kind}`}/><span><strong>{event.title}</strong><small>{String(event.detail.customer || event.detail.form || event.detail.number || event.detail.label || event.source.field || "Company record")}</small>{event.needsReview && <em>Needs review</em>}</span></button>)}{selectedEvent && <div className="calendar-detail" role="dialog" aria-label="Calendar event details"><div><strong>{selectedEvent.title}</strong><button onClick={() => setSelectedEventId(null)} aria-label="Close event details">×</button></div><dl><dt>Date</dt><dd>{selectedEvent.start}{selectedEvent.detail.sourceDate && selectedEvent.detail.sourceDate !== selectedEvent.start ? ` · source ${String(selectedEvent.detail.sourceDate)}` : ""}</dd><dt>Status</dt><dd>{selectedEvent.status}</dd><dt>Source</dt><dd>{selectedEvent.source.table} · {selectedEvent.source.field}</dd>{selectedEvent.detail.customer && <><dt>Customer</dt><dd>{String(selectedEvent.detail.customer)}</dd></>}{selectedEvent.detail.balance !== undefined && <><dt>Balance</dt><dd>{String(selectedEvent.detail.balance)}</dd></>}{selectedEvent.warnings.length > 0 && <><dt>Review</dt><dd>{selectedEvent.warnings.join("; ")}</dd></>}</dl></div>}</aside></div></section>;
}

function money(amount: number, currency = "MYR") {
  return new Intl.NumberFormat("en-MY", { style: "currency", currency: currency || "MYR", maximumFractionDigits: 2 }).format(amount);
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

function recordMember(current: Omit<CompanyMember, "id">, input: string) {
  const next = { ...current };
  let matched = false;
  for (const piece of input.split(/[;\n]+/)) {
    const field = piece.match(/^\s*(name|position|job title|department|email|phone|location)\s*:\s*(.+?)\s*$/i);
    if (!field) continue;
    const key = ({ "job title": "position" } as Record<string, keyof typeof next>)[field[1].toLowerCase()] || field[1].toLowerCase() as keyof typeof next;
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
      const key = labelled[1].toLowerCase() === "job title" ? "position" : labelled[1].toLowerCase() as keyof typeof next;
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

function PeoplePanel({ members, draft, setDraft, onSave, onNavigate, onNotice }: {
  members: CompanyMember[];
  draft: Omit<CompanyMember, "id">;
  setDraft: React.Dispatch<React.SetStateAction<Omit<CompanyMember, "id">>>;
  onSave: (event: FormEvent) => void;
  onNavigate: () => void;
  onNotice: (message: string) => void;
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
      <div className="demo-people-title"><div><h2>Know your people</h2><p>Record who to involve in future work. These are your team members, separate from CRM customers.</p></div><span>{members.length} saved</span></div>
      <div className="demo-person-list">{members.length ? members.map((member) => <div className="demo-person-card" key={member.id}><span className="demo-person-avatar">{member.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase()}</span><div><strong>{member.name}</strong><span>{[member.position, member.department].filter(Boolean).join(" · ")}</span><small>{member.email || member.phone}{member.location ? ` · ${member.location}` : ""}</small></div><Icon name="check" size={16}/></div>) : <div className="demo-person-empty"><Icon name="users" size={23}/><strong>No company people recorded yet</strong><span>Share a contact through chat, the form, or a vCard.</span></div>}</div>
      <div className="demo-person-form-heading"><div><strong>Share a company contact</strong><span>Start with a key person. Add others any time.</span></div><input ref={vcardInput} type="file" accept=".vcf,text/vcard" hidden onChange={(event) => void importVcard(event.target.files?.[0])}/><button type="button" onClick={() => vcardInput.current?.click()}><Icon name="upload" size={14}/> Import .vcf</button></div>
      <form className="demo-person-form" onSubmit={onSave}>
        <label>Full name<input required value={draft.name} onChange={(event) => setDraft((old) => ({ ...old, name: event.target.value }))} placeholder="e.g. Maya Tan"/></label>
        <label>Position<input required value={draft.position} onChange={(event) => setDraft((old) => ({ ...old, position: event.target.value }))} placeholder="e.g. Operations Manager"/></label>
        <label>Department<input required value={draft.department} onChange={(event) => setDraft((old) => ({ ...old, department: event.target.value }))} placeholder="e.g. Operations"/></label>
        <label>Location<input value={draft.location} onChange={(event) => setDraft((old) => ({ ...old, location: event.target.value }))} placeholder="HQ or branch (optional)"/></label>
        <label>Work email<input type="email" value={draft.email} onChange={(event) => setDraft((old) => ({ ...old, email: event.target.value }))} placeholder="maya@company.com"/></label>
        <label>Work phone<input value={draft.phone} onChange={(event) => setDraft((old) => ({ ...old, phone: event.target.value }))} placeholder="+60 ..."/></label>
        <p>Provide at least one work email or phone.</p>
        <button className="demo-primary" type="submit"><Icon name="plus" size={16}/> Save company person</button>
      </form>
    </div>
    <div className="demo-next-card"><span className="demo-next-icon"><Icon name="spark" size={20}/></span><div><strong>{members.length ? "Your team is on record" : "Add a key contact"}</strong><p>{members.length ? "Future tasks can refer to the right person and department." : "You can continue and add people later."}</p><button onClick={onNavigate}>Continue to function demo <Icon name="arrow" size={15}/></button></div></div>
  </aside>;
}

type DemoState = {
  profile: { company: Record<string, unknown>; readiness: { minimum_ready: boolean } };
  members: Array<Record<string, unknown>>;
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

export default function DemoPage({ initialArea = "onboarding" }: { initialArea?: Area } = {}) {
  const [user, setUser] = useState<DemoUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void demoJson<{ user: DemoUser }>("/api/demo/me").then(data => setUser(data.user)).catch(() => {}).finally(() => setChecking(false)); }, []);
  const login = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { const data = await demoJson<{ user: DemoUser }>("/api/demo/login", { username, password }); setPassword(""); setUser(data.user); }
    catch (error) { setError(error instanceof Error ? error.message : "Sign in failed"); }
    finally { setBusy(false); }
  };
  if (checking) return <div className="demo-login"><p role="status">Checking login…</p></div>;
  if (!user) return <div className="demo-login"><form onSubmit={login}><img src="/branding/e-logo.png" alt="e"/><h1>Sign in</h1><p>Open your AI workspace.</p><label>Username<input autoComplete="username" required value={username} onChange={event => setUsername(event.target.value)}/></label><label>Password<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)}/></label>{error && <p role="alert">{error}</p>}<button className="demo-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button></form></div>;
  return <DemoWorkspace key={user.id} user={user} initialArea={initialArea} onLogout={async () => { await demoJson("/api/demo/logout", {}); window.sessionStorage.removeItem(`di-demo-session-${user.id}`); window.location.assign("/demo"); }}/ >;
}

function DemoWorkspace({ user, initialArea = "onboarding", onLogout }: { user: DemoUser; initialArea?: Area; onLogout: () => Promise<void> }) {
  const studio = useStudio();
  const [area, setArea] = useState<Area>(initialArea);
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [companyMembers, setCompanyMembers] = useState<CompanyMember[]>([]);
  const [memberDraft, setMemberDraft] = useState<Omit<CompanyMember, "id">>(emptyMember);
  const [customers, setCustomers] = useState<Customer[]>(initialCustomers);
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [ready, setReady] = useState(false);
  const restoredSession = useRef(false);
  const profileRevision = useRef<number>(0);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"invoice" | "customer" | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All records");
  const [invoiceForm, setInvoiceForm] = useState({ customer: "", description: "", amount: "", due: "" });
  const [customerForm, setCustomerForm] = useState({ name: "", email: "", contact: "" });
  const fileInput = useRef<HTMLInputElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const doneCount = profileLabels.filter(({ key }) => String(profile[key]).trim()).length;
  const essentialCount = [profile.name, profile.country, profile.businessType, profile.businessActivity, profile.email || profile.phone, profile.billingAddress, profile.currency, profile.taxStatus].filter(Boolean).length;
  const activeInvoice = invoices.find((invoice) => invoice.id === selectedInvoice);
  const filteredInvoices = invoices.filter((invoice) => (filter === "All records" || invoice.status === filter) && `${invoice.number} ${invoice.customer} ${invoice.description}`.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [studio.history, area]);
  useEffect(() => { if (notice) { const timer = window.setTimeout(() => setNotice(""), 4500); return () => window.clearTimeout(timer); } }, [notice]);

  const loadState = async () => {
    const data = await demoJson<DemoState>("/api/demo/state");
    profileRevision.current = Number(data.profile.company.revision || 0);
    setProfile(profileFromDb(data.profile.company));
    setCompanyMembers(data.members.map((member) => ({ id: String(member.id), name: String(member.name || ""),
      position: String(member.position || ""), department: String(member.department || ""), email: String(member.email || ""),
      phone: String(member.phone || ""), location: String(member.location || "") })));
    const nextCustomers = data.customers.map((customer) => ({ id: String(customer.id), name: String(customer.name || ""),
      email: String(customer.email || ""), contact: String(customer.code || "") }));
    setCustomers(nextCustomers);
    setInvoiceForm((old) => ({ ...old, customer: nextCustomers.some((customer) => customer.id === old.customer)
      ? old.customer : nextCustomers[0]?.id || "" }));
    setInvoices(data.invoices.map((invoice) => ({ id: String(invoice.id), number: String(invoice.number || "Draft"),
      customer: (invoice.customer as { name?: string } | null)?.name || "", description: (invoice.lines as Array<{ description?: string }> | undefined)?.map((line) => line.description).filter(Boolean).join("; ") || "",
      amount: Number(invoice.total || 0), due: String(invoice.due_date || ""),
      status: invoice.status === "draft" ? "Draft" : invoice.status === "paid" ? "Paid" : "Issued",
      created: String(invoice.issue_date || "") })));
    setReady(true);
  };

  useEffect(() => {
    void loadState().catch((error) => setNotice(error instanceof Error ? error.message : "Document Intelligence is unavailable"));
  }, []);

  useEffect(() => {
    if (!studio.inboxReady || restoredSession.current) return;
    restoredSession.current = true;
    const stored = window.sessionStorage.getItem(`di-demo-session-${user.id}`);
    if (stored && studio.sessions.some((session) => session.id === stored)) studio.openSession(stored);
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
    const member = Object.fromEntries(Object.entries(memberDraft).map(([key, value]) => [key, value.trim()])) as Omit<CompanyMember, "id">;
    if (!hasMemberContact(member)) { setNotice("Add a valid work email or phone for this person."); return; }
    try {
      await demoJson("/api/demo/action", { action: "member", member });
      setMemberDraft(emptyMember); await loadState(); setNotice(`${member.name} added to company people`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not add company member"); }
  };

  const createInvoice = async (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(invoiceForm.amount);
    if (!invoiceForm.customer || !invoiceForm.description.trim() || !Number.isFinite(amount) || amount <= 0 || !invoiceForm.due) return;
    try {
      const data = await demoJson<{ result: { document: { id: string } } }>("/api/demo/action", { action: "invoice", invoice: invoiceForm });
      setSelectedInvoice(data.result.document.id); setModal(null);
      setInvoiceForm({ customer: invoiceForm.customer, description: "", amount: "", due: "" });
      await loadState(); setNotice("Draft invoice created in Document Intelligence");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not create invoice"); }
  };

  const createCustomer = async (event: FormEvent) => {
    event.preventDefault();
    const name = customerForm.name.trim();
    if (!name || !customerForm.email.trim()) return;
    try {
      const data = await demoJson<{ result: { customer: { id: string } } }>("/api/demo/action", { action: "customer", customer: { name, email: customerForm.email.trim() } });
      setInvoiceForm((old) => ({ ...old, customer: data.result.customer.id }));
      setCustomerForm({ name: "", email: "", contact: "" }); setModal(null);
      await loadState(); setNotice(`${name} added to CRM`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not add customer"); }
  };

  const issueInvoice = async (id: string) => {
    try {
      await demoJson("/api/demo/action", { action: "issue", id });
      await loadState(); setNotice("Invoice issued");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Invoice is not ready to issue"); }
  };

  const exportCsv = () => {
    const rows = [["Number", "Customer", "Description", "Amount", "Due date", "Status"], ...filteredInvoices.map((invoice) => [invoice.number, invoice.customer, invoice.description, String(invoice.amount), invoice.due, invoice.status])];
    const csv = rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "demo-invoices.csv"; link.click(); URL.revokeObjectURL(url);
  };

  return <div className="di-demo">
    <aside className="demo-rail">
      <a className="demo-brand" href="/demo" aria-label="e — Eternalgy Sdn Bhd"><span className="demo-brand-mark"><img src="/branding/e-logo.png" alt=""/></span><span><strong>e</strong><small>Eternalgy Sdn Bhd</small></span></a>
      <div className="demo-rail-label">EXPLORE</div>
      <nav aria-label="Demo sections">
        <button className={area === "onboarding" ? "active" : ""} onClick={() => setArea("onboarding")}><Icon name="chat"/><span>Onboarding</span><span className="demo-nav-count">01</span></button>
        <button className={area === "people" ? "active" : ""} onClick={() => setArea("people")}><Icon name="users"/><span>Company people</span><span className="demo-nav-count">02</span></button>
        <button className={area === "workspace" ? "active" : ""} onClick={() => setArea("workspace")}><Icon name="grid"/><span>Function demo</span><span className="demo-nav-count">03</span></button>
        <button className={area === "calendar" ? "active" : ""} onClick={() => setArea("calendar")}><Icon name="calendar"/><span>Company calendar</span><span className="demo-nav-count">04</span></button>
      </nav>
      <div className="demo-rail-bottom"><span className="demo-live-dot"/> Live Document Intelligence <p>Changes are saved to this workspace.</p></div>
    </aside>

    <main className="demo-main">
      <header className="demo-topbar"><div className="demo-breadcrumb">Document Intelligence <span>/</span> <strong>{area === "onboarding" ? "Onboarding" : area === "people" ? "Company people" : area === "calendar" ? "Company calendar" : "Function demo"}</strong></div><div className="demo-top-actions"><span className="demo-badge">{user.display_name || user.username} · {user.role}</span><button className="demo-exit" onClick={() => void onLogout().catch(error => setNotice(error.message))}>Sign out</button><a href="/" className="demo-exit">Back to app <Icon name="arrow" size={15}/></a></div></header>
      <div className="demo-content">
        <div className="demo-heading"><div><div className="demo-eyebrow">{area === "onboarding" ? "STEP 01 · GETTING STARTED" : area === "people" ? "STEP 02 · KNOW YOUR TEAM" : area === "calendar" ? "LIVE COMPANY SIGNALS" : "STEP 03 · EXPLORE CAPABILITIES"}</div><h1>{area === "onboarding" ? "Set up your workspace" : area === "people" ? "Meet your company people" : area === "calendar" ? "One calendar for every date" : "Make work happen"}</h1><p>{area === "onboarding" ? "Tell the assistant about your business and watch your profile take shape." : area === "people" ? "Share a key contact, their position and department, so future work reaches the right person." : area === "calendar" ? "The Calendar AI reads your company records and keeps the important dates together." : "Create records and see the invoice database update instantly."}</p></div>{area === "workspace" && <button className="demo-primary demo-heading-button" onClick={() => setModal("invoice")}><Icon name="plus" size={17}/> New invoice</button>}</div>
        {area === "calendar" ? <CalendarPanel/> : <div className="demo-layout">
          <section className="demo-chat-card" aria-label={`${area} chat`}>
            <div className={`demo-card-head${studio.loading ? " is-working" : ""}`}><div className="demo-agent-identity"><div className="demo-agent-avatar"><img src="/branding/e-logo.png" alt=""/></div><div className="demo-agent-label"><strong>{"e"}</strong><span role="status" title={studio.loading ? studio.liveStatus : undefined}><i aria-hidden="true"/> {studio.loading ? "Working…" : ready && studio.agents.length ? "Connected" : "Connecting…"}</span></div></div><button className="demo-new-chat" disabled={studio.loading || !studio.agents.length} onClick={() => { window.sessionStorage.removeItem(`di-demo-session-${user.id}`); void studio.startNewChat(); }}>New chat</button><button className="demo-more" aria-label="About this demo" title="Live Document Intelligence" onClick={() => setNotice(`Chat uses ${"e"} through the same agent pipeline as the app.`)}>···</button></div>
            <div className="demo-chat-scroll"><div className="demo-chat-date">TODAY</div>{studio.history.length === 0 && <div className="demo-message assistant"><div className="demo-message-avatar"><img src="/branding/e-logo.png" alt=""/></div><div className="demo-message-body"><div className="demo-message-name">{"e"}</div><div className="demo-bubble">Hi! Tell me about your company or upload a document. I’m ready to help.</div></div></div>}{studio.history.map((message, index) => <div className={`demo-message ${message.role}`} key={message.id ?? index}><div className="demo-message-avatar">{message.role === "assistant" ? <img src="/branding/e-logo.png" alt=""/> : "Y"}</div><div className="demo-message-body"><div className="demo-message-name">{message.role === "assistant" ? "e" : "You"}</div><div className="demo-bubble"><ChatCopy text={message.content || (message.streaming ? studio.liveStatus || "Working…" : "")} agentId={studio.selected.id} streaming={message.streaming} onOpen={(src, alt) => studio.setMedia({ src, alt })}/>{message.role === "assistant" && message.blocks?.filter((block) => block.type === "tool" || block.type === "note").map((block, blockIndex) => <div className="demo-agent-activity" key={blockIndex}>{block.type === "tool" ? `${block.running ? "Running" : "Used"} ${block.name}` : block.text}{block.type === "tool" && block.shared_files?.map((file) => <a href={file.url} key={file.id} target="_blank" rel="noopener noreferrer">{file.name}</a>)}</div>)}</div></div></div>)}{studio.error && <div className="demo-chat-error" role="alert">{studio.error}</div>}<div ref={chatEnd}/></div>
            {area === "onboarding" ? <div className="demo-suggestions"><span>TRY SAYING</span><button onClick={() => sendMessage("My company is Acme Studio")}>My company is Acme Studio</button><button onClick={() => sendMessage("My email is hello@acme.example")}>Add business email</button></div> : area === "people" ? <div className="demo-suggestions"><span>TRY SAYING</span><button onClick={() => sendMessage("Name: Maya Tan; Position: Operations Manager; Department: Operations; Email: maya@acme.example")}>Share example contact</button><button onClick={() => sendMessage("Name: Daniel Lee")}>Start with a name</button></div> : <div className="demo-suggestions"><span>QUICK ACTIONS</span><button onClick={() => setModal("invoice")}><Icon name="file" size={14}/> New invoice</button><button onClick={() => setModal("customer")}><Icon name="users" size={14}/> Add CRM entry</button></div>}
            <div className="demo-composer-wrap">{attachments.length > 0 && <div className="demo-attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><Icon name="file" size={14}/>{file.name}<button aria-label={`Remove ${file.name}`} onClick={() => setAttachments((old) => old.filter((_, i) => i !== index))}><Icon name="close" size={12}/></button></span>)}</div>}<form className="demo-composer" onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}><input ref={fileInput} type="file" accept="application/pdf,image/*" multiple hidden onChange={(event) => addFiles(event.target.files)}/><button type="button" className="demo-attach" disabled={studio.loading} onClick={() => fileInput.current?.click()} aria-label="Attach PDF or image" title="Attach PDF or image"><Icon name="upload" size={19}/></button><input aria-label="Message" disabled={studio.loading} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={area === "onboarding" ? "Tell me about your business..." : area === "people" ? "Share a person's details..." : "What would you like to create?"}/><button type="submit" className="demo-send" disabled={studio.loading || !studio.agents.length} aria-label="Send message"><Icon name="send" size={17}/></button></form><div className="demo-composer-note">PDF and images accepted · Files are processed by the agent</div></div>
          </section>

          {area === "onboarding" ? <OnboardingPanel profile={profile} setProfile={setProfile} doneCount={doneCount} essentialCount={essentialCount} onSave={(key, value) => { void saveProfile(key, value); }} onNavigate={() => setArea("people")}/> : area === "people" ? <PeoplePanel members={companyMembers} draft={memberDraft} setDraft={setMemberDraft} onSave={saveCompanyMember} onNavigate={() => setArea("workspace")} onNotice={setNotice}/> : <aside className="demo-side"><div className="demo-panel database-panel"><div className="demo-db-top"><div><div className="demo-panel-kicker"><Icon name="database" size={16}/> DATABASE VIEWER</div><h2>Invoice table</h2><p>Live Document Intelligence invoice records</p></div><button onClick={exportCsv} className="demo-icon-button" title="Export visible rows as CSV" aria-label="Export CSV"><Icon name="download" size={17}/></button></div><div className="demo-db-stat"><span className="demo-live-dot"/> di.document <span className="demo-db-total">{invoices.length} rows</span></div><div className="demo-db-tools"><label><Icon name="search" size={16}/><input aria-label="Search invoices" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search invoices..."/></label><select aria-label="Filter invoices" value={filter} onChange={(event) => setFilter(event.target.value)}><option>All records</option><option>Draft</option><option>Issued</option><option>Paid</option></select></div><div className="demo-table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead><tbody>{filteredInvoices.map((invoice) => <tr key={invoice.id} className={selectedInvoice === invoice.id ? "selected" : ""} onClick={() => setSelectedInvoice(invoice.id)}><td><strong>{invoice.number}</strong><small>{invoice.created}</small></td><td>{invoice.customer}</td><td>{money(invoice.amount, profile.currency)}</td><td><span className={`demo-status ${invoice.status.toLowerCase()}`}>{invoice.status}</span></td></tr>)}</tbody></table>{filteredInvoices.length === 0 && <div className="demo-empty">No matching invoices.</div>}</div>{activeInvoice && <div className="demo-record-detail"><div><span>SELECTED RECORD</span><button onClick={() => setSelectedInvoice(null)} aria-label="Close invoice detail"><Icon name="close" size={14}/></button></div><strong>{activeInvoice.number}</strong><p>{activeInvoice.description}</p><dl><dt>Customer</dt><dd>{activeInvoice.customer}</dd><dt>Due date</dt><dd>{activeInvoice.due}</dd><dt>Total</dt><dd>{money(activeInvoice.amount, profile.currency)}</dd></dl>{activeInvoice.status === "Draft" && <button className="demo-issue" onClick={() => void issueInvoice(activeInvoice.id)}>Mark as issued <Icon name="arrow" size={14}/></button>}</div>}</div><div className="demo-crm-strip"><div><Icon name="users" size={17}/><strong>CRM contacts</strong><span>{customers.length}</span></div><p>{customers.map((customer) => customer.name).join(" · ")}</p><button onClick={() => setModal("customer")}>Add a contact <Icon name="arrow" size={14}/></button></div><div className="demo-crm-strip"><div><Icon name="users" size={17}/><strong>Company people</strong><span>{companyMembers.length}</span></div><p>{companyMembers.length ? companyMembers.map((person) => `${person.name} · ${person.position} (${person.department})`).join(" · ") : "No company people shared yet"}</p><button onClick={() => setArea("people")}>View company people <Icon name="arrow" size={14}/></button></div></aside>}
        </div>}
      </div>
    </main>

    {studio.media && <div className="demo-media-viewer" role="dialog" aria-modal="true" aria-label={studio.media.alt || "Image preview"}><button type="button" aria-label="Close image preview" onClick={() => studio.setMedia(null)}><Icon name="close" size={18}/></button><img src={studio.media.src} alt={studio.media.alt || "Attached image"}/></div>}
    {notice && <div className="demo-toast" role="status"><Icon name="check" size={16}/>{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><Icon name="close" size={13}/></button></div>}
    {modal && <div className="demo-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}><div className="demo-modal" role="dialog" aria-modal="true" aria-label={modal === "invoice" ? "Create invoice" : "Add CRM entry"}><div className="demo-modal-head"><span className="demo-modal-icon"><Icon name={modal === "invoice" ? "file" : "users"} size={22}/></span><button onClick={() => setModal(null)} aria-label="Close"><Icon name="close" size={18}/></button></div><h2>{modal === "invoice" ? "Create a new invoice" : "Add a CRM entry"}</h2><p>{modal === "invoice" ? "Create a draft invoice in Document Intelligence." : "Record a customer so they can be used on future invoices."}</p>{modal === "invoice" ? <form onSubmit={createInvoice}><label>Customer<select value={invoiceForm.customer} onChange={(event) => setInvoiceForm((old) => ({ ...old, customer: event.target.value }))}>{customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label><label>Description<input required value={invoiceForm.description} onChange={(event) => setInvoiceForm((old) => ({ ...old, description: event.target.value }))} placeholder="e.g. Website design services"/></label><div className="demo-form-row"><label>Amount ({profile.currency || "MYR"})<input required type="number" min="0.01" step="0.01" value={invoiceForm.amount} onChange={(event) => setInvoiceForm((old) => ({ ...old, amount: event.target.value }))} placeholder="0.00"/></label><label>Due date<input required type="date" value={invoiceForm.due} onChange={(event) => setInvoiceForm((old) => ({ ...old, due: event.target.value }))}/></label></div><button className="demo-primary" type="submit"><Icon name="plus" size={17}/> Create draft invoice</button></form> : <form onSubmit={createCustomer}><label>Company or customer name<input required value={customerForm.name} onChange={(event) => setCustomerForm((old) => ({ ...old, name: event.target.value }))} placeholder="e.g. Willow & Co"/></label><label>Email address<input required type="email" value={customerForm.email} onChange={(event) => setCustomerForm((old) => ({ ...old, email: event.target.value }))} placeholder="hello@example.com"/></label><label>Primary contact<input value={customerForm.contact} onChange={(event) => setCustomerForm((old) => ({ ...old, contact: event.target.value }))} placeholder="Full name (optional)"/></label><button className="demo-primary" type="submit"><Icon name="plus" size={17}/> Add to CRM</button></form>}</div></div>}
  </div>;
}
