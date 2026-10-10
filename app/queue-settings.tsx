import { useEffect, useState } from "react";

type Live = { active: number; queued: number; oldestWaitMs: number; lastWaitMs: number; admittedTotal: number; maxConcurrent: number | null; perMinute: number | null };
type Limits = { maxConcurrent: number | null; perMinute: number | null };
type Report = {
  saved: { maxPi: number | null; providers: Record<string, Limits> };
  defaults: { maxPi: number };
  pi: Live;
  providers: Record<string, { limits: Partial<Limits>; live: Live | null }>;
};
type Form = { maxPi: string; providers: Record<string, { maxConcurrent: string; perMinute: string }> };

const text = (value: number | null | undefined) => (value == null ? "" : String(value));

function formFrom(report: Report): Form {
  const providers: Form["providers"] = {};
  for (const id of Object.keys(report.providers)) {
    const own = report.saved.providers[id];
    providers[id] = { maxConcurrent: text(own?.maxConcurrent), perMinute: text(own?.perMinute) };
  }
  return { maxPi: text(report.saved.maxPi), providers };
}

function seconds(ms: number) {
  return ms < 1000 ? "0 s" : `${Math.round(ms / 1000)} s`;
}

function line(live: Live | null | undefined) {
  if (!live) return "idle";
  return `${live.active} running · ${live.queued} waiting${live.queued ? ` (oldest ${seconds(live.oldestWaitMs)})` : ""} · last wait ${seconds(live.lastWaitMs)}`;
}

async function request<T>(method: "GET" | "PUT", body?: unknown): Promise<T> {
  const response = await fetch("/api/settings/queue", {
    method, credentials: "include",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data as T;
}

/** Job queue: how many Pi run at once and how fast each model provider may be called. Nothing here ever rejects work; it only decides who waits. */
export default function QueueSettings() {
  const [report, setReport] = useState<Report | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const pull = (resetForm: boolean) => request<Report>("GET").then((next) => {
      if (!active) return;
      setReport(next);
      if (resetForm) setForm(formFrom(next));
    }).catch((error) => { if (active && resetForm) setMessage(error.message); });
    void pull(true);
    const timer = setInterval(() => { void pull(false); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const save = async () => {
    if (!form) return;
    setBusy(true); setMessage("");
    try {
      const next = await request<Report>("PUT", form);
      setReport(next); setForm(formFrom(next));
      setMessage("Saved. The new limits are already in force; work that is running is not touched.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally { setBusy(false); }
  };

  if (!report || !form) return <section className="settings-card"><h2>Job queue</h2><p>{message || "Loading…"}</p></section>;
  const ids = Object.keys(report.providers).sort();
  return <section className="settings-card">
    <h2>Job queue</h2>
    <p>Work that cannot start yet waits in line, in the order it arrived. Nothing is refused or timed out because the host is busy. Leave a field empty for no cap.</p>

    <h2>Pi processes</h2>
    <p>{line(report.pi)}</p>
    <label>Max Pi running at once (default {report.defaults.maxPi})
      <input inputMode="numeric" value={form.maxPi} placeholder={String(report.defaults.maxPi)} disabled={busy}
        onChange={(event) => setForm({ ...form, maxPi: event.target.value })} />
    </label>

    <h2>Model providers</h2>
    {ids.length === 0 && <p>No providers yet.</p>}
    {ids.map((id) => <div key={id}>
      <h3>{id}</h3>
      <p>{line(report.providers[id].live)}</p>
      <label>Concurrent calls
        <input inputMode="numeric" value={form.providers[id]?.maxConcurrent ?? ""} disabled={busy}
          onChange={(event) => setForm({ ...form, providers: { ...form.providers, [id]: { ...form.providers[id], maxConcurrent: event.target.value } } })} />
      </label>
      <label>Calls per minute
        <input inputMode="numeric" value={form.providers[id]?.perMinute ?? ""} disabled={busy}
          onChange={(event) => setForm({ ...form, providers: { ...form.providers, [id]: { ...form.providers[id], perMinute: event.target.value } } })} />
      </label>
    </div>)}

    <button type="button" disabled={busy} onClick={() => void save()}>Save limits</button>
    {message && <p role="status">{message}</p>}
  </section>;
}
