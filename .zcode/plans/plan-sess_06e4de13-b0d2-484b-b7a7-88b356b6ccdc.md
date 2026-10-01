## Findings

The supplied URL is not an MCP server. `https://ee-mail-production.up.railway.app/api` is a JSON discovery route for a REST service; the documented send route is `POST /send` at the service root. Read-only probes found no MCP/JSON-RPC/SSE/streamable-HTTP endpoint at `/api`, `/mcp`, or `/sse`. The public `/send` documentation accepts `to`, `subject`, `text` and/or `html`, optional `from`/`domain`/`cc`/`bcc`/`attachments`, but does not document authentication or a response/idempotency contract.

The repository already has the right security boundary: local stdio MCP processes call back into the host, and the host performs agent/tenant/role validation. The Orchestrator is intentionally a planner/dispatcher and should not receive a broad direct side-effect tool. Therefore the safest interpretation of “so our Document Intelligence orchestrator can send email” is: register one additional local MCP for the document specialist (`di-documents`), and let the existing orchestrator dispatch an approved email task to that specialist.

## Implementation plan

1. **Add a host-side EE-Mail client and configuration.**
   - Add a small `server/ee-mail.mjs` (or equivalent server-side module matching existing HTTP-client conventions) that normalizes the configured URL: the user-provided `/api` URL is treated as the discovery/base URL and the actual send request goes to the service root `.../send`.
   - Make the base URL configurable through the existing settings/secrets mechanism, with the supplied service URL as the default. Do not add or invent an API key because the public contract does not specify one; keep an optional host-side header configuration hook so authentication can be added without exposing credentials to agents.
   - Omit `from` by default so EE-Mail uses its configured domain default. Do not let the model choose arbitrary sender headers.
   - Normalize non-2xx and malformed responses into safe, actionable errors; never include credentials or raw request headers in tool output.

2. **Expose one constrained tool through the existing Document Intelligence MCP.**
   - Add a `send_email` entry to `document_inteligence/core/tools.mjs`, owned only by `di-documents`, so the existing `toolsFor(agent)` and `mcp-server.mjs` automatically expose it only to that agent.
   - Use a strict input schema: one or more validated recipient addresses, bounded subject length, and exactly one of bounded plain-text or HTML body. Initially omit arbitrary headers and attachments (the public endpoint supports them, but the repository has no attachment approval/audit/idempotency policy); add those only as a separate, explicit follow-up.
   - Implement the tool through the host-side EE-Mail client, not from the child MCP process, so provider configuration remains out of agent environment/catalog/runtime files.
   - Require the current agent/user flow to have explicitly approved the concrete recipient, subject, and body before sending; keep document issuance and email sending as distinct mutations.

3. **Wire host dependencies and preserve the current authorization boundary.**
   - Extend the DI host dependency wiring so `runTool()` can call the EE-Mail client while retaining the existing per-agent token, ownership, Zod validation, tenant, actor, and role checks.
   - Keep the Orchestrator MCP unchanged as a direct provider client: it continues to use `create_plan`/`dispatch_task`, and its role instructions will explicitly say that approved email work must be dispatched to `di-documents` rather than sent by guessing or by calling the REST endpoint itself.
   - Update `agent/roles/di-documents.md` and the orchestrator role guidance to describe the confirmation requirement and the new `send_email` capability. Update the checker’s known-gap/mutation documentation so email is no longer listed as missing, while keeping it marked as an external side effect.

4. **Add an idempotent local MCP registration/attachment only if the current catalog flow requires a separate server record.**
   - Prefer reusing the existing `document-intelligence` stdio server because it already materializes per-agent tools and enforces ownership. If the implementation review shows the user specifically needs a separately named MCP card, add a local `ee-mail` stdio server/registration helper following `sales-mcp.mjs` and attach it only to `di-documents`; it must still call the host proxy and must not contain the provider credential.
   - In either case, do not register the REST URL as `transport: http`, and do not attach the capability to every DI agent or directly to the Orchestrator.

5. **Add non-destructive coverage.**
   - Extend the DI MCP protocol tests to verify `di-documents` sees `send_email` and other DI agents do not.
   - Add a fake local EE-Mail HTTP server test that asserts the adapter sends `POST /send` with the documented body, omits `from` by default, handles success, non-2xx, timeout, malformed JSON, and never logs/returns credentials.
   - Add host/agent-environment/runtime coverage proving the provider URL/config is host-side and no provider secret is materialized into `mcp.json` or unrelated agent environments.
   - Add an orchestrator test that confirms email work is dispatched to `di-documents` and that direct self-dispatch/direct provider access remains unavailable.

6. **Validate after implementation.**
   - Run the existing DI MCP, orchestrator, runtime, and context-pack tests plus the new adapter tests using only the fake server; do not call the real `/send` endpoint.
   - Refresh the graft graph with `graft build` after the code changes.
   - Report the exact files changed, test results, and the remaining operational assumption: EE-Mail currently documents no auth, response, rate-limit, or idempotency contract. If production later requires auth or reliable retry semantics, add those as a follow-up before enabling automated retries.

No files have been modified during this planning pass.