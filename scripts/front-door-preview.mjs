// Serve the production bundle with deterministic API fixtures for visual checks.
// Build first, then run: node scripts/front-door-preview.mjs [port] [dist path]
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.argv[3] || "dist");
const user = { id: "preview-user", username: "judha", display_name: "Judha Maygustya", role: "admin", tier: "pro" };
const sessions = [{ id: "recent-1", title: "Getting to know my company", userId: user.id, agentId: "orchestrator", engine: "pi", updatedAt: Date.now() }];
const transcripts = new Map([["recent-1", [{ id: "old-message", role: "assistant", content: "Welcome back. Let’s work on your company profile." }]]]);
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2" };
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) {
      let data = {};
      if (url.pathname === "/api/demo/me") data = { user };
      else if (url.pathname === "/api/demo/state") data = { profile: { company: { name: "Acme Studio", country: "MY", currency: "MYR" }, readiness: { minimum_ready: false } }, people: [], members: [], customers: [], invoices: [] };
      else if (url.pathname === "/api/agents") data = { agents: [{ id: "orchestrator", slug: "orchestrator", name: "e", userFacing: true, engine: "pi" }] };
      else if (url.pathname === "/api/models") data = { models: [{ id: "preview-model", label: "Preview", shortLabel: "Test", provider: "Fixture", available: true }], agyModels: [] };
      else if (url.pathname === "/api/sessions") {
        if (req.method === "POST") {
          let body = ""; for await (const chunk of req) body += chunk;
          const session = { ...sessions[0], id: `new-${Date.now()}`, title: JSON.parse(body).title || "New chat" };
          sessions.unshift(session); data = { session };
        } else data = { sessions };
      } else if (url.pathname === "/api/messages") data = { messages: transcripts.get(url.searchParams.get("sessionId")) || [] };
      else if (url.pathname === "/api/chat") {
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        transcripts.set(input.sessionId, [...(transcripts.get(input.sessionId) || []), { id: `user-${Date.now()}`, role: "user", content: input.message }, { id: `reply-${Date.now()}`, role: "assistant", content: "I can help with that." }]);
        res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end('data: {"type":"text","delta":"I can help with that."}\n\ndata: {"type":"done"}\n\n'); return;
      }
      else if (url.pathname === "/api/files") data = { files: [] };
      else if (url.pathname === "/api/demo/activity") data = { events: [] };
      else if (url.pathname === "/api/demo/db-log") data = { entries: [], nextCursor: null };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); return;
    }
    const resolved = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    let file = resolved;
    try { if (!(await fs.stat(file)).isFile()) file = path.join(root, "index.html"); } catch { file = path.join(root, "index.html"); }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(await fs.readFile(file));
  } catch { res.writeHead(500); res.end("Preview fixture failed"); }
}).listen(Number(process.argv[2] || 47823), "127.0.0.1", () => console.log("Front door production preview is ready"));
