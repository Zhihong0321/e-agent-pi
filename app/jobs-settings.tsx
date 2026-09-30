import { useCallback, useEffect, useState } from "react";

type Job = { id: string; title: string; status: string; completedAt: string | null };
type Preview = { before: string; plans: number; tasks: number; attempts: number };
type Report = { tasks: { id: string; title: string; status: string; result: string | null; error: string | null }[] };

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: "include", ...(body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

export default function JobsSettings() {
  const [before, setBefore] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    const data = await request<{ jobs: Job[] }>("/api/settings/jobs");
    setJobs(data.jobs);
  }, []);
  useEffect(() => {
    let active = true;
    void request<{ jobs: Job[] }>("/api/settings/jobs").then(data => {
      if (active) setJobs(data.jobs);
    }).catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);
  const cleanup = async (remove: boolean) => {
    setBusy(true); setMessage("");
    try {
      const data = await request<Preview>("/api/settings/jobs/cleanup", { before, remove, expected: preview });
      if (remove) {
        setPreview(null); setReport(null);
        setMessage(`Cleared ${data.plans} completed jobs, ${data.tasks} tasks and ${data.attempts} execution attempts.`);
        await load();
      } else setPreview(data);
    } catch (error) {
      setPreview(null);
      setMessage(error instanceof Error ? error.message : "Cleanup failed");
    } finally { setBusy(false); }
  };
  const inspect = async (id: string) => {
    setBusy(true);
    try { setReport(await request<Report>(`/api/settings/jobs?planId=${encodeURIComponent(id)}`)); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Could not load report"); }
    finally { setBusy(false); }
  };
  return <section className="settings-card">
    <h2>Completed job cleanup</h2>
    <p>Clear jobs completed before the selected date, using Kuala Lumpur time. Running, queued, blocked, failed and cancelled jobs are preserved. Chat history and generated files are kept.</p>
    <label>Completed before<input type="date" value={before} disabled={busy} onChange={event => { setBefore(event.target.value); setPreview(null); }} /></label>
    <button type="button" disabled={busy || !before} onClick={() => void cleanup(false)}>Preview cleanup</button>
    {preview && <div role="status">
      <p>{preview.plans} completed jobs, {preview.tasks} tasks and {preview.attempts} execution attempts will be permanently removed.</p>
      <button type="button" disabled={busy || !preview.plans} onClick={() => void cleanup(true)}>Permanently clear these completed jobs</button>
    </div>}
    {message && <p role="status">{message}</p>}
    <h2>Recent jobs</h2>
    <button type="button" disabled={busy} onClick={() => void load().catch(error => setMessage(error.message))}>Refresh jobs</button>
    {jobs.length === 0 && <p>No jobs yet.</p>}
    <ul>{jobs.map(job => <li key={job.id}>
      <button type="button" disabled={busy} onClick={() => void inspect(job.id)}>{job.title}</button> — {job.status}
      {job.completedAt && ` · ${new Date(job.completedAt).toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur" })}`}
    </li>)}</ul>
    {report && <div><h3>Job output</h3>{report.tasks.map(task => <article key={task.id}>
      <h4>{task.title} — {task.status}</h4>
      {task.result && <p style={{ whiteSpace: "pre-wrap" }}>{task.result}</p>}
      {task.error && <p style={{ whiteSpace: "pre-wrap" }}>{task.error}</p>}
    </article>)}</div>}
  </section>;
}
