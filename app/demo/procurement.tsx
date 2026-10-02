import { useEffect, useMemo, useState } from "react";
import "./expenses.css";
import "./procurement.css";

type User = { id: string; username: string; display_name?: string; role: string };
type Tab = "pos" | "invoices" | "quotes" | "suppliers";
type PoRow = { id: string; number: string; status: string; supplier: string; total: number; currency: string; order_date: string; expected_date: string | null; overdue: boolean; received: string };
type DocRow = { id: string; number: string; type: string; status: string; supplier: string; supplier_ref: string; doc_date: string; due_date: string | null; valid_until: string | null; total: number; overdue: boolean; expired: boolean; po: string | null };
type SupplierRow = { id: string; code: string; name: string; email: string | null; phone: string | null; contact_name: string | null; payment_terms_days: number | null; open_pos: number; owed: number };
type Overview = {
  purchase_orders: { by_status: Record<string, { count: number; total: number }>; awaiting_delivery: { count: number; value: number }; late_deliveries: { number: string; supplier: string; expected_date: string }[] };
  invoices: { unpaid: { count: number; total: number }; overdue: { count: number; total: number }; due_within_7_days: { count: number; total: number }; disputed: { count: number; total: number }; overdue_list: { number: string; supplier: string; due_date: string }[]; not_matching_po: { number: string; supplier_ref: string; issues: string[] }[] };
  quotations: { open: number; expired_unanswered: number; accepted_not_ordered: number };
};
type State = { me: { username: string; role: string }; overview: Overview; pos: PoRow[]; invoices: DocRow[]; quotations: DocRow[]; suppliers: SupplierRow[] };
type Line = { line_no: number; description: string; unit: string; quantity: number; unit_price: number; tax_rate: number; total: number; received_qty: number; outstanding: number };
type PoDetail = {
  po: { id: string; number: string; status: string; supplier: { code: string; name: string } | null; order_date: string; expected_date: string | null; overdue: boolean; ship_to: string | null; payment_terms_days: number | null; currency: string; subtotal: number; tax_total: number; total: number; notes: string | null; issued_by: string | null; cancel_reason: string | null; progress: { ordered: number; received: number }; lines: Line[] };
  documents: { number: string; type: string; supplier_ref: string; status: string; total: number }[];
  goods_receipts: { received_on: string; received_by: string; note: string | null; lines: { line_no: number; description: string; quantity: number }[] }[];
};
type Match = { status: string; issues: string[]; po?: string; po_total?: number; invoiced_to_date?: number; received_value?: number };
type DocDetail = {
  document: { id: string; number: string; type: string; status: string; supplier: { code: string; name: string } | null; supplier_ref: string; doc_date: string; valid_until: string | null; due_date: string | null; currency: string; subtotal: number; tax_total: number; total: number; overdue: boolean; expired: boolean; lines: { description: string; quantity: number; unit_price: number; total?: number }[]; po?: string | null; file: { name: string; mime: string } | null; note: string | null; paid_on: string | null; payment_ref: string | null; paid_by: string | null; dispute_reason: string | null };
  match?: Match;
};
type Detail = { kind: "po"; data: PoDetail } | { kind: "doc"; data: DocDetail } | null;
type DraftLine = { description: string; quantity: string; unit_price: string; tax_rate: string };

const LABEL: Record<string, string> = { draft: "Draft", issued: "Issued", partially_received: "Part received", received: "Received", cancelled: "Cancelled", unpaid: "Unpaid", paid: "Paid", disputed: "Disputed", void: "Void", accepted: "Accepted", rejected: "Rejected", converted: "Ordered" };
const blankLine = (): DraftLine => ({ description: "", quantity: "1", unit_price: "", tax_rate: "8" });

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

export function ProcurementPanel({ user, onNotice }: { user: User; onNotice: (message: string) => void }) {
  const isAdmin = user.role === "admin";
  const [data, setData] = useState<State | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("pos");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Detail>(null);
  const [recv, setRecv] = useState<Record<number, string>>({});
  const [modal, setModal] = useState(false);
  const [draft, setDraft] = useState({ supplier: "", expected_date: "", ship_to: "", notes: "" });
  const [draftLines, setDraftLines] = useState<DraftLine[]>([blankLine()]);
  const [formError, setFormError] = useState("");

  const load = async () => {
    setLoading(true); setError("");
    try { setData(await api<State>("/api/demo/procurement")); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not load procurement"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const openPo = async (number: string) => {
    try { setRecv({}); setTab("pos"); setDetail({ kind: "po", data: await api<PoDetail>(`/api/demo/procurement/po?po=${encodeURIComponent(number)}`) }); }
    catch (err) { onNotice(err instanceof Error ? err.message : "Could not open the order"); }
  };
  const openDoc = async (number: string, switchTab?: Tab) => {
    try { if (switchTab) setTab(switchTab); setDetail({ kind: "doc", data: await api<DocDetail>(`/api/demo/procurement/doc?doc=${encodeURIComponent(number)}`) }); }
    catch (err) { onNotice(err instanceof Error ? err.message : "Could not open the document"); }
  };

  /** Runs an action, shows its outcome, reloads the lists and re-opens whatever was open. */
  const act = async (body: Record<string, unknown>, done: (result: any) => string, reopen?: () => Promise<void>) => {
    setBusy(true);
    try {
      const { result } = await api<{ result: any }>("/api/demo/procurement", body);
      onNotice(done(result));
      await load();
      if (reopen) await reopen();
      return result;
    } catch (err) { onNotice(err instanceof Error ? err.message : "That did not work"); return null; }
    finally { setBusy(false); }
  };

  const ask = (question: string) => (window.prompt(question) || "").trim();
  const q = search.toLowerCase();
  const pos = useMemo(() => (data?.pos ?? []).filter((p) => `${p.number} ${p.supplier} ${p.status}`.toLowerCase().includes(q)), [data, q]);
  const invoices = useMemo(() => (data?.invoices ?? []).filter((d) => `${d.number} ${d.supplier} ${d.supplier_ref} ${d.status}`.toLowerCase().includes(q)), [data, q]);
  const quotes = useMemo(() => (data?.quotations ?? []).filter((d) => `${d.number} ${d.supplier} ${d.supplier_ref} ${d.status}`.toLowerCase().includes(q)), [data, q]);
  const suppliers = useMemo(() => (data?.suppliers ?? []).filter((s) => `${s.code} ${s.name} ${s.email ?? ""}`.toLowerCase().includes(q)), [data, q]);

  const submitDraft = async () => {
    setFormError("");
    const lines = draftLines.filter((l) => l.description.trim());
    if (!draft.supplier) return setFormError("Choose a supplier.");
    if (!lines.length) return setFormError("Add at least one line with a description.");
    const result = await act({ action: "draft", po: { ...draft, lines } }, (r) => `Drafted ${r.po.number} for ${fmtMoney(r.po.total)}. An admin issues it to give it a PO number.`);
    if (result) { setModal(false); setDraft({ supplier: "", expected_date: "", ship_to: "", notes: "" }); setDraftLines([blankLine()]); await openPo(result.po.number); }
  };

  if (loading && !data) return <section className="ex-panel"><p className="ex-empty" role="status">Loading procurement…</p></section>;
  if (error && !data) return <section className="ex-panel"><p className="ex-empty" role="alert">{error}</p><button className="ex-btn" onClick={() => void load()}>Try again</button></section>;
  if (!data) return null;
  const o = data.overview;
  const empty = data.suppliers.length === 0 && data.pos.length === 0;
  const needsReview = o.invoices.not_matching_po.length;
  const attention = [
    ...o.purchase_orders.late_deliveries.map((p) => ({ key: p.number, tone: "wait", label: `${p.number} late (${p.supplier})`, open: () => void openPo(p.number) })),
    ...o.invoices.overdue_list.map((d) => ({ key: d.number, tone: "no", label: `${d.number} overdue (${d.supplier})`, open: () => void openDoc(d.number, "invoices") })),
    ...o.invoices.not_matching_po.map((d) => ({ key: `m-${d.number}`, tone: "wait", label: `${d.number} doesn't match its PO`, open: () => void openDoc(d.number, "invoices") })),
  ];

  const po = detail?.kind === "po" ? detail.data : null;
  const doc = detail?.kind === "doc" ? detail.data : null;
  const reopenPo = async () => { if (po) await openPo(po.po.number); };
  const reopenDoc = async () => { if (doc) await openDoc(doc.document.number); };

  return <section className="ex-panel pr-panel" aria-label="Procurement">
    <header className="ex-head">
      <div>
        <div className="demo-panel-kicker">PROCUREMENT</div>
        <h2>From quote to payment</h2>
        <p>Suppliers, their quotations and invoices, purchase orders, and goods received. Every invoice is checked against what was ordered and received before it is paid.{!isAdmin && <span> · Only an admin can issue POs and mark invoices paid.</span>}</p>
      </div>
      <div className="ex-actions"><button className="demo-primary ex-file" onClick={() => { setFormError(""); setModal(true); }}>New draft PO</button></div>
    </header>

    <div className="ex-stats pr-stats">
      <div><span>Waiting for goods</span><strong>{o.purchase_orders.awaiting_delivery.count}</strong><small>{fmtMoney(o.purchase_orders.awaiting_delivery.value)}</small></div>
      <div className={o.purchase_orders.late_deliveries.length ? "wait" : ""}><span>Late deliveries</span><strong>{o.purchase_orders.late_deliveries.length}</strong></div>
      <div><span>Unpaid invoices</span><strong>{fmtMoney(o.invoices.unpaid.total)}</strong><small>{o.invoices.unpaid.count} invoice{o.invoices.unpaid.count === 1 ? "" : "s"}</small></div>
      <div className={o.invoices.overdue.count ? "no" : ""}><span>Overdue</span><strong>{fmtMoney(o.invoices.overdue.total)}</strong><small>{o.invoices.overdue.count} invoice{o.invoices.overdue.count === 1 ? "" : "s"}</small></div>
      <div className={needsReview ? "wait" : ""}><span>Don't match their PO</span><strong>{needsReview}</strong><small>{o.invoices.disputed.count} disputed</small></div>
    </div>

    {attention.length > 0 && <div className="pr-attention"><span>NEEDS ATTENTION</span>{attention.map((a) => <button key={a.key} className={`pr-chip ${a.tone}`} onClick={a.open}>{a.label}</button>)}</div>}

    <div className="ex-toolbar">
      <div className="ex-chips" role="tablist" aria-label="Procurement lists">
        {([["pos", `Purchase orders (${data.pos.length})`], ["invoices", `Supplier invoices (${data.invoices.length})`], ["quotes", `Quotations (${data.quotations.length})`], ["suppliers", `Suppliers (${data.suppliers.length})`]] as const).map(([key, label]) =>
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? "on" : ""} onClick={() => { setTab(key); setDetail(null); }}>{label}</button>)}
      </div>
      <input aria-label="Search" placeholder="Search number, supplier or status…" value={search} onChange={(event) => setSearch(event.target.value)}/>
    </div>

    <div className="ex-body">
      <div className="ex-table-wrap">
        {empty ? <div className="ex-empty"><p>No procurement records yet.</p><div>{isAdmin && <button className="ex-btn" disabled={busy} onClick={() => void act({ action: "seed" }, (r) => r.already_loaded ? "Demo data is already loaded." : `Loaded ${r.seeded} demo records.`)}>Load demo data</button>}<button className="ex-btn" onClick={() => setModal(true)}>New draft PO</button></div></div>
        : tab === "pos" ? <table><thead><tr><th>PO</th><th>Supplier</th><th>Expected</th><th>Received</th><th className="r">Total</th><th>Status</th></tr></thead>
          <tbody>{pos.map((p) => <tr key={p.id} className={po?.po.id === p.id ? "selected" : ""} onClick={() => void openPo(p.number)}>
            <td><strong>{p.number}</strong><small>{fmtDate(p.order_date)}</small></td><td>{p.supplier}</td>
            <td>{p.expected_date ? fmtDate(p.expected_date) : "-"}{p.overdue && <span className="pr-late"> late</span>}</td><td>{p.received}</td>
            <td className="r">{fmtMoney(p.total, p.currency)}</td><td><span className={`ex-status ${p.status}`}>{LABEL[p.status] ?? p.status}</span></td></tr>)}</tbody></table>
        : tab === "invoices" ? <table><thead><tr><th>Invoice</th><th>Supplier</th><th>Due</th><th>PO</th><th className="r">Total</th><th>Status</th></tr></thead>
          <tbody>{invoices.map((d) => <tr key={d.id} className={doc?.document.id === d.id ? "selected" : ""} onClick={() => void openDoc(d.number)}>
            <td><strong>{d.number}</strong><small>{d.supplier_ref}</small></td><td>{d.supplier}</td>
            <td>{d.due_date ? fmtDate(d.due_date) : "-"}{d.overdue && <span className="pr-late"> overdue</span>}</td><td>{d.po ?? "-"}</td>
            <td className="r">{fmtMoney(d.total)}</td><td><span className={`ex-status ${d.status}`}>{LABEL[d.status] ?? d.status}</span></td></tr>)}</tbody></table>
        : tab === "quotes" ? <table><thead><tr><th>Quotation</th><th>Supplier</th><th>Valid until</th><th className="r">Total</th><th>Status</th></tr></thead>
          <tbody>{quotes.map((d) => <tr key={d.id} className={doc?.document.id === d.id ? "selected" : ""} onClick={() => void openDoc(d.number)}>
            <td><strong>{d.number}</strong><small>{d.supplier_ref}</small></td><td>{d.supplier}</td>
            <td>{d.valid_until ? fmtDate(d.valid_until) : "-"}{d.expired && <span className="pr-late"> expired</span>}</td>
            <td className="r">{fmtMoney(d.total)}</td><td><span className={`ex-status ${d.status}`}>{LABEL[d.status] ?? d.status}</span></td></tr>)}</tbody></table>
        : <table><thead><tr><th>Supplier</th><th>Contact</th><th>Terms</th><th>Open POs</th><th className="r">We owe</th></tr></thead>
          <tbody>{suppliers.map((s) => <tr key={s.id} style={{ cursor: "default" }}><td><strong>{s.name}</strong><small>{s.code}</small></td><td>{s.contact_name ?? "-"}<small>{s.email ?? s.phone ?? ""}</small></td>
            <td>{s.payment_terms_days != null ? `${s.payment_terms_days} days` : "-"}</td><td>{s.open_pos}</td><td className="r">{fmtMoney(s.owed)}</td></tr>)}</tbody></table>}
      </div>

      {po && <aside className="ex-detail" aria-label={`Purchase order ${po.po.number}`}>
        <div className="ex-detail-head"><span>{po.po.number}</span><button aria-label="Close" onClick={() => setDetail(null)}>×</button></div>
        <h3>{po.po.supplier?.name}</h3>
        <p className="ex-amount">{fmtMoney(po.po.total, po.po.currency)} <span className={`ex-status ${po.po.status}`}>{LABEL[po.po.status] ?? po.po.status}</span></p>
        <dl>
          <dt>Order date</dt><dd>{fmtDate(po.po.order_date)}</dd>
          <dt>Expected</dt><dd>{po.po.expected_date ? fmtDate(po.po.expected_date) : "Not set"}{po.po.overdue && <span className="pr-late"> late</span>}</dd>
          {po.po.ship_to && <><dt>Deliver to</dt><dd>{po.po.ship_to}</dd></>}
          {po.po.payment_terms_days != null && <><dt>Terms</dt><dd>{po.po.payment_terms_days} days</dd></>}
          {po.po.issued_by && <><dt>Issued by</dt><dd>{po.po.issued_by}</dd></>}
          {po.po.cancel_reason && <><dt>Cancelled</dt><dd>{po.po.cancel_reason}</dd></>}
          {po.po.notes && <><dt>Notes</dt><dd>{po.po.notes}</dd></>}
        </dl>
        <table className="pr-lines"><thead><tr><th>Item</th><th className="r">Ordered</th><th className="r">Got</th>{["issued", "partially_received"].includes(po.po.status) && <th className="r">Now</th>}</tr></thead>
          <tbody>{po.po.lines.map((l) => <tr key={l.line_no}><td>{l.description}<small>{fmtMoney(l.unit_price)} × {l.quantity} {l.unit}</small></td><td className="r">{l.quantity}</td>
            <td className="r"><span className="pr-bar"><i style={{ width: `${Math.min(100, (l.received_qty / l.quantity) * 100)}%` }}/></span>{l.received_qty}</td>
            {["issued", "partially_received"].includes(po.po.status) && <td className="r">{l.outstanding > 0 ? <input aria-label={`Receive ${l.description}`} type="number" min="0" max={l.outstanding} step="any" value={recv[l.line_no] ?? ""} placeholder={String(l.outstanding)} onChange={(event) => setRecv({ ...recv, [l.line_no]: event.target.value })}/> : "✓"}</td>}</tr>)}</tbody></table>
        {po.documents.length > 0 && <div className="pr-links">{po.documents.map((d) => <button key={d.number} className="ex-link" onClick={() => void openDoc(d.number, d.type === "invoice" ? "invoices" : "quotes")}>{d.number} · {d.supplier_ref} · {LABEL[d.status] ?? d.status}</button>)}</div>}
        {po.goods_receipts.length > 0 && <div className="pr-receipts"><b>Goods received</b>{po.goods_receipts.map((r, i) => <p key={i}>{fmtDate(r.received_on)} by {r.received_by}: {r.lines.map((l) => `${l.quantity} × ${l.description}`).join(", ")}{r.note ? ` (${r.note})` : ""}</p>)}</div>}
        <div className="ex-detail-actions">
          <div>
            {["issued", "partially_received"].includes(po.po.status) && <>
              <button className="ex-btn ok" disabled={busy || !Object.values(recv).some((v) => Number(v) > 0)} onClick={() => void act({ action: "receive", po: po.po.number, lines: Object.entries(recv).map(([line_no, quantity]) => ({ line_no, quantity })) }, (r) => `Received. ${r.complete ? "The order is complete." : `${r.outstanding.length} line(s) still to come.`}`, reopenPo)}>Receive entered</button>
              <button className="ex-btn" disabled={busy} onClick={() => void act({ action: "receive", po: po.po.number, receive_all: true }, () => "Everything outstanding received.", reopenPo)}>Receive all</button></>}
            {po.po.status !== "draft" && po.po.status !== "cancelled" && <a className="ex-btn" href={`/api/demo/procurement/po-pdf?po=${encodeURIComponent(po.po.number)}`} target="_blank" rel="noopener noreferrer">PO PDF</a>}
            {po.po.status === "draft" && <a className="ex-btn" href={`/api/demo/procurement/po-pdf?po=${encodeURIComponent(po.po.number)}`} target="_blank" rel="noopener noreferrer">Draft PDF</a>}
          </div>
          {isAdmin && po.po.status === "draft" && <button className="ex-btn ok" disabled={busy} onClick={() => void act({ action: "issue", po: po.po.number }, (r) => `${r.po.number} issued. The PDF is ready.`, async () => { const n = detail?.kind === "po" ? po.po.id : ""; if (n) await openPo(n); })}>Issue this PO</button>}
          {isAdmin && ["draft", "issued"].includes(po.po.status) && <button className="ex-link" disabled={busy} onClick={() => { const reason = ask("Why is this order being cancelled?"); if (reason) void act({ action: "cancel_po", po: po.po.number, reason }, (r) => `${r.po.number} cancelled.`, reopenPo); }}>Cancel this order</button>}
        </div>
      </aside>}

      {doc && <aside className="ex-detail" aria-label={`Supplier ${doc.document.type} ${doc.document.number}`}>
        <div className="ex-detail-head"><span>{doc.document.number}</span><button aria-label="Close" onClick={() => setDetail(null)}>×</button></div>
        <h3>{doc.document.supplier?.name}</h3>
        <p className="ex-amount">{fmtMoney(doc.document.total, doc.document.currency)} <span className={`ex-status ${doc.document.status}`}>{LABEL[doc.document.status] ?? doc.document.status}</span></p>
        <dl>
          <dt>Their number</dt><dd>{doc.document.supplier_ref}</dd><dt>Dated</dt><dd>{fmtDate(doc.document.doc_date)}</dd>
          {doc.document.due_date && <><dt>Due</dt><dd>{fmtDate(doc.document.due_date)}{doc.document.overdue && <span className="pr-late"> overdue</span>}</dd></>}
          {doc.document.valid_until && <><dt>Valid until</dt><dd>{fmtDate(doc.document.valid_until)}{doc.document.expired && <span className="pr-late"> expired</span>}</dd></>}
          {doc.document.po && <><dt>Purchase order</dt><dd><button className="ex-link" onClick={() => void openPo(doc.document.po as string)}>{doc.document.po}</button></dd></>}
          {doc.document.paid_on && <><dt>Paid</dt><dd>{fmtDate(doc.document.paid_on)}{doc.document.payment_ref ? ` · ${doc.document.payment_ref}` : ""}{doc.document.paid_by ? ` · ${doc.document.paid_by}` : ""}</dd></>}
          {doc.document.dispute_reason && <><dt>Dispute</dt><dd>{doc.document.dispute_reason}</dd></>}
          {doc.document.note && <><dt>Note</dt><dd>{doc.document.note}</dd></>}
        </dl>
        {doc.match && doc.document.type === "invoice" && <div className={`pr-match ${doc.match.status}`}>
          <b>{doc.match.status === "matched" ? "Matches the PO and the goods received" : doc.match.status === "no_po" ? "Not linked to a PO" : doc.match.status === "void" ? "Void" : "Needs review before paying"}</b>
          {doc.match.issues.map((issue, i) => <p key={i}>{issue}</p>)}
        </div>}
        {doc.document.lines.length > 0 && <table className="pr-lines"><thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Price</th></tr></thead>
          <tbody>{doc.document.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className="r">{l.quantity}</td><td className="r">{fmtMoney(l.unit_price)}</td></tr>)}</tbody></table>}
        <div className="ex-detail-actions">
          <div>{doc.document.file && <a className="ex-btn" href={`/api/demo/procurement/file?id=${doc.document.id}`} target="_blank" rel="noopener noreferrer">View their document</a>}</div>
          {doc.document.type === "invoice" && doc.document.status === "unpaid" && <>
            {isAdmin && <button className="ex-btn ok" disabled={busy} onClick={() => {
              const review = doc.match?.status === "review";
              if (review && !window.confirm(`This invoice does not match its purchase order:\n\n- ${doc.match!.issues.join("\n- ")}\n\nMark it paid anyway?`)) return;
              void act({ action: "invoice_status", invoice: doc.document.number, status: "paid", confirm_mismatch: review }, (r) => `${r.document.number} marked paid.`, reopenDoc);
            }}>Mark paid</button>}
            <button className="ex-link" disabled={busy} onClick={() => { const reason = ask("What is wrong with this invoice?"); if (reason) void act({ action: "invoice_status", invoice: doc.document.number, status: "disputed", reason }, (r) => `${r.document.number} disputed.`, reopenDoc); }}>Dispute this invoice</button>
            {isAdmin && <button className="ex-link" disabled={busy} onClick={() => { const reason = ask("Why is this invoice being voided?"); if (reason) void act({ action: "invoice_status", invoice: doc.document.number, status: "void", reason }, (r) => `${r.document.number} voided.`, reopenDoc); }}>Void</button>}</>}
          {isAdmin && doc.document.type === "invoice" && doc.document.status === "disputed" && <button className="ex-btn" disabled={busy} onClick={() => void act({ action: "invoice_status", invoice: doc.document.number, status: "unpaid" }, () => "Dispute resolved.", reopenDoc)}>Resolve dispute</button>}
          {doc.document.type === "quotation" && ["received", "accepted"].includes(doc.document.status) && <>
            <button className="ex-btn ok" disabled={busy} onClick={() => { const expected = ask("Expected delivery date (YYYY-MM-DD), or leave empty"); void act({ action: "draft", po: { from_quotation: doc.document.number, ...(expected ? { expected_date: expected } : {}) } }, (r) => `Drafted ${r.po.number} from ${doc.document.number}.`, async () => {}).then((r) => { if (r) void openPo(r.po.number); }); }}>Make a draft PO</button>
            {doc.document.status === "received" && <button className="ex-link" disabled={busy} onClick={() => void act({ action: "quotation", doc: doc.document.number, decision: "reject" }, () => "Quotation rejected.", reopenDoc)}>Reject</button>}</>}
        </div>
      </aside>}
    </div>

    {isAdmin && !empty && <footer className="ex-foot"><span className="ex-grow"/><button className="ex-link" disabled={busy} onClick={() => void act({ action: "seed" }, (r) => r.already_loaded ? "Demo data is already loaded." : `Loaded ${r.seeded} demo records.`)}>Load demo data</button></footer>}

    {modal && <div className="demo-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setModal(false); }}>
      <div className="demo-modal ex-modal pr-modal" role="dialog" aria-modal="true" aria-label="New draft purchase order">
        <div className="demo-modal-head"><span className="demo-modal-icon">PO</span><button onClick={() => setModal(false)} aria-label="Close">×</button></div>
        <h2>New draft purchase order</h2>
        <p>A draft has no number and can be edited. An admin issues it, which numbers and freezes it.</p>
        <form onSubmit={(event) => { event.preventDefault(); void submitDraft(); }}>
          <label>Supplier<select required value={draft.supplier} onChange={(event) => setDraft({ ...draft, supplier: event.target.value })}><option value="">Choose…</option>{data.suppliers.map((s) => <option key={s.id} value={s.code}>{s.code} · {s.name}</option>)}</select></label>
          <div className="demo-form-row"><label>Expected delivery<input type="date" value={draft.expected_date} onChange={(event) => setDraft({ ...draft, expected_date: event.target.value })}/></label>
            <label>Deliver to<input maxLength={300} value={draft.ship_to} onChange={(event) => setDraft({ ...draft, ship_to: event.target.value })} placeholder="Address"/></label></div>
          <div className="pr-draft-lines"><div className="pr-draft-line pr-draft-head" aria-hidden="true"><span>Item</span><span>Qty</span><span>Unit price</span><span>Tax %</span><span/></div>{draftLines.map((l, i) => <div key={i} className="pr-draft-line">
            <input aria-label={`Line ${i + 1} description`} placeholder="Item" value={l.description} onChange={(event) => setDraftLines(draftLines.map((x, j) => j === i ? { ...x, description: event.target.value } : x))}/>
            <input aria-label={`Line ${i + 1} quantity`} type="number" min="0.001" step="any" value={l.quantity} onChange={(event) => setDraftLines(draftLines.map((x, j) => j === i ? { ...x, quantity: event.target.value } : x))}/>
            <input aria-label={`Line ${i + 1} unit price`} type="number" min="0" step="0.01" placeholder="Price" value={l.unit_price} onChange={(event) => setDraftLines(draftLines.map((x, j) => j === i ? { ...x, unit_price: event.target.value } : x))}/>
            <input aria-label={`Line ${i + 1} tax percent`} type="number" min="0" max="100" step="any" value={l.tax_rate} onChange={(event) => setDraftLines(draftLines.map((x, j) => j === i ? { ...x, tax_rate: event.target.value } : x))}/>
            {draftLines.length > 1 && <button type="button" aria-label={`Remove line ${i + 1}`} onClick={() => setDraftLines(draftLines.filter((_, j) => j !== i))}>×</button>}</div>)}
            <button type="button" className="ex-link" onClick={() => setDraftLines([...draftLines, blankLine()])}>+ Add a line</button></div>
          <label>Notes<input maxLength={1000} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="Optional"/></label>
          {formError && <div className="ex-error" role="alert">{formError}</div>}
          <button className="demo-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save draft"}</button>
        </form>
      </div>
    </div>}
  </section>;
}
