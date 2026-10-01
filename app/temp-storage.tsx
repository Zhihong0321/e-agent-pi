import { useEffect, useState } from "react";

type Source = { id: string; title: string; url: string; bytes: number; chars: number; createdAt: string; storedInFull: boolean };
type Inventory = { sources: Source[]; bytes: number; limitBytes: number; folder: string };
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
async function request(body?: { ids: string[] }) {
  const response = await fetch("/api/settings/temp", body ? { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Temporary storage request failed");
  return data;
}

export default function TempStorage() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void request().then(data => { if (active) setInventory(data); }).catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);
  const refresh = async () => {
    setBusy(true);
    try { setInventory(await request()); setSelected([]); setConfirming(false); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not load storage"); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    setBusy(true);
    try {
      const result = await request({ ids: selected });
      setMessage(`Deleted ${result.removed} temporary sources (${size(result.bytes)}).`);
      setSelected([]); setConfirming(false); setInventory(await request());
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not delete sources"); }
    finally { setBusy(false); }
  };
  return <section className="settings-card">
    <h2>Temporary storage</h2>
    <p>Web pages are fetched once and their complete extracted text is stored here for reuse. You can safely delete these temporary copies. Workspace files, uploaded files, saved documents and shared downloads are kept separately.</p>
    <p>Deleting a source removes its reusable copy. A chat or unfinished job that still needs it will have to fetch it again. Save final work as a document or shared file before clearing its source.</p>
    {inventory && <>
      <p><strong>{size(inventory.bytes)}</strong> of {size(inventory.limitBytes)} used · {inventory.sources.length} sources</p>
      <p>Folder: <code>{inventory.folder}</code></p>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh</button>
        <button type="button" disabled={busy || !inventory.sources.length} onClick={() => { setSelected(inventory.sources.map(source => source.id)); setConfirming(false); }}>Select all temporary sources</button>
        <button type="button" disabled={busy || !selected.length} onClick={() => setConfirming(true)}>Delete selected ({selected.length})</button>
      </div>
      {confirming && <div role="alert">
        <p>Delete {selected.length} selected temporary sources ({size(inventory.sources.filter(source => selected.includes(source.id)).reduce((sum, source) => sum + source.bytes, 0))})?</p>
        <button type="button" disabled={busy} onClick={() => void clear()}>Delete these temporary sources</button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
      </div>}
      {!inventory.sources.length && <p>Temporary storage is empty.</p>}
      {inventory.sources.map(source => <article key={source.id} style={{ borderTop: "1px solid #ddd", marginTop: 16, paddingTop: 12 }}>
        <label style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
          <input type="checkbox" style={{ width: "auto" }} disabled={busy} checked={selected.includes(source.id)} onChange={event => { setConfirming(false); setSelected(event.target.checked ? [...selected, source.id] : selected.filter(id => id !== source.id)); }} />
          <strong>{source.title || "Untitled source"}</strong>
        </label>
        <p style={{ overflowWrap: "anywhere" }}>{source.url}</p>
        <p>{size(source.bytes)} · {source.chars.toLocaleString()} characters · {new Date(source.createdAt).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur" })}</p>
        {source.storedInFull ? <a href={`/api/settings/temp/${source.id}`} target="_blank" rel="noreferrer">Open complete saved text</a> : <p>Scraper output awaiting import. This temporary allocation can also be deleted if no longer needed.</p>}
      </article>)}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
