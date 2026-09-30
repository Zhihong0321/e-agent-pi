import { useEffect, useRef, useState, type FormEvent } from "react";
import "./style.css";

type Area = "onboarding" | "people" | "workspace";
type Message = { id: number; role: "assistant" | "user"; text: string; files?: string[] };
type Profile = { name: string; legalName: string; registration: string; country: string; businessType: string; businessActivity: string; website: string; email: string; phone: string; headquarters: string; billingAddress: string; currency: string; taxStatus: string; tin: string; paymentTerms: string };
type CompanyMember = { id: string; name: string; position: string; department: string; email: string; phone: string; location: string };
type Customer = { id: string; name: string; email: string; contact: string };
type Invoice = { id: string; number: string; customer: string; description: string; amount: number; due: string; status: "Draft" | "Issued" | "Paid"; created: string };

const initialProfile: Profile = { name: "", legalName: "", registration: "", country: "MY", businessType: "", businessActivity: "", website: "", email: "", phone: "", headquarters: "", billingAddress: "", currency: "MYR", taxStatus: "", tin: "", paymentTerms: "" };
const emptyMember: Omit<CompanyMember, "id"> = { name: "", position: "", department: "", email: "", phone: "", location: "" };
const initialCustomers: Customer[] = [
  { id: "C-001", name: "Northstar Creative", email: "hello@northstar.example", contact: "Aisha Rahman" },
  { id: "C-002", name: "Meridian Labs", email: "accounts@meridian.example", contact: "Daniel Tan" },
];
const initialInvoices: Invoice[] = [
  { id: "i-1", number: "INV-2026-001", customer: "Northstar Creative", description: "Brand identity package", amount: 4200, due: "2026-10-15", status: "Paid", created: "2026-09-12" },
  { id: "i-2", number: "INV-2026-002", customer: "Meridian Labs", description: "Monthly consulting", amount: 1850, due: "2026-10-20", status: "Issued", created: "2026-09-24" },
];
const initialOnboard: Message[] = [
  { id: 1, role: "assistant", text: "Share your company profile or website to begin." },
];
const initialWork: Message[] = [
  { id: 1, role: "assistant", text: "Your workspace is ready. Try creating an invoice or adding a CRM contact. The invoice table on the right updates as you work." },
];
const initialPeople: Message[] = [
  { id: 1, role: "assistant", text: "Before we begin work, who are the key people at your company? Share one person’s name, position, department, and work email or phone. We can add more people later." },
];
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
    download: <><path d="M12 3v13m0 0-5-5m5 5 5-5M4 18v3h16v-3"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
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
  if (website && (/website|site|url|https?:/i.test(value) || website === value)) { next.website = website.startsWith("http") ? website : `https://${website}`; return { profile: next, recorded: "Website" }; }
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

const guideLines = [
  "Attach your company profile PDF",
  "Tell me your company’s official website",
  "I can quickly understand your company within minutes.",
];

function OnboardingGuide() {
  const [visible, setVisible] = useState<string[]>(["", "", ""]);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setVisible(guideLines);
      return;
    }
    let line = 0;
    let letter = 0;
    let timer: number;
    const type = () => {
      if (line >= guideLines.length) return;
      const currentLine = line;
      const currentLetter = ++letter;
      setVisible((old) => old.map((text, index) => index === currentLine ? guideLines[currentLine].slice(0, currentLetter) : text));
      if (currentLetter >= guideLines[currentLine].length) {
        line++;
        letter = 0;
        timer = window.setTimeout(type, line < guideLines.length ? 380 : 0);
      } else timer = window.setTimeout(type, 34);
    };
    timer = window.setTimeout(type, 300);
    return () => window.clearTimeout(timer);
  }, []);
  return <div className="demo-guide" aria-label={guideLines.join(". ")}>
    {guideLines.map((line, index) => <div className="demo-guide-line" key={line} aria-hidden="true"><span>{String(index + 1).padStart(2, "0")}</span><strong>{visible[index]}{visible[index] && visible[index].length < line.length && <i className="demo-guide-cursor"/>}</strong></div>)}
  </div>;
}

function OnboardingPanel({ profile, setProfile, branches, setBranches, doneCount, essentialCount, onNavigate }: {
  profile: Profile;
  setProfile: React.Dispatch<React.SetStateAction<Profile>>;
  branches: string[];
  setBranches: React.Dispatch<React.SetStateAction<string[]>>;
  doneCount: number;
  essentialCount: number;
  onNavigate: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const highlights = [
    { label: "Company", value: profile.name },
    { label: "Website", value: profile.website },
    { label: "Headquarters", value: profile.headquarters },
  ].filter((item) => item.value);
  return <aside className="demo-side">
    <div className="demo-panel profile-panel demo-profile-overview">
      <div className="demo-overview-head"><div><span className="demo-panel-kicker">YOUR PROFILE</span><h2>What I know so far</h2></div><span className="demo-overview-count">{doneCount} saved</span></div>
      {highlights.length ? <dl className="demo-overview-list">{highlights.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl> : <p className="demo-overview-empty">Your company details will appear here.</p>}
      <button type="button" className="demo-text-button" onClick={() => setDetailsOpen(true)}>View or edit all details <Icon name="arrow" size={15}/></button>
      <button type="button" className="demo-continue" onClick={onNavigate}>Continue to company people <Icon name="arrow" size={16}/></button>
    </div>
    {detailsOpen && <div className="demo-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailsOpen(false); }}><div className="demo-profile-drawer" role="dialog" aria-modal="true" aria-label="Company profile details"><div className="demo-drawer-head"><div><span className="demo-panel-kicker">COMPANY PROFILE</span><h2>All details</h2></div><button type="button" aria-label="Close profile details" onClick={() => setDetailsOpen(false)}><Icon name="close" size={20}/></button></div><p className="demo-drawer-intro">Edit what you know. You can fill in the rest later.</p><div className="demo-drawer-progress">{essentialCount} of 8 essentials saved · {branches.filter(Boolean).length} branches</div>
      {profileSections.map((section) => <div className="demo-profile-section" key={section.title}>
        <div className="demo-section-heading"><div><h3>{section.title}</h3><p>{section.description}</p></div><span>{section.fields.filter(({ key }) => String(profile[key]).trim()).length}/{section.fields.length}</span></div>
        <div className="demo-profile-grid">{section.fields.map(({ key, label, hint }) => <label className="demo-profile-field" key={key}>
          <span className="demo-field-icon">{profile[key] ? <Icon name="check" size={13}/> : <span/>}</span>
          <span className="demo-field-text"><strong>{label}</strong>{key === "businessType" || key === "taxStatus" ? <select aria-label={label} value={profile[key]} onChange={(event) => setProfile((old) => ({ ...old, [key]: event.target.value }))}><option value="">{hint}</option>{(key === "businessType" ? ["Products", "Services", "Both"] : ["Not registered", "Registered", "Exempt", "Needs review"]).map((option) => <option key={option}>{option}</option>)}</select> : <input aria-label={label} value={profile[key]} placeholder={hint} onChange={(event) => setProfile((old) => ({ ...old, [key]: event.target.value }))}/>}</span>
        </label>)}</div>
        {section.title === "Locations" && <div className="demo-branches"><div className="demo-branches-heading"><div><strong>Branches & outlets</strong><span>Additional locations, if any</span></div><button type="button" onClick={() => setBranches((old) => [...old, ""])}><Icon name="plus" size={13}/> Add branch</button></div>{branches.map((branch, index) => <div className="demo-branch-row" key={index}><input aria-label={`Branch ${index + 1}`} placeholder={`Branch ${index + 1} address or name`} value={branch} onChange={(event) => setBranches((old) => old.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}/><button type="button" aria-label={`Remove branch ${index + 1}`} onClick={() => setBranches((old) => old.filter((_, itemIndex) => itemIndex !== index))}><Icon name="close" size={14}/></button></div>)}</div>}
      </div>)}
    </div></div>}
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

export default function DemoPage() {
  const [area, setArea] = useState<Area>("onboarding");
  const [profile, setProfile] = useState<Profile>(initialProfile);
  const [branches, setBranches] = useState<string[]>([]);
  const [companyMembers, setCompanyMembers] = useState<CompanyMember[]>([]);
  const [memberDraft, setMemberDraft] = useState<Omit<CompanyMember, "id">>(emptyMember);
  const [customers, setCustomers] = useState<Customer[]>(initialCustomers);
  const [invoices, setInvoices] = useState<Invoice[]>(initialInvoices);
  const [onboardMessages, setOnboardMessages] = useState<Message[]>(initialOnboard);
  const [peopleMessages, setPeopleMessages] = useState<Message[]>(initialPeople);
  const [workMessages, setWorkMessages] = useState<Message[]>(initialWork);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [notice, setNotice] = useState("");
  const [modal, setModal] = useState<"invoice" | "customer" | null>(null);
  const [selectedInvoice, setSelectedInvoice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All records");
  const [invoiceForm, setInvoiceForm] = useState({ customer: initialCustomers[0].name, description: "", amount: "", due: "" });
  const [customerForm, setCustomerForm] = useState({ name: "", email: "", contact: "" });
  const fileInput = useRef<HTMLInputElement>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const messages = area === "onboarding" ? onboardMessages : area === "people" ? peopleMessages : workMessages;
  const setMessages = area === "onboarding" ? setOnboardMessages : area === "people" ? setPeopleMessages : setWorkMessages;
  const doneCount = profileLabels.filter(({ key }) => key !== "country" && key !== "currency" && String(profile[key]).trim()).length + branches.filter(Boolean).length;
  const essentialCount = [profile.name, profile.country, profile.businessType, profile.businessActivity, profile.email || profile.phone, profile.billingAddress, profile.currency, profile.taxStatus].filter(Boolean).length;
  const activeInvoice = invoices.find((invoice) => invoice.id === selectedInvoice);
  const filteredInvoices = invoices.filter((invoice) => (filter === "All records" || invoice.status === filter) && `${invoice.number} ${invoice.customer} ${invoice.description}`.toLowerCase().includes(search.toLowerCase()));

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages.length, area]);
  useEffect(() => { if (notice) { const timer = window.setTimeout(() => setNotice(""), 4500); return () => window.clearTimeout(timer); } }, [notice]);

  const addFiles = (picked: FileList | null) => {
    if (!picked) return;
    const valid = Array.from(picked).filter((file) => file.type === "application/pdf" || file.type.startsWith("image/"));
    if (valid.length !== picked.length) setNotice("Only PDF and image files are accepted.");
    if (valid.some((file) => file.size > 10 * 1024 * 1024)) setNotice("Each file must be under 10 MB.");
    setAttachments((old) => [...old, ...valid.filter((file) => file.size <= 10 * 1024 * 1024)].slice(0, 4));
    if (fileInput.current) fileInput.current.value = "";
  };

  const sendMessage = (text = draft) => {
    const content = text.trim();
    if (!content && !attachments.length) return;
    const stamp = Date.now();
    const files = attachments.map((file) => file.name);
    setMessages((old) => [...old, { id: stamp, role: "user", text: content || "Uploaded files", files }]);
    setDraft(""); setAttachments([]);
    if (area === "onboarding") {
      let reply = "I’ve added the file to this demo conversation. For this guided demo, tell me the details you want recorded; document contents are not read automatically.";
      if (content) {
        const result = recordProfile(profile, content);
        if (result.recorded) {
          if (result.recorded.startsWith("branch:")) {
            const branch = result.recorded.slice(7);
            setBranches((old) => [...old, branch]);
            reply = `Recorded your ${branch} branch. You can add more branches, or share your headquarters and billing address.`;
          } else {
            setProfile(result.profile);
            const missing = nextMissing(result.profile);
            reply = missing ? `Recorded ${result.recorded.toLowerCase()}. What is your ${missing.label.toLowerCase()}?` : "The core profile is ready. You can add website, locations, tax details, and more in the panel before exploring the Function demo.";
          }
        } else reply = "I can record your company details, website, contact, headquarters, branches, billing address, and invoice defaults. You can also edit the profile panel directly.";
      }
      setOnboardMessages((old) => [...old, { id: stamp + 1, role: "assistant", text: reply }]);
    } else if (area === "people") {
      let reply = "You can share a person's name, position, department and work contact in chat or use the form alongside it.";
      if (content) {
        const next = recordMember(memberDraft, content);
        const question = nextMemberQuestion(next);
        if (question) { setMemberDraft(next); reply = `Got it. ${question}`; }
        else {
          const duplicate = companyMembers.find((member) => (next.email && member.email.toLowerCase() === next.email.toLowerCase()) || member.name.toLowerCase() === next.name.toLowerCase());
          if (duplicate) { setMemberDraft(next); reply = `${duplicate.name} is already in the company people list. Review the details in the form before adding someone else.`; }
          else {
            setCompanyMembers((old) => [...old, { ...next, id: `m-${stamp}` }]);
            setMemberDraft(emptyMember);
            reply = `Recorded ${next.name} as ${next.position} in ${next.department}. ${next.email || next.phone} is saved as their work contact in this demo. Who else should I know?`;
          }
        }
      }
      setPeopleMessages((old) => [...old, { id: stamp + 1, role: "assistant", text: reply }]);
    } else {
      const wantsInvoice = /invoice|bill|quotation/i.test(content);
      const wantsCustomer = /customer|contact|crm/i.test(content);
      if (wantsInvoice) setModal("invoice");
      if (wantsCustomer && !wantsInvoice) setModal("customer");
      const reply = wantsInvoice ? "Let’s make an invoice. Fill in the draft that opened and it will appear in the live table." : wantsCustomer ? "Let’s add a CRM entry. Fill in the contact details in the form that opened." : "I can help you create an invoice or add a CRM entry. Choose an action below to try it.";
      setWorkMessages((old) => [...old, { id: stamp + 1, role: "assistant", text: reply }]);
    }
  };

  const saveCompanyMember = (event: FormEvent) => {
    event.preventDefault();
    const member = Object.fromEntries(Object.entries(memberDraft).map(([key, value]) => [key, value.trim()])) as Omit<CompanyMember, "id">;
    if (!hasMemberContact(member)) { setNotice("Add a valid work email or phone for this person."); return; }
    if (companyMembers.some((person) => (member.email && person.email.toLowerCase() === member.email.toLowerCase()) || person.name.toLowerCase() === member.name.toLowerCase())) { setNotice("This person is already in the company people list."); return; }
    setCompanyMembers((old) => [...old, { ...member, id: `m-${Date.now()}` }]);
    setMemberDraft(emptyMember);
    setPeopleMessages((old) => [...old, { id: Date.now(), role: "assistant", text: `Recorded ${member.name} as ${member.position} in ${member.department}. Their work contact is ready for future tasks in this demo.` }]);
    setNotice(`${member.name} added to company people`);
  };

  const createInvoice = (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(invoiceForm.amount);
    if (!invoiceForm.customer || !invoiceForm.description.trim() || !Number.isFinite(amount) || amount <= 0 || !invoiceForm.due) return;
    const number = `INV-2026-${String(Math.max(0, ...invoices.map((item) => Number(item.number.split("-").at(-1)) || 0)) + 1).padStart(3, "0")}`;
    const invoice: Invoice = { id: `i-${Date.now()}`, number, customer: invoiceForm.customer, description: invoiceForm.description.trim(), amount, due: invoiceForm.due, status: "Draft", created: new Date().toISOString().slice(0, 10) };
    setInvoices((old) => [invoice, ...old]); setSelectedInvoice(invoice.id); setModal(null);
    setInvoiceForm({ customer: invoiceForm.customer, description: "", amount: "", due: "" });
    setWorkMessages((old) => [...old, { id: Date.now(), role: "assistant", text: `${number} is now a draft for ${invoice.customer}. Its row is visible in the invoice table.` }]);
    setNotice(`${number} created in demo data`);
  };

  const createCustomer = (event: FormEvent) => {
    event.preventDefault();
    const name = customerForm.name.trim();
    if (!name || !customerForm.email.trim()) return;
    if (customers.some((customer) => customer.name.toLowerCase() === name.toLowerCase())) { setNotice("That customer is already in the CRM demo."); return; }
    const customer: Customer = { id: `C-${String(customers.length + 1).padStart(3, "0")}`, name, email: customerForm.email.trim(), contact: customerForm.contact.trim() };
    setCustomers((old) => [...old, customer]); setInvoiceForm((old) => ({ ...old, customer: name })); setCustomerForm({ name: "", email: "", contact: "" }); setModal(null);
    setWorkMessages((old) => [...old, { id: Date.now(), role: "assistant", text: `${customer.id} · ${customer.name} was added to CRM. You can now select them when creating an invoice.` }]);
    setNotice(`${customer.name} added to CRM`);
  };

  const exportCsv = () => {
    const rows = [["Number", "Customer", "Description", "Amount", "Due date", "Status"], ...filteredInvoices.map((invoice) => [invoice.number, invoice.customer, invoice.description, String(invoice.amount), invoice.due, invoice.status])];
    const csv = rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "demo-invoices.csv"; link.click(); URL.revokeObjectURL(url);
  };

  return <div className="di-demo">
    <aside className="demo-rail">
      <a className="demo-brand" href="/demo" aria-label="Document Intelligence demo home"><span className="demo-brand-mark"><Icon name="spark" size={22}/></span><span><strong>document<span>iq</span></strong><small>INTERACTIVE DEMO</small></span></a>
      <nav aria-label="Demo sections">
        <button className={area === "onboarding" ? "active" : ""} onClick={() => setArea("onboarding")}><Icon name="chat"/><span>Onboarding</span></button>
        <button className={area === "people" ? "active" : ""} onClick={() => setArea("people")}><Icon name="users"/><span>Company people</span></button>
        <button className={area === "workspace" ? "active" : ""} onClick={() => setArea("workspace")}><Icon name="grid"/><span>Function demo</span></button>
      </nav>
    </aside>

    <main className="demo-main">
      <header className="demo-topbar"><span className="demo-breadcrumb">Interactive demo</span><a href="/" className="demo-exit">Back to app <Icon name="arrow" size={15}/></a></header>
      <div className="demo-content">
        <div className="demo-heading"><h1>{area === "onboarding" ? "Let's get to know your company" : area === "people" ? "Who should I know?" : "Try it out"}</h1></div>
        {area === "onboarding" && <OnboardingGuide/>}
        <div className="demo-layout">
          <section className="demo-chat-card" aria-label={`${area} chat`}>
            <div className="demo-card-head"><div className="demo-agent-avatar"><Icon name="spark" size={19}/></div><strong>Assistant</strong><button className="demo-more" aria-label="About this demo" title="About this demo" onClick={() => setNotice("Guided demo: files stay in your browser and their contents are not processed. Changes reset when you refresh.")}>···</button></div>
            <div className="demo-chat-scroll">{messages.map((message) => <div className={`demo-message ${message.role}`} key={message.id}><div className="demo-message-avatar">{message.role === "assistant" ? <Icon name="spark" size={15}/> : "Y"}</div><div className="demo-message-body"><div className="demo-bubble">{message.text}{message.files?.map((file) => <div className="demo-message-file" key={file}><Icon name="file" size={15}/>{file}</div>)}</div></div></div>)}<div ref={chatEnd}/></div>
            {area === "workspace" && <div className="demo-suggestions"><button onClick={() => setModal("invoice")}><Icon name="file" size={14}/> New invoice</button><button onClick={() => setModal("customer")}><Icon name="users" size={14}/> Add CRM entry</button></div>}
            <div className="demo-composer-wrap">{attachments.length > 0 && <div className="demo-attachments">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><Icon name="file" size={14}/>{file.name}<button aria-label={`Remove ${file.name}`} onClick={() => setAttachments((old) => old.filter((_, i) => i !== index))}><Icon name="close" size={12}/></button></span>)}</div>}<form className="demo-composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}><input ref={fileInput} type="file" accept="application/pdf,image/*" multiple hidden onChange={(event) => addFiles(event.target.files)}/><button type="button" className="demo-attach" onClick={() => fileInput.current?.click()} aria-label="Attach PDF or image" title="Attach PDF or image"><Icon name="upload" size={19}/></button><input aria-label="Message" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={area === "onboarding" ? "Website or company details..." : area === "people" ? "Share a person's details..." : "What would you like to create?"}/><button type="submit" className="demo-send" aria-label="Send message"><Icon name="send" size={17}/></button></form></div>
          </section>

          {area === "onboarding" ? <OnboardingPanel profile={profile} setProfile={setProfile} branches={branches} setBranches={setBranches} doneCount={doneCount} essentialCount={essentialCount} onNavigate={() => setArea("people")}/> : area === "people" ? <PeoplePanel members={companyMembers} draft={memberDraft} setDraft={setMemberDraft} onSave={saveCompanyMember} onNavigate={() => setArea("workspace")} onNotice={setNotice}/> : <aside className="demo-side"><div className="demo-panel database-panel"><div className="demo-db-top"><div><div className="demo-panel-kicker"><Icon name="database" size={16}/> DATABASE VIEWER</div><h2>Invoice table</h2><p>Live view of demo invoice records</p></div><button onClick={exportCsv} className="demo-icon-button" title="Export visible rows as CSV" aria-label="Export CSV"><Icon name="download" size={17}/></button></div><div className="demo-db-stat"><span className="demo-live-dot"/> di.document <span className="demo-db-total">{invoices.length} rows</span></div><div className="demo-db-tools"><label><Icon name="search" size={16}/><input aria-label="Search invoices" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search invoices..."/></label><select aria-label="Filter invoices" value={filter} onChange={(event) => setFilter(event.target.value)}><option>All records</option><option>Draft</option><option>Issued</option><option>Paid</option></select></div><div className="demo-table-wrap"><table><thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead><tbody>{filteredInvoices.map((invoice) => <tr key={invoice.id} className={selectedInvoice === invoice.id ? "selected" : ""} onClick={() => setSelectedInvoice(invoice.id)}><td><strong>{invoice.number}</strong><small>{invoice.created}</small></td><td>{invoice.customer}</td><td>{money(invoice.amount, profile.currency)}</td><td><span className={`demo-status ${invoice.status.toLowerCase()}`}>{invoice.status}</span></td></tr>)}</tbody></table>{filteredInvoices.length === 0 && <div className="demo-empty">No matching invoices.</div>}</div>{activeInvoice && <div className="demo-record-detail"><div><span>SELECTED RECORD</span><button onClick={() => setSelectedInvoice(null)} aria-label="Close invoice detail"><Icon name="close" size={14}/></button></div><strong>{activeInvoice.number}</strong><p>{activeInvoice.description}</p><dl><dt>Customer</dt><dd>{activeInvoice.customer}</dd><dt>Due date</dt><dd>{activeInvoice.due}</dd><dt>Total</dt><dd>{money(activeInvoice.amount, profile.currency)}</dd></dl>{activeInvoice.status === "Draft" && <button className="demo-issue" onClick={() => { setInvoices((old) => old.map((invoice) => invoice.id === activeInvoice.id ? { ...invoice, status: "Issued" } : invoice)); setNotice(`${activeInvoice.number} marked as issued`); }}>Mark as issued <Icon name="arrow" size={14}/></button>}</div>}</div><div className="demo-crm-strip"><div><Icon name="users" size={17}/><strong>CRM contacts</strong><span>{customers.length}</span></div><p>{customers.map((customer) => customer.name).join(" · ")}</p><button onClick={() => setModal("customer")}>Add a contact <Icon name="arrow" size={14}/></button></div><div className="demo-crm-strip"><div><Icon name="users" size={17}/><strong>Company people</strong><span>{companyMembers.length}</span></div><p>{companyMembers.length ? companyMembers.map((person) => `${person.name} · ${person.position} (${person.department})`).join(" · ") : "No company people shared yet"}</p><button onClick={() => setArea("people")}>View company people <Icon name="arrow" size={14}/></button></div></aside>}
        </div>
      </div>
    </main>

    {notice && <div className="demo-toast" role="status"><Icon name="check" size={16}/>{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><Icon name="close" size={13}/></button></div>}
    {modal && <div className="demo-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}><div className="demo-modal" role="dialog" aria-modal="true" aria-label={modal === "invoice" ? "Create invoice" : "Add CRM entry"}><div className="demo-modal-head"><span className="demo-modal-icon"><Icon name={modal === "invoice" ? "file" : "users"} size={22}/></span><button onClick={() => setModal(null)} aria-label="Close"><Icon name="close" size={18}/></button></div><h2>{modal === "invoice" ? "Create a new invoice" : "Add a CRM entry"}</h2><p>{modal === "invoice" ? "Create a draft invoice to add it to the database viewer." : "Record a customer so they can be used on future invoices."}</p>{modal === "invoice" ? <form onSubmit={createInvoice}><label>Customer<select value={invoiceForm.customer} onChange={(event) => setInvoiceForm((old) => ({ ...old, customer: event.target.value }))}>{customers.map((customer) => <option key={customer.id}>{customer.name}</option>)}</select></label><label>Description<input required value={invoiceForm.description} onChange={(event) => setInvoiceForm((old) => ({ ...old, description: event.target.value }))} placeholder="e.g. Website design services"/></label><div className="demo-form-row"><label>Amount ({profile.currency || "MYR"})<input required type="number" min="0.01" step="0.01" value={invoiceForm.amount} onChange={(event) => setInvoiceForm((old) => ({ ...old, amount: event.target.value }))} placeholder="0.00"/></label><label>Due date<input required type="date" value={invoiceForm.due} onChange={(event) => setInvoiceForm((old) => ({ ...old, due: event.target.value }))}/></label></div><button className="demo-primary" type="submit"><Icon name="plus" size={17}/> Create draft invoice</button></form> : <form onSubmit={createCustomer}><label>Company or customer name<input required value={customerForm.name} onChange={(event) => setCustomerForm((old) => ({ ...old, name: event.target.value }))} placeholder="e.g. Willow & Co"/></label><label>Email address<input required type="email" value={customerForm.email} onChange={(event) => setCustomerForm((old) => ({ ...old, email: event.target.value }))} placeholder="hello@example.com"/></label><label>Primary contact<input value={customerForm.contact} onChange={(event) => setCustomerForm((old) => ({ ...old, contact: event.target.value }))} placeholder="Full name (optional)"/></label><button className="demo-primary" type="submit"><Icon name="plus" size={17}/> Add to CRM</button></form>}</div></div>}
  </div>;
}
