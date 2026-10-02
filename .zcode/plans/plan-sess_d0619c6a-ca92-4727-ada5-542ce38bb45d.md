## Goal
Create one durable, provider-neutral usage ledger for every LLM/Tavily request, then expose an admin-only usage dashboard in the existing Settings → Usage page.

## Design
Use an append-only PostgreSQL `api_usage` table rather than only adding fields to `activity_events`. Activity events remain useful for turn/audit context, while the usage table preserves one record per external API call and supports reliable aggregation.

Each record should include:
- timestamp and request duration
- service/provider/operation (`llm`, `tavily`, etc.)
- engine/model when known
- user/session/agent correlation IDs when available
- status and bounded error classification
- input, output, cache-read, cache-write, and total tokens (nullable when the provider does not return them)
- provider-specific billable units such as Tavily credits/results
- request ID when supplied
- estimated cost only when a configured price is available
- small redacted metadata JSON; never prompts, API keys, authorization headers, or raw response bodies

The write path will be best-effort: a database/logging failure must not fail or slow the user’s API request beyond a bounded asynchronous write.

## Implementation steps
1. **Add the usage persistence layer**
   - Extend the existing PostgreSQL initialization/migration in `server/db.mjs` with the table and indexes for time, service/provider/model, user, and session.
   - Add `server/usage.mjs` with a normalized record type, token/credit extraction helpers for common shapes (`input_tokens`/`output_tokens`, OpenAI-style prompt/completion tokens, Pi SDK usage, and Tavily usage/credits), redaction, insertion, and aggregation queries.

2. **Instrument the existing API boundaries**
   - Main LLM/chat path in `server/index.mjs`: capture provider usage from emitted completion/message events where available and write a record for successful and failed calls, linked to the existing turn context.
   - Company-research LLM path in `server/company-research/runner.mjs`: record each lane’s `message_end` usage, cache tokens, model, duration, status, and correlation IDs.
   - Tavily wrapper in `server/company-research/adapters.mjs`: record every search attempt, including retries/auth/quota failures, response usage/credits when returned, and result counts. Do not store search content or secrets.
   - Direct compatibility LLM caller in `document_inteligence/checker/judge.mjs` (and the shared direct model probe in `server/models.mjs` if it is used in production): record normalized response usage and failures. Keep image/metadata APIs extensible but out of the first token dashboard unless they expose a billable usage shape.
   - Add usage fields to the existing `turn_completed` metadata only as a correlation/convenience summary; the usage table remains the source of truth.

3. **Expose an authenticated aggregation API**
   - Add `GET /api/usage` in `server/index.mjs`, using the existing auth/admin conventions.
   - Support a bounded date range plus optional service/provider/model/user filters.
   - Return summary KPIs (calls, total/input/output/cache tokens, Tavily credits, failures, estimated cost), time buckets for charts, grouped breakdowns, and a paginated recent-record list.
   - Enforce admin-only global views; non-admin users can see only their own records if that is consistent with current activity behavior.

4. **Build the dashboard in the existing admin UI**
   - Extend `UsagePanel` in `app/settings.tsx` rather than creating a new route/page.
   - Reuse the existing statistic cards, SVG chart, settings grids, and activity-table styling.
   - Show date range controls, total calls/tokens/credits/cost, daily token trend, provider/model/service breakdown, failure count, and recent API calls with status and latency.
   - Keep resource monitoring (RAM/CPU) intact; make the two sections visually distinct.

5. **Tests and verification**
   - Add unit tests for normalization across provider usage shapes, nullable/partial usage, cost/credit aggregation, redaction, and failed calls.
   - Add database/query tests following existing fake-pool conventions.
   - Add Tavily and research-runner tests asserting one record per attempt/lane, including retries and provider failures.
   - Add endpoint auth/filter/aggregation tests and a frontend build/type check.
   - Verify the dashboard with a seeded/fake usage response and confirm no key, prompt, or raw response content reaches storage or the API.

## Initial retention/defaults
Keep the detailed ledger durable and bounded by indexed queries; do not silently discard records during the first implementation. Add an explicit retention setting/prune job later if volume requires it, rather than losing audit history by reusing the 24-hour resource-sample retention.