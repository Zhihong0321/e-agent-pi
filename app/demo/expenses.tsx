import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import "./expenses.css";

type ExUser = { id: string; username: string; display_name?: string; role: string };
type Totals = { claims: number; pending_count: number; claimed: number; approved: number; pending: number; rejected: number };
type Submission = { id: string; period_key: string; label: string; status: "open" | "closed"; period_start: string; cutoff_date: string; days_left: number | null; totals: Totals; report_path: string | null; closed_at: string | null };
type ClaimRow = { id: string; number: string; status: ClaimStatus; claimant: string; expense_date: string; merchant: string; category: string; amount: number; currency: string; receipts: number; submission: string; submission_status: string };
type ClaimStatus = "submitted" | "approved" | "rejected" | "withdrawn";
type Receipt = { id: string; name: string; mime: string; bytes: number };
type ClaimDetail = { id: string; number: string; status: ClaimStatus; claimant: { name: string; email: string | null }; expense_date: string; merchant: string; category: string; description: string | null; currency: string; amount: number; tax_amount: number | null; payment_method: string | null; no_receipt_reason: string | null; reviewed_by: string | null; review_note: string | null; submission: { label: string; status: string } | null; receipts: Receipt[] };
type Category = { key: string; label: string };
type Panel = {
  me: { username: string; name: string; role: string };
  settings: { cutoff_day: number; currency: string };
  categories: Category[]; payment_methods: string[]; today: string;
  current_submission: { period_key: string; label: string; cutoff_date: string; days_left: number };
  submissions: Submission[]; month: string; selected: Submission | null;
  claims: ClaimRow[]; totals: Totals | null; has_more: boolean; scope: string;
  people: { id: string; name: string; department?: string | null }[];
};
type Form = { claimant: string; expense_date: string; merchant: string; category: string; amount: string; tax_amount: string; payment_method: string; description: string; no_receipt: boolean; no_receipt_reason: string };

const STATUS_LABEL: Record<ClaimStatus, string> = { submitted: "Pending", approved: "Approved", rejected: "Rejected", withdrawn: "Withdrawn" };
const MAX_FILES = 5;
const MAX_BYTES = 8 * 1024 * 1024;

async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? { credentials: "include" } : {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || (response.status === 401 ? "Please sign in to use this demo." : "Request failed"));
  return data;
}

const fmtMoney = (amount: number, currency = "MYR") => new Intl.NumberFormat("en-MY", { style: "currency", currency: currency || "MYR", maximumFractionDigits: 2 }).format(amount);
const fmtDate = (iso: string | null | undefined) => {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-MY", { day: "numeric", month: "short", year: "numeric" }) : "";
};
const emptyForm = (today: string): Form => ({ claimant: "", expense_date: today, merchant: "", category: "meals", amount: "", tax_amount: "", payment_method: "personal_card", description: "", no_receipt: false, no_receipt_reason: "" });
const readFile = (file: File) => new Promise<{ name: string; mime: string; data: string }>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve({ name: file.name, mime: file.type, data: String(reader.result || "") });
  reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
  reader.readAsDataURL(file);
});

function Glyph({ name, size = 16 }: { name: "receipt" | "plus" | "upload" | "close" | "lock" | "pdf" | "check"; size?: number }) {
  const paths = {
    receipt: <><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2V3Z"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4"/></>,
    plus: <path d="M12 4v16M4 12h16"/>,
    upload: <><path d="M12 16V3m0 0L7 8m5-5 5 5"/><path d="M4 16v4h16v-4"/></>,
    close: <path d="M5 5 19 19M19 5 5 19"/>,
    lock: <><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></>,
    pdf: <><path d="M6 2h8l5 5v14H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v6h5"/></>,
    check: <path d="m4 12 5 5L20 6"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function ExpensesPanel({ user, onNotice }: { user: ExUser; onNotice: (message: string) => void }) {
  const isAdmin = user.role === "admin";
  const [data, setData] = useState<Panel | null>(null);
  const [month, setMonth] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<ClaimDetail | null>(null);
  const [filter, setFilter] = useState<"all" | ClaimStatus>("all");
  const [search, setSearch] = useState("");
  const [reportFor, setReportFor] = useState("");
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState<Form>(() => emptyForm(new Date().toISOString().slice(0, 10)));
  const [files, setFiles] = useState<File[]>([]);
  const [formError, setFormError] = useState("");
  const [duplicate, setDuplicate] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [cutoff, setCutoff] = useState("");
  const picker = useRef<HTMLInputElement>(null);

  const load = async (target = month) => {
    setLoading(true); setError("");
    try {
      const next = await api<Panel>(`/api/demo/expenses${target ? `?month=${encodeURIComponent(target)}` : ""}`);
      setData(next); setMonth(next.month); setCutoff(String(next.settings.cutoff_day));
      setDetail((old) => old && next.claims.some((c) => c.id === old.id) ? old : null);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not load expenses"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(""); }, []);

  const act = async (body: Record<string, unknown>, done?: (result: any) => string) => {
    setBusy(true);
    try {
      const { result } = await api<{ result: any }>("/api/demo/expenses", body);
      if (done) onNotice(done(result));
      await load();
      return result;
    } catch (err) { onNotice(err instanceof Error ? err.message : "That did not work"); return null; }
    finally { setBusy(false); }
  };

  const open = async (row: ClaimRow) => {
    setRejecting(false); setNote("");
    try { setDetail((await api<{ claim: ClaimDetail }>(`/api/demo/expenses/claim?claim=${encodeURIComponent(row.number)}`)).claim); }
    catch (err) { onNotice(err instanceof Error ? err.message : "Could not open the claim"); }
  };

  const rows = useMemo(() => (data?.claims ?? []).filter((c) => (filter === "all" ? c.status !== "withdrawn" : c.status === filter)
    && `${c.number} ${c.claimant} ${c.merchant} ${c.category}`.toLowerCase().includes(search.toLowerCase())), [data, filter, search]);
  const claimants = useMemo(() => [...new Set((data?.claims ?? []).map((c) => c.claimant))].sort(), [data]);
  const selected = data?.selected ?? null;
  const open_ = selected?.status === "open";
  const currency = data?.settings.currency ?? "MYR";
  const totals = data?.totals;
  const reportHref = `/api/demo/expenses/report?month=${encodeURIComponent(month)}${isAdmin && reportFor ? `&claimant=${encodeURIComponent(reportFor)}` : ""}`;

  const addFiles = (picked: FileList | null) => {
    if (!picked) return;
    const valid = Array.from(picked).filter((f) => f.type === "application/pdf" || /^image\/(png|jpe?g|webp|gif)$/.test(f.type));
    if (valid.length !== picked.length) onNotice("Receipts must be a photo, screenshot (PNG/JPG/WebP/GIF) or PDF.");
    if (valid.some((f) => f.size > MAX_BYTES)) onNotice("Each receipt must be under 8 MB.");
    setFiles((old) => [...old, ...valid.filter((f) => f.size <= MAX_BYTES)].slice(0, MAX_FILES));
    if (picker.current) picker.current.value = "";
  };

  const submitClaim = async (event: FormEvent, allowDuplicate = false) => {
    event.preventDefault();
    setFormError(""); setDuplicate(false); setBusy(true);
    try {
      const attachments = await Promise.all(files.map(readFile));
      const { result } = await api<{ result: { claim: { number: string }; submission: { label: string; cutoff_date: string }; warnings: string[] } }>("/api/demo/expenses", {
        action: "claim", attachments,
        claim: {
          expense_date: form.expense_date, merchant: form.merchant, category: form.category, amount: form.amount, tax_amount: form.tax_amount || undefined,
          payment_method: form.payment_method, description: form.description, claimant: isAdmin ? form.claimant || undefined : undefined,
          no_receipt_reason: form.no_receipt ? form.no_receipt_reason : undefined, allow_duplicate: allowDuplicate || undefined,
        },
      });
      onNotice(`Filed ${result.claim.number} in the ${result.submission.label} (cut-off ${fmtDate(result.submission.cutoff_date)}).${result.warnings?.length ? ` ${result.warnings[0]}` : ""}`);
      setModal(false); setFiles([]); setForm(emptyForm(data?.today ?? form.expense_date));
      await load("");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not file the claim";
      setFormError(message); setDuplicate(/^Possible duplicate/.test(message));
    } finally { setBusy(false); }
  };

  const closeMonth = async () => {
    if (!selected) return;
    const pending = selected.totals.pending_count;
    if (!window.confirm(`Close the ${selected.label}? Its claims freeze and the final report is created. This cannot be undone.`)) return;
    let carry = false;
    if (pending > 0) {
      carry = window.confirm(`${pending} claim${pending === 1 ? " is" : "s are"} still pending. Move ${pending === 1 ? "it" : "them"} to the next submission?`);
      if (!carry) { onNotice("Approve or reject the pending claims first, or carry them forward."); return; }
    }
    await act({ action: "close", month: selected.period_key, carry_forward_pending: carry }, (r) => `${r.submission.label} closed${r.carried_forward?.length ? `; ${r.carried_forward.length} claim(s) moved to the next month` : ""}.`);
  };

  const review = async (decision: "approve" | "reject") => {
    if (!detail) return;
    if (decision === "reject" && !note.trim()) { setRejecting(true); return; }
    const result = await act({ action: "review", claim: detail.number, decision, note: note.trim() || undefined }, (r) => `${r.claim.number} ${decision === "approve" ? "approved" : "rejected"}.`);
    if (result) { setRejecting(false); setNote(""); setDetail(result.claim); }
  };

  if (loading && !data) return <section className="ex-panel"><p className="ex-empty" role="status">Loading expense claims…</p></section>;
  if (error && !data) return <section className="ex-panel"><p className="ex-empty" role="alert">{error}</p><button className="ex-btn" onClick={() => void load("")}>Try again</button></section>;
  if (!data) return null;

  return <section className="ex-panel" aria-label="Expense claims">
    <header className="ex-head">
      <div>
        <div className="demo-panel-kicker"><Glyph name="receipt"/> EXPENSE CLAIMS</div>
        <h2>{selected?.label ?? data.current_submission.label}{selected && <span className={`ex-state ${selected.status}`}>{selected.status === "closed" ? <><Glyph name="lock" size={11}/> Closed</> : "Open"}</span>}</h2>
        <p>{selected ? `Claims filed ${fmtDate(selected.period_start)} to ${fmtDate(selected.cutoff_date)}. ` : "No claims filed for this month yet. "}
          {selected?.status === "open" && selected.days_left != null ? <strong>{selected.days_left < 0 ? "Cut-off passed" : selected.days_left === 0 ? "Cut-off is today" : `${selected.days_left} day${selected.days_left === 1 ? "" : "s"} to cut-off`}</strong> : null}
          {!isAdmin && <span> · showing your claims only</span>}</p>
      </div>
      <div className="ex-actions">
        <select aria-label="Monthly submission" value={month} onChange={(event) => { setMonth(event.target.value); setDetail(null); void load(event.target.value); }}>
          {!data.submissions.some((s) => s.period_key === data.current_submission.period_key) && <option value={data.current_submission.period_key}>{data.current_submission.label} (none yet)</option>}
          {data.submissions.map((s) => <option key={s.id} value={s.period_key}>{s.label}{s.status === "closed" ? " · closed" : ""}</option>)}
        </select>
        <button className="demo-primary ex-file" onClick={() => { setFormError(""); setDuplicate(false); setModal(true); }}><Glyph name="plus" size={16}/> File a claim</button>
      </div>
    </header>

    {totals && <div className="ex-stats">
      <div><span>Claims</span><strong>{totals.claims}</strong></div>
      <div><span>Claimed</span><strong>{fmtMoney(totals.claimed, currency)}</strong></div>
      <div className="ok"><span>Approved</span><strong>{fmtMoney(totals.approved, currency)}</strong></div>
      <div className="wait"><span>Pending</span><strong>{fmtMoney(totals.pending, currency)}</strong></div>
      <div className="no"><span>Rejected</span><strong>{fmtMoney(totals.rejected, currency)}</strong></div>
    </div>}

    <div className="ex-toolbar">
      <div className="ex-chips" role="group" aria-label="Filter by status">
        {(["all", "submitted", "approved", "rejected"] as const).map((s) => <button key={s} className={filter === s ? "on" : ""} onClick={() => setFilter(s)}>{s === "all" ? "All" : STATUS_LABEL[s]}</button>)}
      </div>
      <input aria-label="Search claims" placeholder="Search claim, person or merchant…" value={search} onChange={(event) => setSearch(event.target.value)}/>
      {selected && <div className="ex-report">
        {isAdmin && <select aria-label="Report for" value={reportFor} onChange={(event) => setReportFor(event.target.value)}><option value="">Whole submission</option>{claimants.map((c) => <option key={c} value={c}>{c}</option>)}</select>}
        <a className="ex-btn" href={reportHref} target="_blank" rel="noopener noreferrer"><Glyph name="pdf" size={15}/> {selected.status === "open" ? "Draft report" : "Final report"}</a>
      </div>}
    </div>

    <div className="ex-body">
      <div className="ex-table-wrap">
        {rows.length === 0 ? <div className="ex-empty">
          <p>{(data.claims.length === 0) ? "No claims here yet." : "No claims match this filter."}</p>
          <div><button className="ex-btn" onClick={() => setModal(true)}><Glyph name="plus" size={15}/> File a claim</button>{isAdmin && data.claims.length === 0 && <button className="ex-btn" disabled={busy} onClick={() => void act({ action: "seed" }, (r) => r.already_loaded ? `Demo claims are already loaded (${r.already_loaded}).` : `Loaded ${r.seeded} demo claims.`)}>Load demo claims</button>}</div>
        </div> : <table>
          <thead><tr><th>Claim</th>{isAdmin && <th>Claimant</th>}<th>Date</th><th>Merchant</th><th>Category</th><th className="r">Amount</th><th>Status</th></tr></thead>
          <tbody>{rows.map((c) => <tr key={c.id} className={detail?.id === c.id ? "selected" : ""} onClick={() => void open(c)}>
            <td><strong>{c.number}</strong><small>{c.receipts} receipt{c.receipts === 1 ? "" : "s"}</small></td>
            {isAdmin && <td>{c.claimant}</td>}
            <td>{fmtDate(c.expense_date)}</td><td>{c.merchant}</td><td>{data.categories.find((k) => k.key === c.category)?.label.replace(/ \(.*\)$/, "") ?? c.category}</td>
            <td className="r">{fmtMoney(c.amount, c.currency)}</td><td><span className={`ex-status ${c.status}`}>{STATUS_LABEL[c.status]}</span></td></tr>)}</tbody>
        </table>}
        {data.has_more && <p className="ex-more">Showing the first 50 claims.</p>}
      </div>

      {detail && <aside className="ex-detail" aria-label={`Claim ${detail.number}`}>
        <div className="ex-detail-head"><span>{detail.number}</span><button aria-label="Close claim" onClick={() => setDetail(null)}><Glyph name="close" size={14}/></button></div>
        <h3>{detail.merchant}</h3>
        <p className="ex-amount">{fmtMoney(detail.amount, detail.currency)} <span className={`ex-status ${detail.status}`}>{STATUS_LABEL[detail.status]}</span></p>
        <dl>
          <dt>Claimant</dt><dd>{detail.claimant.name}</dd>
          <dt>Receipt date</dt><dd>{fmtDate(detail.expense_date)}</dd>
          <dt>Category</dt><dd>{data.categories.find((k) => k.key === detail.category)?.label ?? detail.category}</dd>
          {detail.tax_amount != null && <><dt>Tax</dt><dd>{fmtMoney(detail.tax_amount, detail.currency)}</dd></>}
          {detail.payment_method && <><dt>Paid by</dt><dd>{detail.payment_method.replace(/_/g, " ")}</dd></>}
          {detail.description && <><dt>For</dt><dd>{detail.description}</dd></>}
          {detail.submission && <><dt>Submission</dt><dd>{detail.submission.label}</dd></>}
          {detail.reviewed_by && <><dt>Reviewed by</dt><dd>{detail.reviewed_by}</dd></>}
          {detail.review_note && <><dt>Reviewer note</dt><dd>{detail.review_note}</dd></>}
          {detail.no_receipt_reason && <><dt>No receipt</dt><dd>{detail.no_receipt_reason}</dd></>}
        </dl>
        {detail.receipts.length > 0 && <div className="ex-receipts">{detail.receipts.map((r) => r.mime.startsWith("image/")
          ? <a key={r.id} href={`/api/demo/expenses/receipt?id=${r.id}`} target="_blank" rel="noopener noreferrer"><img src={`/api/demo/expenses/receipt?id=${r.id}`} alt={r.name}/><small>{r.name}</small></a>
          : <a key={r.id} className="ex-pdf" href={`/api/demo/expenses/receipt?id=${r.id}`} target="_blank" rel="noopener noreferrer"><Glyph name="pdf" size={22}/><small>{r.name}</small></a>)}</div>}
        {detail.submission?.status === "open" && <div className="ex-detail-actions">
          {isAdmin && detail.status !== "withdrawn" && <>
            {rejecting && <input aria-label="Reason for rejecting" placeholder="Reason the claimant will see" value={note} onChange={(event) => setNote(event.target.value)}/>}
            <div><button className="ex-btn ok" disabled={busy || detail.status === "approved"} onClick={() => void review("approve")}><Glyph name="check" size={14}/> Approve</button>
              <button className="ex-btn no" disabled={busy || detail.status === "rejected"} onClick={() => void review("reject")}>Reject</button></div>
          </>}
          {(detail.status === "submitted" || detail.status === "rejected") && <button className="ex-link" disabled={busy} onClick={() => void act({ action: "withdraw", claim: detail.number }, (r) => `${r.claim.number} withdrawn.`).then((r) => { if (r) setDetail(null); })}>Withdraw this claim</button>}
        </div>}
        {detail.submission?.status === "closed" && <p className="ex-locked"><Glyph name="lock" size={13}/> This submission is closed. Nothing can change.</p>}
      </aside>}
    </div>

    {isAdmin && <footer className="ex-foot">
      <label>Cut-off day <select value={cutoff} onChange={(event) => setCutoff(event.target.value)}>{Array.from({ length: 28 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
      <button className="ex-btn" disabled={busy || cutoff === String(data.settings.cutoff_day)} onClick={() => void act({ action: "settings", cutoff_day: Number(cutoff) }, (r) => `Cut-off day is now ${r.settings.cutoff_day}.${r.claims_moved_between_open_submissions ? ` ${r.claims_moved_between_open_submissions} claim(s) moved to their new submission.` : ""}`)}>Save cut-off</button>
      <span className="ex-grow"/>
      {open_ && <button className="ex-btn no" disabled={busy || !selected || selected.totals.claims === 0} onClick={() => void closeMonth()}><Glyph name="lock" size={14}/> Close this submission</button>}
      {data.claims.length > 0 && <button className="ex-link" disabled={busy} onClick={() => void act({ action: "seed" }, (r) => r.already_loaded ? `Demo claims are already loaded (${r.already_loaded}).` : `Loaded ${r.seeded} demo claims.`)}>Load demo claims</button>}
    </footer>}

    {modal && <div className="demo-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setModal(false); }}>
      <div className="demo-modal ex-modal" role="dialog" aria-modal="true" aria-label="File an expense claim">
        <div className="demo-modal-head"><span className="demo-modal-icon"><Glyph name="receipt" size={22}/></span><button onClick={() => setModal(false)} aria-label="Close"><Glyph name="close" size={16}/></button></div>
        <h2>File an expense claim</h2>
        <p>One receipt per claim. It joins the {data.current_submission.label} (cut-off {fmtDate(data.current_submission.cutoff_date)}), or the next one if that is already closed.</p>
        <form onSubmit={(event) => void submitClaim(event)}>
          {isAdmin && <label>Claimant<select value={form.claimant} onChange={(event) => setForm({ ...form, claimant: event.target.value })}><option value="">Myself ({data.me.name})</option>{data.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ` · ${p.department}` : ""}</option>)}</select></label>}
          <div className="demo-form-row">
            <label>Date on receipt<input required type="date" max={data.today} value={form.expense_date} onChange={(event) => setForm({ ...form, expense_date: event.target.value })}/></label>
            <label>Total ({currency})<input required type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => setForm({ ...form, amount: event.target.value })} placeholder="0.00"/></label>
          </div>
          <label>Merchant<input required maxLength={120} value={form.merchant} onChange={(event) => setForm({ ...form, merchant: event.target.value })} placeholder="e.g. Grab, Petronas"/></label>
          <div className="demo-form-row">
            <label>Category<select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>{data.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></label>
            <label>Paid by<select value={form.payment_method} onChange={(event) => setForm({ ...form, payment_method: event.target.value })}>{data.payment_methods.map((p) => <option key={p} value={p}>{p.replace(/_/g, " ")}</option>)}</select></label>
          </div>
          <div className="demo-form-row">
            <label>Tax shown (optional)<input type="number" min="0" step="0.01" value={form.tax_amount} onChange={(event) => setForm({ ...form, tax_amount: event.target.value })} placeholder="0.00"/></label>
            <label>What was it for?<input maxLength={500} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="e.g. client lunch"/></label>
          </div>
          <div className="ex-drop">
            <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" multiple hidden onChange={(event) => addFiles(event.target.files)}/>
            <button type="button" className="ex-btn" onClick={() => picker.current?.click()}><Glyph name="upload" size={15}/> Add receipt (photo, screenshot or PDF)</button>
            {files.map((f, i) => <span key={`${f.name}-${i}`} className="ex-file-chip">{f.name}<button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((old) => old.filter((_, j) => j !== i))}><Glyph name="close" size={11}/></button></span>)}
            {files.length === 0 && <label className="ex-check"><input type="checkbox" checked={form.no_receipt} onChange={(event) => setForm({ ...form, no_receipt: event.target.checked })}/> I have no receipt</label>}
            {files.length === 0 && form.no_receipt && <input required maxLength={300} aria-label="Why there is no receipt" placeholder="Why is there no receipt?" value={form.no_receipt_reason} onChange={(event) => setForm({ ...form, no_receipt_reason: event.target.value })}/>}
          </div>
          {formError && <div className={`ex-error${duplicate ? " warn" : ""}`} role="alert">{formError}{duplicate && <button type="button" className="ex-btn" disabled={busy} onClick={(event) => void submitClaim(event as unknown as FormEvent, true)}>It is a separate expense, file anyway</button>}</div>}
          <button className="demo-primary" type="submit" disabled={busy || (files.length === 0 && !form.no_receipt)}><Glyph name="plus" size={16}/> {busy ? "Filing…" : "File claim"}</button>
        </form>
      </div>
    </div>}
  </section>;
}
