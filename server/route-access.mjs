// Route access table. Every /api/ route is one of three classes, and an unlisted route is
// OPERATOR: access is granted by listing a route here, never by forgetting to protect it.
//
//   public   no session needed; the handler authenticates (worker tokens, form links, login).
//   user     a signed-in company user, or the platform operator; handlers scope the data to the
//            caller's company and own sessions.
//   operator only the platform operator (owner credential): settings, catalog, debug, metrics.

const PUBLIC_EXACT = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/demo/login",
  "/api/np/health",
]);
// Handlers behind these prefixes check their own credential (worker/agent tokens, stock token,
// the form link's company id).
const PUBLIC_PREFIX = ["/api/internal/", "/api/forms/", "/api/stock", "/api/test-agy"];

const USER_PREFIX = [
  "/api/demo/",
  "/api/sessions",
  "/api/schedules",
  "/api/media-kit",
  "/api/company-research",
];
const USER_EXACT = new Set(["/api/chat", "/api/messages", "/api/execution/runs"]);
const USER_GET_EXACT = new Set(["/api/agents", "/api/models", "/api/files", "/api/files/raw"]);

/** @returns {"public" | "user" | "operator"} */
export function routeAccess(pathname, method = "GET") {
  if (!pathname.startsWith("/api/")) return "public"; // pages, static files, /files, /reports: own handlers
  if (PUBLIC_EXACT.has(pathname)) return "public";
  if (PUBLIC_PREFIX.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) return "public";
  if (USER_EXACT.has(pathname)) return "user";
  if (USER_GET_EXACT.has(pathname) && (method === "GET" || method === "HEAD")) return "user";
  if (USER_PREFIX.some((prefix) => pathname === prefix || pathname.startsWith(prefix))) return "user";
  return "operator";
}
