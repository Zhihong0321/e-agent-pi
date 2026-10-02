import { useEffect, useState } from "react";
import ChatLogs from "../chat-logs";
import ActivityLog from "../activity-log";
import { UsagePanel, type MetricsPayload, type UsagePayload } from "../settings";
import "./observability.css";

export function ObservabilityPanel({ area, isAdmin }: { area: "logs" | "usage" | "activity"; isAdmin: boolean }) {
  return <div className="demo-observability">{area === "logs" ? <ChatLogs endpoint="/api/demo/chat-logs" /> : area === "activity" ? <ActivityLog endpoint="/api/demo/activity" /> : <DemoUsage isAdmin={isAdmin} />}</div>;
}
async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load usage");
  return data;
}
function DemoUsage({ isAdmin }: { isAdmin: boolean }) {
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [metrics, setMetrics] = useState<MetricsPayload | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [usageData, metricsData] = await Promise.all([request<UsagePayload>("/api/demo/usage"), isAdmin ? request<MetricsPayload>("/api/demo/metrics") : Promise.resolve(null)]);
        if (!cancelled) { setUsage(usageData); setMetrics(metricsData); setError(""); }
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load usage"); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [isAdmin]);
  return <>{error && <p className="activity-error" role="alert">{error}</p>}<UsagePanel data={metrics} usage={usage} showResources={isAdmin} /></>;
}
