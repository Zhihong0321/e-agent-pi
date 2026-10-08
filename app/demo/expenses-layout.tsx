import { useEffect, useMemo, useRef, useState } from "react";

// How this company has chosen to show the Expenses page. The server resolves it (the default plus
// the company's changes); the page only draws it. This file is the admin's editor for it.
export type LayoutItem = { id: string; label: string; default_label: string; visible: boolean; locked: boolean; pinned: boolean };
export type LayoutBlock = { reorder: boolean; items: LayoutItem[] };
export type BlockName = "tiles" | "columns" | "chips" | "detail" | "form";
export type Layout = {
  default_rev: number; rev: number; customized: boolean; override_invalid: boolean; unavailable?: boolean;
  kicker: { value: string; default: string }; blocks: Record<BlockName, LayoutBlock>;
};

type Config = Record<string, unknown>;
type Draft = Record<BlockName, LayoutItem[]>;

const SECTIONS: { name: BlockName; title: string; hint: string }[] = [
  { name: "tiles", title: "Summary tiles", hint: "The totals across the top." },
  { name: "columns", title: "Table columns", hint: "What each claim row shows. Claim, Amount and Status always stay." },
  { name: "chips", title: "Status filters", hint: "A status name changes everywhere on this page, including the badges." },
  { name: "detail", title: "Claim details", hint: "The rows in the panel that opens when you click a claim." },
  { name: "form", title: "Filing form", hint: "Date, total, merchant, category and the receipt always stay. Their names can change." },
];

const startDraft = (layout: Layout): Draft =>
  Object.fromEntries(SECTIONS.map((s) => [s.name, layout.blocks[s.name].items.map((i) => ({ ...i }))])) as Draft;

/** Only what differs from the default is sent; the server drops anything equal to it anyway. */
function toConfig(layout: Layout, draft: Draft, kicker: string): Config {
  const config: Config = {};
  const heading = kicker.trim();
  if (heading && heading !== layout.kicker.default) config.kicker = heading;
  for (const { name } of SECTIONS) {
    const items = draft[name];
    const block: { order?: string[]; hidden?: string[]; labels?: Record<string, string> } = {};
    if (layout.blocks[name].reorder) block.order = items.map((i) => i.id);
    const hidden = items.filter((i) => !i.visible).map((i) => i.id);
    if (hidden.length) block.hidden = hidden;
    const labels = Object.fromEntries(items.filter((i) => i.label.trim() && i.label.trim() !== i.default_label).map((i) => [i.id, i.label.trim()]));
    if (Object.keys(labels).length) block.labels = labels;
    if (Object.keys(block).length) config[name] = block;
  }
  return config;
}

export function LayoutEditor({ layout, busy, onSave, onReset, onReload, onClose }: {
  layout: Layout; busy: boolean;
  onSave: (config: Config) => Promise<string | null>;
  onReset: () => Promise<string | null>;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => startDraft(layout));
  const [kicker, setKicker] = useState(layout.kicker.value);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const initial = useMemo(() => JSON.stringify(toConfig(layout, startDraft(layout), layout.kicker.value)), [layout]);
  const config = toConfig(layout, draft, kicker);
  const changed = JSON.stringify(config) !== initial;
  const stale = /changed this page/i.test(error);

  useEffect(() => { dialog.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const edit = (name: BlockName, id: string, patch: Partial<LayoutItem>) =>
    setDraft((old) => ({ ...old, [name]: old[name].map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  const move = (name: BlockName, index: number, by: -1 | 1) =>
    setDraft((old) => {
      const items = [...old[name]];
      const target = index + by;
      if (target < 0 || target >= items.length || items[target].pinned || items[index].pinned) return old;
      [items[index], items[target]] = [items[target], items[index]];
      return { ...old, [name]: items };
    });

  const save = async () => { setError(""); setError((await onSave(config)) ?? ""); };
  const restore = async () => {
    if (!window.confirm("Restore the default layout? Every change made to this page is removed for everyone in your company.")) return;
    setError(""); setError((await onReset()) ?? "");
  };

  return <div className="demo-modal-backdrop">
    <div ref={dialog} tabIndex={-1} className="demo-modal ex-modal ex-custom" role="dialog" aria-modal="true" aria-label="Customize the Expenses page">
      <div className="ex-custom-head">
        <div><h2>Customize this page</h2><p>Choose what people in your company see on Expenses. Rules such as required fields are not changed here.</p></div>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="ex-custom-body">
        {layout.override_invalid && <div className="ex-error warn" role="alert">Part of the saved layout no longer fits this page, so it is being ignored. Save to replace it, or restore the default.</div>}
        <section className="ex-custom-sec">
          <h3>Page heading</h3>
          <p>The small label above the month.</p>
          <input type="text" maxLength={40} aria-label="Page heading" placeholder={layout.kicker.default} value={kicker} onChange={(event) => setKicker(event.target.value)}/>
        </section>
        {SECTIONS.map(({ name, title, hint }) => <section className="ex-custom-sec" key={name}>
          <h3>{title}</h3>
          <p>{hint}</p>
          {draft[name].map((item, index) => <div key={item.id} className={`ex-custom-row${item.visible ? "" : " off"}`}>
            <input type="checkbox" checked={item.visible} disabled={item.locked} onChange={(event) => edit(name, item.id, { visible: event.target.checked })}
              aria-label={item.locked ? `${item.default_label} is always shown` : `Show ${item.default_label}`} title={item.locked ? "Always shown" : undefined}/>
            <input type="text" maxLength={40} aria-label={`Name for ${item.default_label}`} placeholder={item.default_label} value={item.label} onChange={(event) => edit(name, item.id, { label: event.target.value })}/>
            {layout.blocks[name].reorder ? <div className="ex-custom-move">
              <button type="button" aria-label={`Move ${item.default_label} up`} disabled={item.pinned || index === 0 || draft[name][index - 1].pinned} onClick={() => move(name, index, -1)}>↑</button>
              <button type="button" aria-label={`Move ${item.default_label} down`} disabled={item.pinned || index === draft[name].length - 1} onClick={() => move(name, index, 1)}>↓</button>
            </div> : <span className="ex-custom-move"/>}
          </div>)}
        </section>)}
      </div>
      {error && <div className="ex-error" role="alert">{error}{stale && <button type="button" className="ex-btn" onClick={() => void onReload().then(() => setError(""))}>Load the latest version</button>}</div>}
      <div className="ex-custom-foot">
        {(layout.customized || layout.override_invalid) && <button type="button" className="ex-link" disabled={busy} onClick={() => void restore()}>Restore default</button>}
        <span className="ex-grow"/>
        <button type="button" className="ex-btn" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="demo-primary ex-save" disabled={busy || (!changed && !layout.override_invalid)} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      </div>
    </div>
  </div>;
}
